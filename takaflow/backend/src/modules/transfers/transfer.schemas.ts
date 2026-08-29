import { z } from 'zod';
import { phoneSchema, pinSchema } from '../auth/auth.schemas.js';

/**
 * Amounts arrive as strings of minor units. Not numbers: JSON numbers are IEEE-754 doubles, and
 * a client that sends 10000000.000000001 or 1e7 should be rejected at the boundary rather than
 * quietly rounded somewhere inside the ledger.
 */
export const amountMinorSchema = z
  .string()
  .regex(/^[1-9]\d{0,15}$/, 'Amount must be a positive integer number of poisha, as a string')
  .transform((value) => BigInt(value));

export const createTransferSchema = z.object({
  toPhone: phoneSchema,
  amountMinor: amountMinorSchema,
  note: z.string().trim().max(140).optional(),
  pin: pinSchema,
});

export type CreateTransferInput = z.infer<typeof createTransferSchema>;
