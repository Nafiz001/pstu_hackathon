/**
 * Scheduled-transfer persistence.
 *
 * Two ideas carry the whole design:
 *
 * 1. **Claiming is a guarded, locking statement.** A schedule is picked up with
 *    `FOR UPDATE SKIP LOCKED` and a predicate that repeats every precondition (`ACTIVE`, due
 *    now). Every API replica runs the scheduler, so two of them will regularly reach for the same
 *    row at the same instant; one takes it, the other is handed nothing and moves on. No leader
 *    election, no lock service, no "run this on box 1 only" deployment note.
 *
 * 2. **An occurrence is identified deterministically, not randomly.** `occurrence_key` is
 *    `schedule_id + the instant it was due`, so a retry, a duplicate tick, and a second replica
 *    all compute the same key. The UNIQUE constraint on it is the last line of defence against
 *    paying twice, and it is enforced by the database rather than by careful code.
 */
import type { Tx } from '../../platform/db/transaction.js';
import type { Cursor } from '../../shared/cursor.js';
import { toMinor } from '../../shared/money.js';
import { asPgTimestamp, type PgTimestamp } from '../../shared/timestamp.js';

export type ScheduleStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
export type IntervalKind = 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type OccurrenceStatus = 'PENDING' | 'PAID' | 'FAILED' | 'SKIPPED';

/**
 * Calendar arithmetic belongs in the database, not in JavaScript: `+ interval '1 month'` on
 * 31 January lands on 28 February, and adding "a day" across a DST boundary stays the same
 * wall-clock time. Interpolated, not parameterised, because an interval literal is not a value
 * Postgres will accept as a placeholder — and it is safe because the only possible values are
 * the keys of this object.
 */
const STEP: Record<Exclude<IntervalKind, 'ONCE'>, string> = {
  DAILY: '1 day',
  WEEKLY: '7 days',
  MONTHLY: '1 month',
};

interface ScheduleRow {
  id: string;
  owner_user_id: string;
  payee_user_id: string;
  amount_minor: string;
  note: string | null;
  interval_kind: IntervalKind;
  next_run_at: Date;
  next_run_at_raw: string;
  remaining_runs: number | null;
  status: ScheduleStatus;
  last_run_at: Date | null;
  created_at: Date;
  created_at_raw: string;
}

export interface Schedule {
  id: string;
  ownerUserId: string;
  payeeUserId: string;
  amountMinor: bigint;
  note: string | null;
  intervalKind: IntervalKind;
  nextRunAt: Date;
  /** Full precision — this is what the occurrence key is built from. See shared/timestamp.ts. */
  nextRunAtRaw: PgTimestamp;
  remainingRuns: number | null;
  status: ScheduleStatus;
  lastRunAt: Date | null;
  createdAt: Date;
  createdAtRaw: PgTimestamp;
}

const COLUMNS = 's.*, s.next_run_at::text AS next_run_at_raw, s.created_at::text AS created_at_raw';

const mapSchedule = (row: ScheduleRow): Schedule => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  payeeUserId: row.payee_user_id,
  amountMinor: toMinor(row.amount_minor),
  note: row.note,
  intervalKind: row.interval_kind,
  nextRunAt: row.next_run_at,
  nextRunAtRaw: asPgTimestamp(row.next_run_at_raw),
  remainingRuns: row.remaining_runs,
  status: row.status,
  lastRunAt: row.last_run_at,
  createdAt: row.created_at,
  createdAtRaw: asPgTimestamp(row.created_at_raw),
});

export async function insertSchedule(
  tx: Tx,
  input: {
    ownerUserId: string;
    payeeUserId: string;
    amountMinor: bigint;
    note: string | null;
    intervalKind: IntervalKind;
    startAt: Date;
    remainingRuns: number | null;
  },
): Promise<Schedule> {
  const { rows } = await tx.query<ScheduleRow>(
    `WITH inserted AS (
       INSERT INTO scheduled_transfers
         (owner_user_id, payee_user_id, amount_minor, note, interval_kind, next_run_at, remaining_runs)
       VALUES ($1, $2, $3::bigint, $4, $5::schedule_interval, $6::timestamptz, $7)
       RETURNING *
     )
     SELECT ${COLUMNS} FROM inserted s`,
    [
      input.ownerUserId,
      input.payeeUserId,
      input.amountMinor.toString(),
      input.note,
      input.intervalKind,
      input.startAt,
      input.remainingRuns,
    ],
  );
  return mapSchedule(rows[0]!);
}

export async function findSchedule(tx: Tx, id: string): Promise<Schedule | null> {
  const { rows } = await tx.query<ScheduleRow>(
    `SELECT ${COLUMNS} FROM scheduled_transfers s WHERE s.id = $1`,
    [id],
  );
  return rows[0] ? mapSchedule(rows[0]) : null;
}

