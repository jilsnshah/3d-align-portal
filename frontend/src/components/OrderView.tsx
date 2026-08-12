/* One order page for both portals.
   Everything that differs between doctor and staff lives in the `actions` slot,
   passed in by the caller. */

import { CATEGORY_LABEL, formatBytes, formatDate, formatMoney } from "../api";
import type { FileCategory, OrderDetail } from "../api";
import { api } from "../api";
import { ConfirmButton, StatusPill } from "./ui";
import type { ReactNode } from "react";

/* The 17 statuses collapse into six phases a human can hold in their head.
   The rail answers "where is this case" without reading the timeline. */
const PHASES: { key: string; label: string; statuses: OrderDetail["status"][] }[] = [
  {
    key: "records",
    label: "Records",
    statuses: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "RECORDS_REQUESTED"],
  },
  { key: "quote", label: "Quote", statuses: ["QUOTED"] },
  { key: "scan", label: "Scan", statuses: ["AWAITING_SCAN", "SCAN_SUBMITTED"] },
  { key: "plan", label: "Treatment plan", statuses: ["IN_PLANNING", "PLAN_SHARED"] },
  {
    key: "fit",
    label: "Training aligner",
    statuses: [
      "TRAINING_ALIGNER_PRODUCTION",
      "TRAINING_ALIGNER_SHIPPED",
      "FIT_REVIEW",
      "FIT_ISSUE",
    ],
  },
  { key: "delivery", label: "Delivery", statuses: ["ALIGNER_PRODUCTION", "DISPATCHING"] },
];

const NEEDS_ATTENTION: Partial<Record<OrderDetail["status"], string>> = {
  RECORDS_REQUESTED: "action needed",
  FIT_ISSUE: "issue raised",
};

export function ProgressRail({ order }: { order: OrderDetail }) {
  if (order.status === "CANCELLED") return null;

  const done = order.status === "COMPLETED";
  const currentIndex = PHASES.findIndex((phase) => phase.statuses.includes(order.status));

  return (
    <div className="progress" role="list" aria-label="Case progress">
      {PHASES.map((phase, index) => {
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
          {order.patient_name} · {archLabel(order.arch)} · {order.doctor_name}
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
  return (
    <div className="card">
      <h4 style={{ marginBottom: 12 }}>Case</h4>
      <dl className="kv">
        <dt>Patient</dt>
        <dd>{order.patient_name}</dd>
        <dt>Arches</dt>
        <dd>{archLabel(order.arch)}</dd>
        <dt>Priority</dt>
        <dd>{order.priority === "EXPRESS" ? "Express" : "Standard"}</dd>
        <dt>Submitted</dt>
        <dd>{formatDate(order.submitted_at)}</dd>
        {order.approved_at && (
          <>
            <dt>Quote accepted</dt>
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

  return (
    <Fold
      title="Quote"
      open={open}
      summary={
        <>
          {formatMoney(current.total, current.currency)}
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
            {current.line_items.map((item) => (
              <tr key={item.id}>
                <td>{item.description}</td>
                <td className="num" style={{ textAlign: "right" }}>
                  {formatMoney(item.unit_price, current.currency)}
                </td>
                <td className="num" style={{ textAlign: "right" }}>
                  {item.quantity}
                </td>
                <td className="num" style={{ textAlign: "right" }}>
                  {formatMoney(item.amount, current.currency)}
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
                {formatMoney(current.total, current.currency)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="dim" style={{ marginTop: 10 }}>
        Estimated aligners — upper {current.estimated_aligners_upper}, lower{" "}
        {current.estimated_aligners_lower}.
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
          <span className="dim"> · v{plan.version} · {plan.status.replace(/_/g, " ").toLowerCase()}</span>
        </>
      }
    >
      <dl className="kv">
        <dt>Upper aligners</dt>
        <dd className="num">{plan.aligners_upper}</dd>
        <dt>Lower aligners</dt>
        <dd className="num">{plan.aligners_lower}</dd>
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
}: {
  order: OrderDetail;
  onMarkDelivered?: (shipmentId: string) => void;
  open?: boolean;
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
                      : `Phase ${shipment.phase_number ?? "—"}`}
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
                        Mark delivered
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
                <div className="tl-title">{statusLabel(event.to_status)}</div>
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
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

function statusLabel(status: string): string {
  return LABELS[status] ?? status;
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
