import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { endpoints, type HistoryItem, type MoneyRequestItem, type NotificationItem } from '../lib/api';
import { useApp } from '../lib/app-state';
import { Avatar, Badge, Card, Empty, ErrorBanner, Spinner, StatusBadge } from '../components/ui';
import { relativeTime } from '../lib/format';

export function DashboardPage() {
  const { user, account, refreshAccount } = useApp();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [incoming, setIncoming] = useState<MoneyRequestItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [recent, requests, notes] = await Promise.all([
        endpoints.history('?limit=6'),
        endpoints.requests('incoming', 'PENDING'),
        endpoints.notifications(),
      ]);
      setHistory(recent.items);
      setIncoming(requests.items);
      setNotifications(notes.items.filter((note) => !note.read).slice(0, 4));
      await refreshAccount();
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [refreshAccount]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Hello, {user?.name?.split(' ')[0] ?? 'there'}</h1>
          <p>Everything below is derived from the ledger, never from a stored total.</p>
        </div>
        {account?.status === 'FROZEN' ? (
          <Link to="/settings">
            <button className="secondary">Unfreeze to send</button>
          </Link>
        ) : (
          <Link to="/send">
            <button>Send money</button>
          </Link>
        )}
      </div>

      <ErrorBanner error={error} />

      <div className="grid two" style={{ marginBottom: 16 }}>
        <Card className="balance">
          <div className="stat">
            <span className="label">Available balance</span>
            <span className="amount">৳{account?.balance.formatted ?? '—'}</span>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            {account && <StatusBadge status={account.status} />}
            {account?.servedFromCache && (
              <Badge status="info">
                served from cache
              </Badge>
            )}
            <span className="spacer" />
            <span className="hint">Sent in last 24h: ৳{account?.spentLast24h.formatted ?? '0.00'}</span>
          </div>
        </Card>

        <Card title="Needs your attention">
          {incoming.length === 0 && notifications.length === 0 ? (
            <Empty>Nothing waiting. Quiet is good.</Empty>
          ) : (
            <div className="list">
              {incoming.map((request) => (
                <div className="item" key={request.id}>
                  <Avatar name={request.counterparty.name} />
                  <div className="grow">
                    <div className="title">{request.counterparty.name} requested ৳{request.amount.formatted}</div>
                    <div className="sub">{request.note ?? 'No note'} · {relativeTime(request.createdAt)}</div>
                  </div>
                  <Link to="/requests">
                    <button className="small secondary">Review</button>
                  </Link>
                </div>
              ))}
              {notifications.map((note) => (
                <div className="item" key={note.id}>
                  <Avatar name={note.payload.title ?? 'TakaFlow'} />
                  <div className="grow">
                    <div className="title">{note.payload.title ?? note.type}</div>
                    <div className="sub">{note.payload.body ?? ''} · {relativeTime(note.createdAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Recent activity"
        action={
          <Link to="/history" className="hint">
            View all →
          </Link>
        }
      >
        {loading ? (
          <Empty>
            <Spinner />
          </Empty>
        ) : history.length === 0 ? (
          <Empty>No movements yet.</Empty>
        ) : (
          <div className="list">
            {history.map((item) => (
              <div className="item" key={item.id}>
                <Avatar name={item.counterparty.name} />
                <div className="grow">
                  <div className="title">{item.counterparty.name}</div>
                  <div className="sub">
                    {item.note ?? item.type.toLowerCase().replace('_', ' ')} · {relativeTime(item.createdAt)}
                  </div>
                </div>
                <div className={item.direction === 'IN' ? 'amount-in' : 'amount-out'}>
                  {item.direction === 'IN' ? '+' : '−'}৳{item.amount.formatted}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
