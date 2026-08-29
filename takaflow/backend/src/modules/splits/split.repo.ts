/**
 * Split-bill persistence.
 *
 * A split owns nothing that money requests do not already own; it is a header row plus a
 * `split_id` on each leg. That is deliberate — a leg must behave exactly like any other money
 * request when it is accepted, declined, expired or raced, and the surest way to guarantee that
 * is for it to BE one.
 */
import type { Tx } from '../../platform/db/transaction.js';
import { toMinor } from '../../shared/money.js';
import type { RequestStatus } from '../requests/request.repo.js';

export interface BillSplit {
  id: string;
  creatorUserId: string;
  totalAmountMinor: bigint;
  description: string;
  participantCount: number;
  createdAt: Date;
}

interface SplitRow {
  id: string;
  creator_user_id: string;
  total_amount_minor: string;
  description: string;
  participant_count: number;
  created_at: Date;
}

const mapSplit = (row: SplitRow): BillSplit => ({
  id: row.id,
  creatorUserId: row.creator_user_id,
  totalAmountMinor: toMinor(row.total_amount_minor),
  description: row.description,
  participantCount: row.participant_count,
  createdAt: row.created_at,
});

export async function insertSplit(
  tx: Tx,
  input: {
    creatorUserId: string;
    totalAmountMinor: bigint;
    description: string;
    participantCount: number;
  },
): Promise<BillSplit> {
  const { rows } = await tx.query<SplitRow>(
    `INSERT INTO bill_splits (creator_user_id, total_amount_minor, description, participant_count)
     VALUES ($1, $2::bigint, $3, $4)
     RETURNING *`,
    [
      input.creatorUserId,
      input.totalAmountMinor.toString(),
      input.description,
      input.participantCount,
    ],
  );
  return mapSplit(rows[0]!);
}

export async function findSplit(tx: Tx, id: string): Promise<BillSplit | null> {
  const { rows } = await tx.query<SplitRow>('SELECT * FROM bill_splits WHERE id = $1', [id]);
  return rows[0] ? mapSplit(rows[0]) : null;
}

export interface SplitLeg {
  requestId: string;
  payerUserId: string;
  payerName: string;
  payerPhone: string;
  amountMinor: bigint;
  status: RequestStatus;
  settledReference: string | null;
}

export async function listLegs(tx: Tx, splitId: string): Promise<SplitLeg[]> {
  const { rows } = await tx.query<{
    id: string;
    payer_user_id: string;
    name: string;
    phone: string;
    amount_minor: string;
    status: RequestStatus;
    reference: string | null;
  }>(
    `SELECT r.id, r.payer_user_id, u.name, u.phone, r.amount_minor, r.status, t.reference
       FROM money_requests r
       JOIN users u ON u.id = r.payer_user_id
       LEFT JOIN transfers t ON t.id = r.settled_transfer_id
      WHERE r.split_id = $1
      ORDER BY u.name, r.id`,
    [splitId],
  );

  return rows.map((row) => ({
    requestId: row.id,
    payerUserId: row.payer_user_id,
    payerName: row.name,
    payerPhone: row.phone,
    amountMinor: toMinor(row.amount_minor),
    status: row.status,
    settledReference: row.reference,
  }));
}

export interface SplitSummary extends BillSplit {
  /** The sum of the legs — the total minus the creator's own share, which nobody was asked for. */
  requestedMinor: bigint;
  collectedMinor: bigint;
  outstandingMinor: bigint;
  settledCount: number;
  legCount: number;
}

/**
 * Splits the caller created, with their collection progress.
 *
 * The aggregate is computed in the database rather than by fetching every leg: "how much have I
 * got back?" is one row per split, not one row per participant, and a user with a hundred splits
 * should not pull a thousand legs across the wire to see a list.
 */
export async function listSplits(
  tx: Tx,
  creatorUserId: string,
  limit: number,
): Promise<SplitSummary[]> {
  const { rows } = await tx.query<
    SplitRow & {
      requested_minor: string;
      collected_minor: string;
      settled_count: string;
      leg_count: string;
    }
  >(
    `SELECT s.*,
            coalesce(sum(r.amount_minor), 0)::text AS requested_minor,
            coalesce(sum(r.amount_minor) FILTER (WHERE r.status = 'ACCEPTED'), 0)::text
              AS collected_minor,
            count(r.id) FILTER (WHERE r.status = 'ACCEPTED')::text AS settled_count,
            count(r.id)::text AS leg_count
       FROM bill_splits s
       LEFT JOIN money_requests r ON r.split_id = s.id
      WHERE s.creator_user_id = $1
      GROUP BY s.id
      ORDER BY s.created_at DESC
      LIMIT $2`,
    [creatorUserId, limit],
  );

  return rows.map((row) => {
    const requested = toMinor(row.requested_minor);
    const collected = toMinor(row.collected_minor);
    return {
      ...mapSplit(row),
      requestedMinor: requested,
      collectedMinor: collected,
      // Measured against what was actually asked for: the creator's own share is part of the
      // total but was never requested from anyone, so it can never be collected.
      outstandingMinor: requested - collected,
      settledCount: Number(row.settled_count),
      legCount: Number(row.leg_count),
    };
  });
}
