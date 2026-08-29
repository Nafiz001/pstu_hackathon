/**
 * Auth routes. Handlers do three things and nothing else: validate, call a service, shape a
 * response. No business logic lives here, so the rules are testable without HTTP.
 */
import type { FastifyInstance } from 'fastify';
import { contextOf, currentUser, requireAuth } from '../../platform/http/context.js';
import { errors } from '../../platform/errors/index.js';
import { money } from '../../shared/money.js';
import * as service from './auth.service.js';
import * as repo from './auth.repo.js';
import { loginSchema, refreshSchema, registerSchema } from './auth.schemas.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/register', async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const result = await service.register(input, contextOf(request));
    return reply.code(201).send(result);
  });

  app.post('/auth/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const result = await service.login(input, contextOf(request));
    return reply.code(200).send(result);
  });

  app.post('/auth/refresh', async (request, reply) => {
    const input = refreshSchema.parse(request.body);
    const result = await service.refresh(input.refreshToken, contextOf(request));
    return reply.code(200).send(result);
  });

  app.post('/auth/logout', async (request, reply) => {
    const input = refreshSchema.parse(request.body);
    await service.logout(input.refreshToken);
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = currentUser(request);
    const user = await repo.findUserById(id);
    if (!user) throw errors.notFound('User');
    const account = await repo.findAccountByUserId(id);
    if (!account) throw errors.notFound('Account');

    return reply.send({
      user: { id: user.id, phone: user.phone, name: user.name, createdAt: user.createdAt },
      account: { id: account.id, status: account.status, balance: money(account.balanceMinor) },
    });
  });
}
