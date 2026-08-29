/**
 * Reading a statement. All reads, no locks, no writes.
 */
import { z } from 'zod';
import { withRoutedRead } from '../../platform/db/read-router.js';
import { errors } from '../../platform/errors/index.js';
import { money } from '../../shared/money.js';
import { decodeCursor, encodeCursor } from '../../shared/cursor.js';
import { phoneSchema } from '../auth/auth.schemas.js';
import { findAccountByUserId } from '../auth/auth.repo.js';
import { referenceDateRange } from './ledger.service.js';
import * as repo from './history.repo.js';

export const historyQuerySchema = z.object({
  direction: z.enum(['IN', 'OUT']).optional(),
  type: z.enum(['P2P', 'MINT', 'REQUEST_SETTLEMENT', 'REVERSAL', 'SCHEDULED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  minAmountMinor: z.string().regex(/^\d+$/).optional(),
  maxAmountMinor: z.string().regex(/^\d+$/).optional(),
  counterpartyPhone: phoneSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

export type HistoryQuery = z.infer<typeof historyQuerySchema>;

export interface HistoryItemDTO {
  id: string;
  reference: string;
  direction: 'IN' | 'OUT';
  type: string;
  status: string;
  amount: ReturnType<typeof money>;
  balanceAfter: ReturnType<typeof money>;
  note: string | null;
  counterparty: { name: string; phone: string | null };
  createdAt: string;
}

const toDTO = (entry: repo.HistoryEntry): HistoryItemDTO => ({
  id: entry.id,
  reference: entry.reference,
  direction: entry.direction === 'CREDIT' ? 'IN' : 'OUT',
  type: entry.type,
  status: entry.status,
  amount: money(entry.amountMinor),
  balanceAfter: money(entry.balanceAfterMinor),
  note: entry.note,
  counterparty: { name: entry.counterpartyName, phone: entry.counterpartyPhone },
  createdAt: entry.createdAt.toISOString(),
});

export async function listHistory(
  userId: string,
  query: HistoryQuery,
): Promise<{ items: HistoryItemDTO[]; nextCursor: string | null; servedBy: 'primary' | 'replica' }> {
  const account = await findAccountByUserId(userId);
  if (!account) throw errors.notFound('Account');

  if (query.from && query.to && query.from > query.to) {
    throw errors.validation('`from` must be earlier than `to`');
  }

  const cursor = decodeCursor(query.cursor);

  const { result: rows, servedBy } = await withRoutedRead(
    (tx) =>
      repo.listHistory(tx, {
        accountId: account.id,
        direction: query.direction,
        type: query.type,
        from: query.from,
        to: query.to,
        minAmountMinor: query.minAmountMinor ? BigInt(query.minAmountMinor) : undefined,
        maxAmountMinor: query.maxAmountMinor ? BigInt(query.maxAmountMinor) : undefined,
        counterpartyPhone: query.counterpartyPhone,
        // One extra row proves whether another page exists, without a COUNT(*).
        limit: query.limit + 1,
        cursor,
      }),
    { userId },
  );

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items[items.length - 1];

  return {
    items: items.map(toDTO),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAtRaw, id: last.id }) : null,
    servedBy,
  };
}

export async function getReceipt(userId: string, reference: string): Promise<HistoryItemDTO> {
  const account = await findAccountByUserId(userId);
  if (!account) throw errors.notFound('Account');

  const { result: entry } = await withRoutedRead(
    (tx) => repo.findByReference(tx, account.id, reference, referenceDateRange(reference)),
    { userId },
  );

  // A reference that belongs to someone else is reported as missing, not as forbidden: the
  // difference would confirm that the reference exists.
  if (!entry) throw errors.notFound('Transfer');
  return toDTO(entry);
}
