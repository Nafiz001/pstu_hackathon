/**
 * Outbox dispatcher.
 *
 * Claims committed events and hands them to consumers. Two properties make it safe to run one
 * of these inside every API replica simultaneously:
 *
 *   FOR UPDATE SKIP LOCKED — each dispatcher takes rows nobody else has locked, so N dispatchers
 *   partition the work between them with no coordinator, no leader election, and no chance of
 *   two of them handling the same event.
 *
 *   Per-event SAVEPOINTs — one poisonous event rolls back to its own savepoint and is marked for
 *   retry, while the rest of the batch still commits. Without this, a single bad event would
 *   fail the whole batch forever.
 *
 * Failures back off exponentially and land in FAILED after MAX_ATTEMPTS, where they stay visible
 * for an operator rather than being retried into eternity.
 */
import { withTransaction } from '../platform/db/transaction.js';
import { logger } from '../platform/logging/index.js';
import { outboxProcessed } from '../platform/metrics/index.js';
import { handleEvent, type OutboxEventRecord } from '../modules/notifications/notification.handler.js';

export const MAX_ATTEMPTS = 5;

export interface DispatchResult {
  claimed: number;
  processed: number;
  failed: number;
  notifications: number;
}

interface OutboxRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export async function dispatchBatch(batchSize = 50): Promise<DispatchResult> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<OutboxRow>(
      `SELECT id, event_type, aggregate_type, aggregate_id, payload, attempts
         FROM outbox_events
        WHERE status = 'PENDING'
          AND next_attempt_at <= now()
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );

    const result: DispatchResult = {
      claimed: rows.length,
      processed: 0,
      failed: 0,
      notifications: 0,
    };

    for (const row of rows) {
      const event: OutboxEventRecord = {
        id: row.id,
        eventType: row.event_type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        attempts: row.attempts,
      };

      await tx.query('SAVEPOINT outbox_event');
      try {
        const delivered = await handleEvent(tx, event);
        await tx.query('RELEASE SAVEPOINT outbox_event');
        await tx.query(
          `UPDATE outbox_events
              SET status = 'PROCESSED', processed_at = now(), attempts = attempts + 1
            WHERE id = $1`,
          [event.id],
        );
        result.processed += 1;
        result.notifications += delivered;
        outboxProcessed.inc({ result: 'processed' });
      } catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT outbox_event');
        const attempts = event.attempts + 1;
        const exhausted = attempts >= MAX_ATTEMPTS;

        await tx.query(
          `UPDATE outbox_events
              SET status = $2,
                  attempts = $3,
                  last_error = $4,
                  next_attempt_at = now() + ($5 || ' seconds')::interval
            WHERE id = $1`,
          [
            event.id,
            exhausted ? 'FAILED' : 'PENDING',
            attempts,
            String((error as Error).message).slice(0, 500),
            String(Math.min(2 ** attempts, 300)),
          ],
        );

        result.failed += 1;
        outboxProcessed.inc({ result: exhausted ? 'failed' : 'retrying' });
        logger.error(
          { eventId: event.id, eventType: event.eventType, attempts, exhausted, err: error },
          'outbox event failed',
        );
      }
    }

    return result;
  });
}

/**
 * Drain the queue. Used by tests and by the demo script so results are deterministic rather than
 * dependent on when the background tick happens to fire.
 */
export async function drainOutbox(maxBatches = 100): Promise<DispatchResult> {
  const total: DispatchResult = { claimed: 0, processed: 0, failed: 0, notifications: 0 };
  for (let i = 0; i < maxBatches; i += 1) {
    const batch = await dispatchBatch();
    total.claimed += batch.claimed;
    total.processed += batch.processed;
    total.failed += batch.failed;
    total.notifications += batch.notifications;
    if (batch.claimed === 0) break;
  }
  return total;
}
