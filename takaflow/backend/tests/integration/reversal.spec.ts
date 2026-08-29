/**
 * Reversal — undoing a payment without ever editing history.
 *
 * The properties that matter: the original entries are untouched, the money comes back as a new
 * balanced movement, it can happen at most once, and it cannot overdraw the recipient.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
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

const reverse = (
  user: TestUser,
  reference: string,
  options: { idempotencyKey?: string; pin?: string } = {},
) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/transfers/${reference}/reverse`,
    headers: {
      ...authHeaders(user),
      'idempotency-key': options.idempotencyKey ?? newIdempotencyKey('rev'),
    },
    payload: { pin: options.pin ?? user.pin },
  });

describe('reversing a transfer', () => {
  it('returns the money as a new compensating movement, leaving the original intact', async () => {
    const sent = await sendMoney(app, rahim, karim, TK(2500), { note: 'Wrong person' });
    const reference = sent.json().transfer.reference;

    const response = await reverse(rahim, reference);

    expect(response.statusCode).toBe(201);
    expect(response.json().reversal).toMatchObject({ reversalOf: reference });
    expect(response.json().reversal.amount.formatted).toBe('2,500.00');
    expect(response.json().balance.minor).toBe(BONUS.toString());

    expect(await userBalance(rahim.id)).toBe(BONUS);
    expect(await userBalance(karim.id)).toBe(BONUS);

    // Two transfers now exist: the original and its compensation. The original is NOT deleted.
    expect(await countRows('transfers', "WHERE type = 'P2P'")).toBe(1);
    expect(await countRows('transfers', "WHERE type = 'REVERSAL'")).toBe(1);
    await assertBooksBalance();
  });

  it('never edits the original ledger entries', async () => {
    const sent = await sendMoney(app, rahim, karim, TK(2500));
    const reference = sent.json().transfer.reference;

    const before = await query<{ id: string; amount_minor: string; balance_after: string }>(
      `SELECT e.id::text, e.amount_minor::text, e.balance_after::text
         FROM ledger_entries e JOIN transfers t ON t.id = e.transfer_id
        WHERE t.reference = $1 ORDER BY e.id`,
      [reference],
    );

    await reverse(rahim, reference);

    const after = await query<{ id: string; amount_minor: string; balance_after: string }>(
      `SELECT e.id::text, e.amount_minor::text, e.balance_after::text
         FROM ledger_entries e JOIN transfers t ON t.id = e.transfer_id
        WHERE t.reference = $1 ORDER BY e.id`,
      [reference],
    );

    // Byte-for-byte identical: history is history.
    expect(after.rows).toEqual(before.rows);
  });

  it('marks the original REVERSED and links the two together', async () => {
    const sent = await sendMoney(app, rahim, karim, TK(2500));
    const reference = sent.json().transfer.reference;
    const reversal = await reverse(rahim, reference);

    const { rows } = await query<{ status: string; reversal_of: string | null; reference: string }>(
      `SELECT status::text AS status, reversal_of, reference FROM transfers ORDER BY created_at`,
    );

    const original = rows.find((r) => r.reference === reference)!;
    const compensating = rows.find(
      (r) => r.reference === reversal.json().reversal.reference,
    )!;

    expect(original.status).toBe('REVERSED');
    expect(compensating.reversal_of).not.toBeNull();
    expect(compensating.status).toBe('COMPLETED');
  });

  it('can only happen once', async () => {
    const sent = await sendMoney(app, rahim, karim, TK(2500));
    const reference = sent.json().transfer.reference;

    const first = await reverse(rahim, reference);
    const second = await reverse(rahim, reference);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('INVALID_STATE');
    expect(await countRows('transfers', "WHERE type = 'REVERSAL'")).toBe(1);
    expect(await userBalance(rahim.id)).toBe(BONUS);
    await assertBooksBalance();
  });

  it('settles exactly once when reversals race', async () => {
    const sent = await sendMoney(app, rahim, karim, TK(2500));
    const reference = sent.json().transfer.reference;

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => reverse(rahim, reference)),
    );

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(await countRows('transfers', "WHERE type = 'REVERSAL'")).toBe(1);
    expect(await userBalance(rahim.id)).toBe(BONUS);
    await assertBooksBalance();
  });

  it('replays rather than reversing twice on an idempotent retry', async () => {
    const sent = await sendMoney(app, rahim, karim, TK(2500));
    const reference = sent.json().transfer.reference;
    const key = newIdempotencyKey('rev-retry');

    const first = await reverse(rahim, reference, { idempotencyKey: key });
    const retry = await reverse(rahim, reference, { idempotencyKey: key });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    expect(await countRows('transfers', "WHERE type = 'REVERSAL'")).toBe(1);
  });
});

describe('what reversal refuses to do', () => {
  it('refuses when the recipient has already spent the money', async () => {
    const stranger = await registerUser(app);
    const sent = await sendMoney(app, rahim, karim, TK(2500));

    // Karim spends down below the amount Rahim sent him: 102,500 -> 100 poisha.
    for (let i = 0; i < 4; i += 1) {
      expect((await sendMoney(app, karim, stranger, TK(25_000))).statusCode).toBe(201);
    }
    expect((await sendMoney(app, karim, stranger, TK(2_499))).statusCode).toBe(201);
    expect(await userBalance(karim.id)).toBe(100n);

    const response = await reverse(rahim, sent.json().transfer.reference);

    // A closed-loop wallet has no authority to overdraw someone. Refusing is the correct
    // behaviour, and the whole reversal rolls back — the original stays COMPLETED.
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('INSUFFICIENT_FUNDS');

    const { rows } = await query<{ status: string }>(
      'SELECT status::text AS status FROM transfers WHERE reference = $1',
      [sent.json().transfer.reference],
    );
    expect(rows[0]!.status).toBe('COMPLETED');
    expect(await countRows('transfers', "WHERE type = 'REVERSAL'")).toBe(0);
    await assertBooksBalance();
  });

  it('refuses after the window has closed', async () => {
    const sent = await sendMoney(app, rahim, karim, TK(2500));
    const reference = sent.json().transfer.reference;

    await query(
      "UPDATE transfers SET created_at = created_at - interval '10 minutes' WHERE reference = $1",
      [reference],
    );

    const response = await reverse(rahim, reference);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/within \d+ seconds/);
    expect(await userBalance(karim.id)).toBe(BONUS + TK(2500));
  });

  it('refuses anyone but the original sender', async () => {
    const stranger = await registerUser(app);
    const sent = await sendMoney(app, rahim, karim, TK(2500));
    const reference = sent.json().transfer.reference;

    // Neither the recipient nor an unrelated user may pull money back.
    expect((await reverse(karim, reference)).statusCode).toBe(404);
    expect((await reverse(stranger, reference)).statusCode).toBe(404);
    expect(await countRows('transfers', "WHERE type = 'REVERSAL'")).toBe(0);
  });

  it('refuses to reverse the signup mint', async () => {
    const { rows } = await query<{ reference: string }>(
      "SELECT reference FROM transfers WHERE type = 'MINT' LIMIT 1",
    );
    const response = await reverse(rahim, rows[0]!.reference);
    // Not the sender of a mint, so it is reported as missing before the type check is reached.
    expect(response.statusCode).toBe(404);
  });

  it('refuses to reverse a reversal', async () => {
    const sent = await sendMoney(app, rahim, karim, TK(2500));
    const first = await reverse(rahim, sent.json().transfer.reference);
    const reversalReference = first.json().reversal.reference;

    // The compensating movement was sent by Karim's account, so Karim is its "sender".
    const response = await reverse(karim, reversalReference);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.details.type).toBe('REVERSAL');
    await assertBooksBalance();
  });

  it('requires the PIN', async () => {
    const sent = await sendMoney(app, rahim, karim, TK(2500));
    const response = await reverse(rahim, sent.json().transfer.reference, { pin: '0000' });

    expect(response.statusCode).toBe(401);
    expect(await userBalance(karim.id)).toBe(BONUS + TK(2500));
  });
});
