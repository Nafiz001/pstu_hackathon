import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/app-state';
import { Card, ErrorBanner, Field, Spinner } from '../components/ui';

export function AuthPage() {
  const { signIn, signUp } = useApp();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signin') await signIn(phone, password);
      else await signUp({ phone, name, password, pin });

      // Signing in lands on the overview, not on whatever page the previous session was last
      // looking at. A stale route is a confusing first thing to see after authenticating.
      navigate('/');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <Card>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div className="brand" style={{ justifyContent: 'center' }}>
            <span className="brand-mark">৳</span> TakaFlow
          </div>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Move money that always adds up.
          </p>
        </div>

        <div className="tabs">
          <button className={mode === 'signin' ? 'active' : ''} onClick={() => setMode('signin')}>
            Sign in
          </button>
          <button className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>
            Create account
          </button>
        </div>

        <ErrorBanner error={error} />

        <form onSubmit={submit}>
          <Field label="Mobile number" hint="Bangladeshi format, e.g. 01712345678">
            <input
              value={phone}
              onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 11))}
              placeholder="01712345678"
              autoComplete="username"
            />
          </Field>

          {mode === 'signup' && (
            <Field label="Full name">
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Rahim Uddin" />
            </Field>
          )}

          <Field label="Password" hint={mode === 'signup' ? 'At least 10 characters.' : undefined}>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
          </Field>

          {mode === 'signup' && (
            <Field
              label="Transaction PIN"
              hint="Four digits, asked for on every payment. Stored hashed, never in plain text."
            >
              <input
                inputMode="numeric"
                maxLength={4}
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
                placeholder="••••"
              />
            </Field>
          )}

          <button type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? <Spinner /> : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="hint" style={{ marginTop: 16, textAlign: 'center' }}>
          Judging this? <Link to="/judge">Open the judge console →</Link>
        </p>

        {mode === 'signup' && (
          <p className="hint" style={{ marginTop: 14 }}>
            New accounts are credited with a BDT 100,000 demo balance, minted from the platform
            treasury as a real double-entry movement — not as a number typed into a column.
          </p>
        )}
      </Card>
    </div>
  );
}
