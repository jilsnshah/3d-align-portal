/* What just happened.
 *
 * Every action in the portal used to finish in silence: the receipt was sent,
 * the visit was booked, the doctor was verified — and the page simply
 * rearranged itself, often below the fold, leaving the reader to work out
 * whether the click had landed at all. A confirmation is not decoration; it is
 * the half of the interaction that tells you the work is done.
 *
 * So each completed action says one sentence about what happened, and where it
 * is useful, offers the next step as a link. They stack at the bottom-left —
 * the contact dock owns the right — and clear themselves after a few seconds,
 * except failures, which stay until they are dismissed.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

export type Tone = "ok" | "warn" | "bad";

export type Toast = {
  /** The one sentence: "Visit booked", "Payment confirmed". */
  title: string;
  /** The detail a reader needs to be sure it was the right thing. */
  body?: string;
  tone?: Tone;
  /** Where to go next, when there is an obvious next place. */
  to?: string;
  toLabel?: string;
};

type Shown = Toast & { id: number };

const ToastContext = createContext<(toast: Toast) => void>(() => {});

/** Raise a confirmation. Stable, so it can sit in a mutation's onSuccess
    without re-running effects. */
export function useToast() {
  return useContext(ToastContext);
}

const LIFE = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown[]>([]);
  const next = useRef(1);

  const push = useCallback((toast: Toast) => {
    const id = next.current++;
    setShown((list) => [...list.slice(-2), { ...toast, id }]);
  }, []);

  const drop = useCallback((id: number) => setShown((list) => list.filter((t) => t.id !== id)), []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      {createPortal(
        <div className="toasts" role="region" aria-label="Recent activity">
          {shown.map((toast) => (
            <ToastCard key={toast.id} toast={toast} onDrop={() => drop(toast.id)} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDrop }: { toast: Shown; onDrop: () => void }) {
  const tone = toast.tone ?? "ok";

  useEffect(() => {
    // A failure waits to be read; everything else clears itself.
    if (tone === "bad") return;
    const timer = window.setTimeout(onDrop, LIFE);
    return () => window.clearTimeout(timer);
  }, [tone, onDrop]);

  return (
    <div className={`toast ${tone}`} role="status" aria-live="polite">
      <span className="toast-mark" aria-hidden="true">
        {tone === "ok" ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        ) : tone === "warn" ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 7.5V13M12 16.4v.01" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3.5 2.8 19.5h18.4z" />
            <path d="M12 10v4.2M12 17.2v.01" />
          </svg>
        )}
      </span>
      <span className="toast-say">
        <b>{toast.title}</b>
        {toast.body && <small>{toast.body}</small>}
        {toast.to && (
          <Link to={toast.to} onClick={onDrop}>
            {toast.toLabel ?? "Open"} →
          </Link>
        )}
      </span>
      <button type="button" className="toast-close" onClick={onDrop} aria-label="Dismiss">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}

/** The same confirmation, said in place — for the spots where the eye is
    already on a panel and a corner message would be missed. */
export function Done({ children }: { children: ReactNode }) {
  return (
    <p className="done-line" role="status">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m5 12.5 4.5 4.5L19 7.5" />
      </svg>
      {children}
    </p>
  );
}

export function useToastOnce(when: boolean, toast: Toast) {
  const push = useToast();
  const fired = useRef(false);
  const held = useMemo(() => toast, [toast.title, toast.body, toast.to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!when || fired.current) return;
    fired.current = true;
    push(held);
  }, [when, held, push]);
}
