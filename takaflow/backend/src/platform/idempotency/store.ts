/**
 * Exactly-once request handling.
 *
 * THE DESIGN DECISION THAT MATTERS: the idempotency record is claimed and completed *inside the
 * same transaction that moves the money*. Not before it, not after it. Everything else follows
 * from that.
 *
 * After any crash, at any instant, exactly two states are possible:
 *
 *   - the transaction committed  -> the money moved AND the key is COMPLETED with the stored
 *                                   response. A retry replays that response.
 *   - the transaction did not    -> neither the money nor the key exists. A retry executes
 *                                   cleanly, as if the first attempt never happened.
 *
 * There is no third state, so there is no reconciliation problem, no orphan cleanup on the
 * critical path, and no window where a user's retry is unsafe.
 *
 * The alternative — commit an IN_PROGRESS marker first, do the work, then commit COMPLETED —
 * buys an instant 409 for in-flight duplicates, at the price of exactly that third state: a
 * crash between the two commits leaves a marker that blocks the user's retry until a janitor
 * expires it. For a payment system that trade is backwards.
 *
 * Concurrent duplicates: the second INSERT blocks on the unpublished unique-index entry until
 * the first transaction resolves, then either replays its stored response (it committed) or
 * proceeds (it rolled back). Both outcomes are correct. If the wait exceeds lock_timeout the
 * caller gets REQUEST_IN_PROGRESS and can retry — bounded, and still never a double spend.
 */
import { createHash } from 'node:crypto';
import type { Tx } from '../db/transaction.js';
import { errors, PG_ERRORS, pgErrorCode } from '../errors/index.js';

export type IdempotencyClaim =
  | { kind: 'claimed'; id: string }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'mismatch' };

/**
 * Canonical hash of the request, so that reusing a key with a *different* body is detected
 * rather than silently replaying the wrong response. Object keys are sorted, because
 * `{a:1,b:2}` and `{b:2,a:1}` are the same request.
 */
export function hashRequest(endpoint: string, body: unknown): string {
  return createHash('sha256').update(`${endpoint}\n${canonicalize(body)}`).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}

export async function claimIdempotencyKey(
  tx: Tx,
  input: { userId: string; key: string; endpoint: string; requestHash: string },
): Promise<IdempotencyClaim> {
  let inserted;
  try {
    inserted = await tx.query<{ id: string }>(
      `INSERT INTO idempotency_keys (user_id, key, endpoint, request_hash, state)
       VALUES ($1, $2, $3, $4, 'IN_PROGRESS')
       ON CONFLICT (user_id, key) DO NOTHING
       RETURNING id`,
      [input.userId, input.key, input.endpoint, input.requestHash],
    );
  } catch (error) {
    // We waited on a duplicate request's uncommitted index entry for longer than lock_timeout.
    if (pgErrorCode(error) === PG_ERRORS.LOCK_NOT_AVAILABLE) throw errors.requestInProgress();
    throw error;
  }

  const claimed = inserted.rows[0];
  if (claimed) return { kind: 'claimed', id: claimed.id };

  // The key already exists and belongs to a committed request.
  const { rows } = await tx.query<{
    id: string;
    state: 'IN_PROGRESS' | 'COMPLETED';
    request_hash: string;
    response_status: number | null;
    response_body: unknown;
  }>(
    `SELECT id, state, request_hash, response_status, response_body
       FROM idempotency_keys
      WHERE user_id = $1 AND key = $2`,
    [input.userId, input.key],
  );

  const existing = rows[0];
  if (!existing) {
    // The owning transaction rolled back between our INSERT and this SELECT. Racing it again is
    // pointless within this transaction; the client retries and wins the claim next time.
    throw errors.requestInProgress();
  }

  if (existing.request_hash !== input.requestHash) return { kind: 'mismatch' };

  if (existing.state === 'COMPLETED' && existing.response_status !== null) {
    return { kind: 'replay', status: existing.response_status, body: existing.response_body };
  }

  // IN_PROGRESS and visible means a previous attempt's claim committed without completing —
  // only reachable if a future code path splits the transaction. Treat it as retryable.
  throw errors.requestInProgress();
}

/** Must be called in the same transaction as the work it describes. */
export async function completeIdempotencyKey(
  tx: Tx,
  id: string,
  status: number,
  body: unknown,
): Promise<void> {
  await tx.query(
    `UPDATE idempotency_keys
        SET state = 'COMPLETED',
            response_status = $2,
            response_body = $3::json,
            completed_at = now()
      WHERE id = $1`,
    [id, status, JSON.stringify(body)],
  );
}

const KEY_PATTERN = /^[A-Za-z0-9_:.-]{8,128}$/;

export function requireIdempotencyKey(headerValue: string | string[] | undefined): string {
  const key = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!key) {
    throw errors.validation(
      'Idempotency-Key header is required for this endpoint. Generate one per user intent ' +
        '(not per HTTP attempt) so that retrying is always safe.',
    );
  }
  if (!KEY_PATTERN.test(key)) {
    throw errors.validation(
      'Idempotency-Key must be 8-128 characters of [A-Za-z0-9_:.-] (a UUID is ideal)',
    );
  }
  return key;
}
