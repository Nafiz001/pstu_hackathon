/**
 * Expires money requests whose deadline has passed.
 *
 * Expiry is a real state transition with a notification, not a `WHERE expires_at > now()` filter
 * bolted onto every read. Two reasons: the requester should be told, and the state stored in the
 * database should be the truth rather than something each query has to re-derive.
 *
 * (The accept path *also* checks `expires_at > now()`, so a request is never settleable in the
 * window between its deadline and this worker's next tick. The worker owns the notification; the
 * guard owns the correctness.)
 */
import { withTransaction } from '../platform/db/transaction.js';
import { enqueueEvent } from '../platform/outbox/index.js';
import { logger } from '../platform/logging/index.js';
import { expireDue } from '../modules/requests/request.repo.js';

export async function expireRequests(batchSize = 200): Promise<number> {
  return withTransaction(async (tx) => {
    const expired = await expireDue(tx, batchSize);

    for (const request of expired) {
      await enqueueEvent(tx, {
        eventType: 'REQUEST_EXPIRED',
        aggregateType: 'money_request',
        aggregateId: request.id,
        payload: {
          requestId: request.id,
          requesterUserId: request.requesterUserId,
          payerUserId: request.payerUserId,
          amountMinor: request.amountMinor.toString(),
        },
      });
    }

    if (expired.length > 0) {
      logger.info({ count: expired.length }, 'expired money requests');
    }
    return expired.length;
  });
}
