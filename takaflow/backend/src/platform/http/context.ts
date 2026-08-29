/**
 * Request-scoped plumbing: who is calling, from where, and under which request id.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { verifyAccessToken } from '../auth/jwt.js';
import { config } from '../../config/index.js';
import { errors } from '../errors/index.js';

export interface AuthenticatedUser {
  id: string;
  phone: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export function contextOf(request: FastifyRequest): RequestContext {
  return {
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: String(request.id),
  };
}

/** Fastify preHandler: requires a valid bearer token and populates `request.user`. */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw errors.unauthenticated('Missing bearer token');
  }
  const claims = verifyAccessToken(header.slice('Bearer '.length).trim());
  request.user = { id: claims.sub, phone: claims.phone };
}

/**
 * Fastify preHandler: operator endpoints.
 *
 * Fails CLOSED. With no `ADMIN_API_TOKEN` configured there is no way to satisfy this guard, so a
 * deployment that forgets to set one gets an unusable admin API rather than an open one.
 * Comparison is timing-safe: a shared secret compared with `===` leaks its prefix to anyone
 * patient enough to measure.
 */
export async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const expected = config.ADMIN_API_TOKEN;
  if (!expected) {
    throw errors.unavailable('Operator API is not configured on this instance');
  }

  const header = request.headers['x-admin-token'];
  const presented = Array.isArray(header) ? header[0] : header;
  if (!presented) throw errors.unauthenticated('Missing operator token');

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw errors.unauthenticated('Invalid operator token');
  }
}

/** Narrow `request.user` for handlers mounted behind `requireAuth`. */
export function currentUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.user) throw errors.unauthenticated();
  return request.user;
}
