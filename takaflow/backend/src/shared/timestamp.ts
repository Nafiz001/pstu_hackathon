/**
 * Timestamps that make a round trip.
 *
 * THE HAZARD, stated once so it is never rediscovered a third time:
 *
 *   PostgreSQL `timestamptz` has MICROSECOND resolution. A JavaScript `Date` has MILLISECOND
 *   resolution. Any value that goes database -> JS -> database silently loses up to 999
 *   microseconds, and the two values then compare as different.
 *
 * This has already caused two real bugs in this codebase:
 *
 *   1. Ledger entries were written with a timestamp that had passed through a `Date`, so the
 *      partition-pruning join `ON t.id = e.transfer_id AND t.created_at = e.created_at` matched
 *      nothing and EVERY transaction history came back empty.
 *
 *   2. Reversal's guarded `UPDATE ... WHERE created_at = $2` matched zero rows, so the first
 *      reversal of any transfer was rejected as "already reversed".
 *
 * And a third, subtler one it would have caused: a keyset pagination cursor built from
 * `Date.toISOString()` truncates the anchor downwards, so rows written in the same millisecond as
 * the anchor fall between the truncated cursor and the true value — and are silently SKIPPED.
 * Under load that is a transaction missing from a statement, with nothing to indicate it.
 *
 * THE RULE: a timestamp that will be sent back to the database travels as the TEXT Postgres
 * produced (`column::text`), and is cast back with `$n::timestamptz`. `Date` is for display and
 * arithmetic only.
 */

/** Full-precision timestamp exactly as Postgres rendered it, e.g. `2026-08-29 06:12:31.848125+00`. */
export type PgTimestamp = string & { readonly __pgTimestamp?: unique symbol };

const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?$/;

export function asPgTimestamp(value: string): PgTimestamp {
  if (!PG_TIMESTAMP.test(value)) {
    throw new TypeError(`Not a Postgres timestamp: ${JSON.stringify(value)}`);
  }
  return value as PgTimestamp;
}

export function isPgTimestamp(value: unknown): value is PgTimestamp {
  return typeof value === 'string' && PG_TIMESTAMP.test(value);
}

/**
 * For display and arithmetic only. Never send the result of this back to the database.
 *
 * Postgres renders a `timestamptz` as `2026-08-29 06:58:31.848125+00` — a space instead of `T`,
 * and a two-digit UTC offset. Neither is valid ISO 8601, and `new Date()` on that string returns
 * **Invalid Date** rather than throwing. That failure is silent and downstream arithmetic
 * quietly produces NaN: it disabled the reversal time-window check entirely, because
 * `NaN > windowSeconds` is simply `false`. Normalising here, in one place, is the fix.
 */
export function toDate(value: PgTimestamp): Date {
  const iso = value
    .replace(' ', 'T')
    // `+00` -> `+00:00`, `-0530` -> `-05:30`; leave a full offset or `Z` alone.
    .replace(/([+-])(\d{2})$/, '$1$2:00')
    .replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3');

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Could not parse Postgres timestamp: ${JSON.stringify(value)}`);
  }
  return date;
}
