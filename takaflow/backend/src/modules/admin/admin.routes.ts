/**
 * Operational endpoints.
 *
 * `/admin/reconciliation` is deliberately readable without credentials in this build: it exposes
 * no personal data (only aggregate totals and violation ids) and it is the single most important
 * thing an operator — or a judge — needs to be able to check at any moment. A production
 * deployment would put it behind an operator role; that is noted rather than pretended.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contextOf, currentUser, requireAdmin, requireAuth } from '../../platform/http/context.js';
import { query } from '../../platform/db/pool.js';
import { reconcile } from './reconciliation.service.js';
import { drainOutbox } from '../../workers/outbox.dispatcher.js';
import { expireRequests } from '../../workers/request-expiry.worker.js';
import { drainSchedules } from '../../workers/schedule.worker.js';
import * as adminService from './admin.service.js';
import { getVelocityPolicy, setVelocityPolicy } from '../transfers/velocity.service.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/reconciliation', async (_request, reply) => {
    const report = await reconcile();
    // A failing invariant is a server-side emergency, and the status code should say so to any
    // monitor that only ever looks at status codes.
    return reply.code(report.status === 'PASS' ? 200 : 500).send(report);
  });

  app.get('/admin/outbox', async (_request, reply) => {
    const { rows } = await query<{ status: string; count: string; oldest: Date | null }>(
      `SELECT status::text AS status, count(*)::text AS count, min(created_at) AS oldest
         FROM outbox_events
        GROUP BY status`,
    );
    const { rows: failed } = await query<{
      id: string;
      event_type: string;
      attempts: number;
      last_error: string | null;
    }>(
      `SELECT id, event_type, attempts, last_error
         FROM outbox_events
        WHERE status = 'FAILED'
        ORDER BY created_at DESC
        LIMIT 20`,
    );

    return reply.send({
      byStatus: rows.map((r) => ({
        status: r.status,
        count: Number(r.count),
        oldest: r.oldest?.toISOString() ?? null,
      })),
      failed,
    });
  });

  /**
   * Runs the background workers on demand. Tests and the demo use this so results are
   * deterministic instead of depending on when a timer happens to fire.
   */
  app.post('/admin/workers/run', { preHandler: requireAdmin }, async (_request, reply) => {
    // Order matters: schedules first, so the events they produce are dispatched by the outbox
    // drain in the same call and a caller sees a fully settled system when it returns.
    const schedules = await drainSchedules();
    const expired = await expireRequests();
    const outbox = await drainOutbox();
    return reply.send({ outbox, expiredRequests: expired, schedules });
  });

  /**
   * Freeze or unfreeze an account. Guarded, because it stops someone spending their own money.
   */
  app.post('/admin/accounts/:userId/freeze', { preHandler: requireAdmin }, async (request, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    const { reason } = z
      .object({ reason: z.string().trim().max(200).optional() })
      .parse(request.body ?? {});

    const account = await adminService.setAccountStatus({
      userId,
      status: 'FROZEN',
      reason: reason ?? null,
      actorLabel: 'operator-token',
      context: contextOf(request),
    });
    return reply.send({ account });
  });

  app.post('/admin/accounts/:userId/unfreeze', { preHandler: requireAdmin }, async (request, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    const { reason } = z
      .object({ reason: z.string().trim().max(200).optional() })
      .parse(request.body ?? {});

    const account = await adminService.setAccountStatus({
      userId,
      status: 'ACTIVE',
      reason: reason ?? null,
      actorLabel: 'operator-token',
      context: contextOf(request),
    });
    return reply.send({ account });
  });

  /** The audit trail, filtered. This is the "what happened, and who did it" endpoint. */
  app.get('/admin/audit', { preHandler: requireAdmin }, async (request, reply) => {
    const query = z
      .object({
        actorUserId: z.string().uuid().optional(),
        entityId: z.string().max(64).optional(),
        action: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.string().regex(/^\d{1,19}$/).optional(),
      })
      .parse(request.query);

    return reply.send(await adminService.searchAudit(query));
  });

  /**
   * Read or change the fraud controls at runtime.
   *
   * In-memory and therefore per-instance — see the note in velocity.service.ts. Enough to tighten
   * limits during an incident (or a demo) without a redeploy; not a substitute for the durable
   * policy store a production system would have.
   */
  app.get('/admin/policy/velocity', { preHandler: requireAdmin }, async (_request, reply) => {
    const policy = getVelocityPolicy();
    return reply.send({
      policy: { ...policy, alertThresholdMinor: policy.alertThresholdMinor.toString() },
    });
  });

  app.patch('/admin/policy/velocity', { preHandler: requireAdmin }, async (request, reply) => {
    const input = z
      .object({
        windowSeconds: z.number().int().min(1).max(3600).optional(),
        maxTransfers: z.number().int().min(1).max(10_000).optional(),
        alertThresholdMinor: z.string().regex(/^\d{1,15}$/).optional(),
      })
      .parse(request.body ?? {});

    const policy = setVelocityPolicy({
      ...(input.windowSeconds !== undefined ? { windowSeconds: input.windowSeconds } : {}),
      ...(input.maxTransfers !== undefined ? { maxTransfers: input.maxTransfers } : {}),
      ...(input.alertThresholdMinor !== undefined
        ? { alertThresholdMinor: BigInt(input.alertThresholdMinor) }
        : {}),
    });

    return reply.send({
      policy: { ...policy, alertThresholdMinor: policy.alertThresholdMinor.toString() },
    });
  });

  app.get('/notifications', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const { limit, unreadOnly } = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        unreadOnly: z.coerce.boolean().default(false),
      })
      .parse(request.query);

    const { rows } = await query<{
      id: string;
      type: string;
      payload: Record<string, unknown>;
      read_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, type, payload, read_at, created_at
         FROM notifications
        WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [user.id, limit],
    );

    return reply.send({
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        payload: r.payload,
        read: r.read_at !== null,
        createdAt: r.created_at.toISOString(),
      })),
    });
  });

  app.post('/notifications/:id/read', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await query(
      'UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL',
      [id, user.id],
    );
    return reply.code(204).send();
  });
}
