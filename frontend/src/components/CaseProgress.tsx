import type { OrderKind, OrderStatus } from "../api";
import { StatusPill } from "./ui";
import { STUCK, stageIndex, stagesFor } from "../workflow";

/** How far through the order is, next to what it is doing.
 *
 *  The status alone says which stage an order sits in but not how much of the
 *  journey is behind it, so a board of forty gives no sense of which are nearly
 *  done. The stages come from the shared workflow definition, because a
 *  by-product's journey is four stages and an accessory's is three — measuring
 *  either against the aligner's six left both stuck at nought.
 */
export default function CaseProgress({
  status,
  label,
  kind = "ALIGNER",
  phaseDone,
  phaseTotal,
}: {
  status: OrderStatus;
  label: string;
  kind?: OrderKind;
  /** For a case in delivery, how many of its phases are finished. */
  phaseDone?: number;
  phaseTotal?: number;
}) {
  if (status === "CANCELLED") {
    return <StatusPill status={status} label={label} />;
  }

  const done = status === "COMPLETED";
  const stages = stagesFor(kind);
  const index = stageIndex(kind, status);
  // Phases only describe the delivery stage. A case that has been divided but
  // is back at the scan stage after a refinement is not "phase 3 of 5" — it is
  // waiting for a scan, and saying otherwise reads as progress it has not made.
  const inDelivery = index === stages.length - 1;
  const phases = inDelivery && phaseTotal && phaseTotal > 0 ? phaseTotal : 0;
  const inner = phases ? Math.min((phaseDone ?? 0) / phases, 1) : 0;
  const reached = done ? stages.length : index < 0 ? 0 : index + inner;
  const percent = Math.round((reached / stages.length) * 100);

  return (
    <div className="case-progress">
      <StatusPill status={status} label={label} />
      <div
        className={`case-progress-bar${done ? " done" : STUCK[status] ? " stuck" : ""}`}
        role="img"
        aria-label={`${percent}% through`}
        title={
          phases
            ? `${percent}% — phase ${Math.min((phaseDone ?? 0) + 1, phases)} of ${phases}`
            : `${percent}% through`
        }
      >
        <span style={{ width: `${done ? 100 : Math.max(percent, 4)}%` }} />
      </div>
      {/* The bar already says how far along; printing the same number under it
          on every row is the figure twice. Only what the bar cannot show gets
          words — which phase is out, and that a case is finished. */}
      {(done || phases > 0) && (
        <span className="case-progress-note">
          {done
            ? "Complete"
            : `Phase ${Math.min((phaseDone ?? 0) + 1, phases)} of ${phases}`}
        </span>
      )}
    </div>
  );
}
