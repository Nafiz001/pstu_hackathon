import { useCallback, useEffect, useState } from 'react';
import { endpoints, newIdempotencyKey, type SplitDetail, type SplitSummary } from '../lib/api';
import {
  AmountInput,
  Avatar,
  Banner,
  Card,
  Empty,
  ErrorBanner,
  Field,
  Modal,
  Spinner,
  StatusBadge,
} from '../components/ui';
import { dateOnly } from '../lib/format';

export function SplitsPage() {
  const [items, setItems] = useState<SplitSummary[]>([]);
  const [detail, setDetail] = useState<SplitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [description, setDescription] = useState('');
  const [totalMinor, setTotalMinor] = useState('0');
  const [includeSelf, setIncludeSelf] = useState(true);
  const [phones, setPhones] = useState<string[]>(['']);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await endpoints.splits();
      setItems(page.items);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const participants = phones.map((phone) => phone.trim()).filter((phone) => phone.length === 11);
  const headcount = participants.length + (includeSelf ? 1 : 0);
  const total = BigInt(totalMinor || '0');

  // The same integer arithmetic the server uses, so the preview cannot promise a different split
  // from the one that will actually be created.
  const preview =
    headcount > 0 && total > 0n
      ? Array.from({ length: headcount }, (_, index) =>
          index < Number(total % BigInt(headcount)) ? total / BigInt(headcount) + 1n : total / BigInt(headcount),
        )
      : [];

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await endpoints.createSplit(
        {
          totalAmountMinor: totalMinor,
          description,
          participants: participants.map((phone) => ({ phone })),
          includeSelf,
        },
        newIdempotencyKey(),
      );
      setNotice('Split created — everyone has been asked for their share.');
      setDescription('');
      setTotalMinor('0');
      setPhones(['']);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: string) => {
    setError(null);
    try {
      const result = await endpoints.splitDetail(id);
      setDetail(result.split);
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Split a bill</h1>
          <p>Shares are allocated in poisha, so they add up to the bill exactly — never 33.33 × 3.</p>
        </div>
      </div>

      <ErrorBanner error={error} />
      {notice && <Banner kind="success">{notice}</Banner>}

      <div className="grid two">
        <Card title="Your splits">
          {loading ? (
            <Empty>
              <Spinner />
            </Empty>
          ) : items.length === 0 ? (
            <Empty>No splits yet.</Empty>
          ) : (
            <div className="list">
              {items.map((split) => (
                <div
                  className="item"
                  key={split.id}
                  onClick={() => open(split.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => event.key === 'Enter' && open(split.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <Avatar name={split.description} />
                  <div className="grow">
                    <div className="title">{split.description}</div>
                    <div className="sub">
                      ৳{split.total.formatted} · {split.settledCount}/{split.legCount} paid ·{' '}
                      {dateOnly(split.createdAt)}
                    </div>
                  </div>
                  <div className="amount-in">৳{split.collected.formatted}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="New split">
          <form onSubmit={create}>
            <Field label="What was it for?">
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value.slice(0, 140))}
                placeholder="Dinner at Star Kabab"
              />
            </Field>

            <Field label="Total bill (BDT)">
              <AmountInput valueMinor={totalMinor} onChange={setTotalMinor} />
            </Field>

            <Field label="Split with" hint="Their mobile numbers — one per person.">
              <div className="grid" style={{ gap: 8 }}>
                {phones.map((phone, index) => (
                  <input
                    key={index}
                    value={phone}
                    inputMode="numeric"
                    placeholder="01712345678"
                    onChange={(event) => {
                      const value = event.target.value.replace(/\D/g, '').slice(0, 11);
                      setPhones((current) => current.map((item, i) => (i === index ? value : item)));
                    }}
                  />
                ))}
              </div>
            </Field>

            <div className="row" style={{ marginBottom: 14 }}>
              <button type="button" className="small ghost" onClick={() => setPhones((current) => [...current, ''])}>
                + Add person
              </button>
              {phones.length > 1 && (
                <button
                  type="button"
                  className="small ghost"
                  onClick={() => setPhones((current) => current.slice(0, -1))}
                >
                  − Remove
                </button>
              )}
              <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={includeSelf}
                  onChange={(event) => setIncludeSelf(event.target.checked)}
                  style={{ width: 16 }}
                />
                <span className="hint">I ate too</span>
              </label>
            </div>

            {preview.length > 0 && (
              <div className="banner info">
                {headcount} way split:{' '}
                {preview
                  .map((share) => `৳${(share / 100n).toString()}.${(share % 100n).toString().padStart(2, '0')}`)
                  .join(' + ')}
                <div className="hint" style={{ marginTop: 4 }}>
                  The leftover poisha goes to the first shares, so the parts sum to the bill exactly.
                </div>
              </div>
            )}

            <button type="submit" disabled={busy || participants.length === 0 || total <= 0n || !description}>
              {busy ? <Spinner /> : 'Ask everyone for their share'}
            </button>
          </form>
        </Card>
      </div>

      {detail && (
        <Modal title={detail.description} onClose={() => setDetail(null)}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
            <div className="stat">
              <span className="label">Bill</span>
              <span className="value">৳{detail.total.formatted}</span>
            </div>
            <div className="stat">
              <span className="label">Collected</span>
              <span className="value">৳{detail.collected.formatted}</span>
            </div>
            <div className="stat">
              <span className="label">Outstanding</span>
              <span className="value">৳{detail.outstanding.formatted}</span>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Share</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>You</td>
                <td>৳{detail.yourShare.formatted}</td>
                <td>
                  <span className="hint">own share</span>
                </td>
              </tr>
              {detail.legs.map((leg) => (
                <tr key={leg.requestId}>
                  <td>{leg.payer.name}</td>
                  <td>৳{leg.amount.formatted}</td>
                  <td>
                    <StatusBadge status={leg.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </>
  );
}
