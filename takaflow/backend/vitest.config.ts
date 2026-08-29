import { defineConfig } from 'vitest/config';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? 'postgres://takaflow:takaflow@127.0.0.1:5433/takaflow_test',
  JWT_SECRET: 'test-secret-not-used-anywhere-else',
  LOG_LEVEL: 'silent',
  /**
   * The concurrency and property suites deliberately drive 200-300 simultaneous transactions to
   * exercise row-lock behaviour — several times the concurrency any single production instance
   * sees. Pool sizing is not what they are testing, and at 20 connections on a shared CI machine
   * they become a test of queueing instead.
   *
   * This is NOT papering over the pool self-deadlock found in `acceptRequest`; that was a real
   * bug (a repository taking a second connection while its caller held a transaction) and it is
   * fixed at the source — see the header of auth.repo.ts. Production keeps the smaller,
   * deliberate pool.
   */
  PG_POOL_MAX: '40',
  /** The operator endpoints fail closed without this, which is itself one of the things tested. */
  ADMIN_API_TOKEN: 'test-operator-token-not-a-real-secret',
  /**
   * The concurrency and paging suites deliberately drive hundreds of transfers from one account,
   * which is exactly what the velocity limiter exists to stop. They are not testing it, so the
   * default is effectively off here; velocity.spec.ts sets a real limit through the operator
   * endpoint and puts it back afterwards.
   */
  VELOCITY_MAX_TRANSFERS: '100000',
} as const;

// Applied to THIS process as well, not only to the workers: `globalSetup` runs in the main
// Vitest process, and it is what migrates the test database. Without this it would connect to
// whatever DATABASE_URL .env supplies — i.e. the development database.
Object.assign(process.env, TEST_ENV);

export default defineConfig({
  test: {
    env: { ...TEST_ENV },
    globalSetup: ['./tests/global-setup.ts'],
    include: ['tests/**/*.spec.ts'],
    // These tests assert on global database state (total money in the system, row counts), so
    // they must not run concurrently against one shared database.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
