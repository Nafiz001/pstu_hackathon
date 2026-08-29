/**
 * The scheduler — the only thing in the system that moves money without a person present.
 *
 * That makes duplicate suppression the whole design, because every ordinary safety net is
 * missing: there is no client to retry with the same idempotency key, no HTTP response anyone
 * reads, and N replicas all wake up at the same second.
 *
 * The chain of defences, outermost first:
 *
 *   1. `claimDueSchedule` locks the schedule row with FOR UPDATE SKIP LOCKED. Two replicas
 *      reaching for the same schedule: one gets it, the other is handed nothing.
 *   2. `claimOccurrence` inserts a row keyed by `schedule_id + the instant it was due`. The key
 *      is DERIVED, not generated, so a retry computes the identical key. A key that already
 *      exists in a terminal state returns nothing and no payment is attempted.
 *   3. The occurrence row and the money move in ONE transaction. There is no window in which a
 *      payment has happened but the record of it has not, so a crash at any instant leaves the
 *      pair either both present or both absent.
 *
 * Nothing here is scheduler-specific cleverness: it is the same idempotency argument the HTTP API
 * makes, with a derived key standing in for the one a client would have sent.
 */
import { config } from '../config/index.js';
import { withTransaction, withReadTransaction, type Tx } from '../platform/db/transaction.js';
import { DomainError } from '../platform/errors/index.js';
import { logger } from '../platform/logging/index.js';
import { scheduleRuns } from '../platform/metrics/index.js';
import { enqueueEvent } from '../platform/outbox/index.js';
import { postDoubleEntry } from '../modules/transfers/ledger.service.js';
import * as transferRepo from '../modules/transfers/transfer.repo.js';
import * as repo from '../modules/schedules/schedule.repo.js';

export type RunOutcome = 'paid' | 'failed' | 'deferred' | 'skipped' | 'duplicate' | 'not-claimed';

export interface ScheduleTickResult {
  claimed: number;
  paid: number;
  failed: number;
  deferred: number;
  skipped: number;
  duplicate: number;
}

const EMPTY: ScheduleTickResult = {
  claimed: 0,
  paid: 0,
  failed: 0,
  deferred: 0,
  skipped: 0,
  duplicate: 0,
};

/** Transient reasons deserve a retry; a frozen account or a closed one does not. */
const RETRYABLE_CODES = new Set(['INSUFFICIENT_FUNDS', 'LIMIT_EXCEEDED', 'SERVICE_UNAVAILABLE']);

/**
 * Run every schedule that is due.
 *
 * The due list is read WITHOUT locks and then each schedule is claimed in its own transaction.
 * The alternative — one transaction holding every claimed row while it makes N payments — would
 * hold account locks for the length of the whole batch, so one slow payment would stall every
 * unrelated user whose account happens to be in it.
 */
export async function runDueSchedules(limit = 50): Promise<ScheduleTickResult> {
  const dueIds = await withReadTransaction((tx) => repo.findDueScheduleIds(tx, limit));
  if (dueIds.length === 0) return EMPTY;

  const result: ScheduleTickResult = { ...EMPTY };

  // Sequential on purpose. Concurrency here buys nothing — the work is database-bound and every
  // payment takes row locks — and it would let one tick occupy the entire connection pool.
  for (const id of dueIds) {
    const outcome = await runSchedule(id);
    if (outcome !== 'not-claimed') result.claimed += 1;
    if (outcome === 'paid') result.paid += 1;
    if (outcome === 'failed') result.failed += 1;
    if (outcome === 'deferred') result.deferred += 1;
    if (outcome === 'skipped') result.skipped += 1;
    if (outcome === 'duplicate') result.duplicate += 1;
  }

  if (result.paid > 0 || result.failed > 0) {
    logger.info(result, 'scheduled transfers processed');
  }
  return result;
}

/**
 * One schedule, one transaction.
 *
 * Returns rather than throws for every *expected* outcome. An unexpected error is rethrown: the
 * transaction rolls back, the occurrence row disappears with it, and the next tick reaches the
 * same state and computes the same occurrence key. Failing loudly and retrying is safe precisely
 * because the key is derived rather than generated.
 */
