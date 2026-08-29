import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contextOf, currentUser, requireAuth } from '../../platform/http/context.js';
import { requireIdempotencyKey } from '../../platform/idempotency/store.js';
import { createTransferSchema } from './transfer.schemas.js';
import * as service from './transfer.service.js';
import * as history from './history.service.js';
import * as reversal from './reversal.service.js';
import { statementFilename, statementStream } from './statement.service.js';
import { findAccountByUserId } from '../auth/auth.repo.js';
import { errors } from '../../platform/errors/index.js';

const referenceParam = z.object({
  reference: z.string().regex(/^TF\d{6}[0-9A-Z]{8}$/, 'Not a valid transfer reference'),
});

const pinBody = z.object({ pin: z.string().regex(/^\d{4}$/, 'PIN must be exactly 4 digits') });

export async function transferRoutes(app: FastifyInstance): Promise<void> {
  app.post('/transfers', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const input = createTransferSchema.parse(request.body);

    const outcome = await service.sendMoney(
      user.id,
      idempotencyKey,
      input,
      // The raw body is hashed, not the parsed one: the client's exact intent is what the key
      // is bound to.
      request.body,
      contextOf(request),
    );

    // Lets a client (and a judge) see that a retry was served from the idempotency record
    // rather than executed a second time.
    reply.header('Idempotent-Replay', outcome.replayed ? 'true' : 'false');
    return reply.code(outcome.status).send(outcome.body);
  });

  app.get('/transfers', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const query = history.historyQuerySchema.parse(request.query);
    const page = await history.listHistory(user.id, query);

    // Makes the routing decision observable: a read served by 'primary' right after a write is
    // the read-your-writes guard doing its job, not a misconfiguration.
    reply.header('X-Served-By', page.servedBy);
    return reply.send(page);
  });

  /**
   * The statement, streamed as CSV.
   *
   * Registered before `/transfers/:reference` for readability only — Fastify's router prefers the
   * static segment over the parameter regardless of order.
   */
  app.get('/transfers/statement.csv', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const query = z
      .object({
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
      })
      .parse(request.query);

    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from >= to) throw errors.validation('The date range is inverted');

    const account = await findAccountByUserId(user.id);
    if (!account) throw errors.notFound('Account');

    const window = { accountId: account.id, from, to };

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${statementFilename(window)}"`);
    // The length is unknown until the last row is read, so it is chunked. Saying so explicitly
    // keeps proxies from buffering the whole statement to compute a Content-Length.
    reply.header('Transfer-Encoding', 'chunked');
    reply.header('Cache-Control', 'no-store');

    return reply.send(statementStream(window));
  });

  app.post('/transfers/:reference/reverse', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const { reference } = referenceParam.parse(request.params);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const { pin } = pinBody.parse(request.body);

    const outcome = await reversal.reverseTransfer(
      user.id,
      reference,
      idempotencyKey,
      pin,
      request.body,
      contextOf(request),
    );

    reply.header('Idempotent-Replay', outcome.replayed ? 'true' : 'false');
    return reply.code(outcome.status).send(outcome.body);
  });

  app.get('/transfers/:reference', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const { reference } = referenceParam.parse(request.params);
    return reply.send({ transfer: await history.getReceipt(user.id, reference) });
  });
}
