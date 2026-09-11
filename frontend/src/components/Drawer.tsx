import { useEffect } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** A panel from the right edge, over a dimmed page: the way a row opens across
    the portal — a patient, a doctor, a charge, a visit, a technician.

    Rendered into the body, because `.page` animates a transform, which would
    otherwise make it the containing block for this fixed panel. Escape and a
    click on the dimmed page both close it, and the page behind stops
    scrolling while it is open. */
export default function Drawer({
  eyebrow,
  title,
  sub,
  lead,
  stats,
  foot,
  wide = false,
  onClose,
  children,
}: {
  eyebrow: string;
  title: string;
  sub?: ReactNode;
  /** An avatar or mark beside the title. */
  lead?: ReactNode;
  /** A strip of figures under the head. */
  stats?: ReactNode;
  /** Actions pinned to the foot, always in reach however long the body. */
  foot?: ReactNode;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="pt-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className={`pt-panel${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className={`pt-panel-head${lead ? "" : " bare"}`}>
          {lead}
          <div className="pt-panel-title">
            <span className="pt-eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
            {sub && <p>{sub}</p>}
          </div>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        {stats}
        <div className="pt-panel-body">{children}</div>
        {foot && <footer className="dw-foot">{foot}</footer>}
      </aside>
    </div>,
    document.body,
  );
}