export async function runSchedule(scheduleId: string): Promise<RunOutcome> {
  const outcome = await withTransaction<RunOutcome>(async (tx) => {
    const schedule = await repo.claimDueSchedule(tx, scheduleId);
    // Another replica has it, or it stopped being due between the read and the lock.
    if (!schedule) return 'not-claimed';

    // Derived from the timestamp Postgres itself rendered, at full microsecond precision. A key
    // built from a JS Date would truncate, and two occurrences a few hundred microseconds apart
    // would collapse into one. See shared/timestamp.ts.
    const occurrenceKey = `${schedule.id}:${schedule.nextRunAtRaw}`;

    const occurrence = await repo.claimOccurrence(tx, {
      scheduleId: schedule.id,
      occurrenceKey,
      dueAt: schedule.nextRunAtRaw,
    });

    if (!occurrence) {
      // This occurrence is already PAID, FAILED or SKIPPED. Something ran it and did not get as
      // far as advancing the schedule — a crash between the two, in an earlier design. Advance
      // it now; do not pay it again.
      await repo.advanceSchedule(tx, {
        id: schedule.id,
        intervalKind: schedule.intervalKind,
        consumeRun: false,
      });
      logger.warn({ scheduleId: schedule.id, occurrenceKey }, 'occurrence already settled');
      return 'duplicate';
    }

    /**
     * Catch-up policy: a schedule whose due time is long past is skipped, not paid.
     *
     * If the service is down from Monday to Friday, a daily standing order must not fire five
     * payments the moment it comes back. The user's expectation is "pay this on the day", and a
     * payment four days late is a surprise withdrawal, not a late one. Skips are recorded and
     * the owner is told, so nothing is silently dropped.
     */
    const lateBy = Date.now() - schedule.nextRunAt.getTime();
    if (lateBy > config.SCHEDULE_CATCHUP_GRACE_MS) {
      await repo.settleOccurrence(tx, {
        id: occurrence.id,
        status: 'SKIPPED',
        failureReason: `Missed its window by ${Math.round(lateBy / 1000)}s`,
      });
      await repo.advanceSchedule(tx, {
        id: schedule.id,
        intervalKind: schedule.intervalKind,
        consumeRun: false,
      });
      await enqueueEvent(tx, {
        eventType: 'SCHEDULE_SKIPPED',
        aggregateType: 'scheduled_transfer',
        aggregateId: schedule.id,
        payload: {
          scheduleId: schedule.id,
          ownerUserId: schedule.ownerUserId,
          amountMinor: schedule.amountMinor.toString(),
          dueAt: schedule.nextRunAt.toISOString(),
        },
      });
      scheduleRuns.inc({ outcome: 'skipped' });
      return 'skipped';
    }

    /**
     * The payment attempt is wrapped in a SAVEPOINT so a *business* failure — not enough money,
     * a frozen account — can be recorded rather than lost. Without it, the failed statement would
     * poison the transaction and the record of the failure would roll back with the failure.
     */
    await tx.query('SAVEPOINT schedule_run');
    try {
      const transfer = await pay(tx, schedule);
      await tx.query('RELEASE SAVEPOINT schedule_run');

      await repo.settleOccurrence(tx, {
        id: occurrence.id,
        status: 'PAID',
        transferId: transfer.id,
      });
      await repo.advanceSchedule(tx, {
        id: schedule.id,
        intervalKind: schedule.intervalKind,
        consumeRun: true,
      });

      // The payee is notified exactly as they would be for any other incoming payment.
      await enqueueEvent(tx, {
        eventType: 'MONEY_RECEIVED',
        aggregateType: 'transfer',
        aggregateId: transfer.id,
        payload: {
          transferId: transfer.id,
          reference: transfer.reference,
          senderUserId: schedule.ownerUserId,
          recipientUserId: schedule.payeeUserId,
          amountMinor: transfer.amountMinor.toString(),
          note: transfer.note,
        },
      });
      // ...and the owner is told their standing order went out, because a payment they did not
      // press a button for is exactly the one they want to hear about.
      await enqueueEvent(tx, {
        eventType: 'SCHEDULE_PAID',
        aggregateType: 'scheduled_transfer',
        aggregateId: schedule.id,
        payload: {
          scheduleId: schedule.id,
          ownerUserId: schedule.ownerUserId,
          amountMinor: transfer.amountMinor.toString(),
          reference: transfer.reference,
        },
      });

      scheduleRuns.inc({ outcome: 'paid' });
      return 'paid';
    } catch (error) {
      // Anything that is not a domain failure (a dead connection, a bug) leaves the transaction
      // in an unknown state. Rethrow: rollback discards the occurrence too, and the next tick
      // recomputes the same key and tries again.
      if (!(error instanceof DomainError)) throw error;

      await tx.query('ROLLBACK TO SAVEPOINT schedule_run');

      const canRetry =
        RETRYABLE_CODES.has(error.code) && occurrence.attempts < config.SCHEDULE_MAX_ATTEMPTS;

      if (canRetry) {
        // The occurrence stays PENDING and keeps its key, so the retry cannot become a second
        // payment. Someone whose salary lands at 09:00 gets their 08:00 rent paid at 08:15.
        const delaySeconds = config.SCHEDULE_RETRY_BASE_SECONDS * 2 ** (occurrence.attempts - 1);
        await repo.deferSchedule(tx, schedule.id, delaySeconds);
        scheduleRuns.inc({ outcome: 'deferred' });
        logger.warn(
          { scheduleId: schedule.id, attempt: occurrence.attempts, delaySeconds, code: error.code },
          'scheduled transfer deferred',
        );
        return 'deferred';
      }

      await repo.settleOccurrence(tx, {
        id: occurrence.id,
        status: 'FAILED',
        failureReason: error.message,
      });
      // A failed occurrence does not consume one of the runs the user paid for, and it does not
      // stop the schedule: next month's rent should still go out.
      await repo.advanceSchedule(tx, {
        id: schedule.id,
        intervalKind: schedule.intervalKind,
        consumeRun: false,
      });
      await enqueueEvent(tx, {
        eventType: 'SCHEDULE_FAILED',
        aggregateType: 'scheduled_transfer',
        aggregateId: schedule.id,
        payload: {
          scheduleId: schedule.id,
          ownerUserId: schedule.ownerUserId,
          amountMinor: schedule.amountMinor.toString(),
          reason: error.message,
          code: error.code,
        },
      });

      scheduleRuns.inc({ outcome: 'failed' });
      logger.warn(
        { scheduleId: schedule.id, code: error.code, attempts: occurrence.attempts },
        'scheduled transfer failed',
      );
      return 'failed';
    }
  });

  return outcome;
}

