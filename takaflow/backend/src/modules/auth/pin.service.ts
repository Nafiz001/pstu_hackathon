/**
 * Transaction PIN verification.
 *
 * A 4-digit PIN is 10,000 possibilities; brute force is the only realistic attack and lockout is
 * the only real defence, so the counter has to be durable — including on the path where the
 * request is about to fail.
 *
 * Two constraints shape this code:
 *
 *   1. Argon2 verification (~50 ms, 19 MiB) happens outside any transaction. Doing it while
 *      holding a row lock on `users` would let anyone stall other requests by spamming PINs.
 *   2. The failure counter is committed in its own transaction *before* the error is thrown.
 *      Incrementing it inside the caller's money transaction would roll the increment back
 *      along with everything else, and the lockout would never trigger.
 */
import { withTransaction } from '../../platform/db/transaction.js';
import { query } from '../../platform/db/pool.js';
import { verifySecret } from '../../platform/auth/crypto.js';
import { errors } from '../../platform/errors/index.js';
import { config } from '../../config/index.js';

interface PinRow {
  pin_hash: string;
  failed_pin_attempts: number;
  pin_locked_until: Date | null;
  status: 'ACTIVE' | 'SUSPENDED';
}

export async function verifyPin(userId: string, pin: string): Promise<void> {
  const { rows } = await query<PinRow>(
    'SELECT pin_hash, failed_pin_attempts, pin_locked_until, status FROM users WHERE id = $1',
    [userId],
  );
  const user = rows[0];
  if (!user) throw errors.notFound('User');
  if (user.status !== 'ACTIVE') throw errors.forbidden('This account is suspended');

  if (user.pin_locked_until !== null && user.pin_locked_until.getTime() > Date.now()) {
    throw errors.pinLocked(user.pin_locked_until);
  }

  const ok = await verifySecret(user.pin_hash, pin);

  if (!ok) {
    const attempts = await recordFailedAttempt(userId);
    const remaining = Math.max(0, config.MAX_PIN_ATTEMPTS - attempts);
    if (remaining === 0) {
      throw errors.pinLocked(new Date(Date.now() + config.PIN_LOCKOUT_MINUTES * 60_000));
    }
    throw errors.invalidPin(remaining);
  }

  if (user.failed_pin_attempts > 0 || user.pin_locked_until !== null) {
    await clearFailedAttempts(userId);
  }
}

/** Committed independently of the caller's transaction — see the note at the top of the file. */
async function recordFailedAttempt(userId: string): Promise<number> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<{ failed_pin_attempts: number }>(
      `UPDATE users
          SET failed_pin_attempts = failed_pin_attempts + 1,
              pin_locked_until = CASE
                WHEN failed_pin_attempts + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
                ELSE pin_locked_until
              END,
              updated_at = now()
        WHERE id = $1
        RETURNING failed_pin_attempts`,
      [userId, config.MAX_PIN_ATTEMPTS, String(config.PIN_LOCKOUT_MINUTES)],
    );
    return rows[0]?.failed_pin_attempts ?? 0;
  });
}

async function clearFailedAttempts(userId: string): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE users
          SET failed_pin_attempts = 0, pin_locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [userId],
    );
  });
}
