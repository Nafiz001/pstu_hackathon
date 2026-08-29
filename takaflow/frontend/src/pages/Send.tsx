import { useState } from 'react';
import { ApiError, endpoints, newIdempotencyKey, type Money } from '../lib/api';
import { useApp } from '../lib/app-state';
import { AmountInput, Banner, Card, ErrorBanner, Field, PinPrompt, Spinner } from '../components/ui';

interface Sent {
  reference: string;
  amount: Money;
  balance: Money;
  replayed: boolean;
}

export function SendPage() {
  const { account, refreshAccount } = useApp();
  const [phone, setPhone] = useState('');
  const [amountMinor, setAmountMinor] = useState('0');
  const [note, setNote] = useState('');
  const [payee, setPayee] = useState<{ name: string; isSelf: boolean } | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [askPin, setAskPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<Sent | null>(null);

  /**
   * One key per intent, minted when the form is submitted — NOT per HTTP request.
   *
   * Held in state so that a failed send the user retries with the same details reuses it: if the
   * first attempt actually reached the server, the retry replays that result instead of sending
   * the money a second time.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const lookup = async (value: string) => {
    setPayee(null);
    setLookupError(null);
    if (value.length !== 11) return;

    try {
      const found = await endpoints.findUser(value);
      setPayee({ name: found.user.name, isSelf: found.user.isSelf });
      if (found.user.isSelf) setLookupError('That is your own number.');
    } catch (caught) {
      setLookupError(caught instanceof ApiError && caught.status === 404 ? 'No TakaFlow user with that number.' : 'Could not check that number.');
    }
  };

  const send = async (pin: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await endpoints.send(
        { toPhone: phone, amountMinor, pin, ...(note ? { note } : {}) },
        idempotencyKey,
      );
      setSent({
        reference: result.transfer.reference,
        amount: result.transfer.amount,
        balance: result.balance,
        replayed: false,
      });
      setAskPin(false);
      // A new intent needs a new key; reusing this one would replay the payment just made.
      setIdempotencyKey(newIdempotencyKey());
      setPhone('');
      setAmountMinor('0');
      setNote('');
      setPayee(null);
      await refreshAccount();
    } catch (caught) {
      setError(caught);
      setAskPin(false);
    } finally {
      setBusy(false);
    }
  };

  const amountValid = BigInt(amountMinor || '0') > 0n;
  const canSend = phone.length === 11 && amountValid && payee !== null && !payee.isSelf;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Send money</h1>
          <p>Available: ৳{account?.balance.formatted ?? '—'}</p>
        </div>
      </div>

      <div className="grid two">
        <Card>
          <ErrorBanner error={error} />
          {sent && (
            <Banner kind="success">
              Sent ৳{sent.amount.formatted}. Reference <span className="mono">{sent.reference}</span>.
              <br />
              New balance ৳{sent.balance.formatted}.
            </Banner>
          )}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              setAskPin(true);
            }}
          >
            <Field label="Recipient's mobile number" error={lookupError ?? undefined} hint={payee && !payee.isSelf ? `Paying ${payee.name}` : 'Exact number — there is deliberately no name search.'}>
              <input
                value={phone}
                onChange={(event) => {
                  const value = event.target.value.replace(/\D/g, '').slice(0, 11);
                  setPhone(value);
                  void lookup(value);
                }}
                placeholder="01712345678"
                inputMode="numeric"
              />
            </Field>

            <Field label="Amount (BDT)" hint="Held as poisha end to end; no floating point anywhere.">
              <AmountInput valueMinor={amountMinor} onChange={setAmountMinor} />
            </Field>

            <Field label="Note (optional)">
              <input value={note} onChange={(event) => setNote(event.target.value.slice(0, 140))} placeholder="Lunch" />
            </Field>

            <button type="submit" disabled={!canSend || busy}>
              {busy ? <Spinner /> : 'Review and send'}
            </button>
          </form>
        </Card>

        <Card title="What happens when you press send">
          <ol className="muted" style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 10 }}>
            <li>
              This browser attaches an <strong>idempotency key</strong> for this intent. If the
              network drops and it retries, the server recognises the key and replays the original
              result rather than paying twice.
            </li>
            <li>
              The server locks both accounts <strong>in ascending id order</strong>, so two people
              paying each other at the same instant cannot deadlock.
            </li>
            <li>
              Your balance is checked <em>under that lock</em> — not before it — so a balance that
              changed a microsecond ago cannot be spent twice.
            </li>
            <li>
              One transaction writes the transfer, two ledger entries summing to zero, both new
              balances, and the notification event. All of it commits, or none of it does.
            </li>
          </ol>
        </Card>
      </div>

      {askPin && (
        <PinPrompt
          title="Confirm payment"
          confirmLabel={`Send ৳${(BigInt(amountMinor) / 100n).toString()}.${(BigInt(amountMinor) % 100n).toString().padStart(2, '0')}`}
          busy={busy}
          onConfirm={send}
          onCancel={() => setAskPin(false)}
        >
          <p className="muted" style={{ marginTop: 0 }}>
            Paying <strong>{payee?.name}</strong> on {phone}.
          </p>
        </PinPrompt>
      )}
    </>
  );
}
