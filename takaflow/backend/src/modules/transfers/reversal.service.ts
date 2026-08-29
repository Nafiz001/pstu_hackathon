/**
 * Reversing a transfer.
 *
 * THE RULE: a reversal is a NEW movement in the opposite direction, never an edit of the original.
 *
 * The ledger is append-only and the original entries stay exactly as they were written. Undoing a
 * payment by adjusting balances and deleting rows would destroy the one thing that makes this
 * system auditable — the ability to say what happened, in order, and prove it. So the original
 * transfer is marked REVERSED (a status change, not a value change) and a compensating transfer
 * carries the money back, linked by `reversal_of`.
 *
 * WHAT THIS DELIBERATELY CANNOT DO: force money out of an account that no longer has it. If the
 * recipient has already spent the funds, the reversal is refused. A closed-loop wallet has no
 * authority to overdraw someone, and inventing one would break the non-negative invariant the
 * whole system is built on. That limitation is real and is stated rather than papered over.
 *
 * The window is short (60 s by default) because this is an "undo, I picked the wrong person"
 * feature, not a dispute process. Disputes need a human and an adjudication trail; that is a
 * different product and is out of scope.
 */
import { config } from '../../config/index.js';
import { withTransaction } from '../../platform/db/transaction.js';
import type { Tx } from '../../platform/db/transaction.js';
import { errors } from '../../platform/errors/index.js';
import { enqueueEvent } from '../../platform/outbox/index.js';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  hashRequest,
} from '../../platform/idempotency/store.js';
import { trackWrite } from '../../platform/db/read-router.js';
import { money, toMinor } from '../../shared/money.js';
import { asPgTimestamp, toDate, type PgTimestamp } from '../../shared/timestamp.js';
import { insertAuditLog } from '../auth/auth.repo.js';
import { verifyPin } from '../auth/pin.service.js';
import { postDoubleEntry, referenceDateRange } from './ledger.service.js';

export interface ReversalContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface ReversalResult {
  reversal: {
    reference: string;
    reversalOf: string;
    amount: ReturnType<typeof money>;
    createdAt: string;
  };
  balance: ReturnType<typeof money>;
}

interface OriginalTransfer {
  id: string;
  /** Full-precision, exactly as Postgres rendered it — see shared/timestamp.ts for why. */
  createdAtRaw: PgTimestamp;
  createdAt: Date;
  reference: string;
  fromAccountId: string;
  toAccountId: string;
  amountMinor: bigint;
  status: string;
  type: string;
  senderUserId: string | null;
  recipientUserId: string | null;
}

async function loadOriginal(tx: Tx, reference: string): Promise<OriginalTransfer | null> {
  const range = referenceDateRange(reference);
  const params: unknown[] = [reference];
  let pruning = '';
  if (range) {
    params.push(range.from, range.to);
    pruning = ' AND t.created_at >= $2::timestamptz AND t.created_at < $3::timestamptz';
  }

  const { rows } = await tx.query<{
    id: string;
    created_at_raw: string;
    reference: string;
    from_account_id: string;
    to_account_id: string;
    amount_minor: string;
    status: string;
    type: string;
    sender_user_id: string | null;
    recipient_user_id: string | null;
  }>(
    `SELECT t.id, t.created_at::text AS created_at_raw, t.reference,
            t.from_account_id, t.to_account_id,
            t.amount_minor::text AS amount_minor, t.status::text AS status, t.type::text AS type,
            sa.user_id AS sender_user_id, ra.user_id AS recipient_user_id
       FROM transfers t
       JOIN accounts sa ON sa.id = t.from_account_id
       JOIN accounts ra ON ra.id = t.to_account_id
      WHERE t.reference = $1${pruning}
      LIMIT 1`,
    params,
  );

  const row = rows[0];
  return row
    ? {
        id: row.id,
        createdAtRaw: asPgTimestamp(row.created_at_raw),
        createdAt: toDate(asPgTimestamp(row.created_at_raw)),
        reference: row.reference,
        fromAccountId: row.from_account_id,
        toAccountId: row.to_account_id,
        amountMinor: toMinor(row.amount_minor),
        status: row.status,
        type: row.type,
        senderUserId: row.sender_user_id,
        recipientUserId: row.recipient_user_id,
      }
    : null;
}

const ENDPOINT = 'POST /api/v1/transfers/:reference/reverse';

