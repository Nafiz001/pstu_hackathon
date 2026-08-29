/**
 * Read routing, with read-your-writes.
 *
 * Sending history and notification reads to a streaming replica is how the read path scales past
 * one machine. The catch is replication lag: a user who has just sent money and is redirected to
 * a replica that has not replayed that commit yet sees their *old* balance. In a wallet, that
 * looks exactly like the money vanishing.
 *
 * The fix is precise rather than timing-based. Postgres exposes WAL positions:
 *
 *   1. A write transaction records where it landed  (`pg_current_wal_insert_lsn()`).
 *   2. That position is stored against the user for a short window, in Redis.
 *   3. Before serving that user from a replica, the replica is asked whether it has replayed
 *      that far (`pg_last_wal_replay_lsn() >= $lsn`). If not, the read goes to the primary.
 *
 * So a user always sees at least their own writes, while everyone else's reads still spread
 * across replicas. Compared with "pin the user to the primary for N seconds", this is neither
 * too short (which would serve stale data) nor too long (which would waste the replica).
 *
 * If Redis is unavailable, no write position can be read, and the router conservatively serves
 * that user from the primary. Degrading costs throughput, never correctness.
 */
import pg from 'pg';
import { config } from '../../config/index.js';
import { logger } from '../logging/index.js';
import { tryRedis } from '../cache/redis.js';
import { pool } from './pool.js';
import type { Tx } from './transaction.js';
import { withTransaction } from './transaction.js';

const { Pool } = pg;

/** How long after a write that user's reads keep checking replica freshness. */
const WRITE_TRACKING_TTL_SECONDS = 30;

const lsnKey = (userId: string) => `wlsn:${userId}`;

let replicaPool: pg.Pool | null = null;

export function getReplicaPool(): pg.Pool | null {
  if (!config.REPLICA_DATABASE_URL) return null;
  if (replicaPool) return replicaPool;

  replicaPool = new Pool({
    connectionString: config.REPLICA_DATABASE_URL,
    max: config.PG_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    application_name: `takaflow-api-replica-reader(${config.INSTANCE_ID})`,
  });

  replicaPool.on('error', (error) => {
    logger.warn({ err: error.message }, 'replica pool error — reads will fall back to primary');
  });

  logger.info('read replica configured');
  return replicaPool;
}

/**
 * Record where this transaction's writes landed in the WAL, so subsequent reads by the same user
 * can tell whether a replica has caught up. Call inside a write transaction, before it commits.
 *
 * A no-op when no replica is configured: there is nothing to be behind.
 */
export async function trackWrite(tx: Tx, ...userIds: Array<string | null | undefined>): Promise<void> {
  const targets = userIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (!config.REPLICA_DATABASE_URL || targets.length === 0) return;

  const { rows } = await tx.query<{ lsn: string }>(
    'SELECT pg_current_wal_insert_lsn()::text AS lsn',
  );
  const lsn = rows[0]?.lsn;
  if (!lsn) return;

  // Published only if the transaction commits — a rolled-back write must not make this user's
  // reads wait for a WAL position that will never exist.
  tx.afterCommit(async () => {
    await tryRedis(async (redis) => {
      const pipeline = redis.pipeline();
      // Both sides of a movement are tracked: the recipient did not write, but they still
      // expect to see money that has just arrived rather than a replica's older snapshot.
      for (const id of targets) pipeline.set(lsnKey(id), lsn, 'EX', WRITE_TRACKING_TTL_SECONDS);
      await pipeline.exec();
    }, undefined);
  });
}

async function replicaHasCaughtUp(client: pg.PoolClient, lsn: string): Promise<boolean> {
  try {
    const { rows } = await client.query<{ caught_up: boolean }>(
      'SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS caught_up',
      [lsn],
    );
    return rows[0]?.caught_up === true;
  } catch (error) {
    // A replica that cannot answer this question is not a replica we should read from.
    logger.warn({ err: (error as Error).message }, 'replica freshness check failed');
    return false;
  }
}

export interface ReadOptions {
  /** Reads on behalf of this user must reflect that user's own writes. */
  userId?: string;
}

export interface RoutedRead<T> {
  result: T;
  servedBy: 'primary' | 'replica';
}

/**
 * Run a read-only query set, on the replica when it is safe and on the primary when it is not.
 */
export async function withRoutedRead<T>(
  fn: (tx: Tx) => Promise<T>,
  options: ReadOptions = {},
): Promise<RoutedRead<T>> {
  const replica = getReplicaPool();

  if (!replica) {
    return { result: await withTransaction(fn, { readOnly: true, maxAttempts: 1 }), servedBy: 'primary' };
  }

  const requiredLsn = options.userId
    ? await tryRedis(async (redis) => redis.get(lsnKey(options.userId!)), null)
    : null;

  let client: pg.PoolClient | undefined;
  try {
    client = await replica.connect();

    if (requiredLsn !== null && !(await replicaHasCaughtUp(client, requiredLsn))) {
      client.release();
      client = undefined;
      logger.debug({ userId: options.userId }, 'replica behind writer — serving from primary');
      return {
        result: await withTransaction(fn, { readOnly: true, maxAttempts: 1 }),
        servedBy: 'primary',
      };
    }

    const tx: Tx = {
      client,
      query: (text, params = []) => client!.query(text, params as unknown[]),
      // A read transaction has nothing to publish; accepting the hook and ignoring it keeps the
      // Tx interface uniform for repositories that do not care which pool they are running on.
      afterCommit: () => undefined,
    };

    await client.query('BEGIN READ ONLY');
    try {
      const result = await fn(tx);
      await client.query('COMMIT');
      return { result, servedBy: 'replica' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } catch (error) {
    logger.warn({ err: (error as Error).message }, 'replica read failed — retrying on primary');
    return {
      result: await withTransaction(fn, { readOnly: true, maxAttempts: 1 }),
      servedBy: 'primary',
    };
  } finally {
    client?.release();
  }
}

export async function closeReplicaPool(): Promise<void> {
  if (replicaPool) {
    await replicaPool.end();
    replicaPool = null;
  }
}
