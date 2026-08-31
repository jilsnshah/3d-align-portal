/* One order page for both portals.
   Everything that differs between doctor and staff lives in the `actions` slot,
   passed in by the caller. */

import { Link } from "react-router-dom";

import { CATEGORY_LABEL, formatBytes, formatDate, formatMoney, formatRange } from "../api";
import type { FileCategory, OrderDetail } from "../api";
import { api } from "../api";
import { CategoryPill, ConfirmButton, StatusPill } from "./ui";
import { stageIndex, stagesFor } from "../workflow";
import type { ReactNode } from "react";

const NEEDS_ATTENTION: Partial<Record<OrderDetail["status"], string>> = {
  RECORDS_REQUESTED: "action needed",
  FIT_ISSUE: "issue raised",
};

export function ProgressRail({ order }: { order: OrderDetail }) {
  if (order.status === "CANCELLED") return null;

  const done = order.status === "COMPLETED";
  // The stages a by-product goes through are not the stages an aligner case
  // goes through. Both used to render the aligner's six, so a retainer showed
  // "Treatment plan" and "Training aligner" it would never reach.
  const stages = stagesFor(order.kind);
  const currentIndex = stageIndex(order.kind, order.status);

  return (
    <div className="progress" role="list" aria-label="Case progress">
      {stages.map((phase, index) => {
        const isCurrent = !done && index === currentIndex;
        const isDone = done || (currentIndex > -1 && index < currentIndex);
        const flag = isCurrent ? NEEDS_ATTENTION[order.status] : undefined;
        const state = flag ? "blocked" : isCurrent ? "current" : isDone ? "done" : "";

        return (
          <div className={`progress-step ${state}`} key={phase.key} role="listitem">
            <div className="progress-bar" />
            <span className="progress-label">
              {phase.label}
              {isCurrent && <span className="progress-now">{flag ?? order.status_label}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export type SectionKey = "quote" | "plan" | "shipments" | "invoice" | "files";

/** What matters right now goes first and opens; settled parts fold below it.
    A doctor tracking a delivery should not scroll past a quote they agreed to
    three weeks ago. */
export function sectionOrder(status: OrderDetail["status"]): SectionKey[] {
  switch (status) {
    case "QUOTED":
      return ["quote", "files", "plan", "shipments", "invoice"];
    case "AWAITING_SCAN":
    case "SCAN_SUBMITTED":
      return ["files", "quote", "plan", "shipments", "invoice"];
    case "IN_PLANNING":
    case "PLAN_SHARED":
      return ["plan", "files", "quote", "shipments", "invoice"];
    case "TRAINING_ALIGNER_PRODUCTION":
    case "TRAINING_ALIGNER_SHIPPED":
    case "FIT_REVIEW":
    case "FIT_ISSUE":
      return ["shipments", "plan", "files", "quote", "invoice"];
    case "ALIGNER_PRODUCTION":
    case "DISPATCHING":
    case "COMPLETED":
      return ["shipments", "invoice", "plan", "quote", "files"];
    default:
      return ["files", "quote", "plan", "shipments", "invoice"];
  }
}

/** Collapsible section. Settled parts of a case fold away so the live one leads. */
export function Fold({
  title,
  summary,
  open = false,
  children,
}: {
  title: string;
  summary?: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="fold" open={open}>
      <summary>
        <span className="fold-chevron">▶</span>
        <h4>{title}</h4>
        {summary && <span className="fold-sub">{summary}</span>}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

export function OrderHeader({ order }: { order: OrderDetail }) {
  return (
    <div className="page-head">
      <div>
        <div className="row" style={{ gap: 10 }}>
          <h1 className="mono">{order.order_number}</h1>
          <StatusPill status={order.status} label={order.status_label} />
          {order.priority === "EXPRESS" && <span className="pill pill-gold">Express</span>}
        </div>
        <p className="sub">
          {order.patient_name}
          {order.kind === "ALIGNER" && ` · ${archLabel(order.arch)}`}
          {order.product_label && ` · ${order.product_label}`} · {order.doctor_name}
          {order.clinic_name ? `, ${order.clinic_name}` : ""}
        </p>
      </div>
    </div>
  );
}

function archLabel(arch: OrderDetail["arch"]): string {
  return arch === "BOTH" ? "Both arches" : arch === "UPPER" ? "Upper arch" : "Lower arch";
}

export function CaseSummary({ order }: { order: OrderDetail }) {
  const isAligner = order.kind === "ALIGNER";
  return (
    <div className="card">
      <h4 style={{ marginBottom: 12 }}>{isAligner ? "Case" : "Order"}</h4>
      <dl className="kv">
        <dt>Patient</dt>
        <dd>{order.patient_name}</dd>
        {order.enquiry_number !== order.order_number && (
          <>
            <dt>Enquiry ref</dt>
            <dd className="mono">{order.enquiry_number}</dd>
          </>
        )}
        {/* An Align band prices a course of treatment by aligner count, and the
            arches say which the treatment covers. Neither means anything on a
            retainer or a box of IPR strips. */}
        {isAligner && (
          <>
            <dt>Align category</dt>
            <dd>
              <CategoryPill
                label={order.category_label}
                confirmed={order.category_confirmed}
              />
            </dd>
            <dt>Arches</dt>
            <dd>{archLabel(order.arch)}</dd>
          </>
        )}
        {order.product_label && (
          <>
            <dt>Ordered</dt>
            <dd>{order.product_label}</dd>
          </>
        )}
        <dt>Priority</dt>
        <dd>{order.priority === "EXPRESS" ? "Express" : "Standard"}</dd>
        {isAligner && (
          <>
            <dt>Submitted</dt>
            <dd>{formatDate(order.submitted_at)}</dd>
          </>
        )}
        {order.approved_at && (
          <>
            <dt>{isAligner ? "Quote accepted" : "Ordered on"}</dt>
            <dd>{formatDate(order.approved_at)}</dd>
          </>
        )}
        {order.dispatch_mode && (
          <>
            <dt>Dispatch</dt>
            <dd>{order.dispatch_mode === "PHASED" ? "Phase-wise" : "Full case"}</dd>
          </>
        )}
      </dl>

      {order.chief_complaint && (
        <>
          <h4 style={{ margin: "16px 0 5px" }}>Chief complaint</h4>
          <p className="muted" style={{ fontSize: "0.9rem" }}>
            {order.chief_complaint}
          </p>
        </>
      )}
      {order.clinical_notes && (
        <>
          <h4 style={{ margin: "14px 0 5px" }}>Clinical notes</h4>
          <p className="muted" style={{ fontSize: "0.9rem", whiteSpace: "pre-wrap" }}>
            {order.clinical_notes}
          </p>
        </>
      )}
      {order.shipping_address && (
        <>
          <h4 style={{ margin: "16px 0 5px" }}>Ships to</h4>
          <p className="muted" style={{ fontSize: "0.9rem" }}>
            {order.shipping_address.line1}
            {order.shipping_address.line2 ? `, ${order.shipping_address.line2}` : ""}
            <br />
            {order.shipping_address.city}, {order.shipping_address.state}{" "}
            {order.shipping_address.pincode}
          </p>
        </>
      )}
    </div>
  );
}

export function FileList({
  order,
  categories,
  canDelete = false,
  onDeleted,
  title = "Files",
  open = false,
}: {
  order: OrderDetail;
  categories?: FileCategory[];
  canDelete?: boolean;
  onDeleted?: () => void;
  title?: string;
  open?: boolean;
}) {
  const all = categories
    ? order.files.filter((f) => categories.includes(f.category))
    : order.files;
  // Superseded files stay available but must never be mistaken for the live one.
  const files = [...all].sort((a, b) => Number(b.is_current) - Number(a.is_current));
  const superseded = all.filter((f) => !f.is_current).length;

  return (
    <Fold
      title={title}
      open={open}
      summary={
        <span className="dim">
          {all.length - superseded} current
          {superseded > 0 ? ` · ${superseded} superseded` : ""}
        </span>
      }
    >
      {files.length === 0 ? (
        <p className="dim">No files yet.</p>
      ) : (
        <div>
          {files.map((file) => (
            <div key={file.id} className={`file-row${file.is_current ? "" : " superseded"}`}>
              <span className="pill">{CATEGORY_LABEL[file.category]}</span>
              <span className={file.is_current ? "pill pill-gold" : "pill"}>
                v{file.revision}
                {file.is_current ? "" : " · superseded"}
              </span>
              <span className="name" title={file.filename}>
                {file.filename}
              </span>
              <span className="dim num">{formatBytes(file.size_bytes)}</span>
              <a
                className="btn-link"
                href={api.downloadUrl(order.id, file.id)}
                target="_blank"
                rel="noreferrer"
              >
                Download
              </a>
              {canDelete && (
                <ConfirmButton
                  label="Remove"
                  confirmLabel="Confirm"
                  className="btn-link"
                  onConfirm={async () => {
                    await api.deleteFile(order.id, file.id);
                    onDeleted?.();
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </Fold>
  );
}

export function QuoteCard({ order, open = false }: { order: OrderDetail; open?: boolean }) {
  const quotes = order.quotes;
  if (quotes.length === 0) return null;
  const current = quotes[quotes.length - 1];
  // The estimate is overwritten by the treatment plan's real figure, so there
  // is only ever one price on the card.
  const isFinal = current.is_final;
  const plan = order.plans.find((p) => p.status !== "SUPERSEDED" && Number(p.final_total) > 0);

  return (
    <Fold
      title={isFinal ? "Price" : "Expected quote"}
      open={open}
      summary={
        <>
          {isFinal ? (
            <span className="pill pill-ok">final</span>
          ) : (
            current.category_label && <span className="pill pill-gold">{current.category_label}</span>
          )}{" "}
          <b>{formatRange(current.total, current.total_max, current.currency)}</b>
          <span className="dim">
            {" "}
            · v{current.version}
            {current.status === "ACCEPTED" ? " · accepted" : " · awaiting approval"}
          </span>
        </>
      }
    >
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ textAlign: "right" }}>Rate</th>
              <th style={{ textAlign: "right" }}>Qty</th>
              <th style={{ textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {current.line_items.map((item, index) => (
              <tr key={item.id}>
                <td>{item.description}</td>
                <td className="num" style={{ textAlign: "right" }}>
                  {index === 0
                    ? formatRange(current.category_price, current.category_price_max, current.currency)
                    : formatMoney(item.unit_price, current.currency)}
                </td>
                <td className="num" style={{ textAlign: "right" }}>
                  {item.quantity}
                </td>
                <td className="num" style={{ textAlign: "right" }}>
                  {index === 0
                    ? formatRange(current.category_price, current.category_price_max, current.currency)
                    : formatMoney(item.amount, current.currency)}
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} style={{ textAlign: "right" }} className="dim">
                Tax
              </td>
              <td className="num" style={{ textAlign: "right" }}>
                {formatMoney(current.tax, current.currency)}
              </td>
            </tr>
            <tr>
              <td colSpan={3} style={{ textAlign: "right", fontWeight: 650 }}>
                Total
              </td>
              <td className="num" style={{ textAlign: "right", fontWeight: 650 }}>
                {formatRange(current.total, current.total_max, current.currency)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="dim" style={{ marginTop: 10 }}>
        {isFinal
          ? `Confirmed with the treatment plan${plan ? ` — ${plan.total_aligners} aligners` : ""}. This is the price the case is invoiced at.`
          : "An estimated range read off the clinical photographs. It is replaced by one exact figure once the treatment plan is ready."}
        {quotes.length > 1 && ` ${quotes.length - 1} earlier version(s) superseded.`}
      </p>
      {current.notes && (
        <p className="muted" style={{ fontSize: "0.88rem", marginTop: 8 }}>
          {current.notes}
        </p>
      )}
    </Fold>
  );
}

export function PlanCard({ order, open = false }: { order: OrderDetail; open?: boolean }) {
  if (order.plans.length === 0) return null;
  const plan = order.plans[order.plans.length - 1];

  return (
    <Fold
      title="Treatment plan"
      open={open}
      summary={
        <>
          {plan.aligners_upper + plan.aligners_lower} aligners
          {plan.final_category_label && (
            <span className="dim"> · {plan.final_category_label}</span>
          )}
          <span className="dim"> · v{plan.version} · {plan.status.replace(/_/g, " ").toLowerCase()}</span>
        </>
      }
    >
      <dl className="kv">
        <dt>Align category</dt>
        <dd>
          <CategoryPill label={plan.final_category_label} confirmed={Boolean(plan.final_category)} />
        </dd>
        <dt>Total aligners</dt>
        <dd className="num">
          <b>{plan.total_aligners}</b> ({plan.aligners_upper} upper, {plan.aligners_lower} lower)
        </dd>
        {Number(plan.final_discount) > 0 && (
          <>
            <dt>Discount</dt>
            <dd className="num">
              <b>− {formatMoney(plan.final_discount)}</b>
              <span className="dim"> off {formatMoney(plan.final_price)}</span>
              {plan.final_discount_reason && (
                <span className="dim"> · {plan.final_discount_reason}</span>
              )}
            </dd>
          </>
        )}
        {Number(plan.final_total) > 0 && (
          <>
            <dt>Final price</dt>
            <dd className="num">
              <b>{formatMoney(plan.final_total)}</b>
              {Number(plan.final_tax) > 0 && (
                <span className="dim">
                  {" "}
                  (
                  {formatMoney(
                    Number(plan.final_price) - Number(plan.final_discount || 0),
                  )}{" "}
                  + {formatMoney(plan.final_tax)} tax)
                </span>
              )}
            </dd>
          </>
        )}
        <dt>IPR</dt>
        <dd>{plan.ipr_required ? "Required" : "Not required"}</dd>
        <dt>Attachments</dt>
        <dd>{plan.attachments_required ? "Required" : "Not required"}</dd>
        <dt>Shared</dt>
        <dd>{formatDate(plan.shared_at)}</dd>
      </dl>
      {plan.summary && (
        <p className="muted" style={{ fontSize: "0.9rem", marginTop: 12, whiteSpace: "pre-wrap" }}>
          {plan.summary}
        </p>
      )}
      {plan.status === "REVISION_REQUESTED" && plan.revision_notes && (
        <p style={{ marginTop: 12, fontSize: "0.88rem", color: "var(--warn)" }}>
          Revision requested: {plan.revision_notes}
        </p>
      )}
    </Fold>
  );
}

export function ShipmentsCard({
  order,
  onMarkDelivered,
  open = true,
  deliverLabel = "Mark delivered",
}: {
  order: OrderDetail;
  onMarkDelivered?: (shipmentId: string) => void;
  open?: boolean;
  deliverLabel?: string;
}) {
  if (order.shipments.length === 0) return null;
  const delivered = order.shipments.filter((s) => s.status === "DELIVERED").length;
  const inTransit = order.shipments.length - delivered;

  return (
    <Fold
      title="Shipments & tracking"
      open={open}
      summary={
        inTransit > 0 ? (
          <b>{inTransit} in transit</b>
        ) : (
          <span className="dim">all {delivered} delivered</span>
        )
      }
    >
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Shipment</th>
              <th>Aligners</th>
              <th>Tracking</th>
              <th>Status</th>
              {onMarkDelivered && <th />}
            </tr>
          </thead>
          <tbody>
            {order.shipments.map((shipment) => (
              <tr key={shipment.id}>
                <td>
                  {shipment.shipment_type === "TRAINING_ALIGNER"
                    ? `Training aligner${shipment.fit_round && shipment.fit_round > 1 ? ` · round ${shipment.fit_round}` : ""}`
                    : shipment.shipment_type === "FULL_CASE"
                      ? "Full case"
                      : `Phase ${shipment.phase_number ?? "—"}${
                          shipment.phase_round && shipment.phase_round > 1
                            ? ` · round ${shipment.phase_round}`
                            : ""
                        }`}
                  {shipment.is_final_phase && (
                    <span className="pill pill-ok" style={{ marginLeft: 6 }}>
                      final
                    </span>
                  )}
                  {shipment.phase_decision === "REPEAT" && (
                    <div className="dim">
                      clinic asked for this again
                      {shipment.decision_notes ? ` — ${shipment.decision_notes}` : ""}
                    </div>
                  )}
                </td>
                <td className="num">
                  {shipment.aligner_range_from
                    ? `${shipment.aligner_range_from}–${shipment.aligner_range_to}`
                    : "—"}
                </td>
                <td>
                  {shipment.tracking_number ? (
                    <>
                      <span className="mono">{shipment.tracking_number}</span>
                      <br />
                      <span className="dim">{shipment.carrier}</span>
                    </>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
                <td>
                  <span
                    className={shipment.status === "DELIVERED" ? "pill pill-ok" : "pill pill-dark"}
                  >
                    {shipment.status === "DELIVERED" ? "Delivered" : "In transit"}
                  </span>
                </td>
                {onMarkDelivered && (
                  <td>
                    {shipment.status !== "DELIVERED" && (
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={() => onMarkDelivered(shipment.id)}
                      >
                        {deliverLabel}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Fold>
  );
}

export function InvoiceCard({ order }: { order: OrderDetail }) {
  if (!order.invoice) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h4>Invoice</h4>
        <span className="pill pill-ok">{order.invoice.status}</span>
      </div>
      <dl className="kv">
        <dt>Number</dt>
        <dd className="mono">{order.invoice.invoice_number}</dd>
        <dt>Amount</dt>
        <dd className="num">{formatMoney(order.invoice.amount, order.invoice.currency)}</dd>
        <dt>Issued</dt>
        <dd>{formatDate(order.invoice.issued_at)}</dd>
      </dl>
      {order.invoice.pdf_url && (
        <a
          className="btn-ghost btn-sm"
          style={{ display: "inline-block", marginTop: 12, textDecoration: "none" }}
          href={order.invoice.pdf_url}
          target="_blank"
          rel="noreferrer"
        >
          Download PDF
        </a>
      )}
    </div>
  );
}

export function Timeline({ order }: { order: OrderDetail }) {
  const events = [...order.events].reverse();
  const kind = order.kind;
  return (
    <div className="card">
      <h4 style={{ marginBottom: 14 }}>History</h4>
      {events.length === 0 ? (
        <p className="dim">Nothing has happened yet.</p>
      ) : (
        <div className="timeline">
          {events.map((event) => (
            <div key={event.id} className="tl-item">
              <div className="tl-dot" />
              <div className="tl-body">
                <div className="tl-title">{statusLabel(event.to_status, kind)}</div>
                <div className="tl-meta">
                  {event.actor_name} · {formatDate(event.created_at)}
                </div>
                {event.note && <div className="tl-note">{event.note}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const LABELS: Record<string, string> = {
  DRAFT: "Draft created",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  RECORDS_REQUESTED: "More records requested",
  QUOTED: "Quote sent",
  AWAITING_SCAN: "Quote accepted — scan requested",
  SCAN_SUBMITTED: "Scan submitted for review",
  IN_PLANNING: "In planning",
  PLAN_SHARED: "Treatment plan shared",
  TRAINING_ALIGNER_PRODUCTION: "Training aligner in production",
  TRAINING_ALIGNER_SHIPPED: "Training aligner shipped",
  FIT_REVIEW: "Fit review requested",
  FIT_ISSUE: "Fit issue reported",
  ALIGNER_PRODUCTION: "Aligners in production",
  DISPATCHING: "Dispatching",
  PHASE_REVIEW: "Progress photographs under review",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

/* A by-product was never quoted and an accessory is never fabricated, so the
   aligner wording is wrong on both. Only the entries that differ are listed;
   everything else falls through to the shared map above. */
const KIND_LABELS: Record<string, Record<string, string>> = {
  PRODUCT: {
    DRAFT: "Order started",
    AWAITING_SCAN: "Ordered — scan requested",
    PRODUCT_FABRICATION: "In fabrication",
  },
  ACCESSORY: {
    DRAFT: "Order started",
    PRODUCT_FABRICATION: "Being packed",
  },
};

function statusLabel(status: string, kind?: string): string {
  const override = kind ? KIND_LABELS[kind]?.[status] : undefined;
  return override ?? LABELS[status] ?? status;
}

export function ActionPanel({
  title,
  why,
  children,
}: {
  title: string;
  why?: string;
  children: ReactNode;
}) {
  return (
    <div className="action">
      <h3>{title}</h3>
      {why && <p className="why">{why}</p>}
      {children}
    </div>
  );
}

export function Waiting({ children }: { children: ReactNode }) {
  return <div className="waiting">{children}</div>;
}


/** The way into the 3D viewer.

    Kept out of the treatment plan card on purpose: the lab uploads staged
    models while planning, often before a plan record exists, and a button that
    only appears once the paperwork catches up is a button nobody finds. */
export function SimulationCard({ order }: { order: OrderDetail }) {
  if (!order.has_simulation) return null;
  // The simulation is part of the treatment plan and sits behind the same fee.
  // Offering a button that refuses the click is what makes the gate feel like a
  // fault, so it says what it is waiting for instead.
  if (order.plan_locked) {
    return (
      <div className="card">
        <h4 style={{ marginBottom: 4 }}>3D simulation</h4>
        <p className="dim">
          Ready, and included in the treatment plan fee. It opens as soon as that
          payment is confirmed.
        </p>
      </div>
    );
  }
  return (
    <div className="card row-between">
      <div>
        <h4 style={{ marginBottom: 4 }}>3D simulation</h4>
        <p className="dim">
          Step through the planned movement, arch by arch.
        </p>
      </div>
      <Link to={`/viewer/${order.id}`} style={{ textDecoration: "none" }}>
        <button type="button" className="btn-primary">
          Open the 3D simulation ↗
        </button>
      </Link>
    </div>
  );
}
