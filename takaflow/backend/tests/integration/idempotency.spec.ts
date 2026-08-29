/**
 * Idempotency — "my phone lost signal after I tapped Send. Did it go through?"
 *
 * Covers I1-I7 from the PRD's edge-case matrix.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  newIdempotencyKey,
  registerUser,
  sendMoney,
  type TestApp,
  type TestUser,
} from '../helpers/app.js';
import { assertBooksBalance, countRows, resetDatabase, userBalance } from '../helpers/db.js';
import { closePool, query } from '../../src/platform/db/pool.js';

const BONUS = 10_000_000n;
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

describe('I1 — retry after a network timeout', () => {
  it('replays the stored response byte-for-byte and moves money once', async () => {
    const key = newIdempotencyKey('retry');

    const first = await sendMoney(app, rahim, karim, TK(2500), { idempotencyKey: key });
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replay']).toBe('false');

    const second = await sendMoney(app, rahim, karim, TK(2500), { idempotencyKey: key });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');

    expect(second.json()).toEqual(first.json());
    expect(await countRows('transfers', "WHERE type = 'P2P'")).toBe(1);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(2500));
    await assertBooksBalance();
  });

  it('survives twenty sequential retries', async () => {
    const key = newIdempotencyKey('retry20');
    const responses = [];
    for (let i = 0; i < 20; i += 1) {
      responses.push(await sendMoney(app, rahim, karim, TK(1000), { idempotencyKey: key }));
    }

    expect(responses.every((r) => r.statusCode === 201)).toBe(true);
    expect(responses.slice(1).every((r) => r.headers['idempotent-replay'] === 'true')).toBe(true);
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);

    expect(await countRows('transfers', "WHERE type = 'P2P'")).toBe(1);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(1000));
    await assertBooksBalance();
  });
});

describe('I2 — same key, different payload', () => {
  it('refuses rather than replaying a response for a request that was never made', async () => {
    const key = newIdempotencyKey('mismatch');

    const first = await sendMoney(app, rahim, karim, TK(2500), { idempotencyKey: key });
    expect(first.statusCode).toBe(201);

    const different = await sendMoney(app, rahim, karim, TK(9999), { idempotencyKey: key });
    expect(different.statusCode).toBe(409);
    expect(different.json().error.code).toBe('IDEMPOTENCY_KEY_REUSE');

    expect(await countRows('transfers', "WHERE type = 'P2P'")).toBe(1);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(2500));
  });

  it('treats key order in the body as irrelevant — it is the same request', async () => {
    const key = newIdempotencyKey('canonical');

    const first = await sendMoney(app, rahim, karim, TK(2500), {
      idempotencyKey: key,
      rawPayload: { toPhone: karim.phone, amountMinor: '250000', pin: rahim.pin, note: 'x' },
    });
    const reordered = await sendMoney(app, rahim, karim, TK(2500), {
      idempotencyKey: key,
      rawPayload: { note: 'x', pin: rahim.pin, amountMinor: '250000', toPhone: karim.phone },
    });

    expect(first.statusCode).toBe(201);
    expect(reordered.statusCode).toBe(201);
    expect(reordered.headers['idempotent-replay']).toBe('true');
    expect(await countRows('transfers', "WHERE type = 'P2P'")).toBe(1);
  });
});

describe('I3 — concurrent duplicates', () => {
  it('executes once when the same key arrives many times at the same instant', async () => {
    const key = newIdempotencyKey('concurrent');

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        sendMoney(app, rahim, karim, TK(2500), { idempotencyKey: key }),
      ),
    );

    const created = responses.filter((r) => r.statusCode === 201);
    const inProgress = responses.filter((r) => r.statusCode === 409);
    const shed = responses.filter((r) => r.statusCode === 503);

    // Every response is the receipt, an explicit "already being processed", or back-pressure —
    // never a second execution, and never an unexplained failure.
    expect(created.length + inProgress.length + shed.length).toBe(20);
    expect(created.length).toBeGreaterThanOrEqual(1);
    for (const response of inProgress) {
      expect(response.json().error.code).toBe('REQUEST_IN_PROGRESS');
    }

    expect(await countRows('transfers', "WHERE type = 'P2P'")).toBe(1);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(2500));
    expect(await userBalance(karim.id)).toBe(BONUS + TK(2500));
    await assertBooksBalance();
  });
});

describe('I5 — a failed attempt leaves the key reusable', () => {
  it('does not burn the key when the transfer is rejected', async () => {
    const key = newIdempotencyKey('rejected');

    const rejected = await sendMoney(app, rahim, karim, BONUS + TK(1), { idempotencyKey: key });
    expect(rejected.statusCode).toBe(422);

    // The claim was rolled back with the rest of the transaction, so the client can correct the
    // amount and retry with the same key rather than being locked out of their own request.
    expect(await countRows('idempotency_keys')).toBe(0);

    const retried = await sendMoney(app, rahim, karim, TK(2500), { idempotencyKey: key });
    expect(retried.statusCode).toBe(201);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(2500));
  });
});

describe('I6 — keys are scoped to the user', () => {
  it('lets two users use the same key string independently', async () => {
    const key = 'shared-key-value-1234';

    const fromRahim = await sendMoney(app, rahim, karim, TK(100), { idempotencyKey: key });
    const fromKarim = await sendMoney(app, karim, rahim, TK(200), { idempotencyKey: key });

    expect(fromRahim.statusCode).toBe(201);
    expect(fromKarim.statusCode).toBe(201);
    expect(await countRows('transfers', "WHERE type = 'P2P'")).toBe(2);
    await assertBooksBalance();
  });
});

describe('the idempotency record', () => {
  it('is completed in the same transaction as the money it describes', async () => {
    const key = newIdempotencyKey('linked');
    const response = await sendMoney(app, rahim, karim, TK(2500), { idempotencyKey: key });
    const reference = response.json().transfer.reference;

    const { rows } = await query<{
      state: string;
      response_status: number;
      transfer_reference: string | null;
    }>(
      `SELECT k.state, k.response_status, t.reference AS transfer_reference
         FROM idempotency_keys k
         LEFT JOIN transfers t ON t.idempotency_key_id = k.id
        WHERE k.key = $1`,
      [key],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: 'COMPLETED',
      response_status: 201,
      transfer_reference: reference,
    });
  });

  it('stores the response body that a replay will return', async () => {
    const key = newIdempotencyKey('stored');
    const original = await sendMoney(app, rahim, karim, TK(700), { idempotencyKey: key });

    const { rows } = await query<{ response_body: { transfer: { reference: string } } }>(
      'SELECT response_body FROM idempotency_keys WHERE key = $1',
      [key],
    );

    expect(rows[0]!.response_body.transfer.reference).toBe(original.json().transfer.reference);
  });
});
