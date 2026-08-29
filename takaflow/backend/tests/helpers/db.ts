/**
 * Test database helpers, and the assertions that matter most in this project.
 *
 * `assertBooksBalance` is the one every money test ends with. If it ever fails, the system
 * created or destroyed money — which is the only category of bug this codebase treats as
 * unconditionally fatal.
 */
import { expect } from 'vitest';
import { query } from '../../src/platform/db/pool.js';
import { TREASURY_ACCOUNT_IDS } from '../../src/config/index.js';
import { toMinor } from '../../src/shared/money.js';

const TABLES = [
  'audit_logs',
  'notifications',
  'outbox_events',
  'refresh_tokens',
  'money_requests',
  'ledger_entries',
  'transfers',
  'idempotency_keys',
  'accounts',
  'users',
] as const;

export async function resetDatabase(): Promise<void> {
  await query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  // The treasury is schema, not data: re-seed every stripe exactly as migrations 004/006 do.
  await query(
    `INSERT INTO accounts (id, user_id, type, status, balance_minor, shard_key)
     SELECT id, NULL, 'SYSTEM', 'ACTIVE', 0, ordinality
       FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, ordinality)
     ON CONFLICT (id) DO NOTHING`,
    [TREASURY_ACCOUNT_IDS],
  );
}

/** Invariant #1: money is conserved. The treasury holds the negative image of every mint. */
export async function totalBalance(): Promise<bigint> {
  const { rows } = await query<{ total: string }>(
    'SELECT COALESCE(SUM(balance_minor), 0)::text AS total FROM accounts',
  );
  return toMinor(rows[0]!.total);
}

export async function accountBalance(accountId: string): Promise<bigint> {
  const { rows } = await query<{ balance_minor: string }>(
    'SELECT balance_minor FROM accounts WHERE id = $1',
    [accountId],
  );
  if (!rows[0]) throw new Error(`No account ${accountId}`);
  return toMinor(rows[0].balance_minor);
}

export async function userBalance(userId: string): Promise<bigint> {
  const { rows } = await query<{ balance_minor: string }>(
    'SELECT balance_minor FROM accounts WHERE user_id = $1',
    [userId],
  );
  if (!rows[0]) throw new Error(`No account for user ${userId}`);
  return toMinor(rows[0].balance_minor);
}

/** Invariant #2: every account's balance equals the sum of its ledger entries. */
export async function ledgerDrift(): Promise<
  Array<{ accountId: string; balanceMinor: string; ledgerMinor: string }>
> {
  const { rows } = await query<{
    account_id: string;
    balance_minor: string;
    ledger_minor: string;
  }>(
    `SELECT a.id AS account_id,
            a.balance_minor::text AS balance_minor,
            COALESCE(SUM(
              CASE e.direction WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END
            ), 0)::text AS ledger_minor
       FROM accounts a
       LEFT JOIN ledger_entries e ON e.account_id = a.id
      GROUP BY a.id, a.balance_minor
     HAVING a.balance_minor <> COALESCE(SUM(
              CASE e.direction WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END
            ), 0)`,
  );
  return rows.map((r) => ({
    accountId: r.account_id,
    balanceMinor: r.balance_minor,
    ledgerMinor: r.ledger_minor,
  }));
}

/** Invariant #3: every transfer has exactly two entries, equal and opposite. */
export async function unbalancedTransfers(): Promise<string[]> {
  const { rows } = await query<{ transfer_id: string }>(
    `SELECT t.id AS transfer_id
       FROM transfers t
       LEFT JOIN ledger_entries e ON e.transfer_id = t.id
      GROUP BY t.id, t.amount_minor
     HAVING count(e.id) <> 2
         OR COALESCE(SUM(
              CASE e.direction WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END
            ), 1) <> 0
         OR COUNT(DISTINCT e.amount_minor) <> 1
         OR MIN(e.amount_minor) <> t.amount_minor`,
  );
  return rows.map((r) => r.transfer_id);
}

/** The assertion every money test ends with. */
export async function assertBooksBalance(): Promise<void> {
  expect(await totalBalance(), 'total of all balances must be zero').toBe(0n);
  expect(await ledgerDrift(), 'account balances must equal their ledger sums').toEqual([]);
  expect(await unbalancedTransfers(), 'every transfer must have two balanced entries').toEqual([]);
}

export async function countRows(table: string, where = '', params: unknown[] = []): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} ${where}`,
    params,
  );
  return Number(rows[0]!.count);
}
