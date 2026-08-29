/**
 * Redis.
 *
 * The governing rule: **Redis is never a source of truth in this system.** It holds a cache of
 * balances and a note of where each user's last write landed in the WAL. Every value it holds
 * can be recomputed from Postgres, and every code path that reads it works — more slowly —
 * when it returns nothing.
 *
 * That is why this module degrades rather than throws. If Redis is down, `get` returns null and
 * `set` silently does nothing; balances are then read from the primary and reads stop being
 * routed to the replica. Losing the cache costs latency. It cannot cost correctness.
 */
import Redis from 'ioredis';
import { config } from '../../config/index.js';
import { logger } from '../logging/index.js';

let client: Redis | null = null;
let healthy = false;

export function getRedis(): Redis | null {
  if (client !== null) return client;

  client = new Redis(config.REDIS_URL, {
    lazyConnect: false,
    // Fail fast and fall through to Postgres rather than making every request wait on a dead
    // cache. Two commands' worth of patience, then give up.
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    commandTimeout: 500,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });

  client.on('ready', () => {
    healthy = true;
    logger.info('redis connected');
  });
  client.on('error', (error) => {
    if (healthy) logger.warn({ err: error.message }, 'redis unavailable — degrading to Postgres');
    healthy = false;
  });
  client.on('end', () => {
    healthy = false;
  });

  return client;
}

export const isRedisHealthy = (): boolean => healthy;

/** Run a Redis operation, returning `fallback` if the cache is unavailable or slow. */
export async function tryRedis<T>(
  operation: (redis: Redis) => Promise<T>,
  fallback: T,
): Promise<T> {
  const redis = getRedis();
  if (!redis || !healthy) return fallback;
  try {
    return await operation(redis);
  } catch (error) {
    logger.debug({ err: (error as Error).message }, 'redis operation failed; using fallback');
    return fallback;
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => client?.disconnect());
    client = null;
    healthy = false;
  }
}
