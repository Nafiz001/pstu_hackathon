/**
 * Split bill — "I paid for dinner; everyone owes me their share".
 *
 * Two properties make this more than a loop over `createRequest`:
 *
 * 1. **The shares sum to exactly the total.** BDT 100 between three is not 33.33 each; the
 *    missing poisha is somebody's money. `shared/allocate.ts` does the arithmetic in integers and
 *    hands out the remainder, and the invariant is asserted here before anything is written.
 *
 * 2. **A split is all-or-nothing.** One unknown phone number, one frozen account, and NOTHING is
 *    created — not four requests and an error. Half a split is worse than no split: the creator
 *    has no way to tell which legs exist, and the people who did get a request are being asked to
 *    pay their share of a bill that was never really raised.
 *
 * After creation each leg is an ordinary money request. Accepting one settles through exactly the
 * same path, with the same locking and the same double entry, as any other request.
 */
import { config } from '../../config/index.js';
import { withTransaction, type Tx } from '../../platform/db/transaction.js';
import { DomainError, errors } from '../../platform/errors/index.js';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  hashRequest,
} from '../../platform/idempotency/store.js';
import { enqueueEvent } from '../../platform/outbox/index.js';
import { allocateByWeight, allocateEvenly } from '../../shared/allocate.js';
import { money } from '../../shared/money.js';
import { findUserById, insertAuditLog } from '../auth/auth.repo.js';
import * as requestRepo from '../requests/request.repo.js';
import type { RequestContext } from '../requests/request.service.js';
import * as transferRepo from '../transfers/transfer.repo.js';
import * as repo from './split.repo.js';
import type { CreateSplitInput } from './split.schemas.js';

const CREATE_ENDPOINT = 'POST /api/v1/splits';

export interface SplitLegDTO {
  requestId: string;
  payer: { name: string; phone: string };
  amount: ReturnType<typeof money>;
  status: requestRepo.RequestStatus;
  settledReference: string | null;
}

export interface SplitDTO {
  id: string;
  description: string;
  total: ReturnType<typeof money>;
  /** The creator's own share: part of the total, but never requested from anyone. */
  yourShare: ReturnType<typeof money>;
  requested: ReturnType<typeof money>;
  collected: ReturnType<typeof money>;
  outstanding: ReturnType<typeof money>;
  participantCount: number;
  createdAt: string;
  legs: SplitLegDTO[];
}

function legDTO(leg: repo.SplitLeg): SplitLegDTO {
  return {
    requestId: leg.requestId,
    payer: { name: leg.payerName, phone: leg.payerPhone },
    amount: money(leg.amountMinor),
    status: leg.status,
    settledReference: leg.settledReference,
  };
}

