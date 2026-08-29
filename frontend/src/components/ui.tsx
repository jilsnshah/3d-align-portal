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
  PRODUCT_FABRICATION: "pill pill-dark",
  DISPATCHING: "pill pill-dark",
  PHASE_REVIEW: "pill pill-gold",
  COMPLETED: "pill pill-ok",
  CANCELLED: "pill pill-danger",
};

export function StatusPill({ status, label }: { status: OrderStatus; label: string }) {
  return <span className={PILL_TONE[status]}>{label}</span>;
}

/** The Align band a case is priced in. Rendered muted while it is still the
 *  estimate read off the photographs, solid once the plan confirms it, so a
 *  list distinguishes a guess from a commitment at a glance. */
export function CategoryPill({
  label,
  confirmed,
}: {
  label: string;
  confirmed: boolean;
}) {
  if (!label) return <span className="dim">—</span>;
  return (
    <span
      className={confirmed ? "pill pill-dark" : "pill"}
      title={confirmed ? "Confirmed by the treatment plan" : "Estimated — the plan will confirm it"}
    >
      {label}
      {!confirmed && <span className="pill-est">est</span>}
    </span>
  );
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

/** Placeholders shaped like the content that is coming.

    A spinner says only that something is happening; a shape says what, holds
    the layout so nothing jumps when the data lands, and reads as faster than a
    line of text on an empty page even when it is not. */
export function Skeleton({
  rows = 4,
  variant = "row",
}: {
  rows?: number;
  variant?: "row" | "card" | "tile";
}) {
  return (
    <div className={`skeleton skeleton-${variant}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-item">
          <span className="skeleton-line wide" />
          <span className="skeleton-line narrow" />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  /** A rule the value obeys that the label cannot carry on its own — a
      surcharge, a limit, what the price already covers. */
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small className="muted">{hint}</small> : null}
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
