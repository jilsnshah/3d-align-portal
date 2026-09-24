/* The lab's side of one case.
 *
 * Built on the same four layers as the clinic's page — who and what, the
 * journey, the one thing that happens next, and the file behind it one tab at
 * a time — because it is the same case. What differs is whose move it is: the
 * panel here asks the lab for the thing the stage needs, and exposes the
 * records, the scan, the plan or the photographs that decision is made from
 * inside the stage itself rather than a scroll below it. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { api, formatDate, formatMoney, formatRange, since } from "../../api";
import type { FileCategory, OrderDetail as Order } from "../../api";
import FileUploader from "../../components/FileUploader";
import FileExplorer from "../../components/FileExplorer";
import StageBrowser from "../../components/StageBrowser";
import Journey from "../../components/Journey";
import { stageIndex, stagesFor } from "../../workflow";
import PaymentReview from "../../components/PaymentReview";
import { useToast } from "../../components/Toast";
import PhaseTracker from "../../components/PhaseTracker";
import {
  ActionPanel,
  CaseSummary,
  SimulationCard,
  FileList,
  InvoiceCard,
  PlanCard,
  QuoteCard,
  ShipmentsCard,
  Timeline,
  Waiting,
} from "../../components/OrderView";
import {
  Banner,
  CategoryPill,
  Checklist,
  ConfirmButton,
  ErrorText,
  Field,
  Loading,
  StatusPill,
} from "../../components/ui";
import { useAuth } from "../../auth";

type Tab = "overview" | "records" | "delivery" | "payments" | "history";

const RECORD_CATEGORIES: FileCategory[] = ["RECORD_PHOTO", "OPG", "LATERAL_CEPH", "CBCT", "OTHER"];

/* Stages the case is sitting with the clinic on. The lab can read them, but
   there is nothing on the bench until the clinic answers. */
const WITH_THE_CLINIC = new Set([
  "RECORDS_REQUESTED",
  "PLAN_SHARED",
  "TRAINING_ALIGNER_SHIPPED",
  "FIT_REVIEW",
]);