function splitDTO(split: repo.BillSplit, legs: repo.SplitLeg[]): SplitDTO {
  const requested = legs.reduce((sum, leg) => sum + leg.amountMinor, 0n);
  const collected = legs
    .filter((leg) => leg.status === 'ACCEPTED')
    .reduce((sum, leg) => sum + leg.amountMinor, 0n);

  return {
    id: split.id,
    description: split.description,
    total: money(split.totalAmountMinor),
    yourShare: money(split.totalAmountMinor - requested),
    requested: money(requested),
    collected: money(collected),
    outstanding: money(requested - collected),
    participantCount: split.participantCount,
    createdAt: split.createdAt.toISOString(),
    legs: legs.map(legDTO),
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createSplit(
  creatorUserId: string,
  idempotencyKey: string,
  input: CreateSplitInput,
  rawBody: unknown,
  context: RequestContext,
): Promise<{ status: number; body: { split: SplitDTO }; replayed: boolean }> {
  const shares = allocate(input);
  const legShares = input.includeSelf ? shares.slice(1) : shares;

  // The invariant this whole feature exists to uphold, checked before a single row is written.
  const allocated = shares.reduce((sum, share) => sum + share, 0n);
  if (allocated !== input.totalAmountMinor) {
    // Unreachable unless allocate.ts is broken; asserting it here means a bug becomes a refused
    // request instead of a split whose legs quietly do not add up to the bill.
    throw new DomainError('INTERNAL', 'Split allocation did not sum to the total');
  }

  const minimum = BigInt(config.MIN_TRANSFER_MINOR);
  if (legShares.some((share) => share < minimum)) {
    throw errors.validation(
      `Each share must be at least ${money(minimum).formatted} BDT — split a larger amount, or between fewer people`,
    );
  }

  const requestHash = hashRequest(CREATE_ENDPOINT, rawBody);

  return withTransaction(async (tx) => {
    const claim = await claimIdempotencyKey(tx, {
      userId: creatorUserId,
      key: idempotencyKey,
      endpoint: CREATE_ENDPOINT,
      requestHash,
    });
    if (claim.kind === 'mismatch') throw errors.idempotencyKeyReuse();
    if (claim.kind === 'replay') {
      return { status: claim.status, body: claim.body as { split: SplitDTO }, replayed: true };
    }

    const creator = await findUserById(creatorUserId, tx);
    if (!creator) throw errors.notFound('User');

    // Resolve everyone FIRST. One unknown number and the whole transaction rolls back, so a
    // split is never half-created.
    const payers = [];
    for (const participant of input.participants) {
      const payer = await transferRepo.findPayeeByPhone(tx, participant.phone);
      if (!payer || payer.userStatus !== 'ACTIVE') {
        throw errors.notFound(`User ${participant.phone}`);
      }
      if (payer.userId === creatorUserId) {
        throw errors.validation('You cannot request your own share — use includeSelf instead');
      }
      payers.push(payer);
    }

    const split = await repo.insertSplit(tx, {
      creatorUserId,
      totalAmountMinor: input.totalAmountMinor,
      description: input.description,
      participantCount: input.participants.length + (input.includeSelf ? 1 : 0),
    });

    const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
    const legs: repo.SplitLeg[] = [];

    for (const [index, payer] of payers.entries()) {
      const amountMinor = legShares[index]!;
      const created = await requestRepo.insertRequest(tx, {
        requesterUserId: creatorUserId,
        payerUserId: payer.userId,
        amountMinor,
        note: input.description,
        expiresAt,
        splitId: split.id,
      });

      // The same event an ordinary request emits, so a leg is indistinguishable from any other
      // request to everything downstream.
      await enqueueEvent(tx, {
        eventType: 'REQUEST_CREATED',
        aggregateType: 'money_request',
        aggregateId: created.id,
        payload: {
          requestId: created.id,
          requesterUserId: creatorUserId,
          requesterName: creator.name,
          payerUserId: payer.userId,
          amountMinor: amountMinor.toString(),
          note: input.description,
          splitId: split.id,
        },
      });

      legs.push({
        requestId: created.id,
        payerUserId: payer.userId,
        payerName: payer.name,
        payerPhone: payer.phone,
        amountMinor,
        status: 'PENDING',
        settledReference: null,
      });
    }

    await insertAuditLog(tx, {
      actorUserId: creatorUserId,
      action: 'SPLIT_CREATED',
      entityType: 'bill_split',
      entityId: split.id,
      metadata: {
        totalAmountMinor: input.totalAmountMinor.toString(),
        participantCount: split.participantCount,
      },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    const body = { split: splitDTO(split, legs) };
    await completeIdempotencyKey(tx, claim.id, 201, body);
    return { status: 201, body, replayed: false };
  });
}

/**
 * Work out each person's share.
 *
 * When the creator's own share is included it is the FIRST element, so the leg shares line up
 * with the participant list by index and the remainder poisha do not silently land on whoever
 * happens to be sorted first.
 */
function allocate(input: CreateSplitInput): bigint[] {
  const weighted = input.participants.every((participant) => participant.weight !== undefined);

  if (weighted) {
    const weights = input.participants.map((participant) => BigInt(participant.weight!));
    return allocateByWeight(
      input.totalAmountMinor,
      input.includeSelf ? [BigInt(input.selfWeight), ...weights] : weights,
    );
  }

  return allocateEvenly(
    input.totalAmountMinor,
    input.participants.length + (input.includeSelf ? 1 : 0),
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Visible to the creator and to anyone who was asked to pay a share of it. */
export async function getSplit(viewerUserId: string, splitId: string): Promise<SplitDTO> {
  return withTransaction(
    async (tx) => {
      const split = await repo.findSplit(tx, splitId);
      if (!split) throw errors.notFound('Split');

      const legs = await repo.listLegs(tx, splitId);
      const involved =
        split.creatorUserId === viewerUserId ||
        legs.some((leg) => leg.payerUserId === viewerUserId);
      if (!involved) throw errors.notFound('Split');

      return splitDTO(split, legs);
    },
    { readOnly: true, maxAttempts: 1 },
  );
}

export interface SplitSummaryDTO {
  id: string;
  description: string;
  total: ReturnType<typeof money>;
  collected: ReturnType<typeof money>;
  outstanding: ReturnType<typeof money>;
  settledCount: number;
  legCount: number;
  createdAt: string;
}

export async function listSplits(
  creatorUserId: string,
  limit: number,
): Promise<{ items: SplitSummaryDTO[] }> {
  const rows = await withTransaction((tx: Tx) => repo.listSplits(tx, creatorUserId, limit), {
    readOnly: true,
    maxAttempts: 1,
  });

  return {
    items: rows.map((row) => ({
      id: row.id,
      description: row.description,
      total: money(row.totalAmountMinor),
      collected: money(row.collectedMinor),
      outstanding: money(row.outstandingMinor),
      settledCount: row.settledCount,
      legCount: row.legCount,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
