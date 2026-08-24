import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, formatDate } from "../api";
import { ErrorText } from "./ui";

/** Visits approved leave stranded.
 *
 *  The booking still stands — it is not silently cancelled, because a patient
 *  is expecting somebody. Only a person can decide whether to ask the clinic
 *  for another slot or to let it stand because the lab has arranged something
 *  the portal cannot see.
 */
export default function AttentionQueue() {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");

  const queue = useQuery({ queryKey: ["attention"], queryFn: api.bookingsNeedingAttention });

  const settle = useMutation({
    mutationFn: (v: { id: string; action: "RESCHEDULE" | "IGNORE" }) =>
      api.settleAttention(v.id, v.action, note),
    onSuccess: () => {
      setNote("");
      void queryClient.invalidateQueries({ queryKey: ["attention"] });
      void queryClient.invalidateQueries({ queryKey: ["bookings"] });
    },
  });

  const rows = queue.data ?? [];
  if (rows.length === 0) return null;

  return (
    <section className="card" style={{ borderColor: "var(--danger-line)" }}>
      <h4 style={{ marginBottom: 4 }}>Visits nobody could cover</h4>
      <p className="dim" style={{ marginBottom: 12 }}>
        Approved leave took the technician away and no colleague was free. The booking
        still stands until you decide.
      </p>
      {rows.map((b) => (
        <div key={b.id} className="pay-row">
          <div>
            <b>
              {b.order.order_number} · {b.order.patient_name}
            </b>
            <div className="dim">
              {formatDate(b.starts_at)}
              {b.location ? ` · ${b.location}` : ""}
            </div>
            <div className="dim">{b.attention_reason}</div>
          </div>
          <input
            placeholder="Note (sent to the clinic when rescheduling)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ marginTop: 8 }}
          />
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn-primary"
              disabled={settle.isPending}
              onClick={() => settle.mutate({ id: b.id, action: "RESCHEDULE" })}
            >
              Ask the clinic to rebook
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={settle.isPending}
              onClick={() => settle.mutate({ id: b.id, action: "IGNORE" })}
            >
              Leave it standing
            </button>
          </div>
        </div>
      ))}
      <ErrorText error={settle.error} />
    </section>
  );
}
