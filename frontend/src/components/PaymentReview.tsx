import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, formatDate, formatMoney } from "../api";
import type { OrderDetail, Payment } from "../api";
import { Banner, ErrorText } from "./ui";

/** The lab's side of the money: what has been paid, and the receipts waiting to
 *  be checked against the bank. Approving is what unlocks whatever the charge
 *  was gating, so it is a deliberate act by a person rather than anything
 *  automatic. */
export default function PaymentReview({ order }: { order: OrderDetail }) {
  if (order.payments.length === 0) return null;
  const waiting = order.payments.filter((p) => p.status === "SUBMITTED");
  const rest = order.payments.filter((p) => p.status !== "SUBMITTED");

  return (
    <section className="card">
      <h4 style={{ marginBottom: 4 }}>Payments</h4>
      <p className="dim" style={{ marginBottom: 12 }}>
        {waiting.length > 0
          ? `${waiting.length} receipt(s) to check.`
          : "Nothing waiting to be checked."}
      </p>
      {waiting.map((p) => (
        <Row key={p.id} order={order} payment={p} />
      ))}
      {rest.map((p) => (
        <Row key={p.id} order={order} payment={p} />
      ))}
    </section>
  );
}

function Row({ order, payment }: { order: OrderDetail; payment: Payment }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");

  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api.verifyPayment(order.id, payment.id, approve, reason),
    onSuccess: () => {
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["staff-order", order.id] });
      void queryClient.invalidateQueries({ queryKey: ["staff-orders"] });
    },
  });

  const tone =
    payment.status === "VERIFIED"
      ? "pill pill-ok"
      : payment.status === "SUBMITTED"
        ? "pill pill-gold"
        : payment.status === "REJECTED"
          ? "pill pill-danger"
          : "pill pill-warn";

  return (
    <div className="pay-row">
      <div className="row-between" style={{ alignItems: "flex-start", gap: 12 }}>
        <div>
          <b>{payment.label}</b>
          <div className="dim">
            {formatMoney(payment.amount)}
            {Number(payment.shipping_amount) > 0 && (
              <> + {formatMoney(payment.shipping_amount)} delivery</>
            )}
            {payment.reference && <> · ref {payment.reference}</>}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="num" style={{ fontWeight: 680 }}>
            {formatMoney(payment.total)}
          </div>
          <span className={tone}>{payment.status_label}</span>
        </div>
      </div>

      {payment.status === "VERIFIED" && payment.verified_at && (
        <p className="dim" style={{ marginTop: 4 }}>Confirmed {formatDate(payment.verified_at)}.</p>
      )}
      {payment.status === "REJECTED" && <Banner tone="danger">{payment.rejected_reason}</Banner>}

      {payment.status === "SUBMITTED" && (
        <>
          {payment.proof_file_id && (
            <p style={{ margin: "8px 0" }}>
              <a
                className="btn-link"
                href={api.previewUrl(order.id, payment.proof_file_id)}
                target="_blank"
                rel="noreferrer"
              >
                Open the receipt
              </a>
            </p>
          )}
          <input
            placeholder="If refusing, say why"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn-primary"
              disabled={decide.isPending}
              onClick={() => decide.mutate(true)}
            >
              Money received
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={decide.isPending || !reason.trim()}
              onClick={() => decide.mutate(false)}
            >
              Not received
            </button>
          </div>
          <ErrorText error={decide.error} />
        </>
      )}
    </div>
  );
}
