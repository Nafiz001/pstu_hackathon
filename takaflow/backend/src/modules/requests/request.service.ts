/**
 * Money requests — "my friend owes me BDT 1,200, I want to collect it through the app".
 *
 * The lifecycle is PENDING -> ACCEPTED | DECLINED | CANCELLED | EXPIRED, and the whole design
 * question is: who is allowed to move it, when, and what happens when two people try at once.
 *
 * Accepting is the interesting transition, because it is two things that must be one thing:
 * a state change *and* a payment. They happen in a single transaction, so there is no instant
 * where the request is settled but the money has not moved, or the money moved against a
 * request that someone cancelled a millisecond earlier.
 *
 * The settlement reuses `postDoubleEntry` unchanged — the same locking, the same balance check,
 * the same two ledger entries as an ordinary transfer. A money request is not a second way to
 * move money; it is a different way to *authorise* the one way.
 */
import { config } from '../../config/index.js';
import { withTransaction } from '../../platform/db/transaction.js';
import { trackWrite } from '../../platform/db/read-router.js';
import type { Tx } from '../../platform/db/transaction.js';
import { errors } from '../../platform/errors/index.js';
import { enqueueEvent } from '../../platform/outbox/index.js';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  hashRequest,
} from '../../platform/idempotency/store.js';
import { money } from '../../shared/money.js';
import { decodeCursor, toPage, type Page } from '../../shared/cursor.js';
import { findUserById, insertAuditLog } from '../auth/auth.repo.js';
import { verifyPin } from '../auth/pin.service.js';
import { postDoubleEntry } from '../transfers/ledger.service.js';
import * as transferRepo from '../transfers/transfer.repo.js';
import * as repo from './request.repo.js';
import type { CreateRequestInput, ListRequestsQuery } from './request.schemas.js';

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface MoneyRequestDTO {
  id: string;
  status: repo.RequestStatus;
  amount: ReturnType<typeof money>;
  note: string | null;
  role: 'incoming' | 'outgoing';
  counterparty: { name: string; phone: string };
  expiresAt: string;
  createdAt: string;
  settledReference: string | null;
  declineReason: string | null;
}

function toDTO(
  request: repo.MoneyRequest,
  viewerUserId: string,
  counterparty: { name: string; phone: string },
  settledReference: string | null = null,
): MoneyRequestDTO {
  return {
    id: request.id,
    status: request.status,
    amount: money(request.amountMinor),
    note: request.note,
    role: request.payerUserId === viewerUserId ? 'incoming' : 'outgoing',
    counterparty,
    expiresAt: request.expiresAt.toISOString(),
    createdAt: request.createdAt.toISOString(),
    settledReference,
    declineReason: request.declineReason,
  };
}