/**
 * Find schedules that are due. Deliberately takes no locks: it is a cheap scan of the partial
 * index whose result is a *hint*. Every id it returns is re-checked under a lock by
 * `claimDueSchedule`, so a stale hint costs one wasted round trip and never a wrong payment.
 */
export async function findDueScheduleIds(tx: Tx, limit: number): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id
       FROM scheduled_transfers
      WHERE status = 'ACTIVE'
        AND next_run_at <= now()
        AND coalesce(retry_after, now()) <= now()
      ORDER BY next_run_at
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.id);
}

/**
 * Take exclusive ownership of one due schedule.
 *
 * `SKIP LOCKED` rather than a plain `FOR UPDATE`: a second replica reaching for the same row must
 * be told "nothing here" immediately and go find other work, not queue behind a payment.
 */
export async function claimDueSchedule(tx: Tx, id: string): Promise<Schedule | null> {
  const { rows } = await tx.query<ScheduleRow>(
    `SELECT ${COLUMNS}
       FROM scheduled_transfers s
      WHERE s.id = $1
        AND s.status = 'ACTIVE'
        AND s.next_run_at <= now()
        AND coalesce(s.retry_after, now()) <= now()
      FOR UPDATE SKIP LOCKED`,
    [id],
  );
  return rows[0] ? mapSchedule(rows[0]) : null;
}

export interface ClaimedOccurrence {
  id: string;
  attempts: number;
}

/**
 * Claim the occurrence about to be attempted, or discover that it is already settled.
 *
 * A row that exists and is still PENDING is a *retry* of the same occurrence: its attempt counter
 * is bumped and it is handed back. A row in any terminal state (PAID, FAILED, SKIPPED) returns
 * nothing at all, which is what stops a duplicate tick, a restarted process, or a second replica
 * from paying an occurrence that has already been dealt with.
 */
export async function claimOccurrence(
  tx: Tx,
  input: { scheduleId: string; occurrenceKey: string; dueAt: PgTimestamp },
): Promise<ClaimedOccurrence | null> {
  const { rows } = await tx.query<{ id: string; attempts: number }>(
    `INSERT INTO schedule_occurrences (schedule_id, occurrence_key, due_at, attempts)
     VALUES ($1, $2, $3::timestamptz, 1)
     ON CONFLICT (occurrence_key) DO UPDATE
        SET attempts = schedule_occurrences.attempts + 1
      WHERE schedule_occurrences.status = 'PENDING'
     RETURNING id, attempts`,
    [input.scheduleId, input.occurrenceKey, input.dueAt],
  );
  return rows[0] ?? null;
}

export async function settleOccurrence(
  tx: Tx,
  input: {
    id: string;
    status: Exclude<OccurrenceStatus, 'PENDING'>;
    transferId?: string | null;
    failureReason?: string | null;
  },
): Promise<void> {
  await tx.query(
    `UPDATE schedule_occurrences
        SET status = $2::occurrence_status,
            transfer_id = $3,
            failure_reason = left($4, 500),
            completed_at = now()
      WHERE id = $1`,
    [input.id, input.status, input.transferId ?? null, input.failureReason ?? null],
  );
}

/**
 * Move a schedule on to its next occurrence.
 *
 * The next run is computed from the occurrence that just ran, not from `now()`: a payment that
 * fires four minutes late must not shift every future payment four minutes later, and a monthly
 * rent transfer must stay on its day of the month.
 *
 * `consumeRun` is false when the occurrence was skipped rather than paid — a user who asked for
 * five payments is owed five payments, not five attempts.
 */
export async function advanceSchedule(
  tx: Tx,
  input: { id: string; intervalKind: IntervalKind; consumeRun: boolean },
): Promise<void> {
  if (input.intervalKind === 'ONCE') {
    await tx.query(
      `UPDATE scheduled_transfers
          SET status = 'COMPLETED', remaining_runs = 0, last_run_at = now(),
              retry_after = NULL, updated_at = now()
        WHERE id = $1`,
      [input.id],
    );
    return;
  }

  // One statement, so "is this the last run?" and "when is the next one?" cannot disagree.
  await tx.query(
    `UPDATE scheduled_transfers
        SET remaining_runs = CASE
              WHEN remaining_runs IS NULL THEN NULL
              WHEN $2::boolean THEN greatest(remaining_runs - 1, 0)
              ELSE remaining_runs
            END,
            next_run_at = next_run_at + interval '${STEP[input.intervalKind]}',
            -- A new occurrence starts with a clean slate: the previous one's backoff must not
            -- delay it.
            retry_after = NULL,
            last_run_at = now(),
            status = CASE
              WHEN remaining_runs IS NOT NULL
               AND (CASE WHEN $2::boolean THEN remaining_runs - 1 ELSE remaining_runs END) <= 0
              THEN 'COMPLETED'::schedule_status
              ELSE status
            END,
            updated_at = now()
      WHERE id = $1`,
    [input.id, input.consumeRun],
  );
}

