import { useState } from 'react';
import { ApiError, endpoints, newIdempotencyKey, type Money } from '../lib/api';
import { useApp } from '../lib/app-state';
import { AmountInput, Banner, Card, ErrorBanner, Field, PinPrompt, Spinner } from '../components/ui';
import { UndoCountdown } from '../components/UndoCountdown';
import { Toast } from '../components/Toast';

/** Poisha to taka for display. Integer arithmetic — the UI does not get to use floats either. */
const formatMinor = (minor: string): string => {
  const value = BigInt(minor || '0');
  return `${(value / 100n).toLocaleString()}.${(value % 100n).toString().padStart(2, '0')}`;
};

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
  /**
   * The authorised-but-not-yet-sent payment.
   *
   * The PIN lives here for the length of the countdown and nowhere else: it is never written to
   * storage, never logged, and is dropped the moment the payment resolves or is undone.
   */
  const [pending, setPending] = useState<{ pin: string } | null>(null);
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [alerted, setAlerted] = useState(false);

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
    setPending(null);
    try {
      const result = await endpoints.send(
        { toPhone: phone, amountMinor, pin, ...(note ? { note } : {}) },
        idempotencyKey,
      );
      setAlerted(result.securityAlert === true);
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
  const frozen = account?.status === 'FROZEN';
  const canSend = phone.length === 11 && amountValid && payee !== null && !payee.isSelf && !frozen;

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
          {pending && (
            <UndoCountdown
              label={`Sending ৳${formatMinor(amountMinor)} to ${payee?.name ?? phone}`}
              onElapsed={() => void send(pending.pin)}
              onUndo={() => {
                setPending(null);
                setUndone(true);
              }}
            />
          )}
          {undone && (
            <Banner kind="info">
              Cancelled. No request was ever sent, so there is nothing to reverse.
            </Banner>
          )}
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

            <button type="submit" disabled={!canSend || busy || pending !== null}>
              {busy ? <Spinner /> : frozen ? 'Account frozen' : 'Review and send'}
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

      {alerted && (
        <Toast
          kind="danger"
          title="Security Alert: Unusual transaction detected."
          body="Check your email. If this was not you, freeze your account in Settings."
          onClose={() => setAlerted(false)}
        />
      )}

      {askPin && (
        <PinPrompt
          title="Confirm payment"
          confirmLabel={`Send ৳${formatMinor(amountMinor)}`}
          busy={busy}
          onConfirm={(pin) => {
            // Authorised, not yet sent. The countdown below is the last chance to change your
            // mind before anything reaches the server.
            setAskPin(false);
            setUndone(false);
            setSent(null);
            setPending({ pin });
          }}
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
