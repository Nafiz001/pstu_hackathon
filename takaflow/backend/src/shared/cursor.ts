/**
 * Keyset (cursor) pagination.
 *
 * A cursor encodes the sort key of the last row a client saw — here `(created_at, id)` — so the
 * next page is a range scan that starts exactly where the previous one stopped.
 *
 * Why not OFFSET: `OFFSET 10000` makes the database read and discard 10,000 rows before
 * returning anything, so deep pages get linearly slower, and any row inserted between requests
 * shifts the window and makes a client silently skip or repeat entries. Neither is acceptable
 * for a transaction history at 10M users. Keyset paging costs the same at page 1 and page
 * 10,000, and is stable under concurrent inserts.
 *
 * `id` is the tiebreaker: two transfers can share a timestamp, and without it a page boundary
 * landing between them would drop or duplicate one.
 */
import { errors } from '../platform/errors/index.js';
import { asPgTimestamp, type PgTimestamp } from './timestamp.js';

/**
 * The anchor is the FULL-PRECISION timestamp text Postgres produced, never a Date.
 *
 * A cursor built from `Date.toISOString()` is truncated to milliseconds — downwards. Rows written
 * in the same millisecond as the anchor then sit between the truncated cursor and the anchor's
 * true value, and the next page's `(created_at, id) < (cursor)` predicate excludes them. They are
 * silently skipped: a transaction missing from a statement, with nothing anywhere to indicate it.
 * See shared/timestamp.ts.
 */
export interface Cursor {
  createdAt: PgTimestamp;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;

  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw errors.validation('Invalid pagination cursor');
  }

  const separator = decoded.lastIndexOf('|');
  if (separator === -1) throw errors.validation('Invalid pagination cursor');

  const rawTimestamp = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  // Tiebreakers are either a uuid (money requests) or a bigint (ledger entries).
  const validId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
    /^\d{1,19}$/.test(id);

  if (!validId) throw errors.validation('Invalid pagination cursor');

  try {
    return { createdAt: asPgTimestamp(rawTimestamp), id };
  } catch {
    throw errors.validation('Invalid pagination cursor');
  }
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Callers fetch `limit + 1` rows; the extra row is the proof that another page exists without
 * a second COUNT query (which would be both slow and wrong under concurrent writes).
 */
export function toPage<T extends { createdAtRaw: PgTimestamp; id: string }>(
  rows: T[],
  limit: number,
): Page<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1]!;
  return { items, nextCursor: encodeCursor({ createdAt: last.createdAtRaw, id: last.id }) };
}
