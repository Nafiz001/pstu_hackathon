/**
 * The one place an error becomes an HTTP response.
 *
 * Two rules:
 *   - Every client-visible failure carries a stable machine-readable `code`, because a client
 *     retrying a transfer needs to distinguish "you already did this" from "try again later".
 *   - Nothing internal leaks. Unrecognised errors become a generic 500 with the request id, and
 *     the detail goes to the log where it belongs.
 *
 * Infrastructure failures are deliberately mapped to 503 rather than 500: 503 tells the client
 * this is retryable, and because every money-moving endpoint is idempotent, retrying is safe.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { DomainError, PG_ERRORS, pgErrorCode } from '../errors/index.js';
import { logger } from '../logging/index.js';

const RETRYABLE_PG = new Set<string>([
  PG_ERRORS.SERIALIZATION_FAILURE,
  PG_ERRORS.DEADLOCK_DETECTED,
  PG_ERRORS.LOCK_NOT_AVAILABLE,
  PG_ERRORS.QUERY_CANCELED,
  PG_ERRORS.ADMIN_SHUTDOWN,
  PG_ERRORS.CANNOT_CONNECT_NOW,
]);

interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

function body(
  code: string,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ErrorBody {
  const payload: ErrorBody = { error: { code, message, requestId } };
  if (details && Object.keys(details).length > 0) payload.error.details = details;
  return payload;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply
      .code(404)
      .send(body('NOT_FOUND', `Route ${request.method} ${request.url} not found`, String(request.id)));
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = String(request.id);

    if (error instanceof DomainError) {
      for (const [header, value] of Object.entries(error.headers)) {
        reply.header(header, value);
      }
      // Expected outcomes (insufficient funds, duplicate key) are information, not incidents.
      logger.info(
        { requestId, code: error.code, status: error.status, path: request.url },
        'domain error',
      );
      reply.code(error.status).send(body(error.code, error.message, requestId, error.details));
      return;
    }

    if (error instanceof ZodError) {
      const details = {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      };
      reply.code(400).send(body('VALIDATION_ERROR', 'Request validation failed', requestId, details));
      return;
    }

    // Fastify's own client-side errors (bad JSON, payload too large, missing content-type).
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      reply
        .code(error.statusCode)
        .send(body(error.code ?? 'VALIDATION_ERROR', error.message, requestId));
      return;
    }

    const pgCode = pgErrorCode(error);
    if (pgCode !== undefined && RETRYABLE_PG.has(pgCode)) {
      logger.warn({ requestId, pgCode, path: request.url }, 'retryable infrastructure error');
      reply
        .header('Retry-After', '2')
        .code(503)
        .send(
          body(
            'SERVICE_UNAVAILABLE',
            'The service is briefly unavailable. Retry with the same Idempotency-Key.',
            requestId,
          ),
        );
      return;
    }

    // Connection-level failures: the database went away mid-request.
    const message = String((error as Error).message ?? '');
    if (
      pgCode === undefined &&
      /(ECONNREFUSED|ECONNRESET|Connection terminated|timeout exceeded when trying to connect|server closed the connection)/i.test(
        message,
      )
    ) {
      logger.error({ requestId, err: error, path: request.url }, 'database connectivity failure');
      reply
        .header('Retry-After', '2')
        .code(503)
        .send(
          body(
            'SERVICE_UNAVAILABLE',
            'The service is briefly unavailable. Retry with the same Idempotency-Key.',
            requestId,
          ),
        );
      return;
    }

    logger.error({ requestId, err: error, path: request.url }, 'unhandled error');
    reply.code(500).send(body('INTERNAL', 'An unexpected error occurred', requestId));
  });
}
