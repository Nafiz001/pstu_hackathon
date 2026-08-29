/**
 * Application assembly.
 *
 * `buildApp()` returns a fully wired Fastify instance without listening on a port, so tests can
 * drive the real application through `app.inject()` — the same routing, validation, auth, and
 * error handling that production uses, with no network in the way.
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { randomUUID } from 'node:crypto';
import { config } from './config/index.js';
import { isRedisHealthy } from './platform/cache/redis.js';
import { httpDuration, httpRequests, registry, sampleDatabaseGauges } from './platform/metrics/index.js';
import { loggerOptions } from './platform/logging/index.js';
import { registerErrorHandler } from './platform/http/error-handler.js';
import { query } from './platform/db/pool.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { accountRoutes } from './modules/accounts/accounts.routes.js';
import { transferRoutes } from './modules/transfers/transfer.routes.js';
import { requestRoutes } from './modules/requests/request.routes.js';
import { scheduleRoutes } from './modules/schedules/schedule.routes.js';
import { splitRoutes } from './modules/splits/split.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    // Trust the request id a proxy assigns, otherwise mint one: a single id has to follow a
    // request through logs, audit rows, and the error envelope for any of it to be traceable.
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
    requestIdHeader: 'x-request-id',
    bodyLimit: 64 * 1024,
    /**
     * Close idle keep-alive sockets immediately on shutdown, but let in-flight requests finish.
     *
     * Without this, `app.close()` waits for a proxy's pooled connections to go away on their
     * own, the drain deadline expires, and a *graceful* shutdown ends in a forced kill — the
     * exact opposite of the intent. 'idle' drains correctly: sockets mid-request are respected,
     * sockets merely being held open are not.
     */
    forceCloseConnections: 'idle',
    ajv: { customOptions: { removeAdditional: 'all' } },
  });

  /**
   * Safety net: a bigint anywhere in a response would otherwise throw inside JSON.stringify.
   * Money is serialised deliberately via `money()`; this catches anything that slips through
   * rather than turning it into a 500 at the worst possible moment.
   */
  app.setReplySerializer((payload) =>
    JSON.stringify(payload, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.NODE_ENV === 'production' ? ['http://localhost:5173'] : true,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['Idempotent-Replay', 'Retry-After', 'X-Request-Id'],
  });

  registerErrorHandler(app);

  /**
   * Request metrics.
   *
   * Labelled by ROUTE PATTERN, never by the resolved URL: `/transfers/:reference` is one label,
   * not one per transfer. Labelling by raw path would make the cardinality grow with the number
   * of payments and eventually take Prometheus down — a classic way for observability to become
   * the outage.
   */
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url ?? 'unmatched';
    const labels = {
      method: request.method,
      route,
      status: String(reply.statusCode),
    };
    httpRequests.inc(labels);
    httpDuration.observe(labels, reply.elapsedTime / 1000);
  });

  // --- operational endpoints ------------------------------------------------

  /** Liveness: is the process itself healthy? Deliberately touches no dependency. */
  app.get('/healthz', async () => ({
    status: 'ok',
    instance: config.INSTANCE_ID,
    uptime: process.uptime(),
  }));

  /**
   * Readiness: can this instance actually serve traffic? Checks the database and that
   * migrations have run. A load balancer should stop routing here before the process dies,
   * which is what makes a graceful shutdown graceful.
   */
  app.get('/readyz', async (_request, reply) => {
    if (shuttingDown) {
      return reply.code(503).send({ status: 'shutting_down' });
    }
    try {
      const { rows } = await query<{ count: string }>(
        'SELECT count(*)::text AS count FROM schema_migrations',
      );
      return reply.send({
        status: 'ready',
        instance: config.INSTANCE_ID,
        migrations: Number(rows[0]?.count ?? 0),
        // Reported, never gating: the API is ready to serve money whether or not the cache is up.
        redis: isRedisHealthy() ? 'up' : 'down',
        replica: config.REPLICA_DATABASE_URL ? 'configured' : 'none',
      });
    } catch (error) {
      return reply.code(503).send({
        status: 'not_ready',
        reason: (error as Error).message,
      });
    }
  });

  app.get('/metrics', async (_request, reply) => {
    // Database-backed gauges are sampled here, on scrape, rather than on a timer: a metric
    // nobody is reading should not be querying the ledger.
    await sampleDatabaseGauges();
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  // --- domain routes --------------------------------------------------------

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(accountRoutes);
      await api.register(transferRoutes);
      await api.register(requestRoutes);
      await api.register(scheduleRoutes);
      await api.register(splitRoutes);
      await api.register(adminRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}

let shuttingDown = false;

/** Flipped by the server before it drains, so /readyz starts failing first. */
export function beginShutdown(): void {
  shuttingDown = true;
}
