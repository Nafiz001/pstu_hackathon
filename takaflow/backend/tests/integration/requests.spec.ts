/**
 * "My friend owes me BDT 1,200. I want to collect it through the application."
 *
 * The state machine, and every way two people can race each other through it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptRequest,
  createRequest,
  createTestApp,
  authHeaders,
  newIdempotencyKey,
  registerUser,
  runWorkers,
  sendMoney,
  type TestApp,
  type TestUser,
} from '../helpers/app.js';
import { assertBooksBalance, countRows, resetDatabase, userBalance } from '../helpers/db.js';
import { closePool, query } from '../../src/platform/db/pool.js';

const BONUS = 10_000_000n;
const TK = (taka: number) => BigInt(taka) * 100n;

let app: TestApp;
let karim: TestUser; // requester — is owed money
let rahim: TestUser; // payer — owes money

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  karim = await registerUser(app, { name: 'Karim' });
  rahim = await registerUser(app, { name: 'Rahim' });
});

describe('creating a request', () => {
  it('creates a pending request visible to both sides', async () => {
    const response = await createRequest(app, karim, rahim, TK(1200), { note: 'Dinner' });

    expect(response.statusCode).toBe(201);
    expect(response.json().request).toMatchObject({
      status: 'PENDING',
      role: 'outgoing',
      note: 'Dinner',
    });
    expect(response.json().request.amount.formatted).toBe('1,200.00');

    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v1/requests?role=incoming',
      headers: authHeaders(rahim),
    });
    expect(inbox.json().items).toHaveLength(1);
    expect(inbox.json().items[0]).toMatchObject({ role: 'incoming', status: 'PENDING' });
    expect(inbox.json().items[0].counterparty.name).toBe('Karim');

    // Creating a request must not move money.
    expect(await userBalance(karim.id)).toBe(BONUS);
    expect(await userBalance(rahim.id)).toBe(BONUS);
    await assertBooksBalance();
  });

  it('refuses a request to yourself', async () => {
    const response = await createRequest(app, karim, karim, TK(100));
    expect(response.statusCode).toBe(400);
  });

  it('refuses a request to someone who does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/requests',
      headers: { ...authHeaders(karim), 'idempotency-key': newIdempotencyKey() },
      payload: { fromPhone: '01999999999', amountMinor: '100000' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('is idempotent', async () => {
    const key = newIdempotencyKey('dup');
    const first = await createRequest(app, karim, rahim, TK(1200), { idempotencyKey: key });
    const second = await createRequest(app, karim, rahim, TK(1200), { idempotencyKey: key });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(await countRows('money_requests')).toBe(1);
  });
});

describe('accepting a request', () => {
  it('settles atomically: state change and payment in one transaction', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    const requestId = created.json().request.id;

    const accepted = await acceptRequest(app, rahim, requestId);

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().request.status).toBe('ACCEPTED');
    expect(accepted.json().transfer.reference).toMatch(/^TF\d{6}/);
    expect(accepted.json().balance.minor).toBe((BONUS - TK(1200)).toString());

    expect(await userBalance(rahim.id)).toBe(BONUS - TK(1200));
    expect(await userBalance(karim.id)).toBe(BONUS + TK(1200));

    // The settlement is an ordinary double entry, of a distinguishable type.
    expect(await countRows('transfers', "WHERE type = 'REQUEST_SETTLEMENT'")).toBe(1);
    const { rows } = await query<{ settled_transfer_id: string | null }>(
      'SELECT settled_transfer_id FROM money_requests WHERE id = $1',
      [requestId],
    );
    expect(rows[0]!.settled_transfer_id).not.toBeNull();
    await assertBooksBalance();
  });

  it('cannot be accepted twice', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    const requestId = created.json().request.id;

    const first = await acceptRequest(app, rahim, requestId);
    const second = await acceptRequest(app, rahim, requestId);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('INVALID_STATE');
    expect(second.json().error.details.status).toBe('ACCEPTED');

    expect(await countRows('transfers', "WHERE type = 'REQUEST_SETTLEMENT'")).toBe(1);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(1200));
    await assertBooksBalance();
  });

  it('replays rather than re-settling when the same idempotency key is retried', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    const requestId = created.json().request.id;
    const key = newIdempotencyKey('accept');

    const first = await acceptRequest(app, rahim, requestId, { idempotencyKey: key });
    const retry = await acceptRequest(app, rahim, requestId, { idempotencyKey: key });

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    expect(await countRows('transfers', "WHERE type = 'REQUEST_SETTLEMENT'")).toBe(1);
  });

  it('cannot be accepted by anyone but the payer', async () => {
    const stranger = await registerUser(app);
    const created = await createRequest(app, karim, rahim, TK(1200));
    const requestId = created.json().request.id;

    const byStranger = await acceptRequest(app, stranger, requestId);
    const byRequester = await acceptRequest(app, karim, requestId);

    // Reported as missing, not forbidden: the difference would confirm the request exists.
    expect(byStranger.statusCode).toBe(404);
    expect(byRequester.statusCode).toBe(404);
    expect(await countRows('transfers', "WHERE type = 'REQUEST_SETTLEMENT'")).toBe(0);
  });

  it('leaves the request PENDING and moves nothing when the payer cannot afford it', async () => {
    // Drain Rahim first.
    for (let i = 0; i < 4; i += 1) {
      expect((await sendMoney(app, rahim, karim, TK(25_000))).statusCode).toBe(201);
    }
    expect(await userBalance(rahim.id)).toBe(0n);

    const created = await createRequest(app, karim, rahim, TK(1200));
    const accepted = await acceptRequest(app, rahim, created.json().request.id);

    expect(accepted.statusCode).toBe(422);
    expect(accepted.json().error.code).toBe('INSUFFICIENT_FUNDS');

    const { rows } = await query<{ status: string; settled_transfer_id: string | null }>(
      'SELECT status, settled_transfer_id FROM money_requests WHERE id = $1',
      [created.json().request.id],
    );
    expect(rows[0]).toMatchObject({ status: 'PENDING', settled_transfer_id: null });
    await assertBooksBalance();
  });

  it('refuses an expired request, and the expiry worker marks it', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    const requestId = created.json().request.id;

    await query("UPDATE money_requests SET expires_at = now() - interval '1 second' WHERE id = $1", [
      requestId,
    ]);

    // The accept guard checks expiry itself, so there is no window between the deadline and the
    // worker's next tick in which an expired request could still be settled.
    const accepted = await acceptRequest(app, rahim, requestId);
    expect(accepted.statusCode).toBe(409);
    expect(accepted.json().error.details.status).toBe('EXPIRED');

    const workers = await runWorkers(app);
    expect(workers.json().expiredRequests).toBe(1);

    const { rows } = await query<{ status: string }>(
      'SELECT status FROM money_requests WHERE id = $1',
      [requestId],
    );
    expect(rows[0]!.status).toBe('EXPIRED');
    await assertBooksBalance();
  });

  it('requires the payer’s PIN', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    const response = await acceptRequest(app, rahim, created.json().request.id, { pin: '0000' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_PIN');
    expect(await userBalance(rahim.id)).toBe(BONUS);
  });
});

describe('declining and cancelling', () => {
  it('lets the payer decline', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${created.json().request.id}/decline`,
      headers: authHeaders(rahim),
      payload: { reason: 'Already paid in cash' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().request).toMatchObject({
      status: 'DECLINED',
      declineReason: 'Already paid in cash',
    });
    expect(await userBalance(rahim.id)).toBe(BONUS);
  });

  it('lets the requester cancel', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${created.json().request.id}/cancel`,
      headers: authHeaders(karim),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().request.status).toBe('CANCELLED');
  });

  it('does not let the payer cancel or the requester decline', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    const id = created.json().request.id;

    const payerCancels = await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${id}/cancel`,
      headers: authHeaders(rahim),
    });
    const requesterDeclines = await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${id}/decline`,
      headers: authHeaders(karim),
      payload: {},
    });

    expect(payerCancels.statusCode).toBe(404);
    expect(requesterDeclines.statusCode).toBe(404);
  });

  it('treats repeating the same terminal action as success, not an error', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    const url = `/api/v1/requests/${created.json().request.id}/decline`;

    const first = await app.inject({ method: 'POST', url, headers: authHeaders(rahim), payload: {} });
    const again = await app.inject({ method: 'POST', url, headers: authHeaders(rahim), payload: {} });

    expect(first.statusCode).toBe(200);
    // A client retrying after a timeout should not be told something went wrong when it did not.
    expect(again.statusCode).toBe(200);
    expect(again.json().request.status).toBe('DECLINED');
  });

  it('refuses to accept a request that was declined', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    const id = created.json().request.id;

    await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${id}/decline`,
      headers: authHeaders(rahim),
      payload: {},
    });
    const accepted = await acceptRequest(app, rahim, id);

    expect(accepted.statusCode).toBe(409);
    expect(accepted.json().error.details.status).toBe('DECLINED');
    await assertBooksBalance();
  });

  it('refuses to accept a request that was cancelled', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    const id = created.json().request.id;

    await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${id}/cancel`,
      headers: authHeaders(karim),
    });
    const accepted = await acceptRequest(app, rahim, id);

    expect(accepted.statusCode).toBe(409);
    expect(accepted.json().error.details.status).toBe('CANCELLED');
    await assertBooksBalance();
  });
});

describe('listing requests', () => {
  it('separates the inbox from the outbox and filters by status', async () => {
    const a = await createRequest(app, karim, rahim, TK(100));
    await createRequest(app, karim, rahim, TK(200));
    await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${a.json().request.id}/cancel`,
      headers: authHeaders(karim),
    });

    const outgoing = await app.inject({
      method: 'GET',
      url: '/api/v1/requests?role=outgoing',
      headers: authHeaders(karim),
    });
    const pendingIncoming = await app.inject({
      method: 'GET',
      url: '/api/v1/requests?role=incoming&status=PENDING',
      headers: authHeaders(rahim),
    });

    expect(outgoing.json().items).toHaveLength(2);
    expect(pendingIncoming.json().items).toHaveLength(1);
    expect(pendingIncoming.json().items[0].amount.minor).toBe(TK(200).toString());
  });

  it('paginates with a stable cursor', async () => {
    for (let i = 0; i < 5; i += 1) await createRequest(app, karim, rahim, TK(100 + i));

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/requests?role=outgoing&limit=2',
      headers: authHeaders(karim),
    });
    expect(first.json().items).toHaveLength(2);
    expect(first.json().nextCursor).toBeTypeOf('string');

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/requests?role=outgoing&limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: authHeaders(karim),
    });
    expect(second.json().items).toHaveLength(2);

    const firstIds = first.json().items.map((i: { id: string }) => i.id);
    const secondIds = second.json().items.map((i: { id: string }) => i.id);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
  });

  it('rejects a corrupted cursor rather than silently ignoring it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/requests?cursor=not-a-real-cursor',
      headers: authHeaders(karim),
    });
    expect(response.statusCode).toBe(400);
  });
});
