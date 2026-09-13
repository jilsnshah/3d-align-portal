/* Whatever a click opens, brought to the eye.
 *
 * The portal is full of choices that mount a panel underneath them — pick
 * "Book a scan visit" and a month calendar appears below the fold; ask for
 * changes and a box opens under the buttons; open a day and its times land
 * further down still. On a laptop the page simply grew downwards and nothing
 * moved, so the reader was left looking at the choice they had already made,
 * wondering whether it had worked.
 *
 * A revealed panel therefore brings itself into view, takes the keyboard where
 * there is something to type, and lights its edge once so the eye lands on it.
 * None of this fires on a page that was already showing the panel: it only
 * runs when the panel actually appears.
 */

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

/** The sticky top bar the scroll has to clear. */
const HEADER = 86;

function stilled(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Bring an element into view under the top bar, but never scroll away from
    something already comfortably on screen. */
export function bringIntoView(el: HTMLElement | null, { force = false } = {}) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const room = window.innerHeight - HEADER;
  const fitsAlready = rect.top >= HEADER && rect.bottom <= window.innerHeight - 8;
  if (fitsAlready && !force) return;
  // A panel taller than the screen is aligned to its top; a short one is
  // nudged just far enough to sit fully inside the window.
  const target =
    rect.height > room || rect.top < HEADER
      ? window.scrollY + rect.top - HEADER
      : window.scrollY + rect.bottom - window.innerHeight + 16;
  window.scrollTo({ top: Math.max(0, target), behavior: stilled() ? "auto" : "smooth" });
}

export default function Reveal({
  children,
  /** Put the keyboard in the first field, where there is one to fill in. */
  focus = false,
  /** Skip the scroll — for panels that replace something in place. */
  still = false,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  focus?: boolean;
  still?: boolean;
  className?: string;
  as?: "div" | "section";
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    let settle = 0;
    // After paint, so the panel has its real height before anything scrolls.
    frame = requestAnimationFrame(() => {
      if (!still) bringIntoView(el);
      if (focus) {
        const field = el.querySelector<HTMLElement>(
          "input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])",
        );
        field?.focus({ preventScroll: true });
      }
      /* A panel that fetches — the calendar reads the month's availability —
         grows after that first frame, and a page that grew under a scroll
         already in flight can leave the panel short of the screen. So the
         position is checked once more after it has settled. */
      if (!still) settle = window.setTimeout(() => bringIntoView(el), 450);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [focus, still]);

  return (
    <Tag ref={ref as never} className={`reveal${className ? ` ${className}` : ""}`}>
      {children}
    </Tag>
  );
}
