/**
 * Velocity limiting and anomaly detection.
 *
 * Two different jobs that are easy to confuse:
 *
 *   - **Velocity** blocks the payment. Three transfers from one account in sixty seconds is a
 *     script, not a person, and the fourth is refused with 429.
 *   - **Anomaly** does NOT block the payment. An unusually large transfer is still the user's
 *     money and their instruction; refusing it would be a worse failure than the fraud it guards
 *     against. It goes through, and the account owner is told immediately.
 *
 * WHY THE COUNT IS TAKEN UNDER AN ADVISORY LOCK.
 *
 * A naive "count the last 60 seconds, then decide" is a read-then-write race: fire ten requests
 * at once and all ten read the same count of two, all ten pass, and the limit that exists to stop
 * scripted bursts is defeated by exactly the scripted burst it was written for.
 *
 * `pg_advisory_xact_lock` on the sender's account serialises the check for that one account, so
 * concurrent transfers queue and each sees the ones committed before it. The lock is released at
 * commit or rollback — there is nothing to clean up if the process dies mid-transaction.
 *
 * It is taken BEFORE the account row locks, and it is keyed on the sender alone, so it introduces
 * no new lock-ordering cycle: a transaction holding it never waits on another transaction that
 * wants it.
 */
import { config } from '../../config/index.js';
import type { Tx } from '../../platform/db/transaction.js';
import { errors } from '../../platform/errors/index.js';
import { logger } from '../../platform/logging/index.js';
import { velocityBlocks, securityAlerts } from '../../platform/metrics/index.js';

export interface VelocityPolicy {
  windowSeconds: number;
  maxTransfers: number;
  /** At or above this, a transfer is flagged as unusual — never blocked. */
  alertThresholdMinor: bigint;
}

/**
 * The live policy.
 *
 * Held in memory rather than read from `config` on every call so that an operator can tighten
 * the limits during an incident without a redeploy (see PATCH /admin/policy/velocity). It is
 * therefore PER INSTANCE: changing it on one replica does not change the others. That is an
 * honest limitation of keeping it in memory — a production system would put it in a table and
 * cache it. The enforcement itself is not weakened by this: whatever value an instance holds, it
 * applies exactly, because the counting happens in the database under a lock.
 */
let policy: VelocityPolicy = {
  windowSeconds: config.VELOCITY_WINDOW_SECONDS,
  maxTransfers: config.VELOCITY_MAX_TRANSFERS,
  alertThresholdMinor: BigInt(config.FRAUD_ALERT_THRESHOLD_MINOR),
};

export function getVelocityPolicy(): VelocityPolicy {
  return policy;
}

export function setVelocityPolicy(update: Partial<VelocityPolicy>): VelocityPolicy {
  policy = { ...policy, ...update };
  logger.warn({ policy: { ...policy, alertThresholdMinor: policy.alertThresholdMinor.toString() } },
    'velocity policy changed');
  return policy;
}

/** Only movements a person initiates count. A scheduled payment is not the user typing quickly. */
const COUNTED_TYPES = "('P2P', 'REQUEST_SETTLEMENT')";

/**
 * Refuse the transfer if this account has already made its allowance in the window.
 *
 * Must be called inside the same transaction that posts the transfer: the count and the write
 * have to be atomic with respect to each other, or the limit is advisory at best.
 */
export async function enforceVelocity(tx: Tx, accountId: string): Promise<void> {
  const { windowSeconds, maxTransfers } = policy;

  // Serialise this check for this sender. hashtext gives the bigint key advisory locks want;
  // a collision between two different accounts would only make one wait briefly for the other.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [accountId]);

  const { rows } = await tx.query<{ recent: number; oldest: Date | null }>(
    `SELECT count(*)::int AS recent, min(created_at) AS oldest
       FROM transfers
      WHERE from_account_id = $1
        AND type IN ${COUNTED_TYPES}
        AND created_at >= now() - ($2 || ' seconds')::interval`,
    [accountId, String(windowSeconds)],
  );

  const recent = rows[0]?.recent ?? 0;
  if (recent < maxTransfers) return;

  // Retry-After is when the OLDEST transfer in the window falls out of it, which is the first
  // moment this account could legitimately send again. Telling a client to retry earlier just
  // produces another 429.
  const oldest = rows[0]?.oldest;
  const retryAfter = oldest
    ? Math.max(1, Math.ceil(windowSeconds - (Date.now() - oldest.getTime()) / 1000))
    : windowSeconds;

  velocityBlocks.inc();
  logger.warn({ accountId, recent, windowSeconds, retryAfter }, 'velocity limit tripped');

  throw errors.rateLimited(retryAfter);
}

/** An unusually large transfer. Flagged, never blocked. */
export function isAnomalous(amountMinor: bigint): boolean {
  return amountMinor >= policy.alertThresholdMinor;
}

/**
 * The alert itself.
 *
 * DEMO IMPLEMENTATION: there is no mail provider wired up, so "sending" is a log line. The parts
 * that matter architecturally are real — it runs AFTER the money transaction has committed, it
 * cannot fail the payment, and the durable half of the notification is an outbox event written
 * inside the transaction, so the user is told even if this process dies the instant it returns.
 */
export async function sendSecurityAlert(input: {
  userId: string;
  reference: string;
  amountMinor: bigint;
}): Promise<void> {
  securityAlerts.inc();

  // The literal line the brief asks for, kept verbatim so it is obvious in a demo.
  console.log('SECURITY ALERT EMAIL SENT');
  logger.warn(
    { userId: input.userId, reference: input.reference, amountMinor: input.amountMinor.toString() },
    'security alert: unusually large transfer',
  );
}
