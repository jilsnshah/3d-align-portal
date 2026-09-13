/* Where the case has been and where it is, each stage dated by when it was
   entered. A stage already passed can be opened and read back.

   Shared by both sides of the portal on purpose: the clinic and the lab are
   watching the same case move through the same stages, and a journey drawn two
   different ways would be two different cases as far as the eye is concerned. */

import { useEffect, useRef } from "react";

import type { OrderDetail } from "../api";
import { stageIndex, stagesFor } from "../workflow";

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export default function Journey({
  order,
  viewing,
  onView,
}: {
  order: OrderDetail;
  /** null means the case's own current stage — the live page. */
  viewing: number | null;
  onView: (index: number | null) => void;
}) {
  const strip = useRef<HTMLOListElement | null>(null);
  const done = order.status === "COMPLETED";
  const stages = stagesFor(order.kind, order.intake);
  const current = stageIndex(order.kind, order.status, order.intake);
  const stuck = order.status === "RECORDS_REQUESTED" || order.status === "FIT_ISSUE";

  /* On a phone the strip scrolls, and it opened on the first stage — the one
     that matters was off the right edge. Centre the current stage instead. */
  useEffect(() => {
    const ol = strip.current;
    const li = ol?.querySelector<HTMLElement>("li.current");
    if (!ol || !li || ol.scrollWidth <= ol.clientWidth) return;
    ol.scrollLeft = li.offsetLeft - (ol.clientWidth - li.offsetWidth) / 2;
  }, [current]);

  if (order.status === "CANCELLED") return null;

  return (
    <ol className="ws-journey" aria-label="Case progress" ref={strip}>
      {stages.map((stage, i) => {
        const isCurrent = !done && i === current;
        const isDone = done || (current > -1 && i < current);
        const entered = order.events.find((e) => stage.statuses.includes(e.to_status))?.created_at;
        const reachable = current < 0 || i <= current;
        const isViewed = viewing === i;
        const state = isCurrent ? (stuck ? "current blocked" : "current") : isDone ? "done" : "ahead";
        const inner = (
          <>
            <span className="jr-dot" aria-hidden="true">
              {isDone ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 12 5 5 9-10" />
                </svg>
              ) : (
                i + 1
              )}
            </span>
            <span className="jr-say">
              <b>{stage.label}</b>
              <small>
                {isCurrent ? order.status_label : entered ? shortDate(entered) : isDone ? "Done" : " "}
              </small>
            </span>
          </>
        );
        return (
          <li key={stage.key} className={`${state}${isViewed ? " viewing" : ""}`}>
            {reachable ? (
              <button
                type="button"
                className="jr-step"
                aria-current={isCurrent ? "step" : undefined}
                title={isCurrent ? "Back to now" : `Look back at ${stage.label}`}
                onClick={() => onView(isCurrent || isViewed ? null : i)}
              >
                {inner}
              </button>
            ) : (
              <span className="jr-step">{inner}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
