/**
 * The UI primitives this app needs, and nothing else.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header>
          {title ? <h2>{title}</h2> : <span />}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {error ? <span className="error-text">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/**
 * Errors are shown as the server described them, including the request id.
 *
 * That id is the thread between a screenshot and a log line, and a money app whose failures are
 * all "something went wrong" is a money app nobody can support.
 */
export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;

  const message = error instanceof Error ? error.message : String(error);
  const api = error instanceof ApiError ? error : null;

  return (
    <div className="banner error">
      <strong>{message}</strong>
      {api && (
        <div className="mono" style={{ marginTop: 4, opacity: 0.75 }}>
          {api.code}
          {api.requestId ? ` · request ${api.requestId}` : ''}
        </div>
      )}
    </div>
  );
}

export function Banner({ kind, children }: { kind: 'success' | 'info' | 'error'; children: ReactNode }) {
  return <div className={`banner ${kind}`}>{children}</div>;
}

export function Badge({
  status,
  children,
}: {
  status?: 'ok' | 'bad' | 'warn' | 'info';
  children: ReactNode;
}) {
  return <span className={`badge ${status ?? ''}`}>{children}</span>;
}

const STATUS_TONE: Record<string, 'ok' | 'bad' | 'warn' | 'info'> = {
  ACCEPTED: 'ok',
  COMPLETED: 'ok',
  ACTIVE: 'ok',
  PAID: 'ok',
  PENDING: 'warn',
  PAUSED: 'warn',
  DECLINED: 'bad',
  CANCELLED: 'bad',
  EXPIRED: 'bad',
  FAILED: 'bad',
  REVERSED: 'bad',
  FROZEN: 'bad',
  SKIPPED: 'info',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge status={STATUS_TONE[status]}>{status.toLowerCase()}</Badge>;
}

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
  return <div className="avatar">{initials || '?'}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner() {
  return <span className="spin" aria-label="loading" />;
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div className="modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={title}>
        <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
          <h2>{title}</h2>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/**
 * A PIN prompt.
 *
 * The PIN is asked for at the moment of the action and never stored — not in state that outlives
 * the submit, not in localStorage, not in a "remember me". It is the second factor on every
 * movement of money, and a remembered second factor is not one.
 */
export function PinPrompt({
  title,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: (pin: string) => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const [pin, setPin] = useState('');

  return (
    <Modal title={title} onClose={onCancel}>
      {children}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm(pin);
        }}
      >
        <Field label="4-digit PIN" hint="Asked for every movement of money, and never stored.">
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
            {busy ? <Spinner /> : confirmLabel}
          </button>
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Amount input in taka, carried as poisha.
 *
 * The value handed back is an integer string of minor units. Floats never touch an amount: the
 * whole backend is built on that rule and the UI does not get to be the exception.
 */
export function AmountInput({
  valueMinor,
  onChange,
  autoFocus,
}: {
  valueMinor: string;
  onChange: (minor: string) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(valueMinor ? formatMinorForInput(valueMinor) : '');

  return (
    <input
      autoFocus={autoFocus}
      inputMode="decimal"
      placeholder="0.00"
      value={text}
      onChange={(event) => {
        const raw = event.target.value.replace(/[^\d.]/g, '');
        const [whole, fraction = ''] = raw.split('.');
        const clean = raw.includes('.') ? `${whole}.${fraction.slice(0, 2)}` : whole;
        setText(clean ?? '');
        onChange(toMinor(clean ?? ''));
      }}
    />
  );
}

function formatMinorForInput(minor: string): string {
  const value = BigInt(minor);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

/** Parse "1,234.5" to "123450" poisha, in integer arithmetic only. */
export function toMinor(text: string): string {
  const clean = text.replace(/,/g, '').trim();
  if (!clean) return '0';
  const [whole = '0', fraction = ''] = clean.split('.');
  const poisha = `${fraction}00`.slice(0, 2);
  return (BigInt(whole || '0') * 100n + BigInt(poisha)).toString();
}
