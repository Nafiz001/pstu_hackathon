/**
 * Request schemas. Zod is the single source of truth: it validates at runtime and produces the
 * TypeScript types, so a route handler can never see a shape the validator did not approve.
 */
import { z } from 'zod';

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^01[3-9]\d{8}$/, 'Must be a valid Bangladeshi mobile number (e.g. 01712345678)');

export const pinSchema = z.string().regex(/^\d{4}$/, 'PIN must be exactly 4 digits');

export const registerSchema = z.object({
  phone: phoneSchema,
  name: z.string().trim().min(2).max(80),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(200, 'Password must be at most 200 characters'),
  pin: pinSchema,
});

export const loginSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(1).max(200),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(16).max(200),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
