/**
 * Sending money — the endpoint everything else in this system exists to protect.
 *
 * Order of operations, and why each step is where it is:
 *
 *   1. Verify the PIN *before* BEGIN. Argon2 takes ~50 ms; spending that inside a transaction
 *      would hold a pooled connection, and later a row lock, for no reason.
 *
 *   2. Claim the idempotency key as the first statement of the transaction, so a duplicate
 *      request either blocks on it or replays it. See platform/idempotency/store.ts.
 *
 *   3. Resolve and validate the payee before taking any lock — a 404 should never wait behind
 *      someone else's transfer.
 *
 *   4. Lock both accounts in ascending id order (ledger.service.ts), then re-check funds,
 *      status, and limits *under the lock*. Anything checked before the lock is a guess.
 *
 *   5. Write the movement, the outbox event, the audit row, and the idempotency completion —
 *      all in the same commit.
 *
 * Nothing in this transaction talks to the network. No HTTP, no Redis, no broker. A remote
 * system that hangs must never be able to hold a lock on someone's balance.
 */
import { config } from '../../config/index.js';
import { withTransaction } from '../../platform/db/transaction.js';
import { trackWrite } from '../../platform/db/read-router.js';
import { errors } from '../../platform/errors/index.js';
import { enqueueEvent } from '../../platform/outbox/index.js';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  hashRequest,
} from '../../platform/idempotency/store.js';
import { money } from '../../shared/money.js';
import { insertAuditLog } from '../auth/auth.repo.js';
import { verifyPin } from '../auth/pin.service.js';
import { postDoubleEntry } from './ledger.service.js';
import * as repo from './transfer.repo.js';
import type { CreateTransferInput } from './transfer.schemas.js';

export interface TransferContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface TransferReceipt {
  transfer: {
    reference: string;
    status: 'COMPLETED';
    type: string;
    amount: ReturnType<typeof money>;
    note: string | null;
    createdAt: string;
    counterparty: { name: string; phone: string };
    direction: 'OUT';
  };
  balance: ReturnType<typeof money>;
}

export interface TransferOutcome {
  status: number;
  body: TransferReceipt;
  replayed: boolean;
}

const ENDPOINT = 'POST /api/v1/transfers';

export async function sendMoney(
  senderUserId: string,
  idempotencyKey: string,
  input: CreateTransferInput,
  rawBody: unknown,
  context: TransferContext,
): Promise<TransferOutcome> {
  // Policy checks that need no database state come first — cheapest rejection wins.
  if (input.amountMinor < BigInt(config.MIN_TRANSFER_MINOR)) {
    throw errors.validation(
      `Minimum transfer is ${money(BigInt(config.MIN_TRANSFER_MINOR)).formatted} BDT`,
    );
  }
  if (input.amountMinor > BigInt(config.MAX_TRANSFER_MINOR)) {
    throw errors.limitExceeded(
      `Maximum transfer is ${money(BigInt(config.MAX_TRANSFER_MINOR)).formatted} BDT`,
      { maxMinor: config.MAX_TRANSFER_MINOR.toString() },
    );
  }

  await verifyPin(senderUserId, input.pin);

  const requestHash = hashRequest(ENDPOINT, rawBody);

  return withTransaction(async (tx) => {
    const claim = await claimIdempotencyKey(tx, {
      userId: senderUserId,
      key: idempotencyKey,
      endpoint: ENDPOINT,
      requestHash,
    });

    if (claim.kind === 'mismatch') throw errors.idempotencyKeyReuse();
    if (claim.kind === 'replay') {
      return { status: claim.status, body: claim.body as TransferReceipt, replayed: true };
    }

    const senderAccountId = await repo.findAccountIdForUser(tx, senderUserId);
    if (!senderAccountId) throw errors.notFound('Account');

    const payee = await repo.findPayeeByPhone(tx, input.toPhone);
    if (!payee || payee.userStatus !== 'ACTIVE') throw errors.notFound('Recipient');
    if (payee.userId === senderUserId) throw errors.selfTransfer();

    // Evaluated inside the transaction: two concurrent transfers must not both see the same
    // pre-spend total and each conclude they fit under the cap.
    const spent = await repo.outboundInWindow(tx, senderAccountId);
    const dailyLimit = BigInt(config.DAILY_TRANSFER_LIMIT_MINOR);
    if (spent + input.amountMinor > dailyLimit) {
      throw errors.limitExceeded('This transfer would exceed your daily sending limit', {
        dailyLimitMinor: dailyLimit.toString(),
        alreadySentMinor: spent.toString(),
        attemptedMinor: input.amountMinor.toString(),
      });
    }

    const posted = await postDoubleEntry(tx, {
      fromAccountId: senderAccountId,
      toAccountId: payee.accountId,
      amountMinor: input.amountMinor,
      type: 'P2P',
      note: input.note ?? null,
      idempotencyKeyId: claim.id,
    });

    await enqueueEvent(tx, {
      eventType: 'MONEY_RECEIVED',
      aggregateType: 'transfer',
      aggregateId: posted.id,
      payload: {
        transferId: posted.id,
        reference: posted.reference,
        senderUserId,
        recipientUserId: payee.userId,
        amountMinor: posted.amountMinor.toString(),
        note: posted.note,
      },
    });

    await trackWrite(tx, senderUserId, payee.userId);

    await insertAuditLog(tx, {
      actorUserId: senderUserId,
      action: 'TRANSFER_SENT',
      entityType: 'transfer',
      entityId: posted.id,
      metadata: {
        reference: posted.reference,
        amountMinor: posted.amountMinor.toString(),
        recipientUserId: payee.userId,
      },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    const body: TransferReceipt = {
      transfer: {
        reference: posted.reference,
        status: 'COMPLETED',
        type: posted.type,
        amount: money(posted.amountMinor),
        note: posted.note,
        createdAt: posted.createdAt.toISOString(),
        counterparty: { name: payee.name, phone: payee.phone },
        direction: 'OUT',
      },
      balance: money(posted.senderBalanceAfter),
    };

    // Same commit as the money. This is what makes a retry after a crash resolvable.
    await completeIdempotencyKey(tx, claim.id, 201, body);

    return { status: 201, body, replayed: false };
  });
}
