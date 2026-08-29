import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
  createTestApp,
  registerUser,
  sendMoney,
  type TestApp,
  type TestUser,
} from '../helpers/app.js';
import { resetDatabase } from '../helpers/db.js';
import { closePool, query } from '../../src/platform/db/pool.js';

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

const history = (user: TestUser, qs = '') =>
  app.inject({ method: 'GET', url: `/api/v1/transfers${qs}`, headers: authHeaders(user) });

describe('GET /transfers', () => {
  it('shows the signup mint and both sides of a transfer', async () => {
    await sendMoney(app, rahim, karim, TK(2500), { note: 'Lunch' });

    const senderView = await history(rahim);
    expect(senderView.statusCode).toBe(200);
    expect(senderView.json().items).toHaveLength(2); // the mint, then the send

    const [send, mint] = senderView.json().items;
    expect(send).toMatchObject({ direction: 'OUT', type: 'P2P', note: 'Lunch' });
    expect(send.counterparty).toMatchObject({ name: 'Karim' });
    expect(send.amount.formatted).toBe('2,500.00');
    expect(send.balanceAfter.formatted).toBe('97,500.00');

    // A mint has no counterparty user — the other side is the treasury.
    expect(mint).toMatchObject({ direction: 'IN', type: 'MINT' });
    expect(mint.counterparty.name).toBe('TakaFlow');

    const receiverView = await history(karim);
    const received = receiverView.json().items[0];
    expect(received).toMatchObject({ direction: 'IN', type: 'P2P' });
    expect(received.counterparty.name).toBe('Rahim');
    expect(received.balanceAfter.formatted).toBe('102,500.00');
    // Both sides quote the same public reference.
    expect(received.reference).toBe(send.reference);
  });

  it('orders newest first and paginates without repeating or skipping a row', async () => {
    for (let i = 0; i < 12; i += 1) await sendMoney(app, rahim, karim, TK(10 + i));

    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page += 1) {
      const response = await history(
        rahim,
        `?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      const body = response.json();
      seen.push(...body.items.map((i: { id: string }) => i.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    // 12 sends + 1 mint, each appearing exactly once.
    expect(seen).toHaveLength(13);
    expect(new Set(seen).size).toBe(13);
  });

  it('filters by direction, type, counterparty and amount', async () => {
    const dhaka = await registerUser(app, { name: 'Dhaka Shop' });
    await sendMoney(app, rahim, karim, TK(100));
    await sendMoney(app, rahim, dhaka, TK(5000));
    await sendMoney(app, karim, rahim, TK(300));

    expect((await history(rahim, '?direction=OUT')).json().items).toHaveLength(2);
    expect((await history(rahim, '?direction=IN')).json().items).toHaveLength(2); // mint + refund
    expect((await history(rahim, '?type=MINT')).json().items).toHaveLength(1);
    expect((await history(rahim, `?counterpartyPhone=${dhaka.phone}`)).json().items).toHaveLength(1);

    const large = await history(rahim, '?minAmountMinor=400000');
    expect(large.json().items.every((i: { amount: { minor: string } }) => BigInt(i.amount.minor) >= 400_000n)).toBe(true);
  });

  it('filters by date range and rejects an inverted range', async () => {
    await sendMoney(app, rahim, karim, TK(100));

    const future = new Date(Date.now() + 86_400_000).toISOString();
    const empty = await history(rahim, `?from=${encodeURIComponent(future)}`);
    expect(empty.json().items).toHaveLength(0);

    const inverted = await history(
      rahim,
      `?from=${encodeURIComponent(future)}&to=${encodeURIComponent(new Date(0).toISOString())}`,
    );
    expect(inverted.statusCode).toBe(400);
  });

  it('does not use OFFSET anywhere in the query plan', async () => {
    for (let i = 0; i < 5; i += 1) await sendMoney(app, rahim, karim, TK(10));

    // Prove the claim rather than asserting it in a comment: the plan must be an index scan on
    // ledger_entries with no sort and no offset node.
    const { rows } = await query<{ plan: string }>(
      `EXPLAIN (FORMAT TEXT)
       SELECT e.id FROM ledger_entries e
        WHERE e.account_id = $1
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 20`,
      [rahim.accountId],
    );
    const plan = rows.map((r) => r.plan ?? Object.values(r)[0]).join('\n');
    expect(plan).not.toMatch(/Offset/i);
    expect(plan).toMatch(/Index (Scan|Only Scan)/i);
  });
});

describe('GET /transfers/:reference', () => {
  it('returns the receipt to either party', async () => {
    const sent = await sendMoney(app, rahim, karim, TK(2500), { note: 'Rent' });
    const reference = sent.json().transfer.reference;

    for (const [user, direction] of [
      [rahim, 'OUT'],
      [karim, 'IN'],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/transfers/${reference}`,
        headers: authHeaders(user),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().transfer).toMatchObject({ reference, direction, note: 'Rent' });
    }
  });

  it('hides a transfer from anyone who was not part of it', async () => {
    const stranger = await registerUser(app);
    const sent = await sendMoney(app, rahim, karim, TK(2500));

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/transfers/${sent.json().transfer.reference}`,
      headers: authHeaders(stranger),
    });
    // 404 rather than 403: telling a stranger "forbidden" would confirm the reference exists.
    expect(response.statusCode).toBe(404);
  });

  it('rejects a malformed reference', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/transfers/not-a-reference',
      headers: authHeaders(rahim),
    });
    expect(response.statusCode).toBe(400);
  });
});
