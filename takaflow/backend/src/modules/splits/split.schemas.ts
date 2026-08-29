import { z } from 'zod';
import { phoneSchema } from '../auth/auth.schemas.js';
import { amountMinorSchema } from '../transfers/transfer.schemas.js';

const participantSchema = z.object({
  phone: phoneSchema,
  /**
   * Relative share. Absent everywhere means an even split; present anywhere means every
   * participant's weight is used. Weights are integers so the allocation stays exact — a
   * percentage would reintroduce the rounding this feature exists to avoid.
   */
  weight: z.number().int().min(1).max(1000).optional(),
});

export const createSplitSchema = z
  .object({
    totalAmountMinor: amountMinorSchema,
    description: z.string().trim().min(1).max(140),
    participants: z.array(participantSchema).min(1).max(20),
    /** Whether the creator's own share is part of the total. Usually yes: they ate too. */
    includeSelf: z.boolean().default(true),
    /** The creator's own weight, when weights are used and their share is part of the total. */
    selfWeight: z.number().int().min(1).max(1000).default(1),
    expiresInDays: z.number().int().min(1).max(30).default(7),
  })
  .refine(
    (input) => {
      const phones = input.participants.map((participant) => participant.phone);
      return new Set(phones).size === phones.length;
    },
    { message: 'The same person cannot appear twice in a split', path: ['participants'] },
  )
  .refine(
    (input) =>
      input.participants.every((participant) => participant.weight === undefined) ||
      input.participants.every((participant) => participant.weight !== undefined),
    {
      message: 'Give a weight for everyone or for nobody',
      path: ['participants'],
    },
  );

export type CreateSplitInput = z.infer<typeof createSplitSchema>;
