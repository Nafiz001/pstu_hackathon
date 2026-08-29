/**
 * Scheduled and recurring transfers — "pay my landlord on the 1st, every month".
 *
 * The API surface here only ever writes *intent*. No money moves on any of these paths; a
 * schedule is a durable instruction, and `workers/schedule.worker.ts` is the only thing that acts
 * on it. Keeping the two apart is what makes the hard part testable: the worker can be run by
 * hand, one tick at a time, against a database in any state.
 *
 * Creating a schedule still requires the PIN. It authorises payments that will happen when the
 * user is not present to authorise them, which deserves at least as much friction as one transfer
 * they can see the result of immediately.
 */
import { config } from '../../config/index.js';
import { withTransaction, type Tx } from '../../platform/db/transaction.js';
import { errors } from '../../platform/errors/index.js';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  hashRequest,
} from '../../platform/idempotency/store.js';
import { decodeCursor, toPage, type Page } from '../../shared/cursor.js';
import { money } from '../../shared/money.js';
import { findUserById, insertAuditLog } from '../auth/auth.repo.js';
import { verifyPin } from '../auth/pin.service.js';
import * as transferRepo from '../transfers/transfer.repo.js';
import * as repo from './schedule.repo.js';
import type { CreateScheduleInput, ListSchedulesQuery } from './schedule.schemas.js';
import type { RequestContext } from '../requests/request.service.js';

const CREATE_ENDPOINT = 'POST /api/v1/schedules';

/** A start time in the past would fire immediately, which is never what someone meant to ask for. */
const MIN_LEAD_MS = 0;

export interface ScheduleDTO {
  id: string;
  status: repo.ScheduleStatus;
  intervalKind: repo.IntervalKind;
  amount: ReturnType<typeof money>;
  note: string | null;
  payee: { name: string; phone: string };
  nextRunAt: string | null;
  remainingRuns: number | null;
  lastRunAt: string | null;
  createdAt: string;
}

