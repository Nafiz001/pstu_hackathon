/**
 * Money-request persistence.
 *
 * Every state transition is expressed as a guarded statement whose WHERE clause encodes the
 * precondition. The database decides whether a transition is legal; application code only reads
 * the row count. That is what makes a double-tap, two devices, or an accept racing a cancel
 * resolve correctly without a read-then-write window for them to slip through.
 */
import type { Tx } from '../../platform/db/transaction.js';
import type { Cursor } from '../../shared/cursor.js';
import { toMinor } from '../../shared/money.js';
import { asPgTimestamp, type PgTimestamp } from '../../shared/timestamp.js';

export type RequestStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';

export interface MoneyRequestRow {
  id: string;
  requester_user_id: string;
  payer_user_id: string;
  amount_minor: string;
  note: string | null;
  status: RequestStatus;
  expires_at: Date;
  settled_transfer_id: string | null;
  decline_reason: string | null;
  version: string;
  created_at: Date;
  created_at_raw?: string;
  updated_at: Date;
}

export interface MoneyRequest {
  id: string;
  /** Full precision, for building the next cursor. See shared/timestamp.ts. */
  createdAtRaw: PgTimestamp;
  requesterUserId: string;
  payerUserId: string;
  amountMinor: bigint;
  note: string | null;
  status: RequestStatus;
  expiresAt: Date;
  settledTransferId: string | null;
  declineReason: string | null;
  version: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export const mapRequest = (row: MoneyRequestRow): MoneyRequest => ({
  id: row.id,
  createdAtRaw: asPgTimestamp(
    row.created_at_raw ?? row.created_at.toISOString().replace('T', ' ').replace('Z', '+00'),
  ),
  requesterUserId: row.requester_user_id,
  payerUserId: row.payer_user_id,
  amountMinor: toMinor(row.amount_minor),
  note: row.note,
  status: row.status,
  expiresAt: row.expires_at,
  settledTransferId: row.settled_transfer_id,
  declineReason: row.decline_reason,
  version: toMinor(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export async function insertRequest(
  tx: Tx,
  input: {
    requesterUserId: string;
    payerUserId: string;
    amountMinor: bigint;
    note: string | null;
    expiresAt: Date;
    /** Set when this request is one leg of a split bill. */
    splitId?: string | null;
  },
): Promise<MoneyRequest> {
  const { rows } = await tx.query<MoneyRequestRow>(
    `INSERT INTO money_requests
        (requester_user_id, payer_user_id, amount_minor, note, expires_at, split_id)
     VALUES ($1, $2, $3::bigint, $4, $5, $6)
     RETURNING *`,
    [
      input.requesterUserId,
      input.payerUserId,
      input.amountMinor.toString(),
      input.note,
      input.expiresAt,
      input.splitId ?? null,
    ],
  );
  return mapRequest(rows[0]!);
}

export async function findRequest(tx: Tx, id: string): Promise<MoneyRequest | null> {
  const { rows } = await tx.query<MoneyRequestRow>('SELECT * FROM money_requests WHERE id = $1', [
    id,
  ]);
  return rows[0] ? mapRequest(rows[0]) : null;
}

/**
 * Lock a request for settlement, but only if it is still legally settleable by this payer.
 *
 * Under READ COMMITTED, a concurrent accept that commits first causes this statement to
 * re-evaluate its WHERE clause against the updated row; the status is then ACCEPTED, the
 * predicate fails, and this caller correctly sees "no such pending request" instead of settling
 * it a second time.
 */
export async function lockSettleableRequest(
  tx: Tx,
  id: string,
  payerUserId: string,
): Promise<MoneyRequest | null> {
  const { rows } = await tx.query<MoneyRequestRow>(
    `SELECT *
       FROM money_requests
      WHERE id = $1
        AND payer_user_id = $2
        AND status = 'PENDING'
        AND expires_at > now()
      FOR UPDATE`,
    [id, payerUserId],
  );
  return rows[0] ? mapRequest(rows[0]) : null;
}

export async function markAccepted(
  tx: Tx,
  id: string,
  settledTransferId: string,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE money_requests
        SET status = 'ACCEPTED',
            settled_transfer_id = $2,
            version = version + 1,
            updated_at = now()
      WHERE id = $1 AND status = 'PENDING'`,
    [id, settledTransferId],
  );
  return (rowCount ?? 0) === 1;
}

/** Guarded transition used by decline and cancel; returns the updated row, or null if illegal. */
export async function transition(
  tx: Tx,
  input: {
    id: string;
    to: Extract<RequestStatus, 'DECLINED' | 'CANCELLED' | 'EXPIRED'>;
    actorColumn: 'payer_user_id' | 'requester_user_id';
    actorUserId: string;
    reason?: string | null;
  },
): Promise<MoneyRequest | null> {
  const { rows } = await tx.query<MoneyRequestRow>(
    `UPDATE money_requests
        SET status = $3,
            decline_reason = COALESCE($4, decline_reason),
            version = version + 1,
            updated_at = now()
      WHERE id = $1
        AND ${input.actorColumn} = $2
        AND status = 'PENDING'
      RETURNING *`,
    [input.id, input.actorUserId, input.to, input.reason ?? null],
  );
  return rows[0] ? mapRequest(rows[0]) : null;
}

/** Batch expiry, run by the worker. Uses the partial index on (expires_at) WHERE PENDING. */
export async function expireDue(tx: Tx, limit: number): Promise<MoneyRequest[]> {
  const { rows } = await tx.query<MoneyRequestRow>(
    `UPDATE money_requests
        SET status = 'EXPIRED', version = version + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM money_requests
         WHERE status = 'PENDING' AND expires_at <= now()
         ORDER BY expires_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit],
  );
  return rows.map(mapRequest);
}

export interface RequestListItem extends MoneyRequest {
  counterpartyName: string;
  counterpartyPhone: string;
  settledReference: string | null;
}

/**
 * Keyset pagination on (created_at, id). Never OFFSET: an offset scan reads and discards every
 * row it skips, so page 500 costs 500 pages of work. This costs the same as page 1 at any depth.
 */
export async function listRequests(
  tx: Tx,
  input: {
    userId: string;
    role: 'incoming' | 'outgoing';
    status?: RequestStatus;
    limit: number;
    cursor?: Cursor;
  },
): Promise<RequestListItem[]> {
  const selfColumn = input.role === 'incoming' ? 'payer_user_id' : 'requester_user_id';
  const otherColumn = input.role === 'incoming' ? 'requester_user_id' : 'payer_user_id';

  const params: unknown[] = [input.userId, input.limit];
  let filter = '';

  if (input.status) {
    params.push(input.status);
    filter += ` AND r.status = $${params.length}`;
  }
  if (input.cursor) {
    params.push(input.cursor.createdAt, input.cursor.id);
    // Full-precision text, cast back on the server: see shared/timestamp.ts.
    filter += ` AND (r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }

  const { rows } = await tx.query<MoneyRequestRow & {
    counterparty_name: string;
    counterparty_phone: string;
    settled_reference: string | null;
  }>(
    `SELECT r.*,
            r.created_at::text AS created_at_raw,
            u.name  AS counterparty_name,
            u.phone AS counterparty_phone,
            t.reference AS settled_reference
       FROM money_requests r
       JOIN users u ON u.id = r.${otherColumn}
       LEFT JOIN transfers t ON t.id = r.settled_transfer_id
      WHERE r.${selfColumn} = $1${filter}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $2`,
    params,
  );

  return rows.map((row) => ({
    ...mapRequest(row),
    counterpartyName: row.counterparty_name,
    counterpartyPhone: row.counterparty_phone,
    settledReference: row.settled_reference,
  }));
}
