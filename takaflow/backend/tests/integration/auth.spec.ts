/**
 * Registration is the first place this system moves money, so it is the first place the
 * invariants have to hold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, nextPhone, registerUser, type TestApp } from '../helpers/app.js';
import { assertBooksBalance, countRows, resetDatabase, totalBalance, userBalance } from '../helpers/db.js';
import { closePool, query } from '../../src/platform/db/pool.js';
import { TREASURY_ACCOUNT_IDS } from '../../src/config/index.js';

const SIGNUP_BONUS = 10_000_000n; // BDT 100,000

let app: TestApp;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
});

describe('POST /auth/register', () => {
  it('creates the user, the account, and funds it as a real double-entry mint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { phone: '01712345678', name: 'Rahim Uddin', password: 'correct-horse', pin: '4821' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();

    expect(body.user).toMatchObject({ phone: '01712345678', name: 'Rahim Uddin' });
    expect(body.account.balance).toEqual({
      minor: '10000000',
      formatted: '100,000.00',
      currency: 'BDT',
    });
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.refreshToken).toBeTypeOf('string');

    // The bonus is a movement, not an initial value: one MINT transfer, two ledger entries.
    expect(await countRows('transfers', "WHERE type = 'MINT'")).toBe(1);
    expect(await countRows('ledger_entries')).toBe(2);

    const { rows } = await query<{ direction: string; amount_minor: string; account_id: string }>(
      'SELECT direction, amount_minor, account_id FROM ledger_entries ORDER BY direction',
    );
    // ORDER BY on an enum column sorts by declaration order: DEBIT, then CREDIT.
    expect(rows.map((r) => r.direction)).toEqual(['DEBIT', 'CREDIT']);
    expect(rows.every((r) => r.amount_minor === SIGNUP_BONUS.toString())).toBe(true);
    // The debit lands on one of the treasury stripes; which one is deliberately unpredictable.
    expect(TREASURY_ACCOUNT_IDS).toContain(rows.find((r) => r.direction === 'DEBIT')!.account_id);

    await assertBooksBalance();
  });

  it('leaves the treasury holding the exact negative of all money issued', async () => {
    await registerUser(app);
    await registerUser(app);
    await registerUser(app);

    // The treasury is striped, so its balance is the sum across every stripe.
    const { rows } = await query<{ balance_minor: string }>(
      "SELECT COALESCE(SUM(balance_minor), 0)::text AS balance_minor FROM accounts WHERE type = 'SYSTEM'",
    );
    expect(rows[0]!.balance_minor).toBe((-3n * SIGNUP_BONUS).toString());
    expect(await totalBalance()).toBe(0n);
    await assertBooksBalance();
  });

  it('is atomic: a duplicate phone leaves no user, account, transfer or ledger entry behind', async () => {
    const phone = nextPhone();
    await registerUser(app, { phone });

    const before = {
      users: await countRows('users'),
      accounts: await countRows('accounts'),
      transfers: await countRows('transfers'),
      entries: await countRows('ledger_entries'),
      treasury: await totalBalance(),
    };

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { phone, name: 'Impostor', password: 'another-password', pin: '9999' },
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('DUPLICATE');

    expect(await countRows('users')).toBe(before.users);
    expect(await countRows('accounts')).toBe(before.accounts);
    expect(await countRows('transfers')).toBe(before.transfers);
    expect(await countRows('ledger_entries')).toBe(before.entries);
    expect(await totalBalance()).toBe(before.treasury);
    await assertBooksBalance();
  });

  it('emits exactly one outbox event, written inside the same transaction as the money', async () => {
    const user = await registerUser(app);
    const { rows } = await query<{ event_type: string; aggregate_id: string; status: string }>(
      'SELECT event_type, aggregate_id, status FROM outbox_events',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'USER_REGISTERED',
      aggregate_id: user.id,
      status: 'PENDING',
    });
  });

  it('records an audit entry for the registration', async () => {
    const user = await registerUser(app);
    expect(await countRows('audit_logs', "WHERE action = 'USER_REGISTERED' AND actor_user_id = $1", [user.id])).toBe(1);
  });

  it('never stores the password or PIN in a recoverable form', async () => {
    const user = await registerUser(app, { password: 'super-secret-pw', pin: '2468' });
    const { rows } = await query<{ password_hash: string; pin_hash: string }>(
      'SELECT password_hash, pin_hash FROM users WHERE id = $1',
      [user.id],
    );
    expect(rows[0]!.password_hash).not.toContain('super-secret-pw');
    expect(rows[0]!.pin_hash).not.toContain('2468');
    expect(rows[0]!.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(rows[0]!.pin_hash.startsWith('$argon2id$')).toBe(true);
    expect(rows[0]!.password_hash).not.toBe(rows[0]!.pin_hash);
  });

  it.each([
    ['a non-Bangladeshi phone number', { phone: '12345678901' }],
    ['a phone number of the wrong length', { phone: '0171234567' }],
    ['a short password', { password: 'short' }],
    ['a non-numeric PIN', { pin: 'abcd' }],
    ['a 6-digit PIN', { pin: '123456' }],
    ['an empty name', { name: '' }],
  ])('rejects %s with 400 and moves no money', async (_label, override) => {
    const payload = {
      phone: '01798765432',
      name: 'Valid Name',
      password: 'valid-password',
      pin: '1234',
      ...override,
    };
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(await countRows('users')).toBe(0);
    expect(await countRows('ledger_entries')).toBe(0);
  });
});

describe('POST /auth/login', () => {
  it('returns a session and the current balance', async () => {
    const user = await registerUser(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone: user.phone, password: user.password },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().account.balance.minor).toBe(SIGNUP_BONUS.toString());
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    const user = await registerUser(app);

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone: user.phone, password: 'not-the-password' },
    });
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { phone: '01999999999', password: 'not-the-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    // Identical code and message: the endpoint must not reveal which phone numbers exist.
    expect(wrongPassword.json().error.code).toBe(unknownUser.json().error.code);
    expect(wrongPassword.json().error.message).toBe(unknownUser.json().error.message);
  });
});

describe('POST /auth/refresh', () => {
  it('rotates the refresh token on every use', async () => {
    const user = await registerUser(app);

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });

    expect(first.statusCode).toBe(200);
    const rotated = first.json().refreshToken as string;
    expect(rotated).not.toBe(user.refreshToken);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: rotated },
    });
    expect(second.statusCode).toBe(200);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const user = await registerUser(app);

    const rotate = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    const rotated = rotate.json().refreshToken as string;

    // Replaying the original token means two parties hold it: treat it as theft.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(replay.statusCode).toBe(401);

    // ...and the token issued from it is dead too, not just the replayed one.
    const afterRevocation = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: rotated },
    });
    expect(afterRevocation.statusCode).toBe(401);

    expect(await countRows('audit_logs', "WHERE action = 'REFRESH_TOKEN_REUSE_DETECTED'")).toBe(1);
  });

  it('rejects an unknown refresh token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: 'a'.repeat(43) },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /me and /accounts/me', () => {
  it('requires a bearer token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a malformed token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns the profile and balance of the authenticated user', async () => {
    const user = await registerUser(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.phone).toBe(user.phone);
    expect(response.json().account.balance.minor).toBe(SIGNUP_BONUS.toString());
    expect(await userBalance(user.id)).toBe(SIGNUP_BONUS);
  });

  it('reports the rolling 24h outbound total for the daily limit', async () => {
    const user = await registerUser(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    // The signup mint is inbound and of type MINT: it must not count against a send limit.
    expect(response.json().account.spentLast24h.minor).toBe('0');
  });
});

describe('GET /users/search', () => {
  it('finds a payee by exact phone number', async () => {
    const me = await registerUser(app);
    const payee = await registerUser(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/users/search?q=${payee.phone}`,
      headers: { authorization: `Bearer ${me.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ id: payee.id, phone: payee.phone, isSelf: false });
  });

  it('does not allow enumeration by partial number', async () => {
    const me = await registerUser(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/users/search?q=0171',
      headers: { authorization: `Bearer ${me.accessToken}` },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('operational endpoints', () => {
  it('reports liveness without touching the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });

  it('reports readiness including applied migrations', async () => {
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ready');
    expect(response.json().migrations).toBeGreaterThan(0);
  });

  it('returns a structured error envelope with a request id for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: 'NOT_FOUND' });
    expect(response.json().error.requestId).toBeTypeOf('string');
  });
});