/**
 * The payment itself. Identical rules to a transfer the user makes by hand — the same locking,
 * the same balance check, the same daily cap. A schedule is a different way to *authorise* a
 * payment, never a second way to make one.
 */
async function pay(tx: Tx, schedule: repo.Schedule) {
  const fromAccountId = await transferRepo.findAccountIdForUser(tx, schedule.ownerUserId);
  const toAccountId = await transferRepo.findAccountIdForUser(tx, schedule.payeeUserId);
  if (!fromAccountId || !toAccountId) {
    throw new DomainError('NOT_FOUND', 'Account no longer exists');
  }

  const spent = await transferRepo.outboundInWindow(tx, fromAccountId);
  const dailyLimit = BigInt(config.DAILY_TRANSFER_LIMIT_MINOR);
  if (spent + schedule.amountMinor > dailyLimit) {
    throw new DomainError('LIMIT_EXCEEDED', 'Scheduled payment would exceed the daily limit', {
      details: { dailyLimitMinor: dailyLimit.toString(), alreadySentMinor: spent.toString() },
    });
  }

  return postDoubleEntry(tx, {
    fromAccountId,
    toAccountId,
    amountMinor: schedule.amountMinor,
    type: 'SCHEDULED',
    note: schedule.note,
  });
}

/**
 * Drain every due schedule. Used by tests and the demo script so a run is deterministic instead
 * of depending on when the background tick happens to fire.
 */
export async function drainSchedules(maxTicks = 50): Promise<ScheduleTickResult> {
  const total: ScheduleTickResult = { ...EMPTY };

  for (let tick = 0; tick < maxTicks; tick += 1) {
    const result = await runDueSchedules();
    total.claimed += result.claimed;
    total.paid += result.paid;
    total.failed += result.failed;
    total.deferred += result.deferred;
    total.skipped += result.skipped;
    total.duplicate += result.duplicate;

    // A deferred schedule is due again in the future, so it is not progress; stopping here is
    // what keeps this from spinning until maxTicks.
    if (result.paid === 0 && result.failed === 0 && result.skipped === 0 && result.duplicate === 0) {
      break;
    }
  }

  return total;
}
