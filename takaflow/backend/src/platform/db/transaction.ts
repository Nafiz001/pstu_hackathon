/**
 * The single transaction boundary for the whole system.
 *
 * EVERY money path goes through this function. That is not a style preference:
 *
 *   - Retry policy for serialization failures (40001) and deadlocks (40P01) lives in one place,
 *     so no module can quietly forget it or implement it slightly differently.
 *   - The client is always released, on every path, including a failed ROLLBACK.
 *   - Timeouts are set per transaction, so a pathological statement cannot hold row locks on
 *     accounts while the rest of the system queues behind it.
 *
 * Retrying is safe because a rolled-back transaction leaves no trace: the retry re-reads the
 * world and re-decides. Anything with an effect outside Postgres (HTTP calls, publishing to a
 * broker, sending mail) must therefore NOT be done inside the callback — it would be re-executed
 * on retry. That is why side effects go through the outbox instead.
 */
import type { PoolClient, QueryResultRow } from './pool.js';
import { pool } from './pool.js';
import { errors, PG_ERRORS, pgErrorCode } from '../errors/index.js';
import { logger } from '../logging/index.js';
import { config } from '../../config/index.js';
import { txDeadlineExceeded, txDuration, txRetries } from '../metrics/index.js';
import pg from 'pg';

/**
 * The minimum a repository needs: something it can run a query on.
 *
 * Both `Tx` and the pool satisfy this. Repositories accept an `Executor` rather than reaching
 * for the pool themselves, because a repository that grabs its own connection while the caller
 * is inside a transaction will **deadlock the pool**: the transaction holds one connection and
 * waits for a second, and once concurrency reaches the pool size none of them can ever proceed.
 * Worse, it waits while holding row locks, so everything else queues behind it too.
 *
 * We shipped exactly that bug and it took a lock-graph dump to find. The type now makes the
 * dependency explicit: if a function needs to read inside a transaction, it must be handed the
 * transaction.
 */
export interface Executor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<T>>;
}

export interface Tx extends Executor {
  /** Escape hatch for the rare case a caller genuinely needs the raw client. */
  readonly client: PoolClient;
  /**
   * Register work to run *after* this transaction commits, and only if it commits.
   *
   * This is the sanctioned way to touch anything outside Postgres — invalidating a cache,
   * recording a write position for read routing, publishing to a broker. Doing that work inside
   * the transaction would be wrong twice over: the effect would happen even when the transaction
   * later rolls back, and `withTransaction` may re-run the callback on a retry, so it would
   * happen more than once.
   *
   * Hooks run sequentially and their failures are logged, never propagated: a cache that will
   * not accept a write must not turn a committed payment into an error response.
   */
  afterCommit(hook: () => Promise<void>): void;
}

export interface TransactionOptions {
  /** READ COMMITTED is the default; the write path relies on explicit row locks, not on SSI. */
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
  readOnly?: boolean;
  maxAttempts?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** Wall-clock ceiling for the whole call, retries included. See config.TRANSACTION_DEADLINE_MS. */
  deadlineMs?: number;
}

const RETRYABLE = new Set<string>([PG_ERRORS.SERIALIZATION_FAILURE, PG_ERRORS.DEADLOCK_DETECTED]);

export function isRetryable(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code !== undefined && RETRYABLE.has(code);
}

/** Full jitter: spreads retries of a contended row instead of resynchronising them. */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(10 * 2 ** (attempt - 1), 120);
  return Math.random() * ceiling;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const {
    isolationLevel = 'READ COMMITTED',
    readOnly = false,
    maxAttempts = 3,
    lockTimeoutMs,
    statementTimeoutMs,
    deadlineMs = config.TRANSACTION_DEADLINE_MS,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const client = await pool.connect();

    /**
     * The clock starts HERE, after the connection is in hand — not when the caller asked for a
     * transaction.
     *
     * The deadline exists to bound how long this transaction holds row locks. Time spent queueing
     * for a pooled connection holds no locks at all, and it is already bounded separately by
     * `connectionTimeoutMillis`. Starting the clock earlier made the two limits compound: under
     * load a request could wait 3s for a connection, then be abandoned 2s later having done no
     * work, turning ordinary queueing into a wave of failed transfers.
     */
    const deadlineAt = Date.now() + deadlineMs;
    // Reset on every attempt: hooks registered by an attempt that then rolled back must not run.
    const hooks: Array<() => Promise<void>> = [];
    const tx: Tx = {
      client,
      /**
       * The deadline is checked before every statement, not only at the start.
       *
       * This is what actually bounds how long this transaction can hold a row lock. Server-side
       * timeouts cannot see time spent on the wire, so under network latency they let a
       * transaction stall for as long as the network is slow. Refusing to issue the next
       * statement is the only place that time is visible.
       */
      query: (text, params = []) => {
        if (Date.now() > deadlineAt) {
          txDeadlineExceeded.inc();
          throw errors.unavailable(
            'Transaction exceeded its time budget and was abandoned to release locks',
          );
        }
        return client.query(text, params as unknown[]);
      },
      afterCommit: (hook) => {
        hooks.push(hook);
      },
    };

    const startedAt = performance.now();
    try {
      /**
       * One round trip, not three.
       *
       * BEGIN and the two SET LOCALs are sent as a single simple query. On a healthy local link
       * that saves a fraction of a millisecond and hardly matters; on a degraded link it is the
       * difference between the deadline below being able to fire and the preamble alone
       * consuming the entire budget before a single check runs.
       *
       * The timeouts are always asserted, not only when overridden: they bound how long this
       * transaction may hold a row lock, and that guarantee should not depend on role defaults
       * being in place on whichever database the connection happened to reach.
       */
      await client.query(
        `BEGIN ISOLATION LEVEL ${isolationLevel}${readOnly ? ' READ ONLY' : ''};` +
          `SET LOCAL lock_timeout = ${Number(lockTimeoutMs ?? config.LOCK_TIMEOUT_MS)};` +
          `SET LOCAL statement_timeout = ${Number(statementTimeoutMs ?? config.STATEMENT_TIMEOUT_MS)};`,
      );

      if (Date.now() > deadlineAt) {
        throw errors.unavailable('Transaction budget was exhausted before any work began');
      }

      const result = await fn(tx);
      await client.query('COMMIT');
      txDuration.observe((performance.now() - startedAt) / 1000);

      // Past this line the money has moved and the caller is owed a success response. Nothing
      // a hook does may change that, so failures are logged and swallowed.
      for (const hook of hooks) {
        try {
          await hook();
        } catch (error) {
          logger.error({ err: error }, 'after-commit hook failed (transaction already committed)');
        }
      }

      return result;
    } catch (error) {
      // A failed rollback (connection already gone) must not mask the original error.
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection is unusable; releasing with an error destroys it */
      }

      lastError = error;

      // Each attempt gets its own budget, so a retry is gated on the attempt count alone. A
      // serialization failure or deadlock aborts the transaction almost immediately, so retrying
      // costs little; refusing to retry because the *previous* attempt used its time would turn a
      // recoverable conflict into a user-visible failure.
      if (isRetryable(error) && attempt < maxAttempts) {
        const delay = backoffMs(attempt);
        txRetries.inc({ sqlstate: pgErrorCode(error) ?? 'unknown' });
        logger.warn(
          { attempt, maxAttempts, delay, code: pgErrorCode(error) },
          'retrying transaction after concurrency conflict',
        );
        await sleep(delay);
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  throw lastError;
}

/** Read-only convenience wrapper: reporting and reconciliation queries. */
export async function withReadTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTransaction(fn, { readOnly: true, maxAttempts: 1 });
}
