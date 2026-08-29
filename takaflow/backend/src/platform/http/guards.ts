/**
 * Route guards that need a database read.
 *
 * `requireActiveAccount` is an EARLY rejection, not the authoritative one.
 *
 * The check that actually protects the money is inside `postDoubleEntry`, taken against the
 * account row while it is locked — because only there is the answer guaranteed not to be stale.
 * This guard reads without a lock, so between it and the transaction the status could change in
 * either direction; that is fine, because it is allowed to be wrong in only one harmless way
 * (letting a request through that the lock will then refuse).
 *
 * It exists because a user who has frozen their own account deserves an immediate, obvious "your
 * account is frozen" instead of a validation walk, a PIN check, and a lock wait before hearing
 * the same thing.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { errors } from '../errors/index.js';
import { findAccountByUserId } from '../../modules/auth/auth.repo.js';
import { currentUser } from './context.js';

export async function requireActiveAccount(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const user = currentUser(request);
  const account = await findAccountByUserId(user.id);

  if (!account) throw errors.notFound('Account');
  if (account.status === 'FROZEN') {
    throw errors.accountFrozen(
      'Your account is frozen. Unfreeze it in settings to send money again.',
    );
  }
  if (account.status === 'CLOSED') throw errors.accountFrozen('This account is closed');
}
