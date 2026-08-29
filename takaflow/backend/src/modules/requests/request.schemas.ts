import { z } from 'zod';
import { phoneSchema, pinSchema } from '../auth/auth.schemas.js';
import { amountMinorSchema } from '../transfers/transfer.schemas.js';

export const createRequestSchema = z.object({
  /** The person being asked to pay. */
  fromPhone: phoneSchema,
  amountMinor: amountMinorSchema,
  note: z.string().trim().max(140).optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

export const acceptRequestSchema = z.object({
  pin: pinSchema,
});

export const declineRequestSchema = z.object({
  reason: z.string().trim().max(140).optional(),
});

export const listRequestsSchema = z.object({
  role: z.enum(['incoming', 'outgoing']).default('incoming'),
  status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

export type CreateRequestInput = z.infer<typeof createRequestSchema>;
export type ListRequestsQuery = z.infer<typeof listRequestsSchema>;