function toDTO(schedule: repo.Schedule, payee: { name: string; phone: string }): ScheduleDTO {
  return {
    id: schedule.id,
    status: schedule.status,
    intervalKind: schedule.intervalKind,
    amount: money(schedule.amountMinor),
    note: schedule.note,
    payee,
    // A finished schedule has a next_run_at, but it means nothing; reporting it would be a lie.
    nextRunAt:
      schedule.status === 'ACTIVE' || schedule.status === 'PAUSED'
        ? schedule.nextRunAt.toISOString()
        : null,
    remainingRuns: schedule.remainingRuns,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    createdAt: schedule.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createSchedule(
  ownerUserId: string,
  idempotencyKey: string,
  input: CreateScheduleInput,
  rawBody: unknown,
  context: RequestContext,
): Promise<{ status: number; body: { schedule: ScheduleDTO }; replayed: boolean }> {
  await verifyPin(ownerUserId, input.pin);

  if (input.amountMinor < BigInt(config.MIN_TRANSFER_MINOR)) {
    throw errors.validation(
      `Minimum scheduled amount is ${money(BigInt(config.MIN_TRANSFER_MINOR)).formatted} BDT`,
    );
  }
  if (input.amountMinor > BigInt(config.MAX_TRANSFER_MINOR)) {
    throw errors.limitExceeded(
      `Maximum scheduled amount is ${money(BigInt(config.MAX_TRANSFER_MINOR)).formatted} BDT`,
    );
  }
  if (input.startAt.getTime() < Date.now() - MIN_LEAD_MS) {
    throw errors.validation('A schedule cannot start in the past');
  }

  // Hash the body as the client sent it, exactly like every other idempotent endpoint. Hashing
  // the *parsed* input instead would be hashing bigints and Dates, and two clients sending the
  // same JSON must produce the same hash.
  const requestHash = hashRequest(CREATE_ENDPOINT, rawBody);

  return withTransaction(async (tx) => {
    const claim = await claimIdempotencyKey(tx, {
      userId: ownerUserId,
      key: idempotencyKey,
      endpoint: CREATE_ENDPOINT,
      requestHash,
    });
    if (claim.kind === 'mismatch') throw errors.idempotencyKeyReuse();
    if (claim.kind === 'replay') {
      return {
        status: claim.status,
        body: claim.body as { schedule: ScheduleDTO },
        replayed: true,
      };
    }

    const payee = await transferRepo.findPayeeByPhone(tx, input.toPhone);
    if (!payee || payee.userStatus !== 'ACTIVE') throw errors.notFound('User');
    if (payee.userId === ownerUserId) throw errors.selfTransfer();

    const created = await repo.insertSchedule(tx, {
      ownerUserId,
      payeeUserId: payee.userId,
      amountMinor: input.amountMinor,
      note: input.note ?? null,
      intervalKind: input.intervalKind,
      startAt: input.startAt,
      remainingRuns: input.intervalKind === 'ONCE' ? 1 : (input.totalRuns ?? null),
    });

    await insertAuditLog(tx, {
      actorUserId: ownerUserId,
      action: 'SCHEDULE_CREATED',
      entityType: 'scheduled_transfer',
      entityId: created.id,
      metadata: {
        payeeUserId: payee.userId,
        amountMinor: created.amountMinor.toString(),
        intervalKind: created.intervalKind,
        startAt: created.nextRunAt.toISOString(),
      },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    const body = { schedule: toDTO(created, { name: payee.name, phone: payee.phone }) };
    await completeIdempotencyKey(tx, claim.id, 201, body);
    return { status: 201, body, replayed: false };
  });
}

// ---------------------------------------------------------------------------
// Owner transitions
// ---------------------------------------------------------------------------

const LEGAL_FROM: Record<'PAUSED' | 'ACTIVE' | 'CANCELLED', repo.ScheduleStatus[]> = {
  PAUSED: ['ACTIVE'],
  ACTIVE: ['PAUSED'],
  // Cancelling is allowed from either live state, and is idempotent below.
  CANCELLED: ['ACTIVE', 'PAUSED'],
};

async function transition(
  ownerUserId: string,
  scheduleId: string,
  to: 'PAUSED' | 'ACTIVE' | 'CANCELLED',
  context: RequestContext,
): Promise<ScheduleDTO> {
  return withTransaction(async (tx) => {
    const updated = await repo.transitionSchedule(tx, {
      id: scheduleId,
      ownerUserId,
      to,
      from: LEGAL_FROM[to],
    });

    if (!updated) {
      const existing = await repo.findSchedule(tx, scheduleId);
      // Do not confirm that someone else's schedule exists.
      if (!existing || existing.ownerUserId !== ownerUserId) throw errors.notFound('Schedule');

      // Asking for the state it is already in is success. A client retrying after a timeout
      // should not be told something went wrong when nothing did.
      if (existing.status === to) {
        return toDTO(existing, await payeeOf(tx, existing.payeeUserId));
      }
      throw errors.invalidState(`This schedule is ${existing.status.toLowerCase()}`, {
        status: existing.status,
      });
    }

    await insertAuditLog(tx, {
      actorUserId: ownerUserId,
      action: `SCHEDULE_${to}`,
      entityType: 'scheduled_transfer',
      entityId: updated.id,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return toDTO(updated, await payeeOf(tx, updated.payeeUserId));
  });
}

export const pauseSchedule = (ownerUserId: string, id: string, context: RequestContext) =>
  transition(ownerUserId, id, 'PAUSED', context);

export const resumeSchedule = (ownerUserId: string, id: string, context: RequestContext) =>
  transition(ownerUserId, id, 'ACTIVE', context);

export const cancelSchedule = (ownerUserId: string, id: string, context: RequestContext) =>
  transition(ownerUserId, id, 'CANCELLED', context);

async function payeeOf(tx: Tx, payeeUserId: string): Promise<{ name: string; phone: string }> {
  const user = await findUserById(payeeUserId, tx);
  return { name: user?.name ?? 'Unknown', phone: user?.phone ?? '' };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listSchedules(
  ownerUserId: string,
  query: ListSchedulesQuery,
): Promise<Page<ScheduleDTO>> {
  const cursor = decodeCursor(query.cursor);

  const rows = await withTransaction(
    (tx) =>
      repo.listSchedules(tx, {
        ownerUserId,
        status: query.status,
        // One extra row is the existence proof for the next page.
        limit: query.limit + 1,
        cursor,
      }),
    { readOnly: true, maxAttempts: 1 },
  );

  const page = toPage(rows, query.limit);
  return {
    items: page.items.map((row) => toDTO(row, { name: row.payeeName, phone: row.payeePhone })),
    nextCursor: page.nextCursor,
  };
}

export interface ScheduleDetail {
  schedule: ScheduleDTO;
  occurrences: Array<{
    dueAt: string;
    status: repo.OccurrenceStatus;
    attempts: number;
    failureReason: string | null;
    transferReference: string | null;
  }>;
}

/**
 * One schedule with its recent occurrences — the answer to "did my rent actually go out?", which
 * is the only question a user ever asks about a schedule.
 */
export async function getSchedule(ownerUserId: string, id: string): Promise<ScheduleDetail> {
  return withTransaction(
    async (tx) => {
      const schedule = await repo.findSchedule(tx, id);
      if (!schedule || schedule.ownerUserId !== ownerUserId) throw errors.notFound('Schedule');

      // Sequential on purpose: both statements share one connection, and a transaction is not a
      // place to invite queue-order surprises for the sake of a millisecond.
      const occurrences = await repo.listOccurrences(tx, id, 20);
      const payee = await payeeOf(tx, schedule.payeeUserId);

      return {
        schedule: toDTO(schedule, payee),
        occurrences: occurrences.map((occurrence) => ({
          dueAt: occurrence.dueAt.toISOString(),
          status: occurrence.status,
          attempts: occurrence.attempts,
          failureReason: occurrence.failureReason,
          transferReference: occurrence.transferReference,
        })),
      };
    },
    { readOnly: true, maxAttempts: 1 },
  );
}
