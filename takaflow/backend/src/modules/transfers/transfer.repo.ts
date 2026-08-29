/**
 * Transfer persistence. SQL only — no policy decisions live here.
 */
import type { Tx } from '../../platform/db/transaction.js';
import { toMinor } from '../../shared/money.js';

export interface PayeeAccount {
  userId: string;
  accountId: string;
  name: string;
  phone: string;
  accountStatus: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  userStatus: 'ACTIVE' | 'SUSPENDED';
}

export async function findPayeeByPhone(tx: Tx, phone: string): Promise<PayeeAccount | null> {
  const { rows } = await tx.query<{
    user_id: string;
    account_id: string;
    name: string;
    phone: string;
    account_status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
    user_status: 'ACTIVE' | 'SUSPENDED';
  }>(
    `SELECT u.id   AS user_id,
            a.id   AS account_id,
            u.name,
            u.phone,
            a.status AS account_status,
            u.status AS user_status
       FROM users u
       JOIN accounts a ON a.user_id = u.id
      WHERE u.phone = $1`,
    [phone],
  );

  const row = rows[0];
  return row
    ? {
        userId: row.user_id,
        accountId: row.account_id,
        name: row.name,
        phone: row.phone,
        accountStatus: row.account_status,
        userStatus: row.user_status,
      }
    : null;
}

export async function findAccountIdForUser(tx: Tx, userId: string): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id FROM accounts WHERE user_id = $1',
    [userId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Outbound total over the rolling 24-hour window, evaluated *inside* the caller's transaction so
 * that concurrent transfers cannot each observe the same pre-spend total and both pass the limit.
 * Uses the (from_account_id, created_at DESC) index.
 */
export async function outboundInWindow(
  tx: Tx,
  accountId: string,
  windowInterval = '24 hours',
): Promise<bigint> {
  const { rows } = await tx.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS total
       FROM transfers
      WHERE from_account_id = $1
        AND type IN ('P2P', 'REQUEST_SETTLEMENT', 'SCHEDULED')
        AND status = 'COMPLETED'
        AND created_at >= now() - $2::interval`,
    [accountId, windowInterval],
  );
  return toMinor(rows[0]!.total);
}

export interface CounterpartyNames {
  fromName: string;
  fromPhone: string;
  toName: string;
  toPhone: string;
}

export async function namesForAccounts(
  tx: Tx,
  fromAccountId: string,
  toAccountId: string,
): Promise<CounterpartyNames> {
  const { rows } = await tx.query<{ id: string; name: string | null; phone: string | null }>(
    `SELECT a.id, u.name, u.phone
       FROM accounts a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.id = ANY($1::uuid[])`,
    [[fromAccountId, toAccountId]],
  );

  const byId = new Map(rows.map((r) => [r.id, r]));
  const from = byId.get(fromAccountId);
  const to = byId.get(toAccountId);

  return {
    fromName: from?.name ?? 'TakaFlow',
    fromPhone: from?.phone ?? '',
    toName: to?.name ?? 'TakaFlow',
    toPhone: to?.phone ?? '',
  };
}
