/**
 * Drives the real application through `app.inject()` — same routes, validation, auth, and error
 * handling as production, without a network in the way.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { config } from '../../src/config/index.js';

export type TestApp = FastifyInstance;

export async function createTestApp(): Promise<TestApp> {
  return buildApp();
}

export interface TestUser {
  id: string;
  phone: string;
  name: string;
  password: string;
  pin: string;
  accountId: string;
  accessToken: string;
  refreshToken: string;
}

let phoneCounter = 0;

/** Unique, valid BD mobile number per call, so tests never collide on the phone unique index. */
export function nextPhone(): string {
  phoneCounter += 1;
  return `017${String(phoneCounter).padStart(8, '0')}`;
}

export async function registerUser(
  app: TestApp,
  overrides: Partial<{ phone: string; name: string; password: string; pin: string }> = {},
): Promise<TestUser> {
  const phone = overrides.phone ?? nextPhone();
  const password = overrides.password ?? 'correct-horse-battery';
  const pin = overrides.pin ?? '1234';
  const name = overrides.name ?? `User ${phone.slice(-4)}`;

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { phone, name, password, pin },
  });

  if (response.statusCode !== 201) {
    throw new Error(`registerUser failed (${response.statusCode}): ${response.body}`);
  }

  const parsed = response.json() as {
    user: { id: string; phone: string; name: string };
    account: { id: string };
    accessToken: string;
    refreshToken: string;
  };

  return {
    id: parsed.user.id,
    phone: parsed.user.phone,
    name: parsed.user.name,
    password,
    pin,
    accountId: parsed.account.id,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
  };
}

export function authHeaders(user: TestUser): Record<string, string> {
  return { authorization: `Bearer ${user.accessToken}` };
}

let keyCounter = 0;

/** A fresh idempotency key, as a client would mint one per user intent. */
export function newIdempotencyKey(prefix = 'test'): string {
  keyCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${String(keyCounter).padStart(6, '0')}`;
}

/** Requester asks `payer` for money. */
export async function createRequest(
  app: TestApp,
  requester: TestUser,
  payer: TestUser,
  amountMinor: bigint | string,
  options: { note?: string; expiresInDays?: number; idempotencyKey?: string } = {},
) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/requests',
    headers: {
      ...authHeaders(requester),
      'idempotency-key': options.idempotencyKey ?? newIdempotencyKey('req'),
    },
    payload: {
      fromPhone: payer.phone,
      amountMinor: amountMinor.toString(),
      ...(options.note !== undefined ? { note: options.note } : {}),
      ...(options.expiresInDays !== undefined ? { expiresInDays: options.expiresInDays } : {}),
    },
  });
}

export async function acceptRequest(
  app: TestApp,
  payer: TestUser,
  requestId: string,
  options: { idempotencyKey?: string; pin?: string } = {},
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/requests/${requestId}/accept`,
    headers: {
      ...authHeaders(payer),
      'idempotency-key': options.idempotencyKey ?? newIdempotencyKey('acc'),
    },
    payload: { pin: options.pin ?? payer.pin },
  });
}

export async function runWorkers(app: TestApp) {
  // Running the workers is an operator action, so it carries the operator token.
  return app.inject({
    method: 'POST',
    url: '/api/v1/admin/workers/run',
    headers: { 'x-admin-token': config.ADMIN_API_TOKEN ?? '' },
  });
}

export interface SendMoneyOptions {
  idempotencyKey?: string;
  pin?: string;
  note?: string;
  /** Send a deliberately malformed body (used by validation tests). */
  rawPayload?: Record<string, unknown>;
}

export async function sendMoney(
  app: TestApp,
  from: TestUser,
  to: TestUser | { phone: string },
  amountMinor: bigint | string,
  options: SendMoneyOptions = {},
) {
  const payload = options.rawPayload ?? {
    toPhone: to.phone,
    amountMinor: amountMinor.toString(),
    pin: options.pin ?? from.pin,
    ...(options.note !== undefined ? { note: options.note } : {}),
  };

  return app.inject({
    method: 'POST',
    url: '/api/v1/transfers',
    headers: {
      ...authHeaders(from),
      'idempotency-key': options.idempotencyKey ?? newIdempotencyKey(),
    },
    payload,
  });
}
