/**
 * Password and PIN hashing.
 *
 * Argon2id, with the password and the PIN hashed independently. A 4-digit PIN has only 10,000
 * possible values, so its security comes from the server-side lockout policy, not from the hash;
 * the hash exists so that a database leak does not immediately expose it.
 */
import { hash as argonHash, verify as argonVerify, Algorithm } from '@node-rs/argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456, // 19 MiB — OWASP's minimum recommendation for Argon2id
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashSecret(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTIONS);
}

export async function verifySecret(hash: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plain, ARGON_OPTIONS);
  } catch {
    // A malformed stored hash must read as "wrong secret", never as an exception that a caller
    // might accidentally treat as success.
    return false;
  }
}

/** Opaque refresh token. Stored only as a SHA-256 digest; the plaintext exists only in transit. */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
