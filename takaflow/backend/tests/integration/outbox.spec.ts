/**
 * A5/A6 — the transactional outbox.
 *
 * The property under test: an event exists if and only if the money moved, and delivering it
 * many times produces one notification.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptRequest,
  authHeaders,
  createRequest,
  createTestApp,
  registerUser,
  sendMoney,
  type TestApp,
  type TestUser,
} from '../helpers/app.js';
import { assertBooksBalance, countRows, resetDatabase } from '../helpers/db.js';
import { closePool, query } from '../../src/platform/db/pool.js';
import { dispatchBatch, drainOutbox } from '../../src/workers/outbox.dispatcher.js';

const TK = (taka: number) => BigInt(taka) * 100n;

let app: TestApp;
let rahim: TestUser;
let karim: TestUser;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  rahim = await registerUser(app, { name: 'Rahim' });
  karim = await registerUser(app, { name: 'Karim' });
});

describe('event and money are written together', () => {
  it('records an event for a transfer that happened', async () => {
    await sendMoney(app, rahim, karim, TK(2500));
    expect(await countRows('outbox_events', "WHERE event_type = 'MONEY_RECEIVED'")).toBe(1);
  });

  it('records no event for a transfer that was rejected', async () => {
    const before = await countRows('outbox_events');
    const rejected = await sendMoney(app, rahim, karim, TK(1_000_000));
    expect(rejected.statusCode).toBe(422);
    // The event insert rolled back with the rest of the transaction, so nobody is told about a
    // payment that never happened.
    expect(await countRows('outbox_events')).toBe(before);
  });
});

describe('dispatching', () => {
  it('delivers pending events and marks them processed', async () => {
    await sendMoney(app, rahim, karim, TK(2500));

    const result = await drainOutbox();
    expect(result.processed).toBeGreaterThanOrEqual(3); // 2 welcomes + 1 money received
    expect(result.failed).toBe(0);
    expect(await countRows('outbox_events', "WHERE status = 'PENDING'")).toBe(0);

    const notifications = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: authHeaders(karim),
    });
    const types = notifications.json().items.map((i: { type: string }) => i.type);
    expect(types).toContain('MONEY_RECEIVED');
    expect(types).toContain('WELCOME');
  });

  it('is idempotent: redelivering an event does not duplicate the notification', async () => {
    await sendMoney(app, rahim, karim, TK(2500));
    await drainOutbox();

    const afterFirstPass = await countRows('notifications');

    // Force every event back into the queue, exactly as an at-least-once broker would redeliver.
    await query("UPDATE outbox_events SET status = 'PENDING', processed_at = NULL");
    await drainOutbox();
    await query("UPDATE outbox_events SET status = 'PENDING', processed_at = NULL");
    await drainOutbox();

    expect(await countRows('notifications')).toBe(afterFirstPass);
  });

  it('notifies the right person for each event in a request lifecycle', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    await drainOutbox();

    // The payer is told they were asked.
    expect(
      await countRows('notifications', "WHERE user_id = $1 AND type = 'REQUEST_RECEIVED'", [rahim.id]),
    ).toBe(1);

    await acceptRequest(app, rahim, created.json().request.id);
    await drainOutbox();

    // The requester is told they were paid, and receives the money notification too.
    expect(
      await countRows('notifications', "WHERE user_id = $1 AND type = 'REQUEST_ACCEPTED'", [karim.id]),
    ).toBe(1);
    await assertBooksBalance();
  });

  it('claims work with SKIP LOCKED so parallel dispatchers never collide', async () => {
    for (let i = 0; i < 8; i += 1) await sendMoney(app, rahim, karim, TK(10));

    const pendingBefore = await countRows('outbox_events', "WHERE status = 'PENDING'");
    expect(pendingBefore).toBeGreaterThan(0);

    // Five dispatchers racing, exactly as five API replicas would.
    const results = await Promise.all(Array.from({ length: 5 }, () => dispatchBatch(5)));
    const claimed = results.reduce((sum, r) => sum + r.claimed, 0);
    const processed = results.reduce((sum, r) => sum + r.processed, 0);

    // No event is claimed twice, so total claims can never exceed what was pending.
    expect(claimed).toBeLessThanOrEqual(pendingBefore);
    expect(processed).toBe(claimed);
    expect(await countRows('notifications', 'WHERE 1=1')).toBe(processed);
  });

  it('retries a failing event with backoff and gives up into FAILED', async () => {
    await sendMoney(app, rahim, karim, TK(2500));
    await drainOutbox();

    // A poison event: its payload names a user that does not exist, so the handler's insert
    // violates the foreign key.
    await query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
       VALUES ('MONEY_RECEIVED', 'transfer', gen_random_uuid(),
               '{"recipientUserId":"00000000-0000-0000-0000-0000000000ff","amountMinor":"100"}'::jsonb)`,
    );

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await query("UPDATE outbox_events SET next_attempt_at = now() WHERE status = 'PENDING'");
      await dispatchBatch();
    }

    const { rows } = await query<{ status: string; attempts: number; last_error: string }>(
      `SELECT status::text AS status, attempts, last_error
         FROM outbox_events
        WHERE aggregate_type = 'transfer' AND status = 'FAILED'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBeGreaterThanOrEqual(5);
    expect(rows[0]!.last_error).toBeTruthy();
  });

  it('does not let one poison event block the rest of its batch', async () => {
    await drainOutbox(); // clear the welcome events

    await query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
       VALUES ('MONEY_RECEIVED', 'transfer', gen_random_uuid(),
               '{"recipientUserId":"00000000-0000-0000-0000-0000000000ff","amountMinor":"100"}'::jsonb)`,
    );
    await sendMoney(app, rahim, karim, TK(2500));

    const result = await dispatchBatch();

    // The savepoint rolls back only the failing event; the healthy one in the same batch commits.
    expect(result.failed).toBe(1);
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(await countRows('notifications', "WHERE type = 'MONEY_RECEIVED'")).toBe(1);
  });
});

describe('notifications API', () => {
  it('lists a user’s own notifications and marks them read', async () => {
    await sendMoney(app, rahim, karim, TK(2500));
    await drainOutbox();

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications?unreadOnly=true',
      headers: authHeaders(karim),
    });
    expect(list.json().items.length).toBeGreaterThan(0);
    const first = list.json().items[0];

    const read = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${first.id}/read`,
      headers: authHeaders(karim),
    });
    expect(read.statusCode).toBe(204);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications?unreadOnly=true',
      headers: authHeaders(karim),
    });
    expect(after.json().items.find((i: { id: string }) => i.id === first.id)).toBeUndefined();
  });

  it('never shows one user another user’s notifications', async () => {
    await sendMoney(app, rahim, karim, TK(2500));
    await drainOutbox();

    const rahimsView = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: authHeaders(rahim),
    });
    expect(
      rahimsView.json().items.every((i: { type: string }) => i.type !== 'MONEY_RECEIVED'),
    ).toBe(true);
  });
});
