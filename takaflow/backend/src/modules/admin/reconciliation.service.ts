/**
 * Reconciliation — the proof that this system has not lost, created, or duplicated money.
 *
 * These four invariants are the strongest claim TakaFlow makes, so they are checked by querying
 * the database directly rather than by trusting any application state. Each one is worded as a
 * statement that must be true; the query returns the counterexamples, and an empty result is the
 * pass.
 *
 * Runs in a single READ ONLY transaction, so all four see the same snapshot — otherwise a
 * transfer committing between checks could make a consistent system look inconsistent.
 */
import { withTransaction } from '../../platform/db/transaction.js';
import type { Tx } from '../../platform/db/transaction.js';
import { formatTaka, toMinor } from '../../shared/money.js';

export interface CheckResult {
  name: string;
  claim: string;
  status: 'PASS' | 'FAIL';
  detail: string;
  violations: unknown[];
  durationMs: number;
}

export interface ReconciliationReport {
  status: 'PASS' | 'FAIL';
  checkedAt: string;
  totalDurationMs: number;
  totals: {
    userMoney: string;
    treasury: string;
    net: string;
    accounts: number;
    transfers: number;
    ledgerEntries: number;
  };
  checks: CheckResult[];
}

async function timed(
  name: string,
  claim: string,
  fn: () => Promise<{ detail: string; violations: unknown[] }>,
): Promise<CheckResult> {
  const started = performance.now();
  const { detail, violations } = await fn();
  return {
    name,
    claim,
    status: violations.length === 0 ? 'PASS' : 'FAIL',
    detail,
    violations: violations.slice(0, 20),
    durationMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

export async function reconcile(): Promise<ReconciliationReport> {
  const started = performance.now();

  const report = await withTransaction(
    async (tx): Promise<Omit<ReconciliationReport, 'status' | 'totalDurationMs'>> => {
      const totals = await readTotals(tx);

      const checks = [
        await timed(
          'conservation_of_money',
          'The signed sum of every account balance is exactly zero.',
          async () => {
            const { rows } = await tx.query<{ net: string }>(
              'SELECT COALESCE(SUM(balance_minor), 0)::text AS net FROM accounts',
            );
            const net = toMinor(rows[0]!.net);
            return {
              detail:
                net === 0n
                  ? 'Every poisha held by a user is matched by a debit against the treasury.'
                  : `Off by ${formatTaka(net)} BDT — money was created or destroyed outside the ledger.`,
              violations: net === 0n ? [] : [{ netMinor: net.toString() }],
            };
          },
        ),

        await timed(
          'balances_match_ledger',
          'Every account balance equals the signed sum of its ledger entries.',
          async () => {
            const { rows } = await tx.query<{
              account_id: string;
              balance_minor: string;
              ledger_minor: string;
            }>(
              `SELECT a.id AS account_id,
                      a.balance_minor::text AS balance_minor,
                      COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount_minor
                                                    ELSE -e.amount_minor END), 0)::text AS ledger_minor
                 FROM accounts a
                 LEFT JOIN ledger_entries e ON e.account_id = a.id
                GROUP BY a.id, a.balance_minor
               HAVING a.balance_minor <> COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount_minor
                                                                       ELSE -e.amount_minor END), 0)`,
            );
            return {
              detail:
                rows.length === 0
                  ? 'The cached balance column agrees with the ledger for every account.'
                  : `${rows.length} account(s) have drifted from their ledger history.`,
              violations: rows,
            };
          },
        ),

        await timed(
          'double_entry_complete',
          'Every transfer has exactly two entries of equal value and opposite direction.',
          async () => {
            const { rows } = await tx.query<{ transfer_id: string; reason: string }>(
              `SELECT t.id AS transfer_id,
                      CASE
                        WHEN count(e.id) <> 2 THEN 'entry count is ' || count(e.id)
                        WHEN COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount_minor
                                                           ELSE -e.amount_minor END), 1) <> 0
                          THEN 'entries do not net to zero'
                        WHEN MIN(e.amount_minor) <> t.amount_minor THEN 'entry amount <> transfer amount'
                        ELSE 'unknown'
                      END AS reason
                 FROM transfers t
                 LEFT JOIN ledger_entries e
                   ON e.transfer_id = t.id AND e.created_at = t.created_at
                GROUP BY t.id, t.amount_minor
               HAVING count(e.id) <> 2
                   OR COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount_minor
                                                    ELSE -e.amount_minor END), 1) <> 0
                   OR MIN(e.amount_minor) <> t.amount_minor
                   OR MAX(e.amount_minor) <> t.amount_minor`,
            );
            return {
              detail:
                rows.length === 0
                  ? 'Every movement is a complete, balanced double entry.'
                  : `${rows.length} transfer(s) are not balanced double entries.`,
              violations: rows,
            };
          },
        ),

        await timed(
          'no_orphans',
          'No ledger entry exists without its transfer, no user account may be negative, and no ' +
            'idempotency claim is stranded mid-flight.',
          async () => {
            const { rows: orphans } = await tx.query<{ transfer_id: string }>(
              `SELECT DISTINCT e.transfer_id
                 FROM ledger_entries e
                 LEFT JOIN transfers t
                   ON t.id = e.transfer_id AND t.created_at = e.created_at
                WHERE t.id IS NULL`,
            );
            const { rows: negative } = await tx.query<{ id: string; balance_minor: string }>(
              `SELECT id, balance_minor::text FROM accounts
                WHERE type = 'USER' AND balance_minor < 0`,
            );
            // An IN_PROGRESS row that is visible to a *different* transaction can only exist if
            // a claim was committed without its work — the state this design exists to avoid.
            const { rows: stranded } = await tx.query<{ id: string; created_at: Date }>(
              `SELECT id, created_at FROM idempotency_keys
                WHERE state = 'IN_PROGRESS' AND created_at < now() - interval '1 minute'`,
            );

            const violations = [
              ...orphans.map((r) => ({ kind: 'orphan_ledger_entry', ...r })),
              ...negative.map((r) => ({ kind: 'negative_user_balance', ...r })),
              ...stranded.map((r) => ({ kind: 'stranded_idempotency_key', ...r })),
            ];

            return {
              detail:
                violations.length === 0
                  ? 'No orphaned entries, no negative user balances, no stranded claims.'
                  : `${violations.length} structural violation(s) found.`,
              violations,
            };
          },
        ),
      ];

      return { checkedAt: new Date().toISOString(), totals, checks };
    },
    { readOnly: true, maxAttempts: 1 },
  );

  return {
    ...report,
    status: report.checks.every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL',
    totalDurationMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

async function readTotals(tx: Tx): Promise<ReconciliationReport['totals']> {
  const { rows } = await tx.query<{
    user_money: string;
    treasury: string;
    net: string;
    accounts: string;
    transfers: string;
    entries: string;
  }>(
    `SELECT COALESCE(SUM(balance_minor) FILTER (WHERE type = 'USER'), 0)::text   AS user_money,
            COALESCE(SUM(balance_minor) FILTER (WHERE type = 'SYSTEM'), 0)::text AS treasury,
            COALESCE(SUM(balance_minor), 0)::text                                AS net,
            count(*)::text                                                       AS accounts,
            (SELECT count(*)::text FROM transfers)                               AS transfers,
            (SELECT count(*)::text FROM ledger_entries)                          AS entries
       FROM accounts`,
  );

  const row = rows[0]!;
  return {
    userMoney: formatTaka(toMinor(row.user_money)),
    treasury: formatTaka(toMinor(row.treasury)),
    net: formatTaka(toMinor(row.net)),
    accounts: Number(row.accounts),
    transfers: Number(row.transfers),
    ledgerEntries: Number(row.entries),
  };
}
