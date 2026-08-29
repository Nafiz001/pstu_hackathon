/**
 * Access tokens.
 *
 * Short-lived (15 minutes) and stateless, so read paths need no session lookup. Revocation is
 * handled by the refresh-token family rather than by a token blacklist: a stolen access token is
 * useful for at most one TTL window, and the refresh chain detects reuse immediately.
 */
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';
import { errors } from '../errors/index.js';

export interface AccessTokenClaims {
  sub: string;
  phone: string;
  jti: string;
  iat: number;
  exp: number;
}

export function issueAccessToken(user: { id: string; phone: string }): {
  token: string;
  expiresIn: number;
} {
  const token = jwt.sign({ phone: user.phone, jti: randomUUID() }, config.JWT_SECRET, {
    subject: user.id,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    algorithm: 'HS256',
    issuer: 'takaflow',
  });
  return { token, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS };
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    return jwt.verify(token, config.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'takaflow',
    }) as AccessTokenClaims;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw errors.unauthenticated('Access token expired');
    }
    throw errors.unauthenticated('Invalid access token');
  }
}
