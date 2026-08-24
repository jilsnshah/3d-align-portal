import { formatDate } from "../api";
import type { OrderDetail } from "../api";

const TONE: Record<string, string> = {
  NOT_STARTED: "pill",
  ACTIVE: "pill pill-gold",
  ISSUE: "pill pill-danger",
  COMPLETED: "pill pill-ok",
};

/** Where each phase of the dispatch has got to.
 *
 *  The division is fixed when the clinic chooses it, and each phase keeps its
 *  own state — which is what lets a mid-course rescan resume at the phase that
 *  was interrupted while the ones behind it stay finished. Showing the states
 *  together is the only way either side can see that at a glance.
 */
export default function PhaseTracker({ order }: { order: OrderDetail }) {
  if (!order.phases_divided || order.phase_plan.length === 0) return null;
  const open = order.phase_issues.find((i) => i.status === "OPEN");

  return (
    <section className="card">
      <h4 style={{ marginBottom: 4 }}>Phases</h4>
      <p className="dim" style={{ marginBottom: 12 }}>
        Fixed when the clinic chose {order.phase_count ?? order.phase_plan.length} batch(es).
        Delivery resumes at the first one that is not finished.
      </p>
      <ol className="phase-list">
        {order.phase_plan.map((p) => (
          <li key={p.phase} className={p.status === "ISSUE" ? "phase-issue" : undefined}>
            <b>
              Phase {p.phase}
              {p.round > 1 && <span className="dim"> · round {p.round}</span>}
            </b>
            <span className="num">
              aligners {p.from_step}–{p.to_step}
            </span>
            <span className={TONE[p.status] ?? "pill"}>{p.status_label}</span>
          </li>
        ))}
      </ol>

      {open && (
        <>
          <div className="banner banner-danger" style={{ marginTop: 12 }}>
            <span>
              <b>
                Fit issue · phase {open.phase_number} · {open.arch.toLowerCase()} aligner{" "}
                {open.aligner_number}
              </b>
              {open.notes && <> — {open.notes}</>}
              <br />
              <span className="dim">
                {open.awaiting === "LAB"
                  ? "With 3D Align."
                  : "With the clinic — they will say whether the advice worked, or close it."}
              </span>
            </span>
          </div>
          {open.messages.length > 0 && (
            <div className="stack-sm" style={{ marginTop: 8 }}>
              {open.messages.map((m) => (
                <div key={m.id} className={m.from_lab ? "notif" : "notif unread"}>
                  <div className="t">{m.from_lab ? "3D Align" : "The clinic"}</div>
                  <div className="b">{m.body}</div>
                  <div className="dim">{formatDate(m.created_at)}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {order.phase_issues.filter((i) => i.status === "RESOLVED").length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="btn-link" style={{ cursor: "pointer" }}>
            Earlier fit issues ({order.phase_issues.filter((i) => i.status === "RESOLVED").length})
          </summary>
          <div className="stack-sm" style={{ marginTop: 8 }}>
            {order.phase_issues
              .filter((i) => i.status === "RESOLVED")
              .map((i) => (
                <div key={i.id} className="notif">
                  <div className="t">
                    Phase {i.phase_number} · {i.arch.toLowerCase()} aligner {i.aligner_number}
                    <span className="dim"> · {i.resolution?.toLowerCase()}</span>
                  </div>
                  {i.notes && <div className="b">{i.notes}</div>}
                  {i.lab_comments && (
                    <div className="b">
                      <b>3D Align:</b> {i.lab_comments}
                    </div>
                  )}
                  <div className="dim">{formatDate(i.resolved_at ?? i.created_at)}</div>
                </div>
              ))}
          </div>
        </details>
      )}
    </section>
  );
}
