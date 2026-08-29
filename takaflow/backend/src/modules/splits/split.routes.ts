import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contextOf, currentUser, requireAuth } from '../../platform/http/context.js';
import { requireIdempotencyKey } from '../../platform/idempotency/store.js';
import { createSplitSchema } from './split.schemas.js';
import * as service from './split.service.js';

const idParam = z.object({ id: z.string().uuid('Not a valid split id') });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });

export async function splitRoutes(app: FastifyInstance): Promise<void> {
  app.post('/splits', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const input = createSplitSchema.parse(request.body);

    const outcome = await service.createSplit(
      user.id,
      idempotencyKey,
      input,
      request.body,
      contextOf(request),
    );

    reply.header('Idempotent-Replay', outcome.replayed ? 'true' : 'false');
    return reply.code(outcome.status).send(outcome.body);
  });

  app.get('/splits', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const { limit } = listQuery.parse(request.query);
    return reply.send(await service.listSplits(user.id, limit));
  });

  app.get('/splits/:id', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParam.parse(request.params);
    return reply.send({ split: await service.getSplit(user.id, id) });
  });
}
