import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { api, formatDate } from "../api";
import type { OrderDetail, PhaseFitIssue } from "../api";
import { ErrorText } from "./ui";

/** The exchange over an aligner that does not fit.
 *
 *  Advice from the lab does not close the issue — the clinic is the one wearing
 *  the aligner, so only they can say whether it worked. Until they do, either
 *  side can add to the thread and no further batch is made.
 *
 *  Closing this is not the same as finishing the phase: the patient still has
 *  the rest of the batch to wear, and the progress photographs at the end of it
 *  are what complete it.
 */
export default function FitIssueThread({
  order,
  issue,
  onDone,
}: {
  order: OrderDetail;
  issue: PhaseFitIssue;
  onDone: () => void;
}) {
  const [message, setMessage] = useState("");

  const reply = useMutation({
    mutationFn: () => api.replyToPhaseFitIssue(order.id, message),
    onSuccess: () => {
      setMessage("");
      onDone();
    },
  });
  const close = useMutation({
    mutationFn: () => api.closePhaseFitIssue(order.id),
    onSuccess: onDone,
  });

  const waitingOnLab = issue.awaiting === "LAB";

  return (
    <section className="card">
      <h4 style={{ marginBottom: 4 }}>
        Fit issue · phase {issue.phase_number} · {issue.arch.toLowerCase()} aligner{" "}
        {issue.aligner_number}
      </h4>
      <p className="dim" style={{ marginBottom: 12 }}>
        {waitingOnLab
          ? "With 3D Align. They will reply, remake the phase, or ask for a new scan."
          : "3D Align has replied. Try it, then say how it went — or close this if it is wearing properly now."}
      </p>

      <div className="stack-sm" style={{ marginBottom: 12 }}>
        <div className="notif">
          <div className="t">You reported it</div>
          <div className="b">{issue.notes || "No notes given."}</div>
          <div className="dim">{formatDate(issue.created_at)}</div>
        </div>
        {issue.messages.map((m) => (
          <div key={m.id} className={m.from_lab ? "notif unread" : "notif"}>
            <div className="t">{m.from_lab ? "3D Align" : "You"}</div>
            <div className="b">{m.body}</div>
            <div className="dim">{formatDate(m.created_at)}</div>
          </div>
        ))}
      </div>

      {!waitingOnLab && (
        <>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What happened when you tried it?"
          />
          <ErrorText error={reply.error ?? close.error} />
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn-dark"
              disabled={!message.trim() || reply.isPending}
              onClick={() => reply.mutate()}
            >
              Send to 3D Align
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={close.isPending}
              onClick={() => close.mutate()}
            >
              It fits now — close this
            </button>
          </div>
          <p className="dim" style={{ marginTop: 8, marginBottom: 0 }}>
            Closing this does not finish the phase. Carry on with the batch and send the
            progress photographs when you reach the end of it.
          </p>
        </>
      )}
    </section>
  );
}
