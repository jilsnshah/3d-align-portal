import type { OrderSummary } from "../api";
import { stageIndex, stagesFor } from "../workflow";

/** Where a case has got to, drawn as the journey rather than named. The pill
    beside it says "In planning"; this says planning is the fourth of six with
    two still to come — the distance travelled, which no other column shows.

    Shared by the case list and the patient list, so a case reads the same
    wherever it turns up. */
export default function StageTrack({ order }: { order: OrderSummary }) {
  const stages = stagesFor(order.kind, order.intake);
  const at = stageIndex(order.kind, order.status, order.intake);
  const done = order.status === "COMPLETED";
  const phased = order.phases_total > 0 && order.phases_done < order.phases_total;
  return (
    <span className="track">
      <span className="track-bars" aria-hidden="true">
        {stages.map((stage, i) => (
          <span key={stage.key} className={done || i < at ? "seg done" : i === at ? "seg on" : "seg"} />
        ))}
      </span>
      <span className="track-say">
        {phased
          ? `Phase ${order.phases_done + 1}/${order.phases_total}`
          : done
            ? "Done"
            : `${Math.max(at + 1, 1)}/${stages.length}`}
      </span>
    </span>
  );
}
