import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contextOf, currentUser, requireAuth } from '../../platform/http/context.js';
import { requireIdempotencyKey } from '../../platform/idempotency/store.js';
import { createScheduleSchema, listSchedulesSchema } from './schedule.schemas.js';
import * as service from './schedule.service.js';

const idParam = z.object({ id: z.string().uuid('Not a valid schedule id') });

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  app.post('/schedules', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const input = createScheduleSchema.parse(request.body);

    const outcome = await service.createSchedule(
      user.id,
      idempotencyKey,
      input,
      request.body,
      contextOf(request),
    );

    reply.header('Idempotent-Replay', outcome.replayed ? 'true' : 'false');
    return reply.code(outcome.status).send(outcome.body);
  });

  app.get('/schedules', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const query = listSchedulesSchema.parse(request.query);
    return reply.send(await service.listSchedules(user.id, query));
  });

  app.get('/schedules/:id', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParam.parse(request.params);
    return reply.send(await service.getSchedule(user.id, id));
  });

  app.post('/schedules/:id/pause', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParam.parse(request.params);
    return reply.send({ schedule: await service.pauseSchedule(user.id, id, contextOf(request)) });
  });

  app.post('/schedules/:id/resume', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParam.parse(request.params);
    return reply.send({ schedule: await service.resumeSchedule(user.id, id, contextOf(request)) });
  });

  // Cancelling is a state transition, not a deletion: the occurrences it already paid are
  // history, and history is never removed.
  app.delete('/schedules/:id', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParam.parse(request.params);
    return reply.send({ schedule: await service.cancelSchedule(user.id, id, contextOf(request)) });
  });
}
