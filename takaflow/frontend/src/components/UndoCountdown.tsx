/**
 * The five-second undo window.
 *
 * A deliberate pause between "I pressed send" and "the money left". It is entirely client-side
 * and that is the point: during the countdown NO request has been made, so there is nothing to
 * cancel, nothing to compensate, and no window in which the server and the user disagree about
 * whether a payment exists. Cancelling is free because nothing happened yet.
 *
 * The server-side reversal window (a compensating double entry, within 60 seconds) is the other
 * half of the same idea and covers the case this cannot: the user changed their mind after the
 * money actually moved.
 *
 * The countdown deliberately does NOT hold the payment across a page navigation. If the component
 * unmounts the timer is cleared and the payment never happens — failing to send is recoverable,
 * sending something the user walked away from is not.
 */
import { useEffect, useRef, useState } from 'react';

const WINDOW_MS = 5_000;
const TICK_MS = 50;

export function UndoCountdown({
  label,
  onElapsed,
  onUndo,
}: {
  label: string;
  onElapsed: () => void;
  onUndo: () => void;
}) {
  const [remaining, setRemaining] = useState(WINDOW_MS);

  // Held in a ref so that re-rendering every 50ms does not restart the timer, and so the latest
  // callback is used without making the effect depend on it.
  const elapsedRef = useRef(onElapsed);
  elapsedRef.current = onElapsed;

  useEffect(() => {
    const startedAt = Date.now();

    // Driven by the wall clock rather than by counting ticks: a throttled background tab fires
    // intervals late and irregularly, and counting ticks there would stretch five seconds into
    // considerably more.
    const timer = setInterval(() => {
      const left = WINDOW_MS - (Date.now() - startedAt);
      if (left > 0) {
        setRemaining(left);
        return;
      }

      clearInterval(timer);
      setRemaining(0);
      elapsedRef.current();
    }, TICK_MS);

    return () => clearInterval(timer);
  }, []);

  const seconds = Math.ceil(remaining / 1000);
  const progress = 100 - (remaining / WINDOW_MS) * 100;

  return (
    <div className="banner info" data-testid="undo-countdown">
      <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
        <div>
          <strong>{label}</strong>
          <div className="hint">
            Sending in {seconds}s — nothing has left your account yet.
          </div>
        </div>
        <button type="button" className="danger" onClick={onUndo}>
          Undo
        </button>
      </div>
      <div className="progress" aria-hidden>
        <div className="progress-bar" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}
