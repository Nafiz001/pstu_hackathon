import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  registerUser,
  sendMoney,
  authHeaders,
  newIdempotencyKey,
  type TestApp,
  type TestUser,
} from '../helpers/app.js';
import { assertBooksBalance, countRows, resetDatabase, userBalance } from '../helpers/db.js';
import { closePool, query } from '../../src/platform/db/pool.js';

const BONUS = 10_000_000n; // BDT 100,000
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

describe('POST /transfers — the core flow', () => {
  it('moves BDT 2,500 from one user to another and balances the books', async () => {
    const response = await sendMoney(app, rahim, karim, TK(2500), { note: 'Lunch' });

    expect(response.statusCode).toBe(201);
    expect(response.headers['idempotent-replay']).toBe('false');

    const body = response.json();
    expect(body.transfer).toMatchObject({
      status: 'COMPLETED',
      type: 'P2P',
      direction: 'OUT',
      note: 'Lunch',
    });
    expect(body.transfer.reference).toMatch(/^TF\d{6}[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(body.transfer.amount).toEqual({
      minor: '250000',
      formatted: '2,500.00',
      currency: 'BDT',
    });
    expect(body.transfer.counterparty).toMatchObject({ name: 'Karim', phone: karim.phone });
    expect(body.balance.minor).toBe((BONUS - TK(2500)).toString());

    expect(await userBalance(rahim.id)).toBe(BONUS - TK(2500));
    expect(await userBalance(karim.id)).toBe(BONUS + TK(2500));
    await assertBooksBalance();
  });

  it('writes exactly two ledger entries carrying the resulting balances', async () => {
    await sendMoney(app, rahim, karim, TK(1200));

    const { rows } = await query<{
      direction: string;
      amount_minor: string;
      balance_after: string;
    }>(
      `SELECT e.direction, e.amount_minor, e.balance_after
         FROM ledger_entries e
         JOIN transfers t ON t.id = e.transfer_id
        WHERE t.type = 'P2P'
        ORDER BY e.direction`,
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.direction)).toEqual(['DEBIT', 'CREDIT']);
    expect(rows.every((r) => r.amount_minor === TK(1200).toString())).toBe(true);
    expect(rows[0]!.balance_after).toBe((BONUS - TK(1200)).toString());
    expect(rows[1]!.balance_after).toBe((BONUS + TK(1200)).toString());
  });

  it('records the movement in both users’ histories via the ledger', async () => {
    await sendMoney(app, rahim, karim, TK(500));
    expect(await countRows('ledger_entries', "WHERE account_id = $1", [rahim.accountId])).toBe(2);
    expect(await countRows('ledger_entries', "WHERE account_id = $1", [karim.accountId])).toBe(2);
  });

  it('emits one outbox event and one audit row, inside the money transaction', async () => {
    await sendMoney(app, rahim, karim, TK(300));
    expect(await countRows('outbox_events', "WHERE event_type = 'MONEY_RECEIVED'")).toBe(1);
    expect(await countRows('audit_logs', "WHERE action = 'TRANSFER_SENT'")).toBe(1);
  });

  it('lets a user spend their entire balance but not one poisha more', async () => {
    // Below the per-transfer cap, so this exercises the balance check rather than the limit.
    for (let i = 0; i < 4; i += 1) {
      const response = await sendMoney(app, rahim, karim, TK(25_000));
      expect(response.statusCode).toBe(201);
    }
    expect(await userBalance(rahim.id)).toBe(0n);

    const overdraft = await sendMoney(app, rahim, karim, TK(1));
    expect(overdraft.statusCode).toBe(422);
    expect(overdraft.json().error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await userBalance(rahim.id)).toBe(0n);
    await assertBooksBalance();
  });
});

describe('POST /transfers — rejections', () => {
  it('refuses a transfer to yourself', async () => {
    const response = await sendMoney(app, rahim, rahim, TK(100));
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('SELF_TRANSFER');
    expect(await userBalance(rahim.id)).toBe(BONUS);
  });

  it('refuses a transfer to a phone number nobody owns', async () => {
    const response = await sendMoney(app, rahim, { phone: '01999999999' }, TK(100));
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('refuses more than the balance', async () => {
    const response = await sendMoney(app, rahim, karim, BONUS + 1n);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('LIMIT_EXCEEDED'); // above per-transfer cap first
  });

  it('refuses an amount above the per-transfer cap', async () => {
    const response = await sendMoney(app, rahim, karim, TK(50_001));
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('LIMIT_EXCEEDED');
  });

  it('refuses an amount below the minimum', async () => {
    const response = await sendMoney(app, rahim, karim, 50n);
    expect(response.statusCode).toBe(400);
  });

  it('enforces the rolling daily limit across several transfers', async () => {
    // Cap is BDT 200,000/day and each transfer is capped at BDT 50,000. Give Rahim enough to
    // reach the daily limit, then prove the next transfer is refused for the right reason.
    for (const funder of [karim, await registerUser(app), await registerUser(app)]) {
      const response = await sendMoney(app, funder, rahim, TK(50_000));
      expect(response.statusCode).toBe(201);
    }

    for (let i = 0; i < 4; i += 1) {
      const response = await sendMoney(app, rahim, karim, TK(50_000));
      expect(response.statusCode).toBe(201);
    }

    const overLimit = await sendMoney(app, rahim, karim, TK(1000));
    expect(overLimit.statusCode).toBe(422);
    expect(overLimit.json().error.code).toBe('LIMIT_EXCEEDED');
    expect(overLimit.json().error.details.dailyLimitMinor).toBe('20000000');
    await assertBooksBalance();
  });

  it('refuses a frozen sender but still allows them to receive', async () => {
    await query("UPDATE accounts SET status = 'FROZEN' WHERE user_id = $1", [rahim.id]);

    const outbound = await sendMoney(app, rahim, karim, TK(100));
    expect(outbound.statusCode).toBe(403);
    expect(outbound.json().error.code).toBe('ACCOUNT_FROZEN');

    const inbound = await sendMoney(app, karim, rahim, TK(100));
    expect(inbound.statusCode).toBe(201);
    await assertBooksBalance();
  });

  it.each([
    ['a numeric amount instead of a string', { amountMinor: 250000 }],
    ['a fractional amount', { amountMinor: '250000.5' }],
    ['scientific notation', { amountMinor: '2.5e5' }],
    ['a negative amount', { amountMinor: '-250000' }],
    ['zero', { amountMinor: '0' }],
    ['a leading-zero amount', { amountMinor: '0250000' }],
    ['a missing PIN', { pin: undefined }],
    ['an over-long note', { note: 'x'.repeat(141) }],
  ])('rejects %s without moving money', async (_label, override) => {
    const response = await sendMoney(app, rahim, karim, TK(2500), {
      rawPayload: {
        toPhone: karim.phone,
        amountMinor: '250000',
        pin: rahim.pin,
        ...override,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(await userBalance(rahim.id)).toBe(BONUS);
    expect(await countRows('transfers', "WHERE type = 'P2P'")).toBe(0);
  });
});

describe('transaction PIN', () => {
  it('refuses a wrong PIN and reports the attempts remaining', async () => {
    const response = await sendMoney(app, rahim, karim, TK(100), { pin: '0000' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_PIN');
    expect(response.json().error.details.attemptsRemaining).toBe(4);
    expect(await userBalance(rahim.id)).toBe(BONUS);
  });

  it('locks the PIN after five failures, and the lockout survives the failed request', async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await sendMoney(app, rahim, karim, TK(100), { pin: '0000' });
      expect(response.statusCode).toBe(401);
    }

    const fifth = await sendMoney(app, rahim, karim, TK(100), { pin: '0000' });
    expect(fifth.statusCode).toBe(423);
    expect(fifth.json().error.code).toBe('PIN_LOCKED');

    // The counter must be durable: it is committed outside the request's own transaction,
    // which rolls back.
    const correctPin = await sendMoney(app, rahim, karim, TK(100));
    expect(correctPin.statusCode).toBe(423);
    expect(await userBalance(rahim.id)).toBe(BONUS);
  });

  it('resets the failure counter after a successful transfer', async () => {
    await sendMoney(app, rahim, karim, TK(100), { pin: '0000' });
    expect(await countRows('users', 'WHERE failed_pin_attempts > 0')).toBe(1);

    const success = await sendMoney(app, rahim, karim, TK(100));
    expect(success.statusCode).toBe(201);
    expect(await countRows('users', 'WHERE failed_pin_attempts > 0')).toBe(0);
  });
});

describe('authentication and authorisation', () => {
  it('requires a bearer token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: { 'idempotency-key': newIdempotencyKey() },
      payload: { toPhone: karim.phone, amountMinor: '100', pin: '1234' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires an Idempotency-Key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: authHeaders(rahim),
      payload: { toPhone: karim.phone, amountMinor: '100', pin: rahim.pin },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/Idempotency-Key/);
  });

  it('rejects an Idempotency-Key that is too short to be unique', async () => {
    const response = await sendMoney(app, rahim, karim, TK(100), { idempotencyKey: 'abc' });
    expect(response.statusCode).toBe(400);
  });
});