/**
 * Come back to the SAME occurrence later.
 *
 * `next_run_at` is deliberately untouched: it is the occurrence's identity, and the occurrence
 * key is derived from it. Moving it would give the retry a new identity, which would defeat the
 * only mechanism stopping a retry from becoming a second payment — and would let a payment that
 * can never succeed retry forever, each time as a fresh occurrence. See migration 009.
 */
export async function deferSchedule(tx: Tx, id: string, delaySeconds: number): Promise<void> {
  await tx.query(
    `UPDATE scheduled_transfers
        SET retry_after = now() + ($2 || ' seconds')::interval, updated_at = now()
      WHERE id = $1`,
    [id, String(delaySeconds)],
  );
}

/**
 * Owner-driven transitions. The WHERE clause carries the precondition, so a pause racing a
 * cancel is resolved by the database and the loser simply matches no row.
 */
export async function transitionSchedule(
  tx: Tx,
  input: { id: string; ownerUserId: string; to: ScheduleStatus; from: ScheduleStatus[] },
): Promise<Schedule | null> {
  const { rows } = await tx.query<ScheduleRow>(
    `WITH updated AS (
       UPDATE scheduled_transfers
          SET status = $3::schedule_status,
              updated_at = now(),
              -- Resuming a schedule whose time passed while it was paused must not fire a burst
              -- of back-dated payments; it simply starts again from now.
              next_run_at = CASE
                WHEN $3 = 'ACTIVE' AND next_run_at < now() THEN now()
                ELSE next_run_at
              END,
              retry_after = CASE WHEN $3 = 'ACTIVE' THEN NULL ELSE retry_after END
        WHERE id = $1
          AND owner_user_id = $2
          AND status = ANY($4::schedule_status[])
        RETURNING *
     )
     SELECT ${COLUMNS} FROM updated s`,
    [input.id, input.ownerUserId, input.to, input.from],
  );
  return rows[0] ? mapSchedule(rows[0]) : null;
}

export interface ScheduleListItem extends Schedule {
  payeeName: string;
  payeePhone: string;
}

export async function listSchedules(
  tx: Tx,
  input: { ownerUserId: string; status?: ScheduleStatus; limit: number; cursor?: Cursor },
): Promise<ScheduleListItem[]> {
  const params: unknown[] = [input.ownerUserId, input.limit];
  let filter = '';

  if (input.status) {
    params.push(input.status);
    filter += ` AND s.status = $${params.length}::schedule_status`;
  }
  if (input.cursor) {
    params.push(input.cursor.createdAt, input.cursor.id);
    filter += ` AND (s.created_at, s.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }

  const { rows } = await tx.query<ScheduleRow & { payee_name: string; payee_phone: string }>(
    `SELECT ${COLUMNS}, u.name AS payee_name, u.phone AS payee_phone
       FROM scheduled_transfers s
       JOIN users u ON u.id = s.payee_user_id
      WHERE s.owner_user_id = $1${filter}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT $2`,
    params,
  );

  return rows.map((row) => ({
    ...mapSchedule(row),
    payeeName: row.payee_name,
    payeePhone: row.payee_phone,
  }));
}

export interface OccurrenceRecord {
  id: string;
  dueAt: Date;
  status: OccurrenceStatus;
  attempts: number;
  failureReason: string | null;
  transferReference: string | null;
  completedAt: Date | null;
}

export async function listOccurrences(
  tx: Tx,
  scheduleId: string,
  limit: number,
): Promise<OccurrenceRecord[]> {
  const { rows } = await tx.query<{
    id: string;
    due_at: Date;
    status: OccurrenceStatus;
    attempts: number;
    failure_reason: string | null;
    reference: string | null;
    completed_at: Date | null;
  }>(
    `SELECT o.id, o.due_at, o.status, o.attempts, o.failure_reason, t.reference, o.completed_at
       FROM schedule_occurrences o
       LEFT JOIN transfers t ON t.id = o.transfer_id
      WHERE o.schedule_id = $1
      ORDER BY o.due_at DESC
      LIMIT $2`,
    [scheduleId, limit],
  );

  return rows.map((row) => ({
    id: row.id,
    dueAt: row.due_at,
    status: row.status,
    attempts: row.attempts,
    failureReason: row.failure_reason,
    transferReference: row.reference,
    completedAt: row.completed_at,
  }));
}
