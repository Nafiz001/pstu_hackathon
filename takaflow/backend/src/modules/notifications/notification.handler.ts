/**
 * Outbox consumers.
 *
 * Delivery is at-least-once, so every handler must be idempotent. Here that is enforced by the
 * database rather than by care: `notifications` carries UNIQUE (user_id, event_id), and inserts
 * use ON CONFLICT DO NOTHING. Redelivering an event a hundred times produces one notification.
 *
 * Handlers receive the dispatcher's transaction. They must not perform network I/O — the same
 * rule as the money path, for the same reason.
 */
import type { Tx } from '../../platform/db/transaction.js';
import { formatTaka } from '../../shared/money.js';

export interface OutboxEventRecord {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
}

const str = (payload: Record<string, unknown>, key: string): string | null => {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
};

async function notify(
  tx: Tx,
  input: {
    userId: string;
    eventId: string;
    type: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO notifications (user_id, event_id, type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (user_id, event_id) DO NOTHING`,
    [input.userId, input.eventId, input.type, JSON.stringify(input.payload)],
  );
}

const takaOf = (payload: Record<string, unknown>): string => {
  const minor = str(payload, 'amountMinor');
  return minor === null ? '' : formatTaka(BigInt(minor));
};

/**
 * Returns the number of notifications the event produced. An event type with no consumer is not
 * an error — it is simply not interesting to anyone yet.
 */
export async function handleEvent(tx: Tx, event: OutboxEventRecord): Promise<number> {
  const p = event.payload;

  switch (event.eventType) {
    case 'USER_REGISTERED': {
      const userId = str(p, 'userId');
      if (!userId) return 0;
      await notify(tx, {
        userId,
        eventId: event.id,
        type: 'WELCOME',
        payload: {
          title: 'Welcome to TakaFlow',
          body: `Your account has been funded with BDT ${formatTaka(BigInt(str(p, 'bonusMinor') ?? '0'))}.`,
          reference: str(p, 'transferReference'),
        },
      });
      return 1;
    }

    case 'MONEY_RECEIVED': {
      const recipientUserId = str(p, 'recipientUserId');
      if (!recipientUserId) return 0;
      await notify(tx, {
        userId: recipientUserId,
        eventId: event.id,
        type: 'MONEY_RECEIVED',
        payload: {
          title: 'Money received',
          body: `You received BDT ${takaOf(p)}.`,
          reference: str(p, 'reference'),
          note: str(p, 'note'),
        },
      });
      return 1;
    }

    case 'REQUEST_CREATED': {
      const payerUserId = str(p, 'payerUserId');
      if (!payerUserId) return 0;
      await notify(tx, {
        userId: payerUserId,
        eventId: event.id,
        type: 'REQUEST_RECEIVED',
        payload: {
          title: 'Payment requested',
          body: `${str(p, 'requesterName') ?? 'Someone'} requested BDT ${takaOf(p)} from you.`,
          requestId: str(p, 'requestId'),
          note: str(p, 'note'),
        },
      });
      return 1;
    }

    case 'REQUEST_ACCEPTED': {
      const requesterUserId = str(p, 'requesterUserId');
      if (!requesterUserId) return 0;
      await notify(tx, {
        userId: requesterUserId,
        eventId: event.id,
        type: 'REQUEST_ACCEPTED',
        payload: {
          title: 'Request paid',
          body: `Your request for BDT ${takaOf(p)} was paid.`,
          requestId: str(p, 'requestId'),
          reference: str(p, 'transferReference'),
        },
      });
      return 1;
    }

    case 'REQUEST_DECLINED':
    case 'REQUEST_CANCELLED':
    case 'REQUEST_EXPIRED': {
      // Declined and expired concern the requester; cancelled concerns the payer, who was the
      // one being asked and no longer needs to act.
      const target =
        event.eventType === 'REQUEST_CANCELLED'
          ? str(p, 'payerUserId')
          : str(p, 'requesterUserId');
      if (!target) return 0;

      const wording: Record<string, string> = {
        REQUEST_DECLINED: `Your request for BDT ${takaOf(p)} was declined.`,
        REQUEST_CANCELLED: `A request for BDT ${takaOf(p)} was cancelled.`,
        REQUEST_EXPIRED: `Your request for BDT ${takaOf(p)} expired.`,
      };

      await notify(tx, {
        userId: target,
        eventId: event.id,
        type: event.eventType,
        payload: {
          title: 'Request update',
          body: wording[event.eventType],
          requestId: str(p, 'requestId'),
          reason: str(p, 'reason'),
        },
      });
      return 1;
    }

    /**
     * Money that moves while nobody is looking is the case a user most needs told about, so all
     * three outcomes of a scheduled payment notify the owner — including the ones where nothing
     * happened, because a rent payment that silently did not go out is the expensive surprise.
     */
    case 'SCHEDULE_PAID':
    case 'SCHEDULE_FAILED':
    case 'SCHEDULE_SKIPPED': {
      const ownerUserId = str(p, 'ownerUserId');
      if (!ownerUserId) return 0;

      const wording: Record<string, string> = {
        SCHEDULE_PAID: `Your scheduled payment of BDT ${takaOf(p)} was sent.`,
        SCHEDULE_FAILED: `Your scheduled payment of BDT ${takaOf(p)} could not be sent: ${
          str(p, 'reason') ?? 'unknown reason'
        }`,
        SCHEDULE_SKIPPED: `A scheduled payment of BDT ${takaOf(p)} was skipped because it was overdue.`,
      };

      await notify(tx, {
        userId: ownerUserId,
        eventId: event.id,
        type: event.eventType,
        payload: {
          title: 'Scheduled payment',
          body: wording[event.eventType],
          scheduleId: str(p, 'scheduleId'),
          reference: str(p, 'reference'),
        },
      });
      return 1;
    }

    /**
     * A freeze is worth a notification precisely because the person who triggered it might not
     * be the account's owner: if a thief freezes or unfreezes it, the owner finds out.
     */
    case 'ACCOUNT_FROZEN':
    case 'ACCOUNT_UNFROZEN': {
      const userId = str(p, 'userId');
      if (!userId) return 0;

      const froze = event.eventType === 'ACCOUNT_FROZEN';
      await notify(tx, {
        userId,
        eventId: event.id,
        type: event.eventType,
        payload: {
          title: froze ? 'Account frozen' : 'Account unfrozen',
          body: froze
            ? 'Outgoing payments are blocked until you unfreeze the account.'
            : 'Your account can send money again.',
        },
      });
      return 1;
    }

    /**
     * The durable half of the security alert. The "email" is a log line in this build, but this
     * notification is written in the same transaction as the money, so the user is told about an
     * unusual payment even if the process dies the moment after it commits.
     */
    case 'SECURITY_ALERT': {
      const userId = str(p, 'userId');
      if (!userId) return 0;

      await notify(tx, {
        userId,
        eventId: event.id,
        type: 'SECURITY_ALERT',
        payload: {
          title: 'Security alert',
          body: `Unusual transaction detected: BDT ${takaOf(p)} sent. If this was not you, freeze your account now.`,
          reference: str(p, 'reference'),
        },
      });
      return 1;
    }

    default:
      return 0;
  }
}
