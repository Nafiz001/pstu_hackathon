import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contextOf, currentUser, requireAuth } from '../../platform/http/context.js';
import { requireIdempotencyKey } from '../../platform/idempotency/store.js';
import {
  acceptRequestSchema,
  createRequestSchema,
  declineRequestSchema,
  listRequestsSchema,
} from './request.schemas.js';
import * as service from './request.service.js';

const idParam = z.object({ id: z.string().uuid('Not a valid request id') });

export async function requestRoutes(app: FastifyInstance): Promise<void> {
  app.post('/requests', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const input = createRequestSchema.parse(request.body);

    const outcome = await service.createRequest(
      user.id,
      idempotencyKey,
      input,
      request.body,
      contextOf(request),
    );

    reply.header('Idempotent-Replay', outcome.replayed ? 'true' : 'false');
    return reply.code(outcome.status).send(outcome.body);
  });

  app.get('/requests', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const query = listRequestsSchema.parse(request.query);
    return reply.send(await service.listRequests(user.id, query));
  });

  app.post('/requests/:id/accept', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParam.parse(request.params);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const { pin } = acceptRequestSchema.parse(request.body);

    const outcome = await service.acceptRequest(
      user.id,
      id,
      idempotencyKey,
      pin,
      request.body,
      contextOf(request),
    );

    reply.header('Idempotent-Replay', outcome.replayed ? 'true' : 'false');
    return reply.code(outcome.status).send(outcome.body);
  });

  app.post('/requests/:id/decline', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParam.parse(request.params);
    const { reason } = declineRequestSchema.parse(request.body ?? {});
    const result = await service.declineRequest(user.id, id, reason ?? null, contextOf(request));
    return reply.send({ request: result });
  });

  app.post('/requests/:id/cancel', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParam.parse(request.params);
    const result = await service.cancelRequest(user.id, id, contextOf(request));
    return reply.send({ request: result });
  });
}
