/**
 * Emergency freeze — the user's own kill switch.
 *
 * The properties: freezing is instant and needs no secret, unfreezing needs the PIN, money out
 * stops immediately, money IN still arrives, and a freeze racing a transfer is decided by the
 * account row lock rather than by luck.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptRequest,
  authHeaders,
  createRequest,
  createTestApp,
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

const setFreeze = (user: TestUser, frozen: boolean, pin?: string) =>
  app.inject({
    method: 'PATCH',
    url: '/api/v1/accounts/me/freeze',
    headers: authHeaders(user),
    payload: { frozen, ...(pin !== undefined ? { pin } : {}) },
  });

const accountStatus = async (userId: string) => {
  const { rows } = await query<{ status: string }>(
    'SELECT status::text AS status FROM accounts WHERE user_id = $1',
    [userId],
  );
  return rows[0]!.status;
};

describe('freezing your own account', () => {
  it('freezes instantly, with no PIN — a panic button that asks for a secret is useless', async () => {
    const response = await setFreeze(rahim, true);

    expect(response.statusCode).toBe(200);
    expect(response.json().account).toMatchObject({ status: 'FROZEN', frozen: true });
    expect(await accountStatus(rahim.id)).toBe('FROZEN');
  });

  it('blocks every way money can leave', async () => {
    await setFreeze(rahim, true);

    const transfer = await sendMoney(app, rahim, karim, TK(100));
    expect(transfer.statusCode).toBe(403);
    expect(transfer.json().error.code).toBe('ACCOUNT_FROZEN');

    // A request Rahim accepts is money leaving his account, so it is blocked too.
    const request = await createRequest(app, karim, rahim, TK(100));
    const accept = await acceptRequest(app, rahim, request.json().request.id);
    expect(accept.statusCode).toBe(403);

    // ...as is authorising future payments.
    const schedule = await app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: { ...authHeaders(rahim), 'idempotency-key': newIdempotencyKey('sched') },
      payload: {
        toPhone: karim.phone,
        amountMinor: TK(100).toString(),
        intervalKind: 'ONCE',
        startAt: new Date(Date.now() + 60_000).toISOString(),
        pin: rahim.pin,
      },
    });
    expect(schedule.statusCode).toBe(403);

    expect(await userBalance(rahim.id)).toBe(BONUS);
    await assertBooksBalance();
  });

  it('still lets money arrive — freezing protects you, it does not exile you', async () => {
    await setFreeze(rahim, true);

    const incoming = await sendMoney(app, karim, rahim, TK(500));
    expect(incoming.statusCode).toBe(201);
    expect(await userBalance(rahim.id)).toBe(BONUS + TK(500));
    await assertBooksBalance();
  });

  it('refuses to unfreeze without the PIN, and accepts it with', async () => {
    await setFreeze(rahim, true);

    // Whoever stole the session must not be able to simply switch it back off.
    expect((await setFreeze(rahim, false)).statusCode).toBe(400);
    expect((await setFreeze(rahim, false, '0000')).statusCode).toBe(401);
    expect(await accountStatus(rahim.id)).toBe('FROZEN');

    const unfrozen = await setFreeze(rahim, false, rahim.pin);
    expect(unfrozen.statusCode).toBe(200);
    expect(unfrozen.json().account.status).toBe('ACTIVE');

    expect((await sendMoney(app, rahim, karim, TK(100))).statusCode).toBe(201);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(100));
  });

  it('treats freezing twice as success, not as an error', async () => {
    expect((await setFreeze(rahim, true)).statusCode).toBe(200);
    expect((await setFreeze(rahim, true)).statusCode).toBe(200);

    // The second one changed nothing, so it produced no second audit row and no second event.
    expect(await countRows('audit_logs', "WHERE action = 'SELF_FREEZE'")).toBe(1);
  });

  it('tells the owner it happened, in case it was not them who did it', async () => {
    await setFreeze(rahim, true);
    await runWorkers(app);

    expect(
      await countRows('notifications', "WHERE user_id = $1 AND type = 'ACCOUNT_FROZEN'", [rahim.id]),
    ).toBe(1);
  });

  it('is decided by the row lock when a freeze races a payment', async () => {
    const [transfer, frozen] = await Promise.all([
      sendMoney(app, rahim, karim, TK(2500)),
      setFreeze(rahim, true),
    ]);

    expect(frozen.statusCode).toBe(200);
    // Either order is correct. What must never happen is a frozen account that paid out anyway,
    // or a refused transfer that moved money regardless.
    expect([201, 403]).toContain(transfer.statusCode);

    const expected = transfer.statusCode === 201 ? BONUS - TK(2500) : BONUS;
    expect(await userBalance(rahim.id)).toBe(expected);
    await assertBooksBalance();
  });

  it('refuses to freeze a closed account', async () => {
    await query("UPDATE accounts SET status = 'CLOSED' WHERE user_id = $1", [rahim.id]);

    const response = await setFreeze(rahim, true);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('INVALID_STATE');
  });

  it('cannot be used to freeze anyone else', async () => {
    // The endpoint takes no user id at all: it operates on the caller's own account, so there is
    // no parameter to tamper with.
    await setFreeze(rahim, true);
    expect(await accountStatus(karim.id)).toBe('ACTIVE');
    expect((await sendMoney(app, karim, rahim, TK(100))).statusCode).toBe(201);
  });
});
