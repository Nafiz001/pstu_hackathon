/**
 * Emergency freeze — the user's own kill switch.
 *
 * The asymmetry is the design. Freezing takes no PIN and no confirmation: someone who thinks
 * their phone has been stolen must be able to stop the bleeding in one tap, and demanding a
 * secret from a person in a panic is how a safety feature becomes useless. Unfreezing DOES take
 * the PIN, because otherwise whoever stole the session could simply switch it back off.
 *
 * The freeze itself is not a new mechanism: it sets `accounts.status`, which every money path
 * already re-checks under the account row lock. That is what makes it race-free — a freeze
 * committing during a transfer either lands before the transfer takes the lock (and the transfer
 * is refused) or after it commits (and the transfer stands). There is no interleaving where a
 * frozen account pays out.
 */
import { withTransaction } from '../../platform/db/transaction.js';
import { errors } from '../../platform/errors/index.js';
import { enqueueEvent } from '../../platform/outbox/index.js';
import { money, toMinor } from '../../shared/money.js';
import { insertAuditLog } from '../auth/auth.repo.js';
import { verifyPin } from '../auth/pin.service.js';
import type { RequestContext } from '../requests/request.service.js';

export interface FreezeResult {
  id: string;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  balance: ReturnType<typeof money>;
  frozen: boolean;
}

export async function setOwnFreeze(
  userId: string,
  frozen: boolean,
  pin: string | undefined,
  context: RequestContext,
): Promise<FreezeResult> {
  // Unfreezing is the privileged direction, so it is the one that costs a PIN.
  if (!frozen) {
    if (!pin) throw errors.validation('Your PIN is required to unfreeze the account');
    await verifyPin(userId, pin);
  }

  return withTransaction(async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
      balance_minor: string;
    }>(
      `SELECT id, status::text AS status, balance_minor
         FROM accounts
        WHERE user_id = $1
        FOR UPDATE`,
      [userId],
    );

    const account = rows[0];
    if (!account) throw errors.notFound('Account');
    if (account.status === 'CLOSED') {
      throw errors.invalidState('A closed account cannot be frozen or unfrozen', {
        status: 'CLOSED',
      });
    }

    const target = frozen ? 'FROZEN' : 'ACTIVE';

    // Asking for the state it is already in is success, not an error: a double tap on a panic
    // button must not produce a scary red message.
    if (account.status !== target) {
      await tx.query(
        'UPDATE accounts SET status = $2::account_status, version = version + 1 WHERE id = $1',
        [account.id, target],
      );

      await enqueueEvent(tx, {
        eventType: frozen ? 'ACCOUNT_FROZEN' : 'ACCOUNT_UNFROZEN',
        aggregateType: 'account',
        aggregateId: account.id,
        payload: { userId, accountId: account.id },
      });

      await insertAuditLog(tx, {
        actorUserId: userId,
        action: frozen ? 'SELF_FREEZE' : 'SELF_UNFREEZE',
        entityType: 'account',
        entityId: account.id,
        metadata: { from: account.status, to: target },
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });
    }

    return {
      id: account.id,
      status: target,
      balance: money(toMinor(account.balance_minor)),
      frozen,
    };
  });
}
