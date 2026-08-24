import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, formatDate } from "../api";
import { Banner, ErrorText, Field } from "./ui";

const TONE: Record<string, string> = {
  PENDING: "pill pill-gold",
  APPROVED: "pill pill-ok",
  DECLINED: "pill",
};

/** A technician asking to be off.
 *
 *  Asking does not close the diary — 3D Align approves it first. That matters:
 *  approving is the moment every visit inside the window has to find another
 *  technician, so it cannot happen quietly on one person's say-so.
 */
export default function LeavePanel() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [wholeDay, setWholeDay] = useState(true);
  const [reason, setReason] = useState("");

  const leave = useQuery({ queryKey: ["my-leave"], queryFn: api.myLeave });

  const ask = useMutation({
    mutationFn: () =>
      api.requestLeave({
        starts_at: wholeDay ? `${from}T00:00:00Z` : `${from}:00Z`,
        ends_at: wholeDay ? `${to || from}T23:59:00Z` : `${to}:00Z`,
        reason,
      }),
    onSuccess: () => {
      setOpen(false);
      setFrom("");
      setTo("");
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["my-leave"] });
    },
  });

  const rows = leave.data ?? [];
  const pending = rows.filter((r) => r.status === "PENDING");

  return (
    <section className="card">
      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <div>
          <h4 style={{ marginBottom: 4 }}>Time off</h4>
          <p className="dim">
            {pending.length > 0
              ? `${pending.length} request(s) with 3D Align.`
              : "Ask for a day or a few hours off. 3D Align approves it and moves any visits."}
          </p>
        </div>
        {!open && (
          <button type="button" className="btn-ghost" onClick={() => setOpen(true)}>
            Request leave
          </button>
        )}
      </div>

      {open && (
        <div className="stack-sm" style={{ marginTop: 12 }}>
          <label className="check">
            <input
              type="checkbox"
              checked={wholeDay}
              onChange={(e) => setWholeDay(e.target.checked)}
            />
            <span>Whole day(s)</span>
          </label>
          <div className="grid-2">
            <Field label={wholeDay ? "From" : "From"}>
              <input
                type={wholeDay ? "date" : "datetime-local"}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field label={wholeDay ? "To (leave blank for one day)" : "To"}>
              <input
                type={wholeDay ? "date" : "datetime-local"}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Reason">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Family commitment, medical, and so on"
            />
          </Field>
          <ErrorText error={ask.error} />
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn-primary"
              disabled={!from || (!wholeDay && !to) || ask.isPending}
              onClick={() => ask.mutate()}
            >
              Send the request
            </button>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="stack-sm" style={{ marginTop: 12 }}>
          {rows.slice(0, 6).map((r) => (
            <div key={r.id} className="row-between pay-row">
              <div>
                <b>
                  {formatDate(r.starts_at)} — {formatDate(r.ends_at)}
                </b>
                {r.reason && <div className="dim">{r.reason}</div>}
                {r.decision_note && <div className="dim">3D Align: {r.decision_note}</div>}
              </div>
              <span className={TONE[r.status] ?? "pill"}>{r.status_label}</span>
            </div>
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <Banner tone="warn">
          Keep working to your schedule until a request is approved — your visits are only
          moved once 3D Align approves it.
        </Banner>
      )}
    </section>
  );
}
