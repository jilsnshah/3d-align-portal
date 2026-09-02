/* Looking back at a stage the case has already left.
 *
 * The page only ever showed now: whatever the case is waiting on, and the file
 * cabinet as it currently stands. Answering "what did we send at the records
 * stage" or "when did the scan actually arrive" meant reading the whole
 * timeline and inferring it.
 *
 * This steps through the stages the case has been through and shows what
 * happened in each — nothing more. It is deliberately read-only: while a past
 * stage is open the page hides every action panel, because an action taken
 * against a stage the case has left is not a thing that should be possible.
 */

import { formatDate } from "../api";
import type { OrderDetail } from "../api";
import { filesForStage, stageIndex, stagesFor } from "../workflow";

const CATEGORY_LABEL: Record<string, string> = {
  RECORD_PHOTO: "Clinical photographs",
  OPG: "OPG",
  LATERAL_CEPH: "Lateral cephalogram",
  CBCT: "CBCT",
  INTRAORAL_SCAN: "Intraoral scan",
  TREATMENT_PLAN: "Treatment plan",
  SIMULATION_MODEL: "Simulation",
  FIT_ISSUE_PHOTO: "Fit issue photographs",
  PROGRESS_PHOTO: "Progress photographs",
  PHASE_FIT_PHOTO: "Phase fit photographs",
  OTHER: "Other",
};

export default function StageBrowser({
  order,
  viewing,
  onView,
}: {
  order: OrderDetail;
  /** null means the case's own current stage — the live page. */
  viewing: number | null;
  onView: (index: number | null) => void;
}) {
  const stages = stagesFor(order.kind);
  const current = stageIndex(order.kind, order.status);
  // A completed or cancelled case sits outside the journey, so its last stage
  // is the furthest one anything actually happened in.
  const reached = current >= 0 ? current : stages.length - 1;
  const index = viewing ?? reached;
  const stage = stages[index];
  if (!stage) return null;

  const isPast = viewing !== null && viewing !== reached;

  // Everything the case did while it was in this stage.
  const events = order.events.filter((e) => stage.statuses.includes(e.to_status));
  const wanted = filesForStage(stage.key);
  const files = order.files.filter((f) => wanted.includes(f.category));
  const entered = events.length > 0 ? events[0].created_at : null;

  const byCategory = new Map<string, typeof files>();
  for (const f of files) {
    byCategory.set(f.category, [...(byCategory.get(f.category) ?? []), f]);
  }

  return (
    <section className={`card stage-browser${isPast ? " past" : ""}`}>
      <div className="stage-nav">
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={index === 0}
          onClick={() => onView(index - 1)}
        >
          ← Back
        </button>

        <div className="stage-nav-title">
          <span className="stage-nav-step">
            Stage {index + 1} of {stages.length}
          </span>
          <b>{stage.label}</b>
          {entered && <span className="dim"> · {formatDate(entered)}</span>}
        </div>

        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={index >= reached}
          onClick={() => onView(index + 1 >= reached ? null : index + 1)}
        >
          Next →
        </button>
      </div>

      {isPast && (
        <p className="stage-readonly">
          A record of what happened at <b>{stage.label}</b>. Nothing in it can be changed, and
          the case's own actions are hidden while it is open. Payments are unaffected.{" "}
          <button type="button" className="btn-link" onClick={() => onView(null)}>
            Back to now
          </button>
        </p>
      )}

      {events.length === 0 && files.length === 0 ? (
        <p className="dim">
          {index > reached
            ? "This case has not reached that stage yet."
            : "Nothing was recorded at this stage."}
        </p>
      ) : (
        <div className="stage-body">
          {events.length > 0 && (
            <div>
              <h5 className="stage-head">What happened</h5>
              <ul className="stage-events">
                {events.map((e) => (
                  <li key={e.id}>
                    <span className="stage-when">{formatDate(e.created_at)}</span>
                    <span>
                      {e.note || e.to_status.replace(/_/g, " ").toLowerCase()}
                      {e.actor_name && <span className="dim"> · {e.actor_name}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {byCategory.size > 0 && (
            <div>
              <h5 className="stage-head">What was collected</h5>
              {[...byCategory.entries()].map(([category, list]) => (
                <div key={category} className="stage-files">
                  <span className="stage-cat">{CATEGORY_LABEL[category] ?? category}</span>
                  <ul>
                    {list.map((f) => (
                      <li key={f.id}>
                        {/* A link, not an uploader — this view never writes. */}
                        <a href={`/api/orders/${order.id}/files/${f.id}`} target="_blank" rel="noreferrer">
                          {f.slot_label || f.filename}
                        </a>
                        {f.revision > 1 && <span className="dim"> · v{f.revision}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
