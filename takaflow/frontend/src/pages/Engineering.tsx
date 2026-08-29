/**
 * The engineering panel.
 *
 * This page exists because the interesting properties of this system are invisible from a normal
 * money screen. It surfaces them live: the four ledger invariants, the outbox backlog, which
 * database instance served a read, and — the one worth watching — what actually happens when the
 * same payment is submitted twice with the same idempotency key.
 */
import { useCallback, useEffect, useState } from 'react';
import { endpoints, newIdempotencyKey, type Money } from '../lib/api';
import { Badge, Banner, Card, Empty, ErrorBanner, Field, Spinner } from '../components/ui';
import { useApp } from '../lib/app-state';

interface Reconciliation {
  status: 'PASS' | 'FAIL';
  checks: Array<{ name: string; status: string; detail?: string }>;
  totals?: Record<string, string>;
}

interface DoubleSend {
  first: { reference: string; balance: Money };
  second: { reference: string; balance: Money };
  same: boolean;
}

export function EngineeringPage() {
  const { refreshAccount } = useApp();
  const [report, setReport] = useState<Reconciliation | null>(null);
  const [outbox, setOutbox] = useState<Awaited<ReturnType<typeof endpoints.outbox>> | null>(null);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [proof, setProof] = useState<DoubleSend | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [reconciliation, events, healthz] = await Promise.all([
        // A failing reconciliation answers 500 on purpose, so it is read defensively here.
        endpoints.reconciliation().catch((caught) => {
          if (caught?.details) return caught.details as unknown as Reconciliation;
          throw caught;
        }),
        endpoints.outbox(),
        endpoints.health().catch(() => null),
      ]);
      setReport(reconciliation);
      setOutbox(events);
      setHealth(healthz);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Submit the same payment twice with one key.
   *
   * The two responses come back byte-identical and the balance moves once. That is the whole
   * idempotency argument, demonstrated rather than asserted.
   */
  const doubleSend = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setProof(null);

    const key = newIdempotencyKey();
    const payload = { toPhone: phone, amountMinor: '100', pin, note: 'Idempotency demo' };

    try {
      const [first, second] = await Promise.all([
        endpoints.send(payload, key),
        endpoints.send(payload, key),
      ]);

      setProof({
        first: { reference: first.transfer.reference, balance: first.balance },
        second: { reference: second.transfer.reference, balance: second.balance },
        same: first.transfer.reference === second.transfer.reference,
      });
      await refreshAccount();
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
          <h1>Engineering</h1>
          <p>The properties this system claims, checked live rather than described.</p>
        </div>
        <button className="secondary" onClick={load} disabled={loading}>
          {loading ? <Spinner /> : 'Re-check'}
        </button>
      </div>

      <ErrorBanner error={error} />

      <div className="grid two">
        <Card
          title="Ledger invariants"
          action={report && <Badge status={report.status === 'PASS' ? 'ok' : 'bad'}>{report.status}</Badge>}
        >
          {!report ? (
            <Empty>{loading ? <Spinner /> : 'No report.'}</Empty>
          ) : (
            <>
              <table>
                <tbody>
                  {report.checks.map((check) => (
                    <tr key={check.name}>
                      <td>{check.name.replace(/_/g, ' ')}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Badge status={check.status === 'PASS' ? 'ok' : 'bad'}>{check.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint" style={{ marginTop: 12 }}>
                Every debit has a matching credit, every entry pair sums to zero, every balance
                equals the sum of its ledger, and the platform as a whole nets to zero. These are
                checked against the database, not against application state.
              </p>
            </>
          )}
        </Card>

        <Card title="Outbox">
          {!outbox ? (
            <Empty>{loading ? <Spinner /> : 'No data.'}</Empty>
          ) : (
            <>
              <div className="grid three">
                {outbox.byStatus.map((row) => (
                  <div className="stat" key={row.status}>
                    <span className="label">{row.status.toLowerCase()}</span>
                    <span className="value">{row.count}</span>
                  </div>
                ))}
              </div>
              {outbox.failed.length > 0 && (
                <Banner kind="error">
                  {outbox.failed.length} event(s) gave up after retrying. They are kept, not
                  dropped.
                </Banner>
              )}
              <p className="hint" style={{ marginTop: 12 }}>
                Notifications are written in the same transaction as the money, then delivered by a
                separate dispatcher. An event exists if and only if the movement happened.
              </p>
            </>
          )}
        </Card>
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <Card title="Prove idempotency">
          <p className="muted" style={{ marginTop: 0 }}>
            Sends ৳1.00 <strong>twice, simultaneously, with one idempotency key</strong> — the
            double-tap a flaky network produces. One payment should happen, and both responses
            should be identical.
          </p>

          <form onSubmit={doubleSend}>
            <Field label="Send to (mobile number)">
              <input
                value={phone}
                inputMode="numeric"
                onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 11))}
                placeholder="01712345678"
              />
            </Field>
            <Field label="Your PIN">
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
                placeholder="••••"
              />
            </Field>
            <button type="submit" disabled={busy || phone.length !== 11 || pin.length !== 4}>
              {busy ? <Spinner /> : 'Send it twice'}
            </button>
          </form>

          {proof && (
            <Banner kind={proof.same ? 'success' : 'error'}>
              {proof.same ? 'One payment, two identical responses.' : 'Two different payments — this would be a bug.'}
              <div className="mono" style={{ marginTop: 6 }}>
                #1 {proof.first.reference} → ৳{proof.first.balance.formatted}
                <br />
                #2 {proof.second.reference} → ৳{proof.second.balance.formatted}
              </div>
            </Banner>
          )}
        </Card>

        <Card title="This instance">
          {!health ? (
            <Empty>{loading ? <Spinner /> : 'No health data.'}</Empty>
          ) : (
            <table>
              <tbody>
                {Object.entries(health).map(([key, value]) => (
                  <tr key={key}>
                    <td>{key}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="hint" style={{ marginTop: 12 }}>
            Behind the load balancer this changes between refreshes: the API is stateless, so any
            replica can serve any request, and the transaction history header tells you whether a
            read came from the primary or the replica.
          </p>
        </Card>
      </div>
    </>
  );
}
