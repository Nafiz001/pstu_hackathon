/**
 * Structured logging. Secrets are redacted at the logger, not at each call site — relying on
 * every future contributor to remember not to log a PIN is not a security control.
 *
 * The options are exported separately from the instance so Fastify can build its own child
 * logger from the same configuration. (Handing Fastify a pre-built pino instance narrows its
 * generic parameters and makes every `FastifyInstance` reference in the codebase incompatible.)
 */
import { pino } from 'pino';
import type { LoggerOptions } from 'pino';
import { config } from '../../config/index.js';

export const loggerOptions: LoggerOptions = {
  level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
  base: { service: 'takaflow-api' },
  redact: {
    paths: [
      'pin',
      'password',
      'passwordHash',
      'pinHash',
      'token',
      'refreshToken',
      'accessToken',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.pin',
      '*.password',
      'body.pin',
      'body.password',
    ],
    censor: '[redacted]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
};

export const logger = pino(loggerOptions);

export type Logger = typeof logger;
