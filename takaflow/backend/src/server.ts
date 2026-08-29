/**
 * Process entry point.
 *
 * Shutdown order matters and is deliberate:
 *   1. flip readiness to failing, so the load balancer stops sending new work
 *   2. stop accepting connections and let in-flight requests finish
 *   3. only then close the pool
 *
 * Closing the pool first would abort transactions that were about to commit. Every one of them
 * would roll back safely — that is what transactions are for — but the client would see failures
 * that a correctly ordered shutdown simply avoids.
 */
import { buildApp, beginShutdown } from './app.js';
import { config } from './config/index.js';
import { runMigrations } from './platform/db/migrate.js';
import { closePool } from './platform/db/pool.js';
import { closeReplicaPool } from './platform/db/read-router.js';
import { closeRedis, getRedis } from './platform/cache/redis.js';
import { logger } from './platform/logging/index.js';
import { startWorkers } from './workers/index.js';

const DRAIN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  if (config.RUN_MIGRATIONS_ON_BOOT) {
    const { applied, alreadyApplied } = await runMigrations();
    logger.info({ applied: applied.length, alreadyApplied }, 'migrations up to date');
  }

  // Connect eagerly so /readyz reports the cache's real state from the first request
  // rather than 'down' until something happens to touch it.
  getRedis();

  const app = await buildApp();
  const workers = startWorkers();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'takaflow api listening');

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;

    logger.info({ signal }, 'shutdown requested');
    beginShutdown();

    const timer = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, DRAIN_GRACE_MS);
    timer.unref();

    try {
      // Order matters: stop accepting work, drain in-flight requests, quiesce the
      // workers, and only then close the pool underneath them.
      await app.close();
      await workers.stop();
      await closePool();
      await closeReplicaPool();
      await closeRedis();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection in a money service is a bug, not something to survive quietly.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
