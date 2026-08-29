import { useCallback, useEffect, useState } from 'react';
import { endpoints, newIdempotencyKey, type ScheduleItem } from '../lib/api';
import {
  AmountInput,
  Avatar,
  Banner,
  Card,
  Empty,
  ErrorBanner,
  Field,
  Modal,
  PinPrompt,
  Spinner,
  StatusBadge,
} from '../components/ui';
import { fullDate, toLocalInputValue } from '../lib/format';

type Occurrence = {
  dueAt: string;
  status: string;
  attempts: number;
  failureReason: string | null;
  transferReference: string | null;
};

export function SchedulesPage() {
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [detail, setDetail] = useState<{ schedule: ScheduleItem; occurrences: Occurrence[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [askPin, setAskPin] = useState(false);

  const [phone, setPhone] = useState('');
  const [amountMinor, setAmountMinor] = useState('0');
  const [intervalKind, setIntervalKind] = useState('MONTHLY');
  const [startAt, setStartAt] = useState(toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)));
  const [totalRuns, setTotalRuns] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await endpoints.schedules();
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

  const create = async (pin: string) => {
    setBusy(true);
    setError(null);
    try {
      await endpoints.createSchedule(
        {
          toPhone: phone,
          amountMinor,
          intervalKind,
          startAt: new Date(startAt).toISOString(),
          ...(totalRuns ? { totalRuns: Number(totalRuns) } : {}),
          ...(note ? { note } : {}),
          pin,
        },
        newIdempotencyKey(),
      );
      setNotice('Schedule created. Nothing moves until it is due.');
      setAskPin(false);
      setPhone('');
      setAmountMinor('0');
      setNote('');
      setTotalRuns('');
      await load();
    } catch (caught) {
      setError(caught);
      setAskPin(false);
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
      if (detail) {
        const refreshed = await endpoints.scheduleDetail(detail.schedule.id);
        setDetail(refreshed);
      }
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
          <h1>Scheduled payments</h1>
          <p>
            Rent on the 1st, without anyone pressing a button — and without paying twice if the
            scheduler restarts mid-run.
          </p>
        </div>
      </div>

      <ErrorBanner error={error} />
      {notice && <Banner kind="success">{notice}</Banner>}

      <div className="grid two">
        <Card title="Your schedules">
          {loading ? (
            <Empty>
              <Spinner />
            </Empty>
          ) : items.length === 0 ? (
            <Empty>Nothing scheduled.</Empty>
          ) : (
            <div className="list">
              {items.map((schedule) => (
                <div className="item" key={schedule.id}>
                  <Avatar name={schedule.payee.name} />
                  <div
                    className="grow"
                    role="button"
                    tabIndex={0}
                    style={{ cursor: 'pointer' }}
                    onClick={() => endpoints.scheduleDetail(schedule.id).then(setDetail).catch(setError)}
                    onKeyDown={(event) =>
                      event.key === 'Enter' &&
                      endpoints.scheduleDetail(schedule.id).then(setDetail).catch(setError)
                    }
                  >
                    <div className="title">
                      ৳{schedule.amount.formatted} to {schedule.payee.name}
                    </div>
                    <div className="sub">
                      {schedule.intervalKind.toLowerCase()}
                      {schedule.nextRunAt ? ` · next ${fullDate(schedule.nextRunAt)}` : ''}
                      {schedule.remainingRuns !== null ? ` · ${schedule.remainingRuns} left` : ''}
                    </div>
                  </div>
                  <StatusBadge status={schedule.status} />
                  {schedule.status === 'ACTIVE' && (
                    <button
                      className="small ghost"
                      disabled={busy}
                      onClick={() => act(() => endpoints.pauseSchedule(schedule.id))}
                    >
                      Pause
                    </button>
                  )}
                  {schedule.status === 'PAUSED' && (
                    <button
                      className="small secondary"
                      disabled={busy}
                      onClick={() => act(() => endpoints.resumeSchedule(schedule.id))}
                    >
                      Resume
                    </button>
                  )}
                  {(schedule.status === 'ACTIVE' || schedule.status === 'PAUSED') && (
                    <button
                      className="small danger"
                      disabled={busy}
                      onClick={() => act(() => endpoints.cancelSchedule(schedule.id))}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="New schedule">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setAskPin(true);
            }}
          >
            <Field label="Pay to (mobile number)">
              <input
                value={phone}
                inputMode="numeric"
                onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 11))}
                placeholder="01712345678"
              />
            </Field>

            <Field label="Amount (BDT)">
              <AmountInput valueMinor={amountMinor} onChange={setAmountMinor} />
            </Field>

            <div className="grid two" style={{ gap: 12 }}>
              <Field label="How often">
                <select value={intervalKind} onChange={(event) => setIntervalKind(event.target.value)}>
                  <option value="ONCE">Once</option>
                  <option value="DAILY">Daily</option>
                  <option value="WEEKLY">Weekly</option>
                  <option value="MONTHLY">Monthly</option>
                </select>
              </Field>

              <Field label="First payment">
                <input type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} />
              </Field>
            </div>

            {intervalKind !== 'ONCE' && (
              <Field label="Number of payments" hint="Leave blank to run until you cancel it.">
                <input
                  value={totalRuns}
                  inputMode="numeric"
                  placeholder="e.g. 12"
                  onChange={(event) => setTotalRuns(event.target.value.replace(/\D/g, '').slice(0, 3))}
                />
              </Field>
            )}

            <Field label="Note (optional)">
              <input value={note} onChange={(event) => setNote(event.target.value.slice(0, 140))} placeholder="Rent" />
            </Field>

            <button
              type="submit"
              disabled={busy || phone.length !== 11 || BigInt(amountMinor || '0') <= 0n}
            >
              {busy ? <Spinner /> : 'Create schedule'}
            </button>
          </form>

          <p className="hint" style={{ marginTop: 14 }}>
            Each occurrence is identified by the instant it was due, so a duplicate tick, a restart,
            or two servers waking at once can only ever produce one payment. A payment that cannot
            be made is retried with backoff, then recorded as failed — never silently skipped.
          </p>
        </Card>
      </div>

      {detail && (
        <Modal title="Schedule history" onClose={() => setDetail(null)}>
          <p className="muted" style={{ marginTop: 0 }}>
            ৳{detail.schedule.amount.formatted} to {detail.schedule.payee.name} ·{' '}
            {detail.schedule.intervalKind.toLowerCase()}
          </p>

          {detail.occurrences.length === 0 ? (
            <Empty>Nothing has run yet.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Due</th>
                  <th>Status</th>
                  <th>Tries</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {detail.occurrences.map((occurrence) => (
                  <tr key={occurrence.dueAt}>
                    <td>{fullDate(occurrence.dueAt)}</td>
                    <td>
                      <StatusBadge status={occurrence.status} />
                      {occurrence.failureReason && (
                        <div className="hint">{occurrence.failureReason}</div>
                      )}
                    </td>
                    <td>{occurrence.attempts}</td>
                    <td className="mono">{occurrence.transferReference ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}

      {askPin && (
        <PinPrompt
          title="Authorise this schedule"
          confirmLabel="Create schedule"
          busy={busy}
          onConfirm={create}
          onCancel={() => setAskPin(false)}
        >
          <p className="muted" style={{ marginTop: 0 }}>
            This authorises payments that will happen when you are not here, so it asks for your PIN
            now.
          </p>
        </PinPrompt>
      )}
    </>
  );
}
