import { useCallback, useEffect, useState } from 'react';
import { endpoints, newIdempotencyKey, type MoneyRequestItem } from '../lib/api';
import { useApp } from '../lib/app-state';
import {
  AmountInput,
  Avatar,
  Banner,
  Card,
  Empty,
  ErrorBanner,
  Field,
  PinPrompt,
  Spinner,
  StatusBadge,
} from '../components/ui';
import { relativeTime } from '../lib/format';

export function RequestsPage() {
  const { refreshAccount } = useApp();
  const [role, setRole] = useState<'incoming' | 'outgoing'>('incoming');
  const [items, setItems] = useState<MoneyRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paying, setPaying] = useState<MoneyRequestItem | null>(null);
  const [busy, setBusy] = useState(false);

  // Ask form
  const [phone, setPhone] = useState('');
  const [amountMinor, setAmountMinor] = useState('0');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await endpoints.requests(role);
      setItems(page.items);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [role]);

  useEffect(() => {
    void load();
  }, [load]);

  const ask = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await endpoints.createRequest(
        { fromPhone: phone, amountMinor, ...(note ? { note } : {}) },
        newIdempotencyKey(),
      );
      setNotice('Request sent.');
      setPhone('');
      setAmountMinor('0');
      setNote('');
      setRole('outgoing');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const pay = async (pin: string) => {
    if (!paying) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.acceptRequest(paying.id, pin, newIdempotencyKey());
      setNotice('Paid.');
      setPaying(null);
      await Promise.all([load(), refreshAccount()]);
    } catch (caught) {
      setError(caught);
      setPaying(null);
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Requests</h1>
          <p>Asking is one action; paying is another. Accepting settles both in one transaction.</p>
        </div>
      </div>

      <ErrorBanner error={error} />
      {notice && <Banner kind="success">{notice}</Banner>}

      <div className="grid two">
        <Card
          title={role === 'incoming' ? 'People asking you' : 'People you asked'}
          action={
            <div className="tabs" style={{ margin: 0 }}>
              <button className={role === 'incoming' ? 'active' : ''} onClick={() => setRole('incoming')}>
                Inbox
              </button>
              <button className={role === 'outgoing' ? 'active' : ''} onClick={() => setRole('outgoing')}>
                Sent
              </button>
            </div>
          }
        >
          {loading ? (
            <Empty>
              <Spinner />
            </Empty>
          ) : items.length === 0 ? (
            <Empty>Nothing here.</Empty>
          ) : (
            <div className="list">
              {items.map((request) => (
                <div className="item" key={request.id}>
                  <Avatar name={request.counterparty.name} />
                  <div className="grow">
                    <div className="title">
                      {request.counterparty.name} · ৳{request.amount.formatted}
                    </div>
                    <div className="sub">
                      {request.note ?? 'No note'} · {relativeTime(request.createdAt)}
                      {request.settledReference ? ` · ${request.settledReference}` : ''}
                    </div>
                  </div>
                  <StatusBadge status={request.status} />
                  {request.status === 'PENDING' && (
                    <div className="row">
                      {role === 'incoming' ? (
                        <>
                          <button className="small" onClick={() => setPaying(request)} disabled={busy}>
                            Pay
                          </button>
                          <button
                            className="small ghost"
                            disabled={busy}
                            onClick={() => act(() => endpoints.declineRequest(request.id))}
                          >
                            Decline
                          </button>
                        </>
                      ) : (
                        <button
                          className="small ghost"
                          disabled={busy}
                          onClick={() => act(() => endpoints.cancelRequest(request.id))}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Ask for money">
          <form onSubmit={ask}>
            <Field label="Their mobile number">
              <input
                value={phone}
                onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 11))}
                placeholder="01712345678"
                inputMode="numeric"
              />
            </Field>
            <Field label="Amount (BDT)">
              <AmountInput valueMinor={amountMinor} onChange={setAmountMinor} />
            </Field>
            <Field label="What is it for?" hint="They see this when deciding.">
              <input value={note} onChange={(event) => setNote(event.target.value.slice(0, 140))} placeholder="Dinner on Friday" />
            </Field>
            <button type="submit" disabled={busy || phone.length !== 11 || BigInt(amountMinor || '0') <= 0n}>
              {busy ? <Spinner /> : 'Send request'}
            </button>
          </form>

          <p className="hint" style={{ marginTop: 16 }}>
            A request never moves money by itself. It expires on its own, and it can be declined or
            cancelled — but only by the side entitled to do so, which the database enforces in the
            same statement that changes the state.
          </p>
        </Card>
      </div>

      {paying && (
        <PinPrompt
          title="Pay this request"
          confirmLabel={`Pay ৳${paying.amount.formatted}`}
          busy={busy}
          onConfirm={pay}
          onCancel={() => setPaying(null)}
        >
          <p className="muted" style={{ marginTop: 0 }}>
            Paying <strong>{paying.counterparty.name}</strong> — {paying.note ?? 'no note'}.
          </p>
        </PinPrompt>
      )}
    </>
  );
}
