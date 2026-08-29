import { useState } from 'react';
import { endpoints } from '../lib/api';
import { useApp } from '../lib/app-state';
import { Banner, Card, ErrorBanner, Field, Modal, Spinner } from '../components/ui';

export function SettingsPage() {
  const { user, account, refreshAccount } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [askPin, setAskPin] = useState(false);
  const [pin, setPin] = useState('');

  const frozen = account?.status === 'FROZEN';

  const freeze = async () => {
    setBusy(true);
    setError(null);
    try {
      await endpoints.setFreeze(true);
      await refreshAccount();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const unfreeze = async () => {
    setBusy(true);
    setError(null);
    try {
      await endpoints.setFreeze(false, pin);
      setAskPin(false);
      setPin('');
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
          <h1>Settings</h1>
          <p>Signed in as {user?.name} · {user?.phone}</p>
        </div>
      </div>

      <ErrorBanner error={error} />

      <div className="grid two">
        <Card title="Emergency freeze" className={frozen ? 'frozen' : ''}>
          <p className="muted" style={{ marginTop: 0 }}>
            Blocks every outgoing payment immediately — transfers, requests you would pay, and new
            scheduled payments. Money can still arrive.
          </p>

          <div className="row" style={{ justifyContent: 'space-between', marginTop: 16 }}>
            <div>
              <div className="title">{frozen ? 'Account is frozen' : 'Account is active'}</div>
              <div className="hint">
                {frozen
                  ? 'Unfreezing asks for your PIN.'
                  : 'Freezing is instant and asks for nothing.'}
              </div>
            </div>

            <button
              type="button"
              className={`toggle ${frozen ? 'on' : ''}`}
              role="switch"
              aria-checked={frozen}
              aria-label="Emergency freeze"
              disabled={busy}
              onClick={() => (frozen ? setAskPin(true) : freeze())}
            >
              <span className="knob" />
            </button>
          </div>

          {frozen && (
            <Banner kind="error">
              Outgoing payments are blocked. You can still receive money.
            </Banner>
          )}

          <p className="hint" style={{ marginTop: 16 }}>
            Freezing takes no PIN on purpose: someone who has just lost their phone should be able
            to stop payments in one tap. Unfreezing takes the PIN, so whoever has the phone cannot
            simply switch it back off.
          </p>
        </Card>

        <Card title="How your account is protected">
          <ul className="muted" style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 10 }}>
            <li>
              Every payment needs your 4-digit PIN, which is stored only as an Argon2id hash and
              locks itself after five wrong attempts.
            </li>
            <li>
              The freeze is checked again <em>while the account row is locked</em>, so a freeze
              landing mid-payment is resolved by the database rather than by timing.
            </li>
            <li>
              Unusual payments raise a security alert on your account, and every action is written
              to an audit log that cannot be edited or deleted.
            </li>
            <li>Sending money can be undone for five seconds before it is sent, and reversed for
              sixty seconds after.</li>
          </ul>
        </Card>
      </div>

      {askPin && (
        <Modal title="Unfreeze account" onClose={() => setAskPin(false)}>
          <p className="muted" style={{ marginTop: 0 }}>
            Enter your PIN to allow outgoing payments again.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void unfreeze();
            }}
          >
            <Field label="4-digit PIN">
              <input
                autoFocus
                inputMode="numeric"
                maxLength={4}
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
                placeholder="••••"
              />
            </Field>
            <div className="row">
              <button type="submit" disabled={pin.length !== 4 || busy}>
                {busy ? <Spinner /> : 'Unfreeze'}
              </button>
              <button type="button" className="ghost" onClick={() => setAskPin(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
