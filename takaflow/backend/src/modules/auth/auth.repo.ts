/**
 * Auth persistence. SQL lives here and nowhere else; every statement is parameterised.
 *
 * Read functions take an `Executor` and default to the pool. That default is a convenience for
 * callers outside a transaction — and callers INSIDE one must pass their `tx`.
 *
 * This is not a style rule. A repository that quietly takes its own pooled connection while the
 * caller holds an open transaction deadlocks the pool: the transaction occupies one connection
 * and waits for a second, all while holding row locks, so every other request queues behind it.
 * We shipped that bug in `acceptRequest` and it presented as ten simultaneous accepts all
 * returning 503 with the winner sitting `idle in transaction` for five seconds.
 */
import type { Executor, Tx } from '../../platform/db/transaction.js';
import { pool } from '../../platform/db/pool.js';
import { toMinor } from '../../shared/money.js';

/** The default executor: a connection per statement, for callers outside a transaction. */
const poolExecutor: Executor = { query: (text, params = []) => pool.query(text, params as unknown[]) };

export interface UserRow {
  id: string;
  phone: string;
  name: string;
  password_hash: string;
  pin_hash: string;
  failed_pin_attempts: number;
  pin_locked_until: Date | null;
  status: 'ACTIVE' | 'SUSPENDED';
  created_at: Date;
}

export interface UserRecord {
  id: string;
  phone: string;
  name: string;
  passwordHash: string;
  pinHash: string;
  failedPinAttempts: number;
  pinLockedUntil: Date | null;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: Date;
}

export const mapUser = (row: UserRow): UserRecord => ({
  id: row.id,
  phone: row.phone,
  name: row.name,
  passwordHash: row.password_hash,
  pinHash: row.pin_hash,
  failedPinAttempts: row.failed_pin_attempts,
  pinLockedUntil: row.pin_locked_until,
  status: row.status,
  createdAt: row.created_at,
});

export async function insertUser(
  tx: Tx,
  input: { phone: string; name: string; passwordHash: string; pinHash: string },
): Promise<UserRecord> {
  const { rows } = await tx.query<UserRow>(
    `INSERT INTO users (phone, name, password_hash, pin_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.phone, input.name, input.passwordHash, input.pinHash],
  );
  return mapUser(rows[0]!);
}

export async function insertUserAccount(tx: Tx, userId: string): Promise<{ id: string }> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO accounts (user_id, type, status, balance_minor)
     VALUES ($1, 'USER', 'ACTIVE', 0)
     RETURNING id`,
    [userId],
  );
  return rows[0]!;
}

export async function findUserByPhone(
  phone: string,
  db: Executor = poolExecutor,
): Promise<UserRecord | null> {
  const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE phone = $1', [phone]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function findUserById(
  id: string,
  db: Executor = poolExecutor,
): Promise<UserRecord | null> {
  const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export interface AccountSummary {
  id: string;
  balanceMinor: bigint;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  version: bigint;
}

export async function findAccountByUserId(
  userId: string,
  db: Executor = poolExecutor,
): Promise<AccountSummary | null> {
  const { rows } = await db.query<{
    id: string;
    balance_minor: string;
    status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
    version: string;
  }>('SELECT id, balance_minor, status, version FROM accounts WHERE user_id = $1', [userId]);

  const row = rows[0];
  return row
    ? {
        id: row.id,
        balanceMinor: toMinor(row.balance_minor),
        status: row.status,
        version: toMinor(row.version),
      }
    : null;
}

// --- sessions ---------------------------------------------------------------

export async function insertRefreshToken(
  tx: Tx,
  input: {
    userId: string;
    familyId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
    ip: string | null;
  },
): Promise<{ id: string }> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6::inet)
     RETURNING id`,
    [input.userId, input.familyId, input.tokenHash, input.expiresAt, input.userAgent, input.ip],
  );
  return rows[0]!;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
}

export async function findRefreshTokenByHash(
  tx: Tx,
  tokenHash: string,
): Promise<RefreshTokenRecord | null> {
  const { rows } = await tx.query<{
    id: string;
    user_id: string;
    family_id: string;
    expires_at: Date;
    revoked_at: Date | null;
    replaced_by: string | null;
  }>(
    `SELECT id, user_id, family_id, expires_at, revoked_at, replaced_by
       FROM refresh_tokens
      WHERE token_hash = $1
      FOR UPDATE`,
    [tokenHash],
  );

  const row = rows[0];
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        familyId: row.family_id,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        replacedBy: row.replaced_by,
      }
    : null;
}

export async function markRefreshTokenReplaced(
  tx: Tx,
  tokenId: string,
  replacedBy: string,
): Promise<void> {
  await tx.query(
    'UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1',
    [tokenId, replacedBy],
  );
}

/** Reuse of a rotated token means it leaked: kill every session descended from it. */
export async function revokeFamily(tx: Tx, familyId: string): Promise<number> {
  const { rowCount } = await tx.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
    [familyId],
  );
  return rowCount ?? 0;
}

export async function revokeToken(tx: Tx, tokenHash: string): Promise<number> {
  const { rowCount } = await tx.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash],
  );
  return rowCount ?? 0;
}

// --- audit ------------------------------------------------------------------

export async function insertAuditLog(
  tx: Tx,
  entry: {
    actorUserId: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    metadata?: Record<string, unknown>;
    ip?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs
        (actor_user_id, action, entity_type, entity_id, metadata, ip, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::inet, $7, $8)`,
    [
      entry.actorUserId,
      entry.action,
      entry.entityType,
      entry.entityId,
      JSON.stringify(entry.metadata ?? {}),
      entry.ip ?? null,
      entry.userAgent ?? null,
      entry.requestId ?? null,
    ],
  );
}