function archLabel(arch: Order["arch"]): string {
  return arch === "BOTH" ? "Both arches" : arch === "UPPER" ? "Upper arch" : "Lower arch";
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** The files a stage is judged from, shown inside that stage. Read-only: the
    cabinet under Records is where files are added and binned. */
function StepFiles({
  order,
  categories,
  title,
}: {
  order: Order;
  categories: FileCategory[];
  title: string;
}) {
  if (!order.files.some((f) => categories.includes(f.category))) return null;
  return (
    <div className="ws-stage-fold">
      <FileList order={order} categories={categories} title={title} open />
    </div>
  );
}

/** Parcels still in transit, settled where the stage is about them. The lab
    marks one delivered when the courier says so and the clinic has not. */
function Parcels({
  order,
  onDeliver,
}: {
  order: Order;
  onDeliver?: (shipmentId: string) => void;
}) {
  const out = order.shipments.filter((s) => s.status !== "DELIVERED");
  if (out.length === 0) return null;
  return (
    <div className="ws-stage-fold">
      {out.map((s) => (
        <div className="ws-parcel" key={s.id}>
          <div className="ws-parcel-say">
            <b>
              {s.shipment_type.replace(/_/g, " ").toLowerCase()}
              {s.phase_number ? ` · phase ${s.phase_number}` : ""}
              {s.aligner_range_from && s.aligner_range_to
                ? ` · aligners ${s.aligner_range_from}\u2013${s.aligner_range_to}`
                : ""}
            </b>
            <span>
              {s.carrier || "Courier not named"}
              {s.tracking_number && (
                <>
                  {" \u00b7 "}
                  <span className="mono">{s.tracking_number}</span>
                </>
              )}
              {s.shipped_at && ` \u00b7 sent ${formatDate(s.shipped_at)}`}
            </span>
          </div>
          <div className="row">
            {s.tracking_url && (
              <a className="btn-link" href={s.tracking_url} target="_blank" rel="noreferrer">
                Track it
              </a>
            )}
            {onDeliver && (
              <button type="button" className="btn-ghost btn-sm" onClick={() => onDeliver(s.id)}>
                Mark delivered
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function StaffOrderDetail() {
  const { orderId = "" } = useParams();
  const queryClient = useQueryClient();
  const { me } = useAuth();
  const isTechnician = me?.role === "TECHNICIAN";

  const order = useQuery({
    queryKey: ["staff-order", orderId],
    queryFn: () => (isTechnician ? api.technicianCase(orderId) : api.staffOrder(orderId)),
  });

  const toast = useToast();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["staff-order", orderId] });
    void queryClient.invalidateQueries({ queryKey: ["staff-orders"] });
    void queryClient.invalidateQueries({ queryKey: ["queue"] });
  };

  /* Which stage is being looked at, or null for the case's own. Held
     here because the rail sets it and the browser reads it, and because
     every action panel below has to know to stand down while a past
     stage is open. */
  const [viewing, setViewing] = useState<number | null>(null);
  const [params, setParams] = useSearchParams();
  /* Cases arrive by phone, on WhatsApp and on paper, so the day a case was
     typed in is often not the day it came in. The lab can set the date to
     whatever actually happened; the clinic cannot. */
  const [dateOpen, setDateOpen] = useState(false);

  const setCaseDate = useMutation({
    mutationFn: (submittedAt: string) => api.setCaseDate(orderId, submittedAt),
    onSuccess: (updated) => {
      setDateOpen(false);
      invalidate();
      toast({
        title: "Date changed",
        body: `This case now counts as opened on ${formatDate(updated.created_at)}.`,
      });
    },
  });

  const markDelivered = useMutation({
    mutationFn: (shipmentId: string) => api.updateShipment(shipmentId, { mark_delivered: true }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Marked delivered", body: "The clinic can see it has arrived." });
    },
  });

  const invoice = useMutation({
    mutationFn: () => api.generateInvoice(orderId),
    onSuccess: () => {
      invalidate();
      toast({ title: "Invoice generated", body: "It is on the case, under Invoice." });
    },
  });

  const cancel = useMutation({
    mutationFn: (reason: string) => api.cancelOrder(orderId, reason),
    onSuccess: () => {
      invalidate();
      toast({ title: "Case cancelled", tone: "warn", body: "The clinic has been told." });
    },
  });

  if (order.isLoading) return <Loading what="case" />;
  if (order.isError || !order.data) return <div className="page">Case not found.</div>;

  const data = order.data;
  const closed = data.status === "COMPLETED" || data.status === "CANCELLED";
  const acceptedQuote = data.quotes.find((q) => q.status === "ACCEPTED");
  const billedTotal = acceptedQuote?.total;
  const canInvoice =
    !data.invoice && (data.status === "DISPATCHING" || data.status === "COMPLETED");

  const stages = stagesFor(data.kind, data.intake);
  const liveStage = stageIndex(data.kind, data.status, data.intake);
  const lookingBack = viewing !== null && viewing !== (liveStage >= 0 ? liveStage : null);
  const upNext = liveStage >= 0 ? stages[liveStage + 1]?.label : undefined;

  const checking = data.payments.filter((p) => p.status === "SUBMITTED");
  const unpaid = data.payments.filter((p) => p.status !== "VERIFIED" && p.status !== "SUBMITTED");
  const sum = (list: typeof unpaid) => list.reduce((n, p) => n + Number(p.total), 0);
  const unpaidTotal = sum(unpaid);
  const paidTotal = sum(data.payments.filter((p) => p.status === "VERIFIED"));
  const delivered = data.shipments.filter((s) => s.status === "DELIVERED").length;
  const inTransit = data.shipments.length - delivered;
  const activePhase = data.phase_plan.find((p) => p.status === "ACTIVE" || p.status === "ISSUE");
  const plan = [...data.plans].reverse().find((p) => p.status !== "SUPERSEDED") ?? null;
  const quote = data.quotes[data.quotes.length - 1] ?? null;
  const currentFiles = data.files.filter((f) => f.is_current).length;

  /* Whose move it is. The clinic's page says "your move"; from this side the
     same case says whether it is on the bench or waiting on the clinic — one
     word that decides whether this page needs reading at all today. */
  const tone = closed
    ? data.status === "COMPLETED"
      ? "done"
      : "stop"
    : WITH_THE_CLINIC.has(data.status) || Boolean(data.awaiting_phase_decision)
      ? "lab"
      : "you";
  const eyebrow = {
    you: "On your bench",
    lab: "With the clinic",
    done: "Complete",
    stop: "Cancelled",
  }[tone];

  const tabs: { key: Tab; label: string; badge?: string; warn?: boolean }[] = [
    { key: "overview", label: "Overview" },
    ...(data.kind !== "ACCESSORY"
      ? [{ key: "records" as Tab, label: "Records", badge: currentFiles > 0 ? String(currentFiles) : undefined }]
      : []),
    ...(!isTechnician && data.payments.length > 0
      ? [
          {
            key: "payments" as Tab,
            label: "Payments",
            badge:
              checking.length > 0
                ? `${checking.length} to check`
                : unpaidTotal > 0
                  ? `${formatMoney(unpaidTotal)} unpaid`
                  : undefined,
            warn: checking.length > 0,
          },
        ]
      : []),
    ...(!isTechnician && (data.shipments.length > 0 || data.phases_divided)
      ? [
          {
            key: "delivery" as Tab,
            label: "Delivery",
            badge:
              inTransit > 0
                ? `${inTransit} on the way`
                : delivered > 0
                  ? `${delivered} delivered`
                  : undefined,
          },
        ]
      : []),
    { key: "history", label: "History", badge: data.events.length > 0 ? String(data.events.length) : undefined },
  ];
  // Looking back is reading, not working: only what is unaffected by it stays.
  const allowed = lookingBack ? tabs.filter((t) => t.key === "payments" || t.key === "history") : tabs;
  const tab: Tab = allowed.find((t) => t.key === params.get("tab"))?.key ?? allowed[0].key;

  function showTab(key: Tab, scroll = false) {
    const query = new URLSearchParams(params);
    if (key === "overview") query.delete("tab");
    else query.set("tab", key);
    setParams(query, { replace: true });
    if (scroll) {
      requestAnimationFrame(() =>
        document.getElementById("ws-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
  }

  return (
    <main className="page ws">
      <header className="ws-head">
        <Link to={isTechnician ? "/tech" : "/staff/orders"} className="ws-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M11 6l-6 6 6 6" />
          </svg>
          {isTechnician ? "Visits" : "Cases"}
        </Link>
        <h1>{data.patient_name || "Aligner accessories"}</h1>
        <span className="ws-ref mono">{data.order_number}</span>
        <StatusPill status={data.status} label={data.status_label} />
        {data.priority === "EXPRESS" && (
          <span className="tag-express">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" strokeLinejoin="round" />
            </svg>
            Express
          </span>
        )}
        <p className="ws-meta">
          {data.patient_number && (
            <span className="mono" title="Patient number">
              {data.patient_number}
            </span>
          )}
          {/* Whose case this is comes before what it is: the lab works by
              clinic, and the name is what a phone call is about. */}
          <span title={`${data.doctor_name} · ${data.clinic_name}`}>{data.doctor_name}</span>
          <span>{data.branch_label ? data.branch_label.split(" · ")[0] : data.clinic_name}</span>
          {data.kind === "ALIGNER" ? (
            <>
              <span>
                {data.category_label ? (
                  <CategoryPill label={data.category_label} confirmed={data.category_confirmed} />
                ) : (
                  "Not sized yet"
                )}
              </span>
              <span>{archLabel(data.arch)}</span>
              {data.assigned_to_name && <span>Planned by {data.assigned_to_name}</span>}
            </>
          ) : (
            <span>{data.product_label || "Accessories"}</span>
          )}
          {isTechnician ? (
            <span title={`Opened ${formatDate(data.created_at)}`}>
              Opened {shortDate(data.created_at)}
            </span>
          ) : (
            <span>
              <button
                type="button"
                className="ws-date"
                onClick={() => setDateOpen((open) => !open)}
                title={`Opened ${formatDate(data.created_at)} — change it`}
              >
                Opened {shortDate(data.created_at)}
              </button>
            </span>
          )}
        </p>

        {dateOpen && (
          <div className="ws-datefix">
            <label>
              <span>Case opened on</span>
              <input
                type="date"
                defaultValue={data.created_at.slice(0, 10)}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => {
                  const day = e.target.value;
                  if (!day) return;
                  // Midday, so the date reads the same wherever it is read —
                  // see the note in LabCaseTable's DateCell.
                  setCaseDate.mutate(`${day}T12:00:00Z`);
                }}
              />
            </label>
            {setCaseDate.isPending && <span className="dim">Saving…</span>}
            <ErrorText error={setCaseDate.error} />
            <button type="button" className="btn-link" onClick={() => setDateOpen(false)}>
              Close
            </button>
          </div>
        )}
        {data.has_simulation && (
          <div className="ws-head-do">
            <Link to={`/viewer/${data.id}`} className="ws-sim" title="Step through the planned movement">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" />
                <path d="M4 7.5 12 12l8-4.5M12 12v9" />
              </svg>
              Open the 3D simulation
            </Link>
          </div>
        )}
      </header>

      <Journey order={data} viewing={viewing} onView={setViewing} />

      <div className={lookingBack && data.payments.length === 0 ? "ws-top solo" : "ws-top"}>
        {lookingBack ? (
          <StageBrowser order={data} viewing={viewing} onView={setViewing} />
        ) : (
          <section className={`ws-now tone-${tone}`} aria-label="What happens next">
            <header className="ws-now-head">
              <span className="ws-now-eyebrow">{eyebrow}</span>
              {tone === "lab" && upNext && <span className="ws-now-next">Then: {upNext}</span>}
              {!closed && <span className="ws-now-next">Updated {since(data.updated_at)} ago</span>}
            </header>

            {isTechnician ? (
              <TechnicianPanel order={data} onDone={invalidate} />
            ) : (
              <StaffActions
                order={data}
                onDone={invalidate}
                onDeliver={closed ? undefined : (id) => markDelivered.mutate(id)}
              />
            )}

            {/* A receipt sitting unchecked is money the clinic thinks it has
                paid and a stage that will not move. Said once, with the way
                to it — it is a second job, not the stage's own. */}
            {!isTechnician && checking.length > 0 && (
              <div className="ws-now-also">
                <span>
                  <b>
                    {checking.length} receipt{checking.length === 1 ? "" : "s"} to check
                  </b>{" "}
                  — {formatMoney(sum(checking))} said to be paid
                </span>
                <button type="button" className="btn-link" onClick={() => showTab("payments", true)}>
                  Check now →
                </button>
              </div>
            )}
          </section>
        )}

        <aside className="ws-glance" aria-label="At a glance">
          {!isTechnician && data.payments.length > 0 && (
            <Glance
              label="Payments"
              tone={checking.length > 0 ? "warn" : unpaidTotal > 0 ? undefined : "ok"}
              value={
                checking.length > 0
                  ? `${checking.length} to check`
                  : unpaidTotal > 0
                    ? `${formatMoney(unpaidTotal)} unpaid`
                    : "All paid"
              }
              sub={paidTotal > 0 ? `${formatMoney(paidTotal)} confirmed` : "Nothing confirmed yet"}
              onClick={() => showTab("payments", true)}
            />
          )}
          {data.kind !== "ACCESSORY" && !lookingBack && (
            <Glance
              label="Records"
              tone={data.files.some((f) => f.category === "INTRAORAL_SCAN" && f.is_current) ? "ok" : undefined}
              value={`${currentFiles} file${currentFiles === 1 ? "" : "s"}`}
              sub={
                data.files.some((f) => f.category === "INTRAORAL_SCAN" && f.is_current)
                  ? `Scan v${data.scan_revision || 1} on the case`
                  : "No scan yet"
              }
              onClick={() => showTab("records", true)}
            />
          )}
          {!lookingBack && (
            <Glance
              label={data.kind === "ALIGNER" ? "Treatment" : "Ordered"}
              value={
                data.kind !== "ALIGNER"
                  ? data.product_label || `${data.accessories.length} item${data.accessories.length === 1 ? "" : "s"}`
                  : plan && plan.total_aligners > 0
                    ? `${plan.total_aligners} aligners`
                    : quote
                      ? formatRange(quote.total, quote.total_max, quote.currency)
                      : "Not sized yet"
              }
              sub={
                data.kind !== "ALIGNER"
                  ? "Made from the scan as it stands"
                  : plan && plan.total_aligners > 0
                    ? `${plan.aligners_upper} upper · ${plan.aligners_lower} lower`
                    : quote
                      ? "Expected price, set by the plan"
                      : "Sized when the plan is made"
              }
              onClick={() => showTab("overview", true)}
            />
          )}
          {!isTechnician && !lookingBack && (data.shipments.length > 0 || data.phases_divided) && (
            <Glance
              label="Delivery"
              value={
                activePhase && data.phases_divided
                  ? `Phase ${activePhase.phase} of ${data.phase_plan.length}`
                  : inTransit > 0
                    ? `${inTransit} on the way`
                    : `${delivered} delivered`
              }
              sub={
                data.dispatch_mode === "PHASED"
                  ? "Phase-wise dispatch"
                  : data.dispatch_mode === "FULL"
                    ? "One shipment, whole series"
                    : `${data.shipments.length} parcel${data.shipments.length === 1 ? "" : "s"} so far`
              }
              onClick={() => showTab("delivery", true)}
            />
          )}
        </aside>
      </div>

      <nav className="ws-tabs" id="ws-tabs" role="tablist" aria-label="Case file">
        {allowed.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? "on" : ""}
            onClick={() => showTab(t.key)}
          >
            {t.label}
            {t.badge && <small className={t.warn ? "warn" : ""}>{t.badge}</small>}
          </button>
        ))}
      </nav>

      <div className="ws-panel" role="tabpanel" key={tab}>
        {tab === "overview" && (
          <div className="ws-overview">
            <div className="ws-col">
              <SimulationCard order={data} />
              {data.plans.length > 0 && <PlanCard order={data} open />}
              <QuoteCard order={data} open={data.plans.length === 0} />
              {data.accessories.length > 0 && (
                <section className="card">
                  <h4 style={{ marginBottom: 10 }}>Items</h4>
                  <ul className="ws-items">
                    {data.accessories.map((line) => (
                      <li key={line.accessory_id}>
                        <span>
                          {line.name}
                          {line.quantity > 1 && <span className="dim"> × {line.quantity}</span>}
                        </span>
                        <span className="num">{formatMoney(line.line_total)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
            <div className="ws-col">
              <CaseSummary order={data} />
              {!isTechnician && !closed && (
                <section className="card">
                  <h4 style={{ marginBottom: 10 }}>Cancel this case</h4>
                  <ErrorText error={cancel.error} />
                  <ConfirmButton
                    label="Cancel case"
                    confirmLabel="Yes, cancel it"
                    onConfirm={() => cancel.mutate("Cancelled by the lab.")}
                  />
                </section>
              )}
            </div>
          </div>
        )}

        {tab === "records" && (
          <div className="ws-records">
            <div className="card">
              <FileExplorer order={data} onChanged={invalidate} />
            </div>
          </div>
        )}

        {tab === "delivery" && (
          <div className="ws-ship">
            <PhaseTracker order={data} />
            <ShipmentsCard
              order={data}
              open
              onMarkDelivered={closed ? undefined : (id) => markDelivered.mutate(id)}
            />
          </div>
        )}

        {tab === "payments" && (
          <div className="ws-pay">
            <PaymentReview order={data} />
            <InvoiceCard order={data} />
            {canInvoice && (
              <section className="card">
                <div className="card-head">
                  <h4>Invoice</h4>
                </div>
                <p className="muted" style={{ fontSize: "0.9rem", marginBottom: 12 }}>
                  Billed at the agreed price{billedTotal ? ` — ${formatMoney(billedTotal)}` : ""}.
                </p>
                <ErrorText error={invoice.error} />
                <button
                  type="button"
                  className="btn-dark"
                  disabled={invoice.isPending}
                  onClick={() => invoice.mutate()}
                >
                  {invoice.isPending ? "Generating…" : "Generate invoice"}
                </button>
              </section>
            )}
          </div>
        )}

        {tab === "history" && (
          <div className="ws-hist">
            <Timeline order={data} />
          </div>
        )}
      </div>
    </main>
  );
}

/** One side question, answered in a figure, and the way to its detail. */
function Glance({
  label,
  value,
  sub,
  tone,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "warn" | "ok";
  onClick?: () => void;
}) {
  const body = (
    <>
      <small>{label}</small>
      <b>{value}</b>
      {sub && <span>{sub}</span>}
      {onClick && (
        <svg className="go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
      )}
    </>
  );
  return onClick ? (
    <button type="button" className={`ws-tile${tone ? ` ${tone}` : ""}`} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={`ws-tile${tone ? ` ${tone}` : ""}`}>{body}</div>
  );
}

function TechnicianPanel({ order, onDone }: { order: Order; onDone: () => void }) {
  const visit = order.appointment;
  const scanDone = order.status !== "AWAITING_SCAN";

  if (scanDone) {
    return (
      <Banner tone="ok">
        Scan uploaded — this visit is complete. The lab has taken it from here.
      </Banner>
    );
  }

  return (
    <ActionPanel
      title="Capture the scan"
      why={
        visit
          ? `${visit.status_label} · ${formatDate(visit.starts_at)}${visit.location ? ` · ${visit.location}` : ""}`
          : "Upload the intraoral scan for this case."
      }
    >
      <Checklist
        items={[
          { done: true, label: "Visit assigned to you" },
          {
            done: order.files.some((f) => f.category === "RECORD_PHOTO" && f.is_current),
            label: "Clinical photographs on file",
          },
          {
            done: order.files.some((f) => f.category === "INTRAORAL_SCAN" && f.is_current),
            label: "Intraoral scan (.stl) uploaded",
          },
        ]}
      />
      <p className="dim">
        Retaking the photographs replaces the clinic's set as the current revision. Uploading the
        scan closes this visit and hands the case back to the lab.
      </p>
      <FileUploader
        orderId={order.id}
        categories={["INTRAORAL_SCAN", "RECORD_PHOTO", "OPG", "OTHER"]}
        onUploaded={onDone}
      />
    </ActionPanel>
  );
}

function StaffActions({
  order,
  onDone,
  onDeliver,
}: {
  order: Order;
  onDone: () => void;
  /** Settling a parcel is part of the shipped stage, so it is offered there
      as well as in the delivery section. */
  onDeliver?: (shipmentId: string) => void;
}) {
  const toast = useToast();
  /* Each of these hands the case to somebody else. The panel it was pressed
     in disappears as the case moves on, so the confirmation is what tells the
     lab which way it went. */
  const settled = (title: string, body?: string) => () => {
    onDone();
    toast({ title, body });
  };
  const [note, setNote] = useState("");
  const [category, setCategory] = useState("");
  const [extras, setExtras] = useState<{ description: string; unit_price: string; quantity: number }[]>([]);
  const [tax, setTax] = useState("");
  const [discount, setDiscount] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  const prices = useQuery({ queryKey: ["pricing"], queryFn: api.pricing });
  const [plan, setPlan] = useState({
    aligners_upper: "",
    aligners_lower: "",
    final_price: "",
    final_discount: "",
    final_discount_reason: "",
    final_tax: "",
    ipr_required: false,
    attachments_required: false,
    summary: "",
  });
  const [shipment, setShipment] = useState({
    aligner_range_to: "",
    carrier: "",
    tracking_number: "",
    tracking_url: "",
  });

  const startReview = useMutation({
    mutationFn: () => api.startReview(order.id),
    onSuccess: settled("Review started", "The case is off the new-submissions pile and on your desk."),
  });
  const requestRecords = useMutation({
    mutationFn: () => api.requestRecords(order.id, note),
    onSuccess: () => {
      setNote("");
      onDone();
      toast({ title: "Sent back for records", body: "The clinic has been told exactly what is missing." });
    },
  });
  const sendQuote = useMutation({
    mutationFn: () =>
      api.sendQuote(order.id, {
        category,
        extras: extras
          .filter((item) => item.description.trim() && item.unit_price !== "")
          .map((item) => ({
            description: item.description,
            unit_price: item.unit_price,
            quantity: Number(item.quantity) || 1,
          })),
        discount: discount || "0",
        discount_reason: discountReason,
        tax: tax || "0",
      }),
    onSuccess: settled("Quote sent", "The clinic decides next — nothing is made until they accept."),
  });
  const acceptScan = useMutation({
    mutationFn: () => api.acceptScan(order.id, note),
    onSuccess: () => {
      setNote("");
      onDone();
      toast({ title: "Scan accepted", body: "The case is in planning." });
    },
  });
  const rejectScan = useMutation({
    mutationFn: () => api.rejectScan(order.id, note),
    onSuccess: () => {
      setNote("");
      onDone();
      toast({ title: "New scan requested", tone: "warn", body: "The clinic has your note and will send another." });
    },
  });
  const sharePlan = useMutation({
    mutationFn: () =>
      api.sharePlan(order.id, {
        aligners_upper: Number(plan.aligners_upper || 0),
        aligners_lower: Number(plan.aligners_lower || 0),
        final_price: plan.final_price || "0",
        final_discount: plan.final_discount || "0",
        final_discount_reason: plan.final_discount_reason,
        final_tax: plan.final_tax || "0",
        ipr_required: plan.ipr_required,
        attachments_required: plan.attachments_required,
        summary: plan.summary,
      }),
    onSuccess: settled("Plan shared", "The clinic approves it, or sends it back with changes."),
  });
  const phaseIssue = order.phase_issues.find((i) => i.status === "OPEN");
  const resolveIssue = useMutation({
    mutationFn: (resolution: "COMMENTS" | "REMAKE" | "RESCAN") =>
      api.resolvePhaseFitIssue(order.id, resolution, note),
    onSuccess: (_order, resolution) =>
      settled(
        resolution === "COMMENTS"
          ? "Advice sent"
          : resolution === "REMAKE"
            ? "Phase being remade"
            : "New scan requested",
        resolution === "COMMENTS"
          ? "The issue stays open until the clinic says whether it worked."
          : "The clinic has been told what happens next.",
      )(),
  });
  const reviewPhase = useMutation({
    mutationFn: (outcome: "CONTINUE" | "RESCAN") => api.reviewPhase(order.id, outcome, note),
    onSuccess: (_order, outcome) =>
      settled(
        outcome === "CONTINUE" ? "Phase approved" : "New scan requested",
        outcome === "CONTINUE"
          ? "The next batch is on the bench."
          : "The remaining aligners will be rebuilt from a fresh scan.",
      )(),
  });
  const resolveFit = useMutation({
    mutationFn: (resolution: "rescan" | "replan" | "refabricate") =>
      api.resolveFitIssue(order.id, resolution),
    onSuccess: settled("Fit issue resolved", "A fresh training aligner is on its way to the clinic."),
  });
  const shipTraining = useMutation({
    mutationFn: () =>
      api.createShipment(order.id, {
        shipment_type: "TRAINING_ALIGNER",
        carrier: shipment.carrier,
        tracking_number: shipment.tracking_number,
        tracking_url: shipment.tracking_url,
      }),
    onSuccess: settled("Training aligner shipped", "The clinic confirms the fit when it arrives."),
  });
  const shipProduct = useMutation({
    mutationFn: () =>
      api.createShipment(order.id, {
        shipment_type: "PRODUCT",
        carrier: shipment.carrier,
        tracking_number: shipment.tracking_number,
        tracking_url: shipment.tracking_url,
      }),
    onSuccess: settled("Order shipped", "It completes itself once the clinic confirms it arrived."),
  });
  const shipAligners = useMutation({
    mutationFn: () =>
      api.createShipment(order.id, {
        shipment_type: order.dispatch_mode === "FULL" ? "FULL_CASE" : "ALIGNER_PHASE",
        aligner_range_to: shipment.aligner_range_to ? Number(shipment.aligner_range_to) : null,
        carrier: shipment.carrier,
        tracking_number: shipment.tracking_number,
        tracking_url: shipment.tracking_url,
      }),
    onSuccess: () => {
      setShipment({ ...shipment, aligner_range_to: "", tracking_number: "" });
      onDone();
      toast({ title: "Batch dispatched", body: "Tracking is on the case, and the clinic can see it." });
    },
  });
  const complete = useMutation({
    mutationFn: () => api.completeOrder(order.id),
    onSuccess: settled("Case completed", "It moves out of the open list."),
  });

  const chosen = prices.data?.find((p) => p.category === category);
  const extrasTotal = extras.reduce(
    (sum, item) => sum + (Number(item.unit_price) || 0) * (Number(item.quantity) || 0),
    0,
  );
  // Taken off before tax, and off both ends of the band by the same amount:
  // it is one discount on one case, not a proportion of a range. Mirrors what
  // the server does, so the preview cannot promise a different figure.
  const off = Number(discount) || 0;
  const totalLow = (Number(chosen?.price_min) || 0) + extrasTotal - off + (Number(tax) || 0);
  const totalHigh = (Number(chosen?.price_max) || 0) + extrasTotal - off + (Number(tax) || 0);
  // Named for the quote: the treatment plan carries a discount of its own,
  // and the two must not be confused for one another. Only meaningful once a
  // band is picked — before that there is no estimate for it to exceed, and
  // comparing against nothing called every discount too large.
  const quoteDiscountTooBig =
    !!chosen && off > (Number(chosen.price_min) || 0) + extrasTotal;

  const planTotalAligners =
    Number(plan.aligners_upper || 0) + Number(plan.aligners_lower || 0);
  const suggested = prices.data?.find(
    (p) =>
      planTotalAligners >= p.range_from &&
      (p.range_to === null ? true : planTotalAligners <= p.range_to),
  );
  // The batch this phase should carry, as the clinic chose it. When it is
  // known the lab confirms a filled-in span instead of deriving one per batch.
  const plannedPhase = useMemo(
    () => (order.phase_plan ?? []).find((p) => p.phase === order.next_phase_number) ?? null,
    [order.phase_plan, order.next_phase_number],
  );

  // Fill the span in from the clinic's choice, so the usual case is a
  // confirmation rather than a calculation. Still editable — a remake or a
  // short final batch sometimes has to differ.
  useEffect(() => {
    if (plannedPhase) {
      setShipment((current) =>
        current.aligner_range_to
          ? current
          : { ...current, aligner_range_to: String(plannedPhase.to_step) },
      );
    }
  }, [plannedPhase]);

  const planDiscount = Number(plan.final_discount) || 0;
  const planNet = Math.max(0, (Number(plan.final_price) || 0) - planDiscount);
  const planTotal = planNet + (Number(plan.final_tax) || 0);
  const discountTooBig = planDiscount > (Number(plan.final_price) || 0);
  const acceptedQuote = order.quotes.find((q) => q.status === "ACCEPTED");
  const quotedTotal = acceptedQuote ? Number(acceptedQuote.total) : null;

  switch (order.status) {
    case "SUBMITTED":
      return (
        <ActionPanel title="Review this submission" why="Check the records are adequate to plan from.">
          <StepFiles order={order} categories={RECORD_CATEGORIES} title="What the clinic sent" />
          <ErrorText error={startReview.error} />
          <button
            type="button"
            className="btn-primary"
            disabled={startReview.isPending}
            onClick={() => startReview.mutate()}
          >
            Start review
          </button>
        </ActionPanel>
      );

    case "UNDER_REVIEW":
    case "QUOTED":
      return (
        <ActionPanel
          title={order.status === "QUOTED" ? "Revise the quote" : "Send a quote"}
          why={
            order.status === "QUOTED"
              ? "A new version supersedes the one the doctor is looking at."
              : "Production cannot start until the doctor accepts a priced quote."
          }
        >
          <p className="why">
            Pick the aligner band this case looks like from the photographs. Each band has a fixed
            price; the exact figure is confirmed later with the treatment plan.
          </p>

          <StepFiles order={order} categories={RECORD_CATEGORIES} title="The records to price from" />

          <div className="band-grid">
            {prices.data
              ?.filter((p) => p.is_active)
              .map((p) => (
                <button
                  key={p.category}
                  type="button"
                  className={`band${category === p.category ? " picked" : ""}`}
                  onClick={() => setCategory(p.category)}
                >
                  <span className="band-name">{p.label}</span>
                  <span className="band-price">{formatRange(p.price_min, p.price_max)}</span>
                </button>
              ))}
          </div>

          <div className="stack-sm">
            <h4>Extra charges (optional)</h4>
            {extras.map((item, index) => (
              <div className="row" key={index}>
                <input
                  placeholder="Description"
                  value={item.description}
                  style={{ flex: 2, minWidth: 150 }}
                  onChange={(e) => {
                    const next = [...extras];
                    next[index] = { ...item, description: e.target.value };
                    setExtras(next);
                  }}
                />
                <input
                  type="number"
                  placeholder="Amount"
                  value={item.unit_price}
                  style={{ flex: 1, minWidth: 100 }}
                  onChange={(e) => {
                    const next = [...extras];
                    next[index] = { ...item, unit_price: e.target.value };
                    setExtras(next);
                  }}
                />
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => setExtras(extras.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn-link"
              onClick={() => setExtras([...extras, { description: "", unit_price: "", quantity: 1 }])}
            >
              Add a charge
            </button>
          </div>

          <div className="grid-2">
            <Field label="Discount">
              <input
                type="number"
                min="0"
                value={discount}
                placeholder="0"
                onChange={(e) => setDiscount(e.target.value)}
              />
            </Field>
            <Field label="Reason for the discount">
              <input
                value={discountReason}
                placeholder="Introductory offer, referral, staff case…"
                onChange={(e) => setDiscountReason(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid-2">
            <Field label="Tax">
              <input type="number" value={tax} onChange={(e) => setTax(e.target.value)} />
            </Field>
            <div>
              <h4>Expected range</h4>
              <p className="num" style={{ fontSize: "1.2rem", fontWeight: 680 }}>
                {chosen ? formatRange(totalLow, totalHigh) : "—"}
              </p>
              {off > 0 && chosen && !quoteDiscountTooBig && (
                <p className="dim" style={{ marginTop: -4 }}>
                  After {formatMoney(off)} off, before tax.
                </p>
              )}
            </div>
          </div>

          {quoteDiscountTooBig && (
            <Banner tone="danger">
              The discount is more than the estimate itself. The clinic cannot be shown a
              figure below zero.
            </Banner>
          )}

          <ErrorText error={sendQuote.error} />
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={sendQuote.isPending || !category || quoteDiscountTooBig}
              onClick={() => sendQuote.mutate()}
            >
              {order.status === "QUOTED" ? "Send revised quote" : "Send expected quote"}
            </button>
          </div>

          {order.status === "UNDER_REVIEW" && (
            <>
              <Field label="Or bounce it back for better records">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Say exactly what is missing or unusable."
                />
              </Field>
              <ErrorText error={requestRecords.error} />
              <button
                type="button"
                className="btn-ghost"
                disabled={!note.trim() || requestRecords.isPending}
                onClick={() => requestRecords.mutate()}
              >
                Request more records
              </button>
            </>
          )}
        </ActionPanel>
      );

    case "AWAITING_SCAN": {
      const routeCopy =
        order.scan_route === "COURIER"
          ? `The clinic couriered a PVS impression — tracking ${order.scan_courier_tracking || "not given"}. Digitise it, then upload the STL here.`
          : order.scan_route === "APPOINTMENT"
            ? `${order.appointment ? `${order.appointment.technician_name} attends ${formatDate(order.appointment.starts_at)}` : "A technician visit is booked"}. Upload the STL once the scan has been taken.`
            : "The clinic is uploading an STL from its own scanner. Nothing to do until it lands.";

      return (
        <ActionPanel title="Waiting for the scan" why={routeCopy}>
          <Checklist
            items={[
              { done: true, label: "Quote accepted by the doctor" },
              { done: order.scan_route !== null, label: "Scan route chosen" },
              { done: false, label: "Intraoral scan (.stl) on the case" },
            ]}
          />
          {order.scan_route !== "UPLOAD" && order.scan_route !== null && (
            <>
              <p className="dim">
                Uploading the scan moves this case straight to review — there is no separate
                "received" step, because a case cannot be planned without the geometry.
              </p>
              <FileUploader
                orderId={order.id}
                categories={["INTRAORAL_SCAN"]}
                onUploaded={onDone}
                hint="STL files only."
              />
            </>
          )}
        </ActionPanel>
      );
    }

    case "SCAN_SUBMITTED":
      return (
        <ActionPanel
          title="Verify the scan"
          why="Accepting starts treatment planning. Rejecting sends the case back for another scan."
        >
          <Checklist
            items={[
              { done: true, label: "Quote accepted by the doctor" },
              {
                done: true,
                label:
                  order.scan_route === "UPLOAD"
                    ? `Intraoral scan uploaded (${order.files.filter((f) => f.category === "INTRAORAL_SCAN").length} file(s))`
                    : "Scan marked received at the lab",
              },
              { done: false, label: "Scan checked and accepted" },
            ]}
          />
          <StepFiles order={order} categories={["INTRAORAL_SCAN"]} title="The scan to check" />
          <Field label="Note">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional when accepting, required when sending it back."
            />
          </Field>
          <ErrorText error={acceptScan.error ?? rejectScan.error} />
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={acceptScan.isPending}
              onClick={() => acceptScan.mutate()}
            >
              Accept scan, start planning
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={!note.trim() || rejectScan.isPending}
              onClick={() => rejectScan.mutate()}
            >
              Ask for a new scan
            </button>
          </div>
        </ActionPanel>
      );

    case "IN_PLANNING":
      return (
        <ActionPanel
          title="Publish the treatment plan"
          why="Attach the plan document and the simulation files below, then publish."
        >
          <Checklist
            items={[
              {
                done: order.files.some((f) => f.category === "INTRAORAL_SCAN"),
                label: "Intraoral scan on file",
              },
              {
                done: order.files.some((f) => f.category === "TREATMENT_PLAN"),
                label: "Treatment plan document attached (add it below)",
              },
              {
                done: order.files.some((f) => f.category === "SIMULATION_MODEL"),
                label: "Simulation files attached — the clinic reviews these in 3D",
              },
            ]}
          />
          {order.plans.some((p) => p.status === "REVISION_REQUESTED") && (
            <Banner tone="warn">
              Revision requested:{" "}
              {order.plans.filter((p) => p.status === "REVISION_REQUESTED").slice(-1)[0]
                ?.revision_notes}
            </Banner>
          )}
          {/* The plan document and the staged models are what this step is
              waiting for, so they are attached here rather than in the cabinet
              two sections down. */}
          <FileUploader
            orderId={order.id}
            categories={["TREATMENT_PLAN", "SIMULATION_MODEL"]}
            onUploaded={onDone}
            hint="The plan document, and the staged models the clinic steps through in 3D."
          />
          <StepFiles
            order={order}
            categories={["TREATMENT_PLAN", "SIMULATION_MODEL"]}
            title="Attached so far"
          />

          <div className="grid-2">
            <Field label="Upper aligners">
              <input
                type="number"
                min={0}
                value={plan.aligners_upper}
                onChange={(e) => setPlan({ ...plan, aligners_upper: e.target.value })}
              />
            </Field>
            <Field label="Lower aligners">
              <input
                type="number"
                min={0}
                value={plan.aligners_lower}
                onChange={(e) => setPlan({ ...plan, aligners_lower: e.target.value })}
              />
            </Field>
          </div>

          <div className="card price-card">
            <h4 style={{ marginBottom: 8 }}>Final price</h4>
            <p className="price-callout">
              {planTotalAligners > 0
                ? `${planTotalAligners} aligner(s) in total.`
                : "Enter the aligner counts above."}
              {suggested && ` ${suggested.label} quotes ${formatRange(suggested.price_min, suggested.price_max)}.`}
              {" "}This replaces the expected quote once the plan is shared.
            </p>
            <div className="grid-2">
              <Field label="Price before discount">
                <input
                  type="number"
                  min={0}
                  value={plan.final_price}
                  placeholder={suggested ? String(Number(suggested.price_min)) : ""}
                  onChange={(e) => setPlan({ ...plan, final_price: e.target.value })}
                />
              </Field>
              <Field label="Discount">
                <input
                  type="number"
                  min={0}
                  value={plan.final_discount}
                  placeholder="0"
                  onChange={(e) => setPlan({ ...plan, final_discount: e.target.value })}
                />
              </Field>
            </div>
            {planDiscount > 0 && (
              <div className="row" style={{ marginTop: -2, marginBottom: 8 }}>
                {[5, 10, 15].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    className="btn-link"
                    onClick={() =>
                      setPlan({
                        ...plan,
                        final_discount: String(
                          Math.round(((Number(plan.final_price) || 0) * pct) / 100),
                        ),
                      })
                    }
                  >
                    {pct}%
                  </button>
                ))}
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => setPlan({ ...plan, final_discount: "", final_discount_reason: "" })}
                >
                  Clear
                </button>
              </div>
            )}
            {planDiscount > 0 && (
              <Field label="Reason for the discount (the clinic sees this)">
                <input
                  type="text"
                  maxLength={160}
                  placeholder="Referral scheme, goodwill on a redo, camp rate…"
                  value={plan.final_discount_reason}
                  onChange={(e) => setPlan({ ...plan, final_discount_reason: e.target.value })}
                />
              </Field>
            )}
            {discountTooBig && (
              <Banner tone="danger">The discount cannot be more than the price before discount.</Banner>
            )}
            <div className="grid-2">
              <Field label="Tax">
                <input
                  type="number"
                  min={0}
                  value={plan.final_tax}
                  onChange={(e) => setPlan({ ...plan, final_tax: e.target.value })}
                />
              </Field>
            </div>
            {suggested && !plan.final_price && (
              <div className="row">
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => setPlan({ ...plan, final_price: String(Number(suggested.price_min)) })}
                >
                  Use {formatMoney(suggested.price_min)}
                </button>
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => setPlan({ ...plan, final_price: String(Number(suggested.price_max)) })}
                >
                  Use {formatMoney(suggested.price_max)}
                </button>
              </div>
            )}
            {planDiscount > 0 && !discountTooBig && (
              <p className="dim" style={{ marginTop: 10, marginBottom: 0 }}>
                <span className="num">{formatMoney(plan.final_price || 0)}</span> less{" "}
                <span className="num">{formatMoney(planDiscount)}</span> discount ={" "}
                <span className="num">{formatMoney(planNet)}</span>
                {Number(plan.final_tax) > 0 && <> + {formatMoney(plan.final_tax)} tax</>}
              </p>
            )}
            <p className="num" style={{ fontSize: "1.2rem", fontWeight: 680, marginTop: 10 }}>
              {formatMoney(planTotal)}
              {quotedTotal !== null && (
                <span className="dim" style={{ fontSize: "0.82rem", fontWeight: 400 }}>
                  {"  "}
                  vs {formatMoney(quotedTotal)} estimated
                  {planTotal !== quotedTotal &&
                    ` (${planTotal > quotedTotal ? "+" : ""}${formatMoney(planTotal - quotedTotal)})`}
                </span>
              )}
            </p>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={plan.ipr_required}
              onChange={(e) => setPlan({ ...plan, ipr_required: e.target.checked })}
            />
            IPR required
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={plan.attachments_required}
              onChange={(e) => setPlan({ ...plan, attachments_required: e.target.checked })}
            />
            Attachments required
          </label>
          <Field label="Summary for the doctor">
            <textarea
              value={plan.summary}
              onChange={(e) => setPlan({ ...plan, summary: e.target.value })}
            />
          </Field>
          <ErrorText error={sharePlan.error} />
          <button
            type="button"
            className="btn-primary"
            disabled={
              sharePlan.isPending ||
              planTotalAligners === 0 ||
              !Number(plan.final_price) ||
              discountTooBig
            }
            onClick={() => sharePlan.mutate()}
          >
            Share plan with the doctor
          </button>
        </ActionPanel>
      );

    case "FIT_ISSUE":
      // Two different problems land on this status. A fit issue raised inside a
      // delivered phase is about one aligner in a batch the patient is already
      // wearing; the training-aligner one is about whether the case can start
      // at all. They have different answers, so the panel picks.
      if (phaseIssue) {
        return (
          <ActionPanel
            title={`Fit issue — phase ${phaseIssue.phase_number}`}
            why={`The clinic reports that ${phaseIssue.arch.toLowerCase()} aligner ${phaseIssue.aligner_number} does not fit. Nothing further is made until this is answered.`}
          >
            {phaseIssue.notes && <Banner tone="warn">{phaseIssue.notes}</Banner>}
            <StepFiles
              order={order}
              categories={["PHASE_FIT_PHOTO"]}
              title={`Phase ${phaseIssue.phase_number} fit photographs`}
            />
            {phaseIssue.messages.length > 0 && (
              <div className="stack-sm" style={{ marginBottom: 10 }}>
                {phaseIssue.messages.map((m) => (
                  <div key={m.id} className={m.from_lab ? "notif" : "notif unread"}>
                    <div className="t">{m.from_lab ? "3D Align" : "The clinic"}</div>
                    <div className="b">{m.body}</div>
                    <div className="dim">{formatDate(m.created_at)}</div>
                  </div>
                ))}
              </div>
            )}
            <p className="dim">
              The six views are in this step. Instructions
              change nothing that has been made and do not close the issue — the clinic
              tries them and says whether they worked, and only they can close it. A
              remake replaces the same aligners as a new round of this phase; a rescan
              rebuilds what is left from a fresh scan, with a training aligner first, and
              picks up again at this phase. Both of those close the issue outright.
            </p>
            <Field label="Comments for the clinic (required to send instructions)">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What the clinic should do, or why the phase is being remade."
              />
            </Field>
            <ErrorText error={resolveIssue.error} />
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                className="btn-primary"
                disabled={resolveIssue.isPending || !note.trim()}
                onClick={() => resolveIssue.mutate("COMMENTS")}
              >
                Send advice
              </button>
              <button
                type="button"
                className="btn-dark"
                disabled={resolveIssue.isPending}
                onClick={() => resolveIssue.mutate("REMAKE")}
              >
                Remake phase {phaseIssue.phase_number}
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={resolveIssue.isPending}
                onClick={() => resolveIssue.mutate("RESCAN")}
              >
                Ask for a new scan
              </button>
            </div>
          </ActionPanel>
        );
      }
      return (
        <ActionPanel
          title="Fit issue reported"
          why={`All three routes produce a fresh training aligner — this case moves to round ${order.fit_round + 1}.`}
        >
          <StepFiles
            order={order}
            categories={["FIT_ISSUE_PHOTO"]}
            title="Photographs from the clinic"
          />
          <ErrorText error={resolveFit.error} />
          <div className="stack-sm">
            <button
              type="button"
              className="btn-primary"
              disabled={resolveFit.isPending}
              onClick={() => resolveFit.mutate("refabricate")}
            >
              Refabricate from the existing plan
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={resolveFit.isPending}
              onClick={() => resolveFit.mutate("replan")}
            >
              Re-plan using the current scan
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={resolveFit.isPending}
              onClick={() => resolveFit.mutate("rescan")}
            >
              Ask the clinic for a fresh scan (v{order.scan_revision + 1})
            </button>
          </div>
        </ActionPanel>
      );

    case "TRAINING_ALIGNER_PRODUCTION":
      return (
        <ActionPanel title="Ship the training aligner" why="Add the courier and tracking number.">
          <div className="grid-2">
            <Field label="Carrier">
              <input
                value={shipment.carrier}
                onChange={(e) => setShipment({ ...shipment, carrier: e.target.value })}
              />
            </Field>
            <Field label="Tracking number">
              <input
                value={shipment.tracking_number}
                onChange={(e) => setShipment({ ...shipment, tracking_number: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Tracking URL">
            <input
              value={shipment.tracking_url}
              onChange={(e) => setShipment({ ...shipment, tracking_url: e.target.value })}
            />
          </Field>
          <ErrorText error={shipTraining.error} />
          <button
            type="button"
            className="btn-primary"
            disabled={shipTraining.isPending}
            onClick={() => shipTraining.mutate()}
          >
            Mark shipped
          </button>
        </ActionPanel>
      );

    case "PRODUCT_FABRICATION":
      return (
        <ActionPanel
          title={`Make the ${order.product_label || "appliance"}`}
          why="Nothing to plan — this is made from the scan as it stands. It ships once the clinic has paid for it."
        >
          <div className="grid-2">
            <Field label="Carrier">
              <input
                value={shipment.carrier}
                onChange={(e) => setShipment({ ...shipment, carrier: e.target.value })}
              />
            </Field>
            <Field label="Tracking number">
              <input
                value={shipment.tracking_number}
                onChange={(e) => setShipment({ ...shipment, tracking_number: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Tracking URL">
            <input
              value={shipment.tracking_url}
              onChange={(e) => setShipment({ ...shipment, tracking_url: e.target.value })}
            />
          </Field>
          <ErrorText error={shipProduct.error} />
          <button
            type="button"
            className="btn-primary"
            disabled={shipProduct.isPending}
            onClick={() => shipProduct.mutate()}
          >
            Mark shipped
          </button>
        </ActionPanel>
      );

    case "PHASE_REVIEW":
      return (
        <ActionPanel
          title="Review the progress photographs"
          why="The clinic has sent six views of the phase it just finished — upper, lower and frontal, with the aligners in and out. Compare them against the step the plan expected before committing the next batch."
        >
          <p className="dim">
            They are in this step. If the teeth are
            tracking, the next phase goes to the bench. If they are not, the case needs a fresh
            scan — the treatment plan is not reopened; the remaining aligners are simply rebuilt
            against where the teeth actually are, and a training aligner confirms the new fit
            before the phases carry on.
          </p>
          <StepFiles
            order={order}
            categories={["PROGRESS_PHOTO"]}
            title={`Progress photographs · round ${order.progress_round || 1}`}
          />
          <Field label="Notes for the clinic (required to ask for a new scan)">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What the photographs show — which teeth are behind, and by how much."
            />
          </Field>
          <ErrorText error={reviewPhase.error} />
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={reviewPhase.isPending}
              onClick={() => reviewPhase.mutate("CONTINUE")}
            >
              Tracking — make phase {order.next_phase_number}
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={reviewPhase.isPending || !note.trim()}
              onClick={() => reviewPhase.mutate("RESCAN")}
            >
              Not tracking — ask for a new scan
            </button>
          </div>
        </ActionPanel>
      );

    case "ALIGNER_PRODUCTION":
    case "DISPATCHING":
      // A by-product and a box of accessories went out in one parcel. They
      // have no dispatch mode, so this arm used to fall through to the phased
      // copy and offer to ship "phase 1 of a plan with 0 steps".
      if (order.kind !== "ALIGNER") {
        const outstanding = order.shipments.filter((s) => s.status !== "DELIVERED");
        return (
          <ActionPanel
            title="On its way"
            why={
              outstanding.length > 0
                ? "One parcel, already dispatched. The order completes itself the moment it is marked delivered."
                : "Everything has been delivered."
            }
          >
            {outstanding.length === 0 ? (
              <Banner tone="ok">
                Delivered. This order is finished — nothing further to ship.
              </Banner>
            ) : (
              <p className="dim">
                Waiting on delivery of{" "}
                {outstanding.length === 1 ? "the parcel" : `${outstanding.length} parcels`}. Mark
                it delivered here, or the clinic can confirm receipt themselves.
              </p>
            )}
            <Parcels order={order} onDeliver={onDeliver} />
            <ErrorText error={complete.error} />
            {order.status === "DISPATCHING" && (
              <button
                type="button"
                className="btn-dark"
                disabled={complete.isPending || outstanding.length > 0}
                onClick={() => complete.mutate()}
              >
                Close the order
              </button>
            )}
          </ActionPanel>
        );
      }
      return (
        <ActionPanel
          title={order.dispatch_mode === "FULL" ? "Dispatch the full case" : "Dispatch a phase"}
          why={
            order.dispatch_mode === "FULL"
              ? "The doctor chose one shipment for the whole series."
              : "The doctor chose phase-wise dispatch. Add one shipment per batch."
          }
        >
          {order.phases_divided && <PhaseTracker order={order} />}
          {order.phase_blocker ? (
            <Banner tone="warn">{order.phase_blocker}</Banner>
          ) : (
            order.dispatch_mode !== "FULL" && (
              <>
                <p className="dim">
                  <b>
                    Phase {order.next_phase_number}
                    {order.next_phase_round > 1 ? ` · round ${order.next_phase_round}` : ""}
                  </b>{" "}
                  starts at aligner <b>{order.next_phase_from}</b>.
                  {order.next_phase_round > 1 &&
                    " This is a remake, so it covers the same aligners as before."}
                </p>

                {plannedPhase ? (
                  // The clinic already said how many phases it wanted, so the
                  // span is settled — the lab confirms it rather than works it
                  // out again for every batch.
                  <div className="price-callout">
                    The clinic asked for <b>{order.phase_count} phase(s)</b>. This one
                    carries <b>aligners {plannedPhase.from_step}–{plannedPhase.to_step}</b>
                    {plannedPhase.upper_from !== null && (
                      <> · upper {plannedPhase.upper_from}–{plannedPhase.upper_to}</>
                    )}
                    {plannedPhase.lower_from !== null ? (
                      <> · lower {plannedPhase.lower_from}–{plannedPhase.lower_to}</>
                    ) : (
                      <> · the lower arch has already finished</>
                    )}
                    .
                  </div>
                ) : (
                  <p className="dim">
                    No phase count was recorded for this case, so set how far this batch
                    runs. The plan has {order.aligner_steps} steps in total.
                  </p>
                )}

                <Field
                  label={
                    plannedPhase
                      ? `Runs to aligner (planned ${plannedPhase.to_step})`
                      : `Runs to aligner (max ${order.next_phase_max})`
                  }
                >
                  <input
                    type="number"
                    min={order.next_phase_from}
                    max={order.next_phase_max}
                    value={shipment.aligner_range_to}
                    onChange={(e) => setShipment({ ...shipment, aligner_range_to: e.target.value })}
                  />
                </Field>
              </>
            )
          )}

          <div className="grid-2">
            <Field label="Carrier">
              <input
                value={shipment.carrier}
                onChange={(e) => setShipment({ ...shipment, carrier: e.target.value })}
              />
            </Field>
            <Field label="Tracking number">
              <input
                value={shipment.tracking_number}
                onChange={(e) => setShipment({ ...shipment, tracking_number: e.target.value })}
              />
            </Field>
          </div>
          <ErrorText error={shipAligners.error ?? complete.error} />
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={
                shipAligners.isPending ||
                !!order.phase_blocker ||
                (order.dispatch_mode !== "FULL" && !shipment.aligner_range_to)
              }
              onClick={() => shipAligners.mutate()}
            >
              {order.dispatch_mode === "FULL"
                ? "Dispatch the case"
                : `Ship phase ${order.next_phase_number}${
                    order.next_phase_round > 1 ? ` round ${order.next_phase_round}` : ""
                  }`}
            </button>
            {order.status === "DISPATCHING" && (
              <button
                type="button"
                className="btn-dark"
                disabled={complete.isPending}
                onClick={() => complete.mutate()}
              >
                Complete case
              </button>
            )}
          </div>
        </ActionPanel>
      );

    case "RECORDS_REQUESTED":
      return (
        <>
          <Waiting>Waiting on the doctor to supply better records.</Waiting>
          {order.records_request_note && (
            <p className="ws-step-say">You asked for: {order.records_request_note}</p>
          )}
        </>
      );
    case "PLAN_SHARED":
      /* What they are deciding about, on the screen that says they are
         deciding — the lab is usually looking this up to answer a phone call
         about it. */
      return (
        <>
          <Waiting>Waiting on the doctor to approve the treatment plan.</Waiting>
          {order.plans.length > 0 && (
            <div className="ws-stage-fold">
              <PlanCard order={order} open />
            </div>
          )}
        </>
      );
    case "TRAINING_ALIGNER_SHIPPED":
      return (
        <>
          <Waiting>
            In transit. The clinic confirms the fit once it arrives — mark it delivered here if the
            courier says so first.
          </Waiting>
          <Parcels order={order} onDeliver={onDeliver} />
        </>
      );
    case "FIT_REVIEW":
      return <Waiting>Waiting on the doctor to confirm the fit and pick a dispatch mode.</Waiting>;
    case "COMPLETED":
      return <Banner tone="ok">Case complete.</Banner>;
    case "CANCELLED":
      return <Banner tone="danger">Cancelled. {order.cancel_reason}</Banner>;
    default:
      return <Waiting>Nothing to do right now.</Waiting>;
  }
}