export async function reverseTransfer(
  actorUserId: string,
  reference: string,
  idempotencyKey: string,
  pin: string,
  rawBody: unknown,
  context: ReversalContext,
): Promise<{ status: number; body: ReversalResult; replayed: boolean }> {
  await verifyPin(actorUserId, pin);

  const requestHash = hashRequest(`${ENDPOINT}:${reference}`, rawBody);

  return withTransaction(async (tx) => {
    const claim = await claimIdempotencyKey(tx, {
      userId: actorUserId,
      key: idempotencyKey,
      endpoint: `${ENDPOINT}:${reference}`,
      requestHash,
    });
    if (claim.kind === 'mismatch') throw errors.idempotencyKeyReuse();
    if (claim.kind === 'replay') {
      return { status: claim.status, body: claim.body as ReversalResult, replayed: true };
    }

    const original = await loadOriginal(tx, reference);
    // Reported as missing rather than forbidden: confirming existence to a stranger would leak
    // that the reference is real.
    if (!original || original.senderUserId !== actorUserId) throw errors.notFound('Transfer');

    if (original.type === 'MINT' || original.type === 'REVERSAL') {
      throw errors.invalidState('This kind of transfer cannot be reversed', {
        type: original.type,
      });
    }
    if (original.status !== 'COMPLETED') {
      throw errors.invalidState('This transfer has already been reversed', {
        status: original.status,
      });
    }

    const ageSeconds = (Date.now() - original.createdAt.getTime()) / 1000;
    if (ageSeconds > config.REVERSAL_WINDOW_SECONDS) {
      throw errors.invalidState(
        `A transfer can only be reversed within ${config.REVERSAL_WINDOW_SECONDS} seconds`,
        { ageSeconds: Math.round(ageSeconds) },
      );
    }

    /**
     * Claim the reversal by flipping the original's status, guarded on it still being COMPLETED.
     * Two concurrent reversal attempts both reach here; exactly one changes a row, and the other
     * finds nothing to change and is refused. Same pattern as the money-request state machine.
     *
     * The partition key is in the predicate so this touches one monthly partition.
     */
    const { rowCount } = await tx.query(
      `UPDATE transfers
          SET status = 'REVERSED'
        WHERE id = $1 AND created_at = $2::timestamptz AND status = 'COMPLETED'`,
      // The raw text, not a Date: a Date would have truncated the microseconds and matched
      // nothing, rejecting every first reversal as "already reversed".
      [original.id, original.createdAtRaw],
    );
    if (rowCount !== 1) throw errors.invalidState('This transfer has already been reversed');

    // The compensating movement: recipient back to sender. If the recipient has spent the money,
    // postDoubleEntry refuses on insufficient funds and the whole reversal rolls back — the
    // original stays COMPLETED and nothing is half-undone.
    const compensating = await postDoubleEntry(tx, {
      fromAccountId: original.toAccountId,
      toAccountId: original.fromAccountId,
      amountMinor: original.amountMinor,
      type: 'REVERSAL',
      note: `Reversal of ${original.reference}`,
      idempotencyKeyId: claim.id,
      reversalOf: original.id,
    });

    await trackWrite(tx, actorUserId, original.recipientUserId);

    await enqueueEvent(tx, {
      eventType: 'TRANSFER_REVERSED',
      aggregateType: 'transfer',
      aggregateId: original.id,
      payload: {
        originalReference: original.reference,
        reversalReference: compensating.reference,
        senderUserId: actorUserId,
        recipientUserId: original.recipientUserId,
        amountMinor: original.amountMinor.toString(),
      },
    });

    await insertAuditLog(tx, {
      actorUserId,
      action: 'TRANSFER_REVERSED',
      entityType: 'transfer',
      entityId: original.id,
      metadata: {
        originalReference: original.reference,
        reversalReference: compensating.reference,
        ageSeconds: Math.round(ageSeconds),
      },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    const body: ReversalResult = {
      reversal: {
        reference: compensating.reference,
        reversalOf: original.reference,
        amount: money(original.amountMinor),
        createdAt: compensating.createdAt.toISOString(),
      },
      // The reverser is the CREDIT side of the compensating movement.
      balance: money(compensating.receiverBalanceAfter),
    };

    await completeIdempotencyKey(tx, claim.id, 201, body);
    return { status: 201, body, replayed: false };
  });
}
