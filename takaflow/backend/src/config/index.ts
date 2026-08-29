/**
 * Configuration is parsed and validated exactly once, at boot.
 *
 * A money service that starts with a missing JWT secret or an unparseable limit and only
 * discovers it on the first transfer is a worse failure than one that refuses to start.
 */
import { hostname } from 'node:os';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const intFromEnv = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : Number(value)))
    .pipe(z.number().int().positive());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromEnv(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  /** Optional streaming replica. When absent, every read is served by the primary. */
  REPLICA_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().default('redis://127.0.0.1:6380'),
  /**
   * Identifies which API replica served a request, in logs and in /healthz. Defaults to the
   * container hostname, so replicas of one compose service still identify themselves.
   */
  INSTANCE_ID: z.string().default(hostname()),

  JWT_SECRET: z.string().min(8),
  ACCESS_TOKEN_TTL_SECONDS: intFromEnv(900),
  REFRESH_TOKEN_TTL_SECONDS: intFromEnv(604_800),

  SIGNUP_BONUS_MINOR: intFromEnv(10_000_000),
  MIN_TRANSFER_MINOR: intFromEnv(100),
  MAX_TRANSFER_MINOR: intFromEnv(5_000_000),
  DAILY_TRANSFER_LIMIT_MINOR: intFromEnv(20_000_000),

  PG_POOL_MAX: intFromEnv(20),
  STATEMENT_TIMEOUT_MS: intFromEnv(5_000),
  LOCK_TIMEOUT_MS: intFromEnv(3_000),
  /**
   * Wall-clock ceiling for one transaction, enforced by the application.
   *
   * Postgres cannot provide this. `statement_timeout` bounds how long the *server* spends
   * executing a statement, and `idle_in_transaction_session_timeout` bounds a single idle gap —
   * neither bounds the total time a transaction holds its row locks when the network between
   * the application and the database is slow. A transfer issues a dozen round trips; add a few
   * seconds of latency to each and both server-side guards stay happily under their limits
   * while everyone else queues behind the locks.
   */
  TRANSACTION_DEADLINE_MS: intFromEnv(5_000),

  /**
   * How long a sender may undo a transfer. Short on purpose: this is "I picked the wrong
   * person", not a dispute process.
   */
  REVERSAL_WINDOW_SECONDS: intFromEnv(60),

  /**
   * How late a scheduled payment may be and still run.
   *
   * If the service is down for a day, a daily standing order must not fire a day's worth of
   * back-dated payments the moment it returns. Anything later than this is recorded as SKIPPED
   * and the owner is notified. Six hours: late enough to survive an ordinary outage, short
   * enough that nobody is surprised by a withdrawal they had stopped expecting.
   */
  SCHEDULE_CATCHUP_GRACE_MS: intFromEnv(6 * 60 * 60 * 1000),
  /** Attempts at ONE occurrence before it is abandoned. Retries reuse the same occurrence key. */
  SCHEDULE_MAX_ATTEMPTS: intFromEnv(3),
  SCHEDULE_RETRY_BASE_SECONDS: intFromEnv(900),
  SCHEDULE_TICK_MS: intFromEnv(15_000),

  /**
   * Shared secret for the operator endpoints (freeze an account, search the audit log, run the
   * workers on demand). Optional, and when it is absent those endpoints refuse every request
   * rather than falling open — an admin API that is unguarded because nobody set a variable is
   * the worst of the three possible outcomes.
   *
   * A real deployment would use an operator role and per-person credentials; this is honest
   * about being a shared secret rather than pretending to be more.
   */
  ADMIN_API_TOKEN: z.string().min(16).optional(),

  MAX_PIN_ATTEMPTS: intFromEnv(5),
  PIN_LOCKOUT_MINUTES: intFromEnv(15),

  RUN_MIGRATIONS_ON_BOOT: z
    .string()
    .optional()
    .transform((value) => value !== 'false'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = Object.freeze(parsed.data);
export type Config = typeof config;

/**
 * The treasury: the only accounts permitted to hold a negative balance.
 *
 * It is striped across 8 rows (migrations 004 and 006) because every registration mints from it,
 * and a single row would serialise every concurrent signup behind one lock. Writers pick a
 * stripe at random; the treasury's true balance is the sum of all of them.
 */
export const TREASURY_STRIPE_COUNT = 8;

export const TREASURY_ACCOUNT_IDS: readonly string[] = Array.from(
  { length: TREASURY_STRIPE_COUNT },
  (_, index) => `00000000-0000-0000-0000-00000000000${(index + 1).toString(16)}`,
);

/** Stripe 1 — the account seeded by migration 004, kept for tests and fixtures. */
export const TREASURY_ACCOUNT_ID = TREASURY_ACCOUNT_IDS[0]!;

/** Pick a stripe to debit. Random rather than round-robin: no shared counter to contend on. */
export function pickTreasuryStripe(): string {
  return TREASURY_ACCOUNT_IDS[Math.floor(Math.random() * TREASURY_STRIPE_COUNT)]!;
}
