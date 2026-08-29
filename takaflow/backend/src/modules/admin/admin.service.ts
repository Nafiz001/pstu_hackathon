/**
 * Operator actions.
 *
 * Freezing an account is the one operator action that touches money, so it takes the account row
 * lock exactly as a transfer does. That is what makes the race well-defined: a freeze and a
 * transfer contend for the same lock, so either the transfer completes and then the account
 * freezes, or the account freezes and the transfer is refused under the lock. There is no
 * interleaving in which a frozen account pays out.
 */
import { withTransaction, withReadTransaction } from '../../platform/db/transaction.js';
import { errors } from '../../platform/errors/index.js';
import { money } from '../../shared/money.js';
import { toMinor } from '../../shared/money.js';
import { insertAuditLog } from '../auth/auth.repo.js';

export type AccountStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED';

export interface AccountAdminView {
  userId: string;
  name: string;
  phone: string;
  accountId: string;
  status: AccountStatus;
  balance: ReturnType<typeof money>;
}

/**
 * Freeze or unfreeze one account.
 *
 * A CLOSED account is not reopened here: closing is a terminal state with consequences elsewhere
 * (no incoming payments either), and quietly flipping it back would be a surprise.
 */
export async function setAccountStatus(input: {
  userId: string;
  status: Extract<AccountStatus, 'ACTIVE' | 'FROZEN'>;
  reason: string | null;
  actorLabel: string;
  context: { ip: string | null; userAgent: string | null; requestId: string | null };
}): Promise<AccountAdminView> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; status: AccountStatus }>(
      `SELECT a.id, a.status::text AS status
         FROM accounts a
        WHERE a.user_id = $1
        FOR UPDATE`,
      [input.userId],
    );
    const account = rows[0];
    if (!account) throw errors.notFound('Account');
    if (account.status === 'CLOSED') {
      throw errors.invalidState('A closed account cannot be reopened', { status: 'CLOSED' });
    }

    await tx.query(
      'UPDATE accounts SET status = $2::account_status, version = version + 1 WHERE id = $1',
      [account.id, input.status],
    );

    await insertAuditLog(tx, {
      // Operator actions are not attributable to a user account, and the audit row must not
      // pretend they are. The actor is named in the metadata instead.
      actorUserId: null,
      action: input.status === 'FROZEN' ? 'ACCOUNT_FROZEN' : 'ACCOUNT_UNFROZEN',
      entityType: 'account',
      entityId: account.id,
      metadata: { operator: input.actorLabel, reason: input.reason, targetUserId: input.userId },
      ip: input.context.ip,
      userAgent: input.context.userAgent,
      requestId: input.context.requestId,
    });

    const { rows: view } = await tx.query<{
      user_id: string;
      name: string;
      phone: string;
      id: string;
      status: AccountStatus;
      balance_minor: string;
    }>(
      `SELECT a.user_id, u.name, u.phone, a.id, a.status::text AS status, a.balance_minor
         FROM accounts a JOIN users u ON u.id = a.user_id
        WHERE a.id = $1`,
      [account.id],
    );

    const row = view[0]!;
    return {
      userId: row.user_id,
      name: row.name,
      phone: row.phone,
      accountId: row.id,
      status: row.status,
      balance: money(toMinor(row.balance_minor)),
    };
  });
}

export interface AuditEntry {
  id: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  requestId: string | null;
  createdAt: string;
}

/**
 * Search the audit log.
 *
 * Keyset pagination on the identity column alone: `audit_logs.id` is monotonic and unique, so it
 * is a complete sort key by itself and needs no timestamp tiebreaker. Never OFFSET — an
 * investigation that pages deep into an incident should not get slower the further it looks.
 */
export async function searchAudit(filters: {
  actorUserId?: string;
  entityId?: string;
  action?: string;
  limit: number;
  before?: string;
}): Promise<{ items: AuditEntry[]; nextCursor: string | null }> {
  const params: unknown[] = [filters.limit + 1];
  const where: string[] = [];

  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.actorUserId) where.push(`actor_user_id = ${push(filters.actorUserId)}::uuid`);
  if (filters.entityId) where.push(`entity_id = ${push(filters.entityId)}`);
  if (filters.action) where.push(`action = ${push(filters.action)}`);
  if (filters.before) where.push(`id < ${push(filters.before)}::bigint`);

  const rows = await withReadTransaction(async (tx) => {
    const result = await tx.query<{
      id: string;
      actor_user_id: string | null;
      action: string;
      entity_type: string;
      entity_id: string | null;
      metadata: Record<string, unknown>;
      ip: string | null;
      request_id: string | null;
      created_at: Date;
    }>(
      `SELECT id::text AS id, actor_user_id, action, entity_type, entity_id, metadata,
              host(ip) AS ip, request_id, created_at
         FROM audit_logs
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id DESC
        LIMIT $1`,
      params,
    );
    return result.rows;
  });

  const items = rows.slice(0, filters.limit).map((row) => ({
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: row.metadata,
    ip: row.ip,
    requestId: row.request_id,
    createdAt: row.created_at.toISOString(),
  }));

  return {
    items,
    // The extra row is the proof another page exists — no COUNT, which would be both slow and
    // wrong the moment anything is written.
    nextCursor: rows.length > filters.limit ? items[items.length - 1]!.id : null,
  };
}