const CREATE_ENDPOINT = 'POST /api/v1/requests';
const ACCEPT_ENDPOINT = 'POST /api/v1/requests/:id/accept';

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createRequest(
  requesterUserId: string,
  idempotencyKey: string,
  input: CreateRequestInput,
  rawBody: unknown,
  context: RequestContext,
): Promise<{ status: number; body: { request: MoneyRequestDTO }; replayed: boolean }> {
  if (input.amountMinor < BigInt(config.MIN_TRANSFER_MINOR)) {
    throw errors.validation(
      `Minimum request is ${money(BigInt(config.MIN_TRANSFER_MINOR)).formatted} BDT`,
    );
  }
  if (input.amountMinor > BigInt(config.MAX_TRANSFER_MINOR)) {
    throw errors.limitExceeded(
      `Maximum request is ${money(BigInt(config.MAX_TRANSFER_MINOR)).formatted} BDT`,
    );
  }

  const requestHash = hashRequest(CREATE_ENDPOINT, rawBody);

  return withTransaction(async (tx) => {
    const claim = await claimIdempotencyKey(tx, {
      userId: requesterUserId,
      key: idempotencyKey,
      endpoint: CREATE_ENDPOINT,
      requestHash,
    });
    if (claim.kind === 'mismatch') throw errors.idempotencyKeyReuse();
    if (claim.kind === 'replay') {
      return {
        status: claim.status,
        body: claim.body as { request: MoneyRequestDTO },
        replayed: true,
      };
    }

    const payer = await transferRepo.findPayeeByPhone(tx, input.fromPhone);
    if (!payer || payer.userStatus !== 'ACTIVE') throw errors.notFound('User');
    if (payer.userId === requesterUserId) {
      throw errors.validation('You cannot request money from yourself');
    }

    const requester = await findUserById(requesterUserId, tx);
    if (!requester) throw errors.notFound('User');

    const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
    const created = await repo.insertRequest(tx, {
      requesterUserId,
      payerUserId: payer.userId,
      amountMinor: input.amountMinor,
      note: input.note ?? null,
      expiresAt,
    });

    await enqueueEvent(tx, {
      eventType: 'REQUEST_CREATED',
      aggregateType: 'money_request',
      aggregateId: created.id,
      payload: {
        requestId: created.id,
        requesterUserId,
        requesterName: requester.name,
        payerUserId: payer.userId,
        amountMinor: created.amountMinor.toString(),
        note: created.note,
      },
    });

    await insertAuditLog(tx, {
      actorUserId: requesterUserId,
      action: 'REQUEST_CREATED',
      entityType: 'money_request',
      entityId: created.id,
      metadata: { payerUserId: payer.userId, amountMinor: created.amountMinor.toString() },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    const body = {
      request: toDTO(created, requesterUserId, { name: payer.name, phone: payer.phone }),
    };
    await completeIdempotencyKey(tx, claim.id, 201, body);

    return { status: 201, body, replayed: false };
  });
}

// ---------------------------------------------------------------------------
// Accept — state change and payment, atomically
// ---------------------------------------------------------------------------

export interface AcceptResult {
  request: MoneyRequestDTO;
  transfer: { reference: string; amount: ReturnType<typeof money>; createdAt: string };
  balance: ReturnType<typeof money>;
}

export async function acceptRequest(
  payerUserId: string,
  requestId: string,
  idempotencyKey: string,
  pin: string,
  rawBody: unknown,
  context: RequestContext,
): Promise<{ status: number; body: AcceptResult; replayed: boolean }> {
  await verifyPin(payerUserId, pin);

  const requestHash = hashRequest(`${ACCEPT_ENDPOINT}:${requestId}`, rawBody);

  return withTransaction(async (tx) => {
    const claim = await claimIdempotencyKey(tx, {
      userId: payerUserId,
      key: idempotencyKey,
      endpoint: `${ACCEPT_ENDPOINT}:${requestId}`,
      requestHash,
    });
    if (claim.kind === 'mismatch') throw errors.idempotencyKeyReuse();
    if (claim.kind === 'replay') {
      return { status: claim.status, body: claim.body as AcceptResult, replayed: true };
    }

    // Locked and validated in one statement. A second accept arriving concurrently blocks here,
    // then re-evaluates the predicate against the committed row and finds nothing to settle.
    const request = await repo.lockSettleableRequest(tx, requestId, payerUserId);
    if (!request) throw await explainUnsettleable(tx, requestId, payerUserId);

    const payerAccountId = await transferRepo.findAccountIdForUser(tx, payerUserId);
    const requesterAccountId = await transferRepo.findAccountIdForUser(tx, request.requesterUserId);
    if (!payerAccountId || !requesterAccountId) throw errors.notFound('Account');

    // Daily limit applies to settlements too — a request is not a way around a sending cap.
    const spent = await transferRepo.outboundInWindow(tx, payerAccountId);
    const dailyLimit = BigInt(config.DAILY_TRANSFER_LIMIT_MINOR);
    if (spent + request.amountMinor > dailyLimit) {
      throw errors.limitExceeded('Settling this request would exceed your daily sending limit', {
        dailyLimitMinor: dailyLimit.toString(),
        alreadySentMinor: spent.toString(),
      });
    }

    const posted = await postDoubleEntry(tx, {
      fromAccountId: payerAccountId,
      toAccountId: requesterAccountId,
      amountMinor: request.amountMinor,
      type: 'REQUEST_SETTLEMENT',
      note: request.note,
      idempotencyKeyId: claim.id,
    });

    // Belt and braces: the row is already locked, so this must succeed. If it ever returns 0 the
    // state machine has been violated and the transaction must not commit.
    const accepted = await repo.markAccepted(tx, request.id, posted.id);
    if (!accepted) throw errors.invalidState('Request was modified concurrently');

    const requester = await findUserById(request.requesterUserId, tx);

    await enqueueEvent(tx, {
      eventType: 'REQUEST_ACCEPTED',
      aggregateType: 'money_request',
      aggregateId: request.id,
      payload: {
        requestId: request.id,
        requesterUserId: request.requesterUserId,
        payerUserId,
        amountMinor: request.amountMinor.toString(),
        transferReference: posted.reference,
      },
    });

    await trackWrite(tx, payerUserId, request.requesterUserId);

    await insertAuditLog(tx, {
      actorUserId: payerUserId,
      action: 'REQUEST_ACCEPTED',
      entityType: 'money_request',
      entityId: request.id,
      metadata: { transferReference: posted.reference },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    const body: AcceptResult = {
      request: toDTO(
        { ...request, status: 'ACCEPTED', settledTransferId: posted.id },
        payerUserId,
        { name: requester?.name ?? 'Unknown', phone: requester?.phone ?? '' },
        posted.reference,
      ),
      transfer: {
        reference: posted.reference,
        amount: money(posted.amountMinor),
        createdAt: posted.createdAt.toISOString(),
      },
      balance: money(posted.senderBalanceAfter),
    };

    await completeIdempotencyKey(tx, claim.id, 200, body);
    return { status: 200, body, replayed: false };
  });
}

/**
 * Turn "the guarded update matched nothing" into an error a human can act on. Called only on
 * the failure path, so the extra read costs nothing in the common case.
 */
async function explainUnsettleable(tx: Tx, requestId: string, payerUserId: string) {
  const request = await repo.findRequest(tx, requestId);
  if (!request) return errors.notFound('Money request');
  if (request.payerUserId !== payerUserId) {
    // Do not confirm the request exists to someone it does not concern.
    return errors.notFound('Money request');
  }
  if (request.status !== 'PENDING') {
    return errors.invalidState(`This request is already ${request.status.toLowerCase()}`, {
      status: request.status,
    });
  }
  return errors.invalidState('This request has expired', { status: 'EXPIRED' });
}

// ---------------------------------------------------------------------------
// Decline / cancel
// ---------------------------------------------------------------------------

async function terminate(
  actorUserId: string,
  requestId: string,
  to: 'DECLINED' | 'CANCELLED',
  reason: string | null,
  context: RequestContext,
): Promise<MoneyRequestDTO> {
  const actorColumn = to === 'DECLINED' ? 'payer_user_id' : 'requester_user_id';
  const eventType = to === 'DECLINED' ? 'REQUEST_DECLINED' : 'REQUEST_CANCELLED';

  return withTransaction(async (tx) => {
    const updated = await repo.transition(tx, {
      id: requestId,
      to,
      actorColumn,
      actorUserId,
      reason,
    });

    if (!updated) {
      const existing = await repo.findRequest(tx, requestId);
      if (!existing) throw errors.notFound('Money request');
      const isActor =
        to === 'DECLINED'
          ? existing.payerUserId === actorUserId
          : existing.requesterUserId === actorUserId;
      if (!isActor) throw errors.notFound('Money request');

      // Repeating an action that already happened is success, not an error: a client retrying
      // after a timeout should not be told something went wrong when it did not.
      if (existing.status === to) {
        const other = await findUserById(
          to === 'DECLINED' ? existing.requesterUserId : existing.payerUserId,
          tx,
        );
        return toDTO(existing, actorUserId, {
          name: other?.name ?? 'Unknown',
          phone: other?.phone ?? '',
        });
      }
      throw errors.invalidState(`This request is already ${existing.status.toLowerCase()}`, {
        status: existing.status,
      });
    }

    const counterpartyId = to === 'DECLINED' ? updated.requesterUserId : updated.payerUserId;
    const counterparty = await findUserById(counterpartyId, tx);

    await enqueueEvent(tx, {
      eventType,
      aggregateType: 'money_request',
      aggregateId: updated.id,
      payload: {
        requestId: updated.id,
        requesterUserId: updated.requesterUserId,
        payerUserId: updated.payerUserId,
        amountMinor: updated.amountMinor.toString(),
        reason,
      },
    });

    await insertAuditLog(tx, {
      actorUserId,
      action: eventType,
      entityType: 'money_request',
      entityId: updated.id,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return toDTO(updated, actorUserId, {
      name: counterparty?.name ?? 'Unknown',
      phone: counterparty?.phone ?? '',
    });
  });
}

export const declineRequest = (
  payerUserId: string,
  requestId: string,
  reason: string | null,
  context: RequestContext,
) => terminate(payerUserId, requestId, 'DECLINED', reason, context);

export const cancelRequest = (
  requesterUserId: string,
  requestId: string,
  context: RequestContext,
) => terminate(requesterUserId, requestId, 'CANCELLED', null, context);

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listRequests(
  userId: string,
  queryInput: ListRequestsQuery,
): Promise<Page<MoneyRequestDTO & { createdAt: string }>> {
  const cursor = decodeCursor(queryInput.cursor);

  const rows = await withTransaction(
    (tx) =>
      repo.listRequests(tx, {
        userId,
        role: queryInput.role,
        status: queryInput.status,
        // One extra row is the existence proof for the next page.
        limit: queryInput.limit + 1,
        cursor,
      }),
    { readOnly: true, maxAttempts: 1 },
  );

  const page = toPage(rows, queryInput.limit);
  return {
    items: page.items.map((row) => ({
      ...toDTO(
        row,
        userId,
        { name: row.counterpartyName, phone: row.counterpartyPhone },
        row.settledReference,
      ),
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
}
