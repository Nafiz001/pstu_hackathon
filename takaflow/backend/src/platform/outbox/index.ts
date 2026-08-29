/**
 * Transactional outbox.
 *
 * The rule: side effects are never performed inside the money transaction. Publishing to a
 * broker, sending a notification, or calling another service from inside the transaction gives
 * you two failure modes with no good answer — the publish succeeds and the transaction then
 * rolls back (an event for money that never moved), or the transaction commits and the publish
 * fails (money moved with nobody told).
 *
 * Instead the intent to emit is written as a row, in the same transaction as the money. The
 * event therefore exists if and only if the movement happened. A separate dispatcher then
 * delivers it at-least-once to idempotent consumers.
 *
 * Because `withTransaction` may retry the callback, enqueueing must have no effect outside the
 * transaction — which it does not: it is just an INSERT that a rollback erases.
 */
import type { Tx } from '../db/transaction.js';

export type EventType =
  | 'USER_REGISTERED'
  | 'MONEY_SENT'
  | 'MONEY_RECEIVED'
  | 'REQUEST_CREATED'
  | 'REQUEST_ACCEPTED'
  | 'REQUEST_DECLINED'
  | 'REQUEST_CANCELLED'
  | 'REQUEST_EXPIRED'
  | 'TRANSFER_REVERSED'
  | 'SCHEDULE_PAID'
  | 'SCHEDULE_FAILED'
  | 'SCHEDULE_SKIPPED'
  | 'ACCOUNT_FROZEN'
  | 'ACCOUNT_UNFROZEN';

export interface OutboxEvent {
  eventType: EventType;
  aggregateType: 'user' | 'transfer' | 'money_request' | 'scheduled_transfer' | 'account';
  aggregateId: string;
  payload: Record<string, unknown>;
}

export async function enqueueEvent(tx: Tx, event: OutboxEvent): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [event.eventType, event.aggregateType, event.aggregateId, JSON.stringify(event.payload)],
  );
  return rows[0]!.id;
}

export async function enqueueEvents(tx: Tx, events: readonly OutboxEvent[]): Promise<void> {
  for (const event of events) {
    await enqueueEvent(tx, event);
  }
}
