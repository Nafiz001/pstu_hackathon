import { z } from 'zod';
import { phoneSchema, pinSchema } from '../auth/auth.schemas.js';
import { amountMinorSchema } from '../transfers/transfer.schemas.js';

export const intervalKindSchema = z.enum(['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY']);

export const createScheduleSchema = z
  .object({
    toPhone: phoneSchema,
    amountMinor: amountMinorSchema,
    note: z.string().trim().max(140).optional(),
    intervalKind: intervalKindSchema,
    /** ISO 8601. The first payment runs at or after this instant, never before it. */
    startAt: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value)),
    /** Absent means "until cancelled". */
    totalRuns: z.number().int().min(1).max(120).optional(),
    pin: pinSchema,
  })
  .refine((input) => input.intervalKind !== 'ONCE' || (input.totalRuns ?? 1) === 1, {
    message: 'A one-off schedule runs exactly once',
    path: ['totalRuns'],
  });

export const listSchedulesSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type ListSchedulesQuery = z.infer<typeof listSchedulesSchema>;
