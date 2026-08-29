/**
 * The ledger primitive: the only code in this system that moves money.
 *
 * Every movement in TakaFlow — the signup mint, a P2P send, a money-request settlement, a
 * reversal — goes through `postDoubleEntry`. One implementation means one place where locking,
 * validation, and double-entry bookkeeping have to be right, and one place a reviewer has to
 * read to believe the whole system.
 *
 * The locking discipline is the load-bearing part:
 *
 *   Both accounts are locked with SELECT ... FOR UPDATE, in ascending account-id order, using
 *   two separate statements. Ordering is what makes concurrent A->B and B->A transfers safe:
 *   both transactions request the same rows in the same sequence, so one simply waits instead of
 *   the pair deadlocking. Two explicit statements are used rather than one `IN (...) ORDER BY id
 *   FOR UPDATE`, because with a single statement the acquisition order is a property of the
 *   chosen plan; with two statements it is a property of this code.
 *
 * The balance check happens *after* the lock is held. Checking before would be a
 * time-of-check-to-time-of-use race: the value read could be stale by the time the UPDATE lands.
 * And even that check is not the last line of defence — `CHECK (balance_minor >= 0)` in the
 * database will reject the write regardless of what this code believes.
 */
import { randomBytes } from 'node:crypto';
import type { Tx } from '../../platform/db/transaction.js';
import { errors, PG_ERRORS, pgConstraint, pgErrorCode } from '../../platform/errors/index.js';
import { toMinor } from '../../shared/money.js';
import { writeBalance } from '../../platform/cache/balance.cache.js';
import { transferAmount, transfers } from '../../platform/metrics/index.js';

export type TransferType = 'P2P' | 'MINT' | 'REQUEST_SETTLEMENT' | 'REVERSAL' | 'SCHEDULED';
export type AccountType = 'USER' | 'SYSTEM';
export type AccountStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED';

export interface LockedAccount {
  id: string;
  userId: string | null;
  type: AccountType;
  status: AccountStatus;
  balanceMinor: bigint;
  version: bigint;
}

export interface PostDoubleEntryCommand {
  fromAccountId: string;
  toAccountId: string;
  amountMinor: bigint;
  type: TransferType;
  note?: string | null;
  idempotencyKeyId?: string | null;
  reversalOf?: string | null;
}

export interface PostedTransfer {
  id: string;
  reference: string;
  fromAccountId: string;
  toAccountId: string;
  amountMinor: bigint;
  type: TransferType;
  note: string | null;
  createdAt: Date;
  senderBalanceAfter: bigint;
  receiverBalanceAfter: bigint;
}

/**
 * Public transfer reference: TF + YYMMDD + 8 random Crockford-base32 characters.
 *
 * The date prefix is not decoration. `transfers` is partitioned by created_at, and a unique
 * index on a partitioned table must include the partition key — so `reference` alone cannot be
 * globally unique. Embedding the date lets a lookup by reference prune straight to one
 * partition, which both restores an effective global lookup and keeps it O(1) as the table
 * grows. 8 characters of base32 is 40 bits of entropy within a single day.
 */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U

export function generateReference(now = new Date()): string {
  const yy = String(now.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const bytes = randomBytes(5);
  let suffix = '';
  for (let i = 0; i < 8; i += 1) {
    // 5 bytes = 40 bits = exactly 8 base32 characters.
    const bitOffset = i * 5;
    const byteIndex = bitOffset >> 3;
    const shift = bitOffset & 7;
    const chunk = ((bytes[byteIndex]! << 8) | (bytes[byteIndex + 1] ?? 0)) >> (11 - shift);
    suffix += BASE32[chunk & 31];
  }
  return `TF${yy}${mm}${dd}${suffix}`;
}

/** Parse the date a reference encodes, so a lookup can prune to a single partition. */
export function referenceDateRange(reference: string): { from: Date; to: Date } | null {
  const match = /^TF(\d{2})(\d{2})(\d{2})[0-9A-Z]{8}$/.exec(reference);
  if (!match) return null;
  const [, yy, mm, dd] = match;
  const from = new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd)));
  if (Number.isNaN(from.getTime())) return null;
  return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) };
}

interface AccountRow {
  id: string;
  user_id: string | null;
  type: AccountType;
  status: AccountStatus;
  balance_minor: string;
  version: string;
}

const mapAccount = (row: AccountRow): LockedAccount => ({
  id: row.id,
  userId: row.user_id,
  type: row.type,
  status: row.status,
  balanceMinor: toMinor(row.balance_minor),
  version: toMinor(row.version),
});

/**
 * Lock a single account row. Callers must invoke this in ascending id order — use
 * `lockAccountPair` rather than calling this directly for a two-sided movement.
 */
async function lockAccount(tx: Tx, accountId: string): Promise<LockedAccount | null> {
  const { rows } = await tx.query<AccountRow>(
    `SELECT id, user_id, type, status, balance_minor, version
       FROM accounts
      WHERE id = $1
      FOR UPDATE`,
    [accountId],
  );
  const row = rows[0];
  return row ? mapAccount(row) : null;
}

/** Lock both sides of a movement in a deterministic, deadlock-free order. */
export async function lockAccountPair(
  tx: Tx,
  fromAccountId: string,
  toAccountId: string,
): Promise<{ from: LockedAccount; to: LockedAccount }> {
  if (fromAccountId === toAccountId) throw errors.selfTransfer();

  const [firstId, secondId] =
    fromAccountId < toAccountId ? [fromAccountId, toAccountId] : [toAccountId, fromAccountId];

  const first = await lockAccount(tx, firstId);
  if (!first) throw errors.notFound('Account');
  const second = await lockAccount(tx, secondId);
  if (!second) throw errors.notFound('Account');

  return firstId === fromAccountId
    ? { from: first, to: second }
    : { from: second, to: first };
}

