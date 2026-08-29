/**
 * Velocity limiting and security alerts.
 *
 * The two behaviours are deliberately opposite, and that is the point of testing them together:
 * a burst of transfers is REFUSED, and an unusually large one is ALLOWED and reported.
 *
 * The limit is set through the operator endpoint rather than by reaching into module state — the
 * same path an operator would use during an incident, so the test exercises a real feature
 * instead of a test-only hook.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
  createTestApp,
  registerUser,
  runWorkers,
  sendMoney,
  type TestApp,
  type TestUser,
} from '../helpers/app.js';
import { assertBooksBalance, countRows, resetDatabase, userBalance } from '../helpers/db.js';
import { closePool, query } from '../../src/platform/db/pool.js';
import { config } from '../../src/config/index.js';

const BONUS = 10_000_000n;
const TK = (taka: number) => BigInt(taka) * 100n;

let app: TestApp;
let rahim: TestUser;
let karim: TestUser;

const adminHeaders = { 'x-admin-token': config.ADMIN_API_TOKEN ?? '' };

const setPolicy = (body: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: '/api/v1/admin/policy/velocity',
    headers: adminHeaders,
    payload: body,
  });

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

afterEach(async () => {
  // Put the limits back so the rest of the suite is unaffected by whatever a test set.
  await setPolicy({
    windowSeconds: 60,
    maxTransfers: Number(config.VELOCITY_MAX_TRANSFERS),
    alertThresholdMinor: String(config.FRAUD_ALERT_THRESHOLD_MINOR),
  });
});

describe('velocity limiting', () => {
  it('allows the allowance and refuses the next one with 429', async () => {
    await setPolicy({ maxTransfers: 3, windowSeconds: 60 });

    for (let i = 0; i < 3; i += 1) {
      const response = await sendMoney(app, rahim, karim, TK(10));
      expect(response.statusCode, `transfer ${i + 1}`).toBe(201);
    }

    const blocked = await sendMoney(app, rahim, karim, TK(10));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    // A client that is told to slow down should be told for how long.
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // The refused transfer moved nothing.
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(30));
    expect(await countRows('transfers', "WHERE type = 'P2P'")).toBe(3);
    await assertBooksBalance();
  });

  it('holds under a simultaneous burst — the case it exists for', async () => {
    await setPolicy({ maxTransfers: 3, windowSeconds: 60 });

    // Ten at once. A read-then-write limiter lets all ten through here, because every one of
    // them reads the same count before any of them writes.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => sendMoney(app, rahim, karim, TK(10))),
    );

    const accepted = responses.filter((response) => response.statusCode === 201);
    const refused = responses.filter((response) => response.statusCode === 429);

    expect(accepted).toHaveLength(3);
    expect(refused).toHaveLength(7);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(30));
    await assertBooksBalance();
  });

  it('counts per account, so one busy sender does not throttle anyone else', async () => {
    await setPolicy({ maxTransfers: 2, windowSeconds: 60 });

    expect((await sendMoney(app, rahim, karim, TK(10))).statusCode).toBe(201);
    expect((await sendMoney(app, rahim, karim, TK(10))).statusCode).toBe(201);
    expect((await sendMoney(app, rahim, karim, TK(10))).statusCode).toBe(429);

    // Karim has sent nothing, so his allowance is untouched.
    expect((await sendMoney(app, karim, rahim, TK(10))).statusCode).toBe(201);
  });

  it('lets the account send again once the window has passed', async () => {
    await setPolicy({ maxTransfers: 2, windowSeconds: 60 });

    expect((await sendMoney(app, rahim, karim, TK(10))).statusCode).toBe(201);
    expect((await sendMoney(app, rahim, karim, TK(10))).statusCode).toBe(201);
    expect((await sendMoney(app, rahim, karim, TK(10))).statusCode).toBe(429);

    // Age the earlier transfers out of the window rather than waiting a minute for real.
    await query(
      `UPDATE transfers SET created_at = created_at - interval '2 minutes'
        WHERE from_account_id = (SELECT id FROM accounts WHERE user_id = $1)`,
      [rahim.id],
    );

    expect((await sendMoney(app, rahim, karim, TK(10))).statusCode).toBe(201);
  });

  it('does not count money arriving, only money leaving', async () => {
    await setPolicy({ maxTransfers: 2, windowSeconds: 60 });

    // Three payments INTO Rahim's account do not consume his own allowance. They come from three
    // different senders, because each sender spends their own.
    for (let i = 0; i < 3; i += 1) {
      const sender = await registerUser(app);
      expect((await sendMoney(app, sender, rahim, TK(10))).statusCode).toBe(201);
    }

    expect((await sendMoney(app, rahim, karim, TK(10))).statusCode).toBe(201);
  });
});

describe('security alerts for unusual transfers', () => {
  it('lets a large transfer through and flags it', async () => {
    await setPolicy({ alertThresholdMinor: String(TK(2000)) });

    const response = await sendMoney(app, rahim, karim, TK(2500), { note: 'Deposit' });

    // Allowed: it is the user's money and their instruction.
    expect(response.statusCode).toBe(201);
    expect(response.json().securityAlert).toBe(true);
    expect(await userBalance(karim.id)).toBe(BONUS + TK(2500));
    await assertBooksBalance();
  });

  it('does not flag an ordinary transfer', async () => {
    await setPolicy({ alertThresholdMinor: String(TK(2000)) });

    const response = await sendMoney(app, rahim, karim, TK(100));
    expect(response.statusCode).toBe(201);
    expect(response.json().securityAlert).toBeUndefined();
  });

  it('notifies the account owner durably, through the outbox', async () => {
    await setPolicy({ alertThresholdMinor: String(TK(2000)) });
    await sendMoney(app, rahim, karim, TK(2500));

    // The event was written in the same transaction as the money...
    expect(await countRows('outbox_events', "WHERE event_type = 'SECURITY_ALERT'")).toBe(1);

    // ...so the alert survives even if the process delivering it had died.
    await runWorkers(app);
    expect(
      await countRows('notifications', "WHERE user_id = $1 AND type = 'SECURITY_ALERT'", [rahim.id]),
    ).toBe(1);
  });

  it('raises no alert for a transfer that was refused', async () => {
    await setPolicy({ alertThresholdMinor: String(TK(2000)), maxTransfers: 1 });

    expect((await sendMoney(app, rahim, karim, TK(2500))).statusCode).toBe(201);
    // Refused by the velocity limiter, so nothing happened — including the alert.
    expect((await sendMoney(app, rahim, karim, TK(2500))).statusCode).toBe(429);

    expect(await countRows('outbox_events', "WHERE event_type = 'SECURITY_ALERT'")).toBe(1);
  });

  it('replays the flag on an idempotent retry, rather than alerting twice', async () => {
    await setPolicy({ alertThresholdMinor: String(TK(2000)) });

    const key = 'velocity-replay-key';
    const first = await sendMoney(app, rahim, karim, TK(2500), { idempotencyKey: key });
    const retry = await sendMoney(app, rahim, karim, TK(2500), { idempotencyKey: key });

    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    expect(retry.json().securityAlert).toBe(true);
    // One payment, one alert.
    expect(await countRows('outbox_events', "WHERE event_type = 'SECURITY_ALERT'")).toBe(1);
  });
});

describe('the operator can retune the controls without a redeploy', () => {
  it('reads and writes the policy, and rejects a caller without the token', async () => {
    const unauthorised = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/policy/velocity',
      headers: authHeaders(rahim),
      payload: { maxTransfers: 9999 },
    });
    expect(unauthorised.statusCode).toBe(401);

    const updated = await setPolicy({ maxTransfers: 7, windowSeconds: 30 });
    expect(updated.json().policy).toMatchObject({ maxTransfers: 7, windowSeconds: 30 });

    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/policy/velocity',
      headers: adminHeaders,
    });
    expect(read.json().policy.maxTransfers).toBe(7);
  });
});
