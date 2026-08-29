/**
 * A toast.
 *
 * Used for one thing only: telling someone their payment raised a security alert. It is not a
 * general notification system, and deliberately does not auto-dismiss when it carries a warning
 * — a message about money leaving your account should not disappear because you looked away.
 */
import { useEffect } from 'react';

export function Toast({
  kind,
  title,
  body,
  onClose,
}: {
  kind: 'danger' | 'info';
  title: string;
  body: string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (kind === 'danger') return;
    const timer = setTimeout(onClose, 6000);
    return () => clearTimeout(timer);
  }, [kind, onClose]);

  return (
    <div className={`toast ${kind}`} role="alert" data-testid="toast">
      <div className="grow">
        <strong>{title}</strong>
        <div className="hint" style={{ color: 'inherit', opacity: 0.85 }}>
          {body}
        </div>
      </div>
      <button className="ghost small" onClick={onClose} aria-label="Dismiss">
        Dismiss
      </button>
    </div>
  );
}
