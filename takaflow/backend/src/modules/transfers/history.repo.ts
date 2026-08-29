/**
 * Transaction history.
 *
 * Read from `ledger_entries`, not from `transfers`. A user's statement is "every entry that
 * touched my account", which is exactly one row per account per movement — so a single index,
 * `(account_id, created_at DESC, id DESC)`, answers it as a range scan.
 *
 * Reading from `transfers` instead would need `WHERE from_account_id = $1 OR to_account_id = $1`,
 * and an OR across two different columns cannot use either index cleanly; it becomes a bitmap
 * OR or a UNION that has to be re-sorted. The ledger already stores the shape the query wants.
 *
 * The join carries `created_at` as well as `transfer_id` so the planner can prune `transfers`
 * to the same monthly partition instead of probing all of them.
 */
import type { Tx } from '../../platform/db/transaction.js';
import { toMinor } from '../../shared/money.js';
import { asPgTimestamp, toDate, type PgTimestamp } from '../../shared/timestamp.js';
import type { Cursor } from '../../shared/cursor.js';

export interface HistoryFilters {
  accountId: string;
  direction?: 'IN' | 'OUT';
  type?: 'P2P' | 'MINT' | 'REQUEST_SETTLEMENT' | 'REVERSAL' | 'SCHEDULED';
  from?: Date;
  to?: Date;
  minAmountMinor?: bigint;
  maxAmountMinor?: bigint;
  counterpartyPhone?: string;
  limit: number;
  cursor?: Cursor;
}

export interface HistoryEntry {
  id: string;
  /** Full precision, for building the next cursor. See shared/timestamp.ts. */
  createdAtRaw: PgTimestamp;
  createdAt: Date;
  direction: 'DEBIT' | 'CREDIT';
  amountMinor: bigint;
  balanceAfterMinor: bigint;
  reference: string;
  type: string;
  status: string;
  note: string | null;
  counterpartyName: string;
  counterpartyPhone: string | null;
}

interface HistoryRow {
  id: string;
  created_at_raw: string;
  direction: 'DEBIT' | 'CREDIT';
  amount_minor: string;
  balance_after: string;
  reference: string;
  type: string;
  status: string;
  note: string | null;
  counterparty_name: string | null;
  counterparty_phone: string | null;
}

const mapEntry = (row: HistoryRow): HistoryEntry => ({
  id: row.id,
  createdAtRaw: asPgTimestamp(row.created_at_raw),
  createdAt: toDate(asPgTimestamp(row.created_at_raw)),
  direction: row.direction,
  amountMinor: toMinor(row.amount_minor),
  balanceAfterMinor: toMinor(row.balance_after),
  reference: row.reference,
  type: row.type,
  status: row.status,
  note: row.note,
  // A mint has no counterparty user: the other side is the system treasury.
  counterpartyName: row.counterparty_name ?? 'TakaFlow',
  counterpartyPhone: row.counterparty_phone,
});

const SELECT = `
    SELECT e.id::text        AS id,
           e.created_at::text AS created_at_raw,
           e.direction,
           e.amount_minor::text  AS amount_minor,
           e.balance_after::text AS balance_after,
           t.reference,
           t.type::text      AS type,
           t.status::text    AS status,
           t.note,
           cu.name  AS counterparty_name,
           cu.phone AS counterparty_phone
      FROM ledger_entries e
      JOIN transfers t
        ON t.id = e.transfer_id
       AND t.created_at = e.created_at
      JOIN accounts ca
        ON ca.id = CASE WHEN e.direction = 'DEBIT' THEN t.to_account_id ELSE t.from_account_id END
      LEFT JOIN users cu ON cu.id = ca.user_id`;

export async function listHistory(tx: Tx, filters: HistoryFilters): Promise<HistoryEntry[]> {
  const params: unknown[] = [filters.accountId, filters.limit];
  const where: string[] = ['e.account_id = $1'];

  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.direction) {
    where.push(`e.direction = ${push(filters.direction === 'IN' ? 'CREDIT' : 'DEBIT')}`);
  }
  if (filters.type) where.push(`t.type = ${push(filters.type)}::transfer_type`);
  if (filters.from) where.push(`e.created_at >= ${push(filters.from)}::timestamptz`);
  if (filters.to) where.push(`e.created_at < ${push(filters.to)}::timestamptz`);
  if (filters.minAmountMinor !== undefined) {
    where.push(`e.amount_minor >= ${push(filters.minAmountMinor.toString())}::bigint`);
  }
  if (filters.maxAmountMinor !== undefined) {
    where.push(`e.amount_minor <= ${push(filters.maxAmountMinor.toString())}::bigint`);
  }
  if (filters.counterpartyPhone) where.push(`cu.phone = ${push(filters.counterpartyPhone)}`);
  if (filters.cursor) {
    const ts = push(filters.cursor.createdAt);  // full-precision text, cast below
    const id = push(filters.cursor.id);
    where.push(`(e.created_at, e.id) < (${ts}::timestamptz, ${id}::bigint)`);
  }

  const { rows } = await tx.query<HistoryRow>(
    `${SELECT}
      WHERE ${where.join('\n        AND ')}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $2`,
    params,
  );
  return rows.map(mapEntry);
}

/**
 * Fetch one movement by its public reference, from the viewer's perspective.
 *
 * `dateRange` comes from the date embedded in the reference itself, which lets the planner
 * prune to a single monthly partition rather than scanning all of them.
 */
export async function findByReference(
  tx: Tx,
  accountId: string,
  reference: string,
  dateRange: { from: Date; to: Date } | null,
): Promise<HistoryEntry | null> {
  const params: unknown[] = [accountId, reference];
  let pruning = '';
  if (dateRange) {
    params.push(dateRange.from, dateRange.to);
    pruning = ' AND e.created_at >= $3::timestamptz AND e.created_at < $4::timestamptz';
  }

  const { rows } = await tx.query<HistoryRow>(
    `${SELECT}
      WHERE e.account_id = $1 AND t.reference = $2${pruning}
      LIMIT 1`,
    params,
  );
  return rows[0] ? mapEntry(rows[0]) : null;
}
