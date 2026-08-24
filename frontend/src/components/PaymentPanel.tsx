import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { api, formatMoney } from "../api";
import type { OrderDetail, Payment } from "../api";
import { Banner, ErrorText } from "./ui";

/** What the clinic owes on a case, and how they settle it.
 *
 *  Nothing is charged through the portal. "Pay now" hands the payee and the
 *  amount to whichever UPI app is on the phone, so nothing is typed in by hand
 *  and the money cannot arrive short or land in the wrong place. The receipt
 *  they send back is the lab's only record that it moved, which is why a person
 *  checks it before anything unlocks.
 */
export default function PaymentPanel({ order }: { order: OrderDetail }) {
  const due = order.payments.filter((p) => p.status !== "VERIFIED");
  const settled = order.payments.filter((p) => p.status === "VERIFIED");
  if (order.payments.length === 0) return null;

  return (
    <section className="card">
      <h4 style={{ marginBottom: 4 }}>Payments</h4>
      <p className="dim" style={{ marginBottom: 12 }}>
        Pay by UPI and send the screenshot. 3D Align confirms each one.
      </p>

      {order.charges.length > 0 && <ChargeTable order={order} />}

      {due.map((p) => (
        <PaymentRow key={p.id} order={order} payment={p} />
      ))}
      {settled.map((p) => (
        <PaymentRow key={p.id} order={order} payment={p} />
      ))}
    </section>
  );
}

function ChargeTable({ order }: { order: OrderDetail }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 14 }}>
      <button type="button" className="btn-link" onClick={() => setOpen(!open)}>
        {open ? "Hide the breakdown" : "How this is worked out"}
      </button>
      {open && (
        <dl className="kv" style={{ marginTop: 8 }}>
          {order.charges.map((line) => (
            <div key={line.label} style={{ display: "contents" }}>
              <dt>{line.label}</dt>
              <dd className="num">
                {Number(line.amount) === 0 && line.note ? (
                  <span>{line.note}</span>
                ) : (
                  <>
                    <b>
                      {Number(line.amount) < 0 ? "− " : ""}
                      {formatMoney(Math.abs(Number(line.amount)))}
                    </b>
                    {line.note && <span className="dim"> · {line.note}</span>}
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function PaymentRow({ order, payment }: { order: OrderDetail; payment: Payment }) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [reference, setReference] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const send = useMutation({
    mutationFn: () => api.payProof(order.id, payment.id, file!, reference),
    onSuccess: () => {
      setFile(null);
      setReference("");
      if (fileInput.current) fileInput.current.value = "";
      void queryClient.invalidateQueries({ queryKey: ["order", order.id] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
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
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="num" style={{ fontWeight: 680 }}>
            {formatMoney(payment.total)}
          </div>
          <span className={tone}>{payment.status_label}</span>
        </div>
      </div>

      {payment.status === "REJECTED" && (
        <Banner tone="danger">{payment.rejected_reason}</Banner>
      )}

      {payment.status !== "VERIFIED" && payment.status !== "SUBMITTED" && (
        <>
          {payment.upi_link ? (
            <a className="btn-primary pay-now" href={payment.upi_link}>
              Pay {formatMoney(payment.total)} now
            </a>
          ) : (
            <Banner tone="warn">
              3D Align has not published a UPI ID yet. Please contact the lab to pay.
            </Banner>
          )}
          <p className="dim" style={{ margin: "8px 0 6px" }}>
            On a phone this opens your UPI app with the amount already filled in. Then
            send the screenshot below.
          </p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <input
              placeholder="UPI reference (optional)"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              style={{ maxWidth: 220 }}
            />
            <button
              type="button"
              className="btn-dark"
              disabled={!file || send.isPending}
              onClick={() => send.mutate()}
            >
              {send.isPending ? "Sending…" : "Send the receipt"}
            </button>
          </div>
          <ErrorText error={send.error} />
        </>
      )}

      {payment.status === "SUBMITTED" && (
        <p className="dim" style={{ marginTop: 6 }}>
          Receipt sent{payment.reference && ` · ${payment.reference}`}. 3D Align is checking it.
        </p>
      )}
    </div>
  );
}