/**
 * Move money. Must be called inside a transaction (see platform/db/transaction.ts).
 *
 * Writes, atomically: two balance updates, one transfer row, and exactly two ledger entries
 * whose signed sum is zero.
 */
export async function postDoubleEntry(
  tx: Tx,
  command: PostDoubleEntryCommand,
): Promise<PostedTransfer> {
  const { fromAccountId, toAccountId, amountMinor, type } = command;

  if (amountMinor <= 0n) {
    throw errors.validation('Transfer amount must be greater than zero');
  }

  const { from, to } = await lockAccountPair(tx, fromAccountId, toAccountId);

  // Validated under the lock — anything read before it could already be stale.
  if (from.status !== 'ACTIVE') {
    throw errors.accountFrozen(
      from.status === 'CLOSED' ? 'Sender account is closed' : 'Sender account is frozen',
    );
  }
  if (to.status === 'CLOSED') {
    throw errors.accountFrozen('Recipient account is closed');
  }

  // The treasury is the source of newly minted money and is expected to go negative; every
  // other account must have the funds.
  if (from.type !== 'SYSTEM' && from.balanceMinor < amountMinor) {
    transfers.inc({ type, outcome: 'insufficient_funds' });
    throw errors.insufficientFunds(from.balanceMinor, amountMinor);
  }

  const senderBalanceAfter = from.balanceMinor - amountMinor;
  const receiverBalanceAfter = to.balanceMinor + amountMinor;

  try {
    await tx.query(
      `UPDATE accounts
          SET balance_minor = balance_minor - $2::bigint,
              version       = version + 1,
              updated_at    = now()
        WHERE id = $1`,
      [from.id, amountMinor.toString()],
    );
    await tx.query(
      `UPDATE accounts
          SET balance_minor = balance_minor + $2::bigint,
              version       = version + 1,
              updated_at    = now()
        WHERE id = $1`,
      [to.id, amountMinor.toString()],
    );
  } catch (error) {
    // Reachable only if this code's own check disagreed with the database. Translating it keeps
    // the API contract honest instead of surfacing a 500.
    if (
      pgErrorCode(error) === PG_ERRORS.CHECK_VIOLATION &&
      pgConstraint(error) === 'non_negative_user_balance'
    ) {
      throw errors.insufficientFunds(from.balanceMinor, amountMinor);
    }
    throw error;
  }

  const reference = generateReference();

  /**
   * The transfer and its two entries are written by ONE statement, with the entries taking
   * `created_at` straight from the inserted transfer row.
   *
   * That is not a micro-optimisation, it is a correctness requirement. Both tables are
   * partitioned by `created_at`, and history joins on `(transfer_id, created_at)` so the planner
   * can prune to a single monthly partition. If the timestamp made a round trip through
   * JavaScript to get here, it would come back with millisecond precision while Postgres stores
   * microseconds — the two rows would land on timestamps that differ by less than a millisecond,
   * the join would silently match nothing, and every statement in the system would look empty.
   *
   * Data-modifying CTEs are guaranteed to run exactly once and to completion, so the entries are
   * written even though the outer SELECT only reads the transfer.
   */
  const { rows: transferRows } = await tx.query<{ id: string; created_at: Date }>(
    `WITH new_transfer AS (
       INSERT INTO transfers
           (reference, from_account_id, to_account_id, amount_minor, type, note,
            idempotency_key_id, reversal_of)
       VALUES ($1, $2, $3, $4::bigint, $5, $6, $7, $8)
       RETURNING id, created_at
     ), new_entries AS (
       INSERT INTO ledger_entries
           (transfer_id, account_id, direction, amount_minor, balance_after, created_at)
       SELECT nt.id, leg.account_id, leg.direction, $4::bigint, leg.balance_after, nt.created_at
         FROM new_transfer nt
         CROSS JOIN (VALUES ($2::uuid, 'DEBIT'::entry_direction,  $9::bigint),
                            ($3::uuid, 'CREDIT'::entry_direction, $10::bigint))
                    AS leg(account_id, direction, balance_after)
       RETURNING 1
     )
     SELECT id, created_at FROM new_transfer`,
    [
      reference,
      from.id,
      to.id,
      amountMinor.toString(),
      type,
      command.note ?? null,
      command.idempotencyKeyId ?? null,
      command.reversalOf ?? null,
      senderBalanceAfter.toString(),
      receiverBalanceAfter.toString(),
    ],
  );

  const transfer = transferRows[0];
  if (!transfer) throw new Error('INSERT ... RETURNING produced no transfer row');

  /**
   * Publish both new balances to the cache *after* the commit, stamped with the version they
   * came from. Doing it here rather than in each caller means every movement in the system —
   * mint, transfer, settlement, reversal — keeps the cache coherent by construction.
   *
   * The hook cannot run if the transaction rolls back, and a stale concurrent writer loses the
   * version comparison inside Redis, so the cache converges on the newest balance it has seen.
   */
  transfers.inc({ type, outcome: 'committed' });
  transferAmount.observe(Number(amountMinor) / 100);

  tx.afterCommit(async () => {
    await Promise.all([
      writeBalance(from.id, { balanceMinor: senderBalanceAfter, version: from.version + 1n }),
      writeBalance(to.id, { balanceMinor: receiverBalanceAfter, version: to.version + 1n }),
    ]);
  });

  return {
    id: transfer.id,
    reference,
    fromAccountId: from.id,
    toAccountId: to.id,
    amountMinor,
    type,
    note: command.note ?? null,
    createdAt: transfer.created_at,
    senderBalanceAfter,
    receiverBalanceAfter,
  };
}
