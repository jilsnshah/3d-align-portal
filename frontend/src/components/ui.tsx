import { useState } from "react";
import type { ReactNode } from "react";

import type { OrderStatus } from "../api";

const PILL_TONE: Record<OrderStatus, string> = {
  DRAFT: "pill",
  SUBMITTED: "pill pill-dark",
  UNDER_REVIEW: "pill pill-dark",
  RECORDS_REQUESTED: "pill pill-warn",
  QUOTED: "pill pill-gold",
  AWAITING_SCAN: "pill pill-warn",
  SCAN_SUBMITTED: "pill pill-dark",
  IN_PLANNING: "pill pill-dark",
  PLAN_SHARED: "pill pill-gold",
  TRAINING_ALIGNER_PRODUCTION: "pill pill-dark",
  TRAINING_ALIGNER_SHIPPED: "pill pill-dark",
  FIT_REVIEW: "pill pill-gold",
  FIT_ISSUE: "pill pill-danger",
  ALIGNER_PRODUCTION: "pill pill-dark",
  DISPATCHING: "pill pill-dark",
  COMPLETED: "pill pill-ok",
  CANCELLED: "pill pill-danger",
};

export function StatusPill({ status, label }: { status: OrderStatus; label: string }) {
  return <span className={PILL_TONE[status]}>{label}</span>;
}

export function Banner({
  tone = "warn",
  children,
}: {
  tone?: "warn" | "danger" | "ok";
  children: ReactNode;
}) {
  return <div className={`banner banner-${tone}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ what = "" }: { what?: string }) {
  return <div className="loading">Loading {what}…</div>;
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Inline error surface for mutations, so failures never vanish silently. */
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p style={{ color: "var(--danger)", fontSize: "0.85rem" }} role="alert">
      {message}
    </p>
  );
}

/** Two-step destructive confirm — no window.confirm, no accidental clicks. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = "btn-danger",
  disabled,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button type="button" className={className} disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="row">
      <button
        type="button"
        className="btn-danger"
        disabled={disabled}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="btn-link" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  );
}

/** Shows what an action depends on, so a disabled button is never a mystery. */
export function Checklist({ items }: { items: { done: boolean; label: string }[] }) {
  return (
    <ul className="checklist">
      {items.map((item) => (
        <li key={item.label} className={item.done ? "done" : ""}>
          <span className="mark" aria-hidden="true">
            ✓
          </span>
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
