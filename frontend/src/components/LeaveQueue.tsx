import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, formatDate } from "../api";
import type { LeaveDecision } from "../api";
import { Banner, ErrorText } from "./ui";

/** Leave waiting on the lab, and the visits it would take away.
 *
 *  Approving is the moment the diary actually closes, so the count of affected
 *  visits is shown before the decision rather than after it. Whatever nobody
 *  can cover lands in the queue below this one.
 */
export default function LeaveQueue() {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<LeaveDecision | null>(null);

  const queue = useQuery({ queryKey: ["leave-queue"], queryFn: () => api.leaveQueue(true) });

  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean }) =>
      api.decideLeave(v.id, v.approve, note),
    onSuccess: (result) => {
      setNote("");
      setOutcome(result);
      void queryClient.invalidateQueries({ queryKey: ["leave-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["attention"] });
      void queryClient.invalidateQueries({ queryKey: ["bookings"] });
    },
  });

  const rows = queue.data ?? [];

  return (
    <section className="card">
      <h4 style={{ marginBottom: 4 }}>Leave requests</h4>
      <p className="dim" style={{ marginBottom: 12 }}>
        {rows.length > 0
          ? `${rows.length} waiting. Approving closes the diary and moves the visits inside it.`
          : "Nothing waiting."}
      </p>

      {outcome && (
        <Banner tone={outcome.stranded.length > 0 ? "warn" : "ok"}>
          {outcome.leave.status === "DECLINED" ? (
            <span>Declined — nothing was moved.</span>
          ) : (
            <span>
              Approved. {outcome.covered.length} visit(s) moved to another technician
              {outcome.stranded.length > 0 ? (
                <>
                  , <b>{outcome.stranded.length} nobody could cover</b> — they are below.
                </>
              ) : (
                <>, none stranded.</>
              )}
            </span>
          )}
        </Banner>
      )}

      {rows.map((r) => (
        <div key={r.id} className="pay-row">
          <div className="row-between" style={{ alignItems: "flex-start", gap: 12 }}>
            <div>
              <b>{r.technician_name}</b>
              <div className="dim">
                {formatDate(r.starts_at)} — {formatDate(r.ends_at)}
              </div>
              {r.reason && <div className="dim">{r.reason}</div>}
            </div>
            <span className={r.affected_visits > 0 ? "pill pill-warn" : "pill"}>
              {r.affected_visits} visit(s)
            </span>
          </div>
          <input
            placeholder="Note for the technician (required to decline)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ marginTop: 8 }}
          />
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="btn-primary"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: r.id, approve: true })}
            >
              Approve and move the visits
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={decide.isPending || !note.trim()}
              onClick={() => decide.mutate({ id: r.id, approve: false })}
            >
              Decline
            </button>
          </div>
        </div>
      ))}
      <ErrorText error={decide.error} />
    </section>
  );
}
