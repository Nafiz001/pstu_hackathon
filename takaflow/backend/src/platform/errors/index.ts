/**
 * Typed domain errors.
 *
 * Services throw these; exactly one place (the Fastify error handler) turns them into HTTP.
 * Nothing else in the codebase decides a status code, so the API's error contract cannot drift
 * module by module.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_PIN'
  | 'PIN_LOCKED'
  | 'FORBIDDEN'
  | 'ACCOUNT_FROZEN'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REUSE'
  | 'REQUEST_IN_PROGRESS'
  | 'INVALID_STATE'
  | 'INSUFFICIENT_FUNDS'
  | 'LIMIT_EXCEEDED'
  | 'SELF_TRANSFER'
  | 'DUPLICATE'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  | 'SERVICE_UNAVAILABLE';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  INVALID_PIN: 401,
  PIN_LOCKED: 423,
  FORBIDDEN: 403,
  ACCOUNT_FROZEN: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_KEY_REUSE: 409,
  REQUEST_IN_PROGRESS: 409,
  INVALID_STATE: 409,
  DUPLICATE: 409,
  INSUFFICIENT_FUNDS: 422,
  LIMIT_EXCEEDED: 422,
  SELF_TRANSFER: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,
};

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  /** Extra response headers (e.g. Retry-After) the handler should emit. */
  readonly headers: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details ?? {};
    this.headers = options.headers ?? {};
  }
}

export const errors = {
  validation: (message: string, details?: Record<string, unknown>) =>
    new DomainError('VALIDATION_ERROR', message, { details }),

  unauthenticated: (message = 'Authentication required') =>
    new DomainError('UNAUTHENTICATED', message),

  invalidCredentials: () => new DomainError('INVALID_CREDENTIALS', 'Phone or password is incorrect'),

  invalidPin: (attemptsRemaining: number) =>
    new DomainError('INVALID_PIN', 'Transaction PIN is incorrect', {
      details: { attemptsRemaining },
    }),

  pinLocked: (until: Date) =>
    new DomainError('PIN_LOCKED', 'Too many incorrect PIN attempts', {
      details: { lockedUntil: until.toISOString() },
    }),

  forbidden: (message = 'Not permitted') => new DomainError('FORBIDDEN', message),

  accountFrozen: (message = 'This account cannot send money') =>
    new DomainError('ACCOUNT_FROZEN', message),

  notFound: (what: string) => new DomainError('NOT_FOUND', `${what} not found`),

  idempotencyKeyReuse: () =>
    new DomainError(
      'IDEMPOTENCY_KEY_REUSE',
      'This Idempotency-Key was already used with a different request body',
    ),

  requestInProgress: () =>
    new DomainError('REQUEST_IN_PROGRESS', 'An identical request is currently being processed', {
      headers: { 'Retry-After': '1' },
    }),

  invalidState: (message: string, details?: Record<string, unknown>) =>
    new DomainError('INVALID_STATE', message, { details }),

  insufficientFunds: (balanceMinor: bigint, requiredMinor: bigint) =>
    new DomainError('INSUFFICIENT_FUNDS', 'Insufficient balance for this transfer', {
      details: { balanceMinor: balanceMinor.toString(), requiredMinor: requiredMinor.toString() },
    }),

  limitExceeded: (message: string, details?: Record<string, unknown>) =>
    new DomainError('LIMIT_EXCEEDED', message, { details }),

  selfTransfer: () => new DomainError('SELF_TRANSFER', 'You cannot send money to yourself'),

  duplicate: (message: string) => new DomainError('DUPLICATE', message),

  rateLimited: (retryAfterSeconds: number) =>
    new DomainError('RATE_LIMITED', 'Too many requests', {
      headers: { 'Retry-After': String(retryAfterSeconds) },
    }),

  unavailable: (message = 'Service temporarily unavailable') =>
    new DomainError('SERVICE_UNAVAILABLE', message, { headers: { 'Retry-After': '2' } }),
};

/** Postgres SQLSTATE codes this codebase reasons about explicitly. */
export const PG_ERRORS = {
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  FOREIGN_KEY_VIOLATION: '23503',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
  QUERY_CANCELED: '57014',
  ADMIN_SHUTDOWN: '57P01',
  CANNOT_CONNECT_NOW: '57P03',
  RESTRICT_VIOLATION: '23001',
} as const;

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function pgConstraint(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    const constraint = (error as { constraint?: unknown }).constraint;
    return typeof constraint === 'string' ? constraint : undefined;
  }
  return undefined;
}
