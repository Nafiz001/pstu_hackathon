import { useCallback, useEffect, useState } from 'react';
import { downloadStatement, endpoints, newIdempotencyKey, type HistoryItem } from '../lib/api';
import { useApp } from '../lib/app-state';
import {
  Avatar,
  Badge,
  Banner,
  Card,
  Empty,
  ErrorBanner,
  Modal,
  PinPrompt,
  Spinner,
  StatusBadge,
} from '../components/ui';
import { fullDate, relativeTime } from '../lib/format';

const TYPES = ['', 'P2P', 'REQUEST_SETTLEMENT', 'SCHEDULED', 'REVERSAL', 'MINT'];

export function HistoryPage() {
  const { refreshAccount } = useApp();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [servedBy, setServedBy] = useState<string>('');
  const [direction, setDirection] = useState('');
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<HistoryItem | null>(null);
  const [reversing, setReversing] = useState<HistoryItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const query = useCallback(
    (next?: string) => {
      const params = new URLSearchParams({ limit: '20' });
      if (direction) params.set('direction', direction);
      if (type) params.set('type', type);
      if (next) params.set('cursor', next);
      return `?${params.toString()}`;
    },
    [direction, type],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await endpoints.history(query());
      setItems(page.items);
      setCursor(page.nextCursor);
      setServedBy(page.servedBy);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const more = async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await endpoints.history(query(cursor));
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const reverse = async (pin: string) => {
    if (!reversing) return;
    setBusy(true);
    setError(null);
    try {
      const result = await endpoints.reverse(reversing.reference, pin, newIdempotencyKey());
      setNotice(`Reversed. Compensating movement ${result.reversal.reference}.`);
      setReversing(null);
      setSelected(null);
      await Promise.all([load(), refreshAccount()]);
    } catch (caught) {
      setError(caught);
      setReversing(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Transactions</h1>
          <p>
            Every row is a ledger entry against your account — one per movement, never a summary
            recomputed on read.
          </p>
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            setError(null);
            downloadStatement().catch(setError);
          }}
        >
          Download statement (CSV)
        </button>
      </div>

      <ErrorBanner error={error} />
      {notice && <Banner kind="success">{notice}</Banner>}

      <Card
        action={
          servedBy ? (
            <Badge status={servedBy === 'primary' ? 'warn' : 'info'}>served by {servedBy}</Badge>
          ) : null
        }
      >
        <div className="row" style={{ marginBottom: 12 }}>
          <select value={direction} onChange={(event) => setDirection(event.target.value)} style={{ width: 160 }}>
            <option value="">All directions</option>
            <option value="IN">Money in</option>
            <option value="OUT">Money out</option>
          </select>
          <select value={type} onChange={(event) => setType(event.target.value)} style={{ width: 220 }}>
            {TYPES.map((value) => (
              <option key={value} value={value}>
                {value === '' ? 'All types' : value.toLowerCase().replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <Empty>
            <Spinner />
          </Empty>
        ) : items.length === 0 ? (
          <Empty>Nothing matches those filters.</Empty>
        ) : (
          <>
            <div className="list">
              {items.map((item) => (
                <div
                  className="item"
                  key={item.id}
                  onClick={() => setSelected(item)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => event.key === 'Enter' && setSelected(item)}
                  style={{ cursor: 'pointer' }}
                >
                  <Avatar name={item.counterparty.name} />
                  <div className="grow">
                    <div className="title">{item.counterparty.name}</div>
                    <div className="sub">
                      <span className="mono">{item.reference}</span> · {relativeTime(item.createdAt)}
                      {item.note ? ` · ${item.note}` : ''}
                    </div>
                  </div>
                  {item.status !== 'COMPLETED' && <StatusBadge status={item.status} />}
                  <div className={item.direction === 'IN' ? 'amount-in' : 'amount-out'}>
                    {item.direction === 'IN' ? '+' : '−'}৳{item.amount.formatted}
                  </div>
                </div>
              ))}
            </div>

            {cursor && (
              <div style={{ marginTop: 14 }}>
                <button className="secondary" onClick={more} disabled={busy}>
                  {busy ? <Spinner /> : 'Load more'}
                </button>
                <span className="hint" style={{ marginLeft: 10 }}>
                  Keyset pagination — page 500 costs the same as page 1.
                </span>
              </div>
            )}
          </>
        )}
      </Card>

      {selected && (
        <Modal title="Receipt" onClose={() => setSelected(null)}>
          <div className="grid" style={{ gap: 10 }}>
            <Row label="Reference" value={<span className="mono">{selected.reference}</span>} />
            <Row label="Amount" value={`৳${selected.amount.formatted}`} />
            <Row label="Direction" value={selected.direction === 'IN' ? 'Received' : 'Sent'} />
            <Row label="Counterparty" value={`${selected.counterparty.name} ${selected.counterparty.phone ?? ''}`} />
            <Row label="Balance after" value={`৳${selected.balanceAfter.formatted}`} />
            <Row label="Type" value={selected.type.toLowerCase().replace('_', ' ')} />
            <Row label="Status" value={<StatusBadge status={selected.status} />} />
            <Row label="When" value={fullDate(selected.createdAt)} />
            {selected.note && <Row label="Note" value={selected.note} />}
          </div>

          {selected.direction === 'OUT' && selected.status === 'COMPLETED' && selected.type === 'P2P' && (
            <>
              <p className="hint" style={{ marginTop: 16 }}>
                A reversal does not edit this record. It writes a new, opposite movement — the
                original stays exactly as it is, because history is history.
              </p>
              <button className="danger" style={{ marginTop: 8 }} onClick={() => setReversing(selected)}>
                Reverse this payment
              </button>
            </>
          )}
        </Modal>
      )}

      {reversing && (
        <PinPrompt
          title="Reverse payment"
          confirmLabel="Reverse"
          busy={busy}
          onConfirm={reverse}
          onCancel={() => setReversing(null)}
        >
          <p className="muted" style={{ marginTop: 0 }}>
            Pulling ৳{reversing.amount.formatted} back from {reversing.counterparty.name}. Only
            possible within the reversal window, and only if they still have the money.
          </p>
        </PinPrompt>
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', gap: 20 }}>
      <span className="muted">{label}</span>
      <span style={{ textAlign: 'right' }}>{value}</span>
    </div>
  );
}
