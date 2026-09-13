/* The case workspace.
 *
 * Where a doctor spends the working day, so it is built around the one
 * question they open a case to answer: what happens next, and is it me?
 *
 * The page used to be every part of the case at once — an action panel, a
 * records cabinet with eight folds open, a price table, payments in a column
 * on the right and the history under them — and a doctor read all of it to
 * find the one thing being asked. Now it is four layers, each quieter than the
 * one above:
 *
 *   1. who and what — the patient, the treatment, the stage;
 *   2. the journey — where the case has been, and when;
 *   3. now — the single thing that happens next, with everything needed to do
 *      it inside it (the upload slots it wants, the payment it waits on);
 *   4. the file — overview, records, payments and history, one at a time.
 *
 * Beside "now" sits a column of four figures that answer the side questions
 * — owed anything? records complete? how many aligners? where is the parcel?
 * — and each opens the tab that holds the detail.
 *
 * Every action, rule and request is unchanged; only where things live is new.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import AddressChooser from "../../components/AddressChooser";
import PaymentPanel, { PaymentRow } from "../../components/PaymentPanel";
import PhaseTracker from "../../components/PhaseTracker";
import FitIssueThread from "../../components/FitIssueThread";
import { api, formatDate, formatMoney, formatRange, since } from "../../api";
import type { FileCategory, OrderDetail as Order, Slot } from "../../api";
import { completedCopy, stageIndex, stagesFor, waitingCopyFor } from "../../workflow";
import FileUploader from "../../components/FileUploader";
import FileExplorer from "../../components/FileExplorer";
import Reveal from "../../components/Reveal";
import { useToast } from "../../components/Toast";
import StageBrowser from "../../components/StageBrowser";
import Journey from "../../components/Journey";
import SlotCalendar from "../../components/SlotCalendar";
import {
  ActionPanel,
  CaseSummary,
  SimulationCard,
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
  ConfirmButton,
  ErrorText,
  Field,
  Loading,
  StatusPill,
} from "../../components/ui";

type Tab = "overview" | "records" | "delivery" | "payments" | "history";

const RECORD_CATEGORIES: FileCategory[] = ["RECORD_PHOTO", "OPG", "LATERAL_CEPH", "CBCT", "OTHER"];

function archLabel(arch: Order["arch"]): string {
  return arch === "BOTH" ? "Both arches" : arch === "UPPER" ? "Upper arch" : "Lower arch";
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** What the clinic owes on this case, split the way it is acted on. */
function moneyOf(order: Order) {
  const due = order.payments.filter((p) => p.status !== "VERIFIED" && p.status !== "SUBMITTED");
  const checking = order.payments.filter((p) => p.status === "SUBMITTED");
  const paid = order.payments.filter((p) => p.status === "VERIFIED");
  const sum = (list: typeof due) => list.reduce((n, p) => n + Number(p.total), 0);
  return { due, checking, paid, dueTotal: sum(due), paidTotal: sum(paid) };
}

/** Views still missing from the sets the clinic can actually still change. A
    locked set's gap is not something they can do anything about, so it is not
    counted against them. */
function missingViews(order: Order): number {
  return order.record_sets
    .filter((s) => s.editable)
    .reduce((n, s) => {
      if (s.slots.length > 0) return n + s.missing.length;
      const onFile = s.extras.filter((f) => f.is_current).length;
      return n + (s.required && onFile === 0 ? 1 : 0);
    }, 0);
}

export default function DoctorOrderDetail() {
  const { orderId = "" } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const order = useQuery({
    queryKey: ["order", orderId],
    queryFn: () => api.order(orderId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
    void queryClient.invalidateQueries({ queryKey: ["orders"] });
    void queryClient.invalidateQueries({ queryKey: ["unread"] });
    void queryClient.invalidateQueries({ queryKey: ["payment-ledger"] });
  };

  /* Which stage is being looked at, or null for the case's own. Held here
     because the journey sets it and the "now" panel reads it: while a past
     stage is open, nothing can be done — an action against a stage the case
     has already left is not a thing that should be possible. */
  const [viewing, setViewing] = useState<number | null>(null);

  const toast = useToast();
  const confirmDelivery = useMutation({
    mutationFn: (shipmentId: string) => api.confirmDelivery(orderId, shipmentId),
    onSuccess: () => {
      invalidate();
      toast({ title: "Parcel marked received", body: "Thank you — the lab can see it arrived." });
    },
  });
  const decidePhase = useMutation({
    mutationFn: (v: {
      id: string;
      decision: "CONTINUE" | "REPEAT";
      notes: string;
      addressId: string | null;
    }) => api.decidePhase(orderId, v.id, v.decision, v.notes, v.addressId),
    onSuccess: () => {
      invalidate();
      toast({
        title: "Sent to 3D Align",
        body: "Your progress photographs are with the lab. They review them before making the next batch.",
      });
    },
  });

  if (order.isLoading) return <Loading what="case" />;
  if (order.isError || !order.data) return <div className="page">Case not found.</div>;

  const data = order.data;
  const stages = stagesFor(data.kind, data.intake);
  const liveStage = stageIndex(data.kind, data.status, data.intake);
  const lookingBack = viewing !== null && viewing !== (liveStage >= 0 ? liveStage : null);

  const openIssue = data.phase_issues.find((i) => i.status === "OPEN") ?? null;
  const money = moneyOf(data);
  const missing = data.kind === "ACCESSORY" ? 0 : missingViews(data);

  const needsYou =
    (data.needs_doctor_action && data.status !== "CANCELLED") ||
    Boolean(data.awaiting_phase_decision) ||
    (openIssue !== null && openIssue.awaiting !== "LAB");
  const tone = needsYou
    ? "you"
    : data.status === "COMPLETED"
      ? "done"
      : data.status === "CANCELLED"
        ? "stop"
        : "lab";
  const eyebrow = {
    you: "Your move",
    lab: "With 3D Align",
    done: "Complete",
    stop: "Cancelled",
  }[tone];
  const upNext = liveStage >= 0 ? stages[liveStage + 1]?.label : undefined;

  const plan = [...data.plans].reverse().find((p) => p.status !== "SUPERSEDED") ?? null;
  const quote = data.quotes[data.quotes.length - 1] ?? null;
  const delivered = data.shipments.filter((s) => s.status === "DELIVERED").length;
  const inTransit = data.shipments.length - delivered;
  const activePhase = data.phase_plan.find((p) => p.status === "ACTIVE" || p.status === "ISSUE");

  /* A fee the current stage is waiting on is asked for inside that stage, so
     it is not mentioned a second time underneath it. */
  /* While the plan stage is open, the plan is already on the screen inside
     the panel on the left. Repeating it as a fold under Overview is the same
     document twice on one page. */
  const planInStep = data.status === "PLAN_SHARED" && !data.plan_locked && data.plans.length > 0;

  const feeInStep =
    data.status === "PLAN_SHARED" && data.plan_locked
      ? "TREATMENT_PLAN"
      : data.status === "TRAINING_ALIGNER_PRODUCTION"
        ? "TRAINING_FIT"
        : null;
  const alsoDue = money.due.filter((p) => p.kind !== feeInStep);

  const tabs: { key: Tab; label: string; badge?: string; warn?: boolean }[] = [
    { key: "overview", label: "Overview" },
    ...(data.kind !== "ACCESSORY"
      ? [{ key: "records" as Tab, label: "Records", badge: missing > 0 ? `${missing} missing` : undefined, warn: missing > 0 }]
      : []),
    ...(data.payments.length > 0
      ? [
          {
            key: "payments" as Tab,
            label: "Payments",
            badge:
              money.dueTotal > 0
                ? `${formatMoney(money.dueTotal)} due`
                : money.checking.length > 0
                  ? "Being checked"
                  : undefined,
            warn: money.dueTotal > 0,
          },
        ]
      : []),
    /* Deliveries are their own part of the case, not a card buried in the
       overview: a clinic tracking a parcel should not read past a quote it
       agreed to three weeks ago to find it. */
    ...(data.shipments.length > 0 || data.phases_divided
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
        <Link to="/orders" className="ws-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M11 6l-6 6 6 6" />
          </svg>
          Cases
        </Link>
        {/* One line, not four. The case's name, its reference and its state are
            what identify it; everything else about it is detail, set small and
            kept on the same row so the work itself starts at the top of the
            screen rather than a scroll below it. */}
        <h1>{data.patient_name || "Practice stock"}</h1>
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
          {data.branch_label && <span title={data.branch_label}>{data.branch_label.split(" · ")[0]}</span>}
          {data.submitted_at && <span title={`Sent ${formatDate(data.submitted_at)}`}>Sent {shortDate(data.submitted_at)}</span>}
        </p>
        {data.has_simulation && !data.plan_locked && (
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

      {/* Looking back on a case with no payments leaves nothing for the side
          column, so the record takes the whole width rather than two thirds. */}
      <div className={lookingBack && data.payments.length === 0 ? "ws-top solo" : "ws-top"}>
        {lookingBack ? (
          /* A stage the case has left, read back: what happened in it and what
             was collected. Nothing here can be acted on. */
          <StageBrowser order={data} viewing={viewing} onView={setViewing} />
        ) : (
          <section className={`ws-now tone-${tone}`} aria-label="What happens next">
            <header className="ws-now-head">
              <span className="ws-now-eyebrow">{eyebrow}</span>
              {tone === "lab" && upNext && <span className="ws-now-next">Then: {upNext}</span>}
              {tone !== "you" && tone !== "stop" && (
                <span className="ws-now-next">Updated {since(data.updated_at)} ago</span>
              )}
            </header>

            {/* A batch that does not fit is the most urgent thing on the page,
                so it is offered before anything else the clinic might do. */}
            {openIssue ? (
              <FitIssueThread order={data} issue={openIssue} onDone={invalidate} />
            ) : (
              data.status === "DISPATCHING" &&
              data.phases_divided && <PhaseFitIssuePanel order={data} onDone={invalidate} />
            )}
            {/* A phase waiting on the clinic's decision owns the moment: the
                stage's own line would otherwise sit above it saying something
                more general about the same case, and the panel read as two
                things happening at once. */}
            {!data.awaiting_phase_decision && (
              <DoctorActions order={data} onDone={invalidate} onCancelled={() => navigate("/orders")} />
            )}
            {data.awaiting_phase_decision && (
              <PhaseDecisionPanel
                order={data}
                shipmentId={data.awaiting_phase_decision}
                pending={decidePhase.isPending}
                error={decidePhase.error}
                onDone={invalidate}
                onDecide={(decision, notes, addressId) =>
                  decidePhase.mutate({
                    id: data.awaiting_phase_decision!,
                    decision,
                    notes,
                    addressId,
                  })
                }
              />
            )}

            {/* Money owed is a second thing to do, not the first — said once,
                briefly, with the way to it. */}
            {alsoDue.length > 0 && (
              <div className="ws-now-also">
                <span>
                  <b>{alsoDue[0].label}</b> — {formatMoney(alsoDue[0].total)} to pay
                  {alsoDue.length > 1 ? `, and ${alsoDue.length - 1} more` : ""}
                </span>
                <button type="button" className="btn-link" onClick={() => showTab("payments", true)}>
                  Pay now →
                </button>
              </div>
            )}
          </section>
        )}

        <aside className="ws-glance" aria-label="At a glance">
          {data.payments.length > 0 && (
            <Glance
              label="Payments"
              tone={money.dueTotal > 0 ? "warn" : money.checking.length > 0 ? undefined : "ok"}
              value={
                money.dueTotal > 0
                  ? `${formatMoney(money.dueTotal)} due`
                  : money.checking.length > 0
                    ? "Receipt with 3D Align"
                    : "All paid"
              }
              sub={money.paidTotal > 0 ? `${formatMoney(money.paidTotal)} paid so far` : "Nothing paid yet"}
              onClick={lookingBack || tab !== "payments" ? () => showTab("payments", true) : undefined}
            />
          )}
          {data.kind !== "ACCESSORY" && !lookingBack && (
            <Glance
              label="Records"
              tone={missing > 0 ? "warn" : "ok"}
              value={missing > 0 ? `${missing} view${missing === 1 ? "" : "s"} missing` : "Complete"}
              sub={`${data.files.filter((f) => f.is_current).length} files on the case`}
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
                  ? data.kind === "PRODUCT"
                    ? data.quantity_upper || data.quantity_lower
                      ? [
                          data.quantity_upper ? `${data.quantity_upper} upper` : "",
                          data.quantity_lower ? `${data.quantity_lower} lower` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : `${data.quantity} set${data.quantity === 1 ? "" : "s"}, upper and lower`
                    : "Practice stock"
                  : plan && plan.total_aligners > 0
                    ? `${plan.aligners_upper} upper · ${plan.aligners_lower} lower`
                    : quote
                      ? quote.is_final
                        ? "Final price"
                        : "Expected price, set by the plan"
                      : "Sized when the plan is made"
              }
              onClick={() => showTab("overview", true)}
            />
          )}
          {!lookingBack && (data.shipments.length > 0 || data.phases_divided) && (
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
                inTransit > 0
                  ? data.shipments.find((s) => s.status !== "DELIVERED")?.tracking_number
                    ? `Tracking ${data.shipments.find((s) => s.status !== "DELIVERED")!.tracking_number}`
                    : "Tracking to follow"
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
        {tab === "overview" && <Overview order={data} hidePlan={planInStep} />}
        {tab === "delivery" && (
          <div className="ws-ship">
            <PhaseTracker order={data} />
            <ShipmentsCard
              order={data}
              open
              // The clinic receives the parcel, so it confirms arrival.
              onMarkDelivered={
                data.status === "COMPLETED" || data.status === "CANCELLED"
                  ? undefined
                  : (id) => confirmDelivery.mutate(id)
              }
              deliverLabel="Mark received"
            />
          </div>
        )}
        {tab === "records" && (
          <div className="ws-records">
            <FileExplorer order={data} onChanged={invalidate} />
          </div>
        )}
        {tab === "payments" && (
          <div className="ws-pay">
            <PaymentPanel order={data} />
            <InvoiceCard order={data} />
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

/** The case at rest: what is being made and for how much on the left, the
    clinical facts on the right. Deliveries have a part of their own. */
function Overview({ order, hidePlan = false }: { order: Order; hidePlan?: boolean }) {
  const nothingYet =
    !hidePlan &&
    !order.has_simulation &&
    order.shipments.length === 0 &&
    order.plans.length === 0 &&
    order.quotes.length === 0 &&
    order.accessories.length === 0 &&
    !(order.phases_divided && order.phase_plan.length > 0);

  return (
    <div className="ws-overview">
      <div className="ws-col">
        {nothingYet && (
          <p className="ws-empty">
            The price, the treatment plan and the deliveries will appear here as the case moves.
          </p>
        )}
        <SimulationCard order={order} />
        {!hidePlan && <PlanCard order={order} open />}
        <QuoteCard order={order} open={order.plans.length === 0} />
        {order.accessories.length > 0 && (
          <section className="card">
            <h4 style={{ marginBottom: 10 }}>Items</h4>
            <ul className="ws-items">
              {order.accessories.map((line) => (
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
        <CaseSummary order={order} />
      </div>
    </div>
  );
}

/** The upload slots a step is asking for, placed inside that step. Falls back
    to a plain uploader where the case has no editable set for those files. */
function Uploads({
  order,
  categories,
  onDone,
  fallback,
}: {
  order: Order;
  categories: FileCategory[];
  onDone: () => void;
  fallback?: ReactNode;
}) {
  const editable = order.record_sets.some(
    (s) => categories.includes(s.category as FileCategory) && s.editable,
  );
  if (!editable) return <>{fallback ?? null}</>;
  return <FileExplorer order={order} onChanged={onDone} only={categories} embedded />;
}

function PhaseDecisionPanel({
  order,
  shipmentId,
  pending,
  error,
  onDecide,
  onDone,
}: {
  order: Order;
  shipmentId: string;
  pending: boolean;
  error: unknown;
  onDecide: (decision: "CONTINUE" | "REPEAT", notes: string, addressId: string | null) => void;
  onDone: () => void;
}) {
  const [deliverTo, setDeliverTo] = useState<string | null>(order.shipping_address?.id ?? null);
  const phase = order.shipments.find((s) => s.id === shipmentId);
  const span =
    phase?.aligner_range_from && phase?.aligner_range_to
      ? `aligners ${phase.aligner_range_from}–${phase.aligner_range_to}`
      : "this phase";
  const isFinal = phase?.is_final_phase ?? false;
  const ready = order.progress_missing.length === 0;

  return (
    <ActionPanel
      title={
        isFinal
          ? `Final phase received — does it fit?`
          : `Phase ${phase?.phase_number ?? ""} received — what next?`
      }
      why={
        isFinal
          ? `You have confirmed ${span}, the last in the plan. Accepting closes the case.`
          : `You have confirmed ${span}. The lab reviews your progress photographs before making the next batch.`
      }
    >
      {order.phases_divided && <PhaseLine order={order} />}
      {!isFinal && (
        <>
          {/* The lab needs to see how the teeth actually moved before it makes
              the next batch, so the photographs come before the handover —
              and they are taken here, not in a section further down. */}
          <Banner tone={ready ? "ok" : "warn"}>
            {ready ? (
              <span>All six progress photographs are in — the lab can review this phase.</span>
            ) : (
              <span>
                Add the progress photographs: upper, lower and frontal, each with the aligners
                in and out. Still needed: {order.progress_missing.join(", ")}.
              </span>
            )}
          </Banner>
          <Uploads
            order={order}
            categories={["PROGRESS_PHOTO"]}
            onDone={onDone}
            fallback={<p className="dim">Add them under Records.</p>}
          />
          <AddressChooser
            value={deliverTo}
            onChange={setDeliverTo}
            title="Deliver the next phase to"
          />
        </>
      )}
      <ErrorText error={error} />
      <div className="row">
        <button
          type="button"
          className="btn-primary"
          disabled={pending || (!isFinal && !ready)}
          onClick={() => onDecide("CONTINUE", "", deliverTo)}
        >
          {isFinal
            ? "All fitting — complete the case"
            : ready
              ? "Send the photographs to the lab"
              : "Photographs needed first"}
        </button>
      </div>
    </ActionPanel>
  );
}

function DoctorActions({
  order,
  onDone,
  onCancelled,
}: {
  order: Order;
  onDone: () => void;
  onCancelled: () => void;
}) {
  const toast = useToast();
  /* Every one of these ends by changing the case, which changes the page.
     Saying what happened is how the reader knows the click landed, and what
     the case is now waiting for. */
  const settled = (title: string, body?: string) => () => {
    onDone();
    toast({ title, body });
  };
  const [revisionNotes, setRevisionNotes] = useState("");
  const [issueNotes, setIssueNotes] = useState("");
  const [dispatchMode, setDispatchMode] = useState<"FULL" | "PHASED">("PHASED");
  // Default to the fewest phases that still respects the minimum batch, since
  // fewer dispatches is the usual preference unless the clinic says otherwise.
  const [phaseCount, setPhaseCount] = useState<number>(2);
  // Confirmed at each dispatch decision, because a practice can have several
  // clinics and the right one depends on where the patient is being seen.
  const [deliverTo, setDeliverTo] = useState<string | null>(order.shipping_address?.id ?? null);
  // Where the scan is taken is a separate question from where aligners are
  // posted — a patient can be seen at a branch and the boxes go to the main site.
  const [visitTo, setVisitTo] = useState<string | null>(order.shipping_address?.id ?? null);
  const [scanRoute, setScanRoute] = useState<"UPLOAD" | "APPOINTMENT" | "COURIER">(
    order.scan_route ?? "UPLOAD",
  );
  const [courierTracking, setCourierTracking] = useState(order.scan_courier_tracking);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [accessNotes, setAccessNotes] = useState("");
  const [changing, setChanging] = useState(false);
  /* Moving a visit that is already booked. The lab's rule is one live visit
     per case, so the old one is given up as the new one is taken — but only
     when the clinic asks for that, never as a side effect of opening the
     calendar to look. */
  const [moving, setMoving] = useState(false);

  const liveVisit =
    order.appointment && (order.appointment.status === "ASSIGNED" || order.appointment.status === "EN_ROUTE")
      ? order.appointment
      : null;

  const submit = useMutation({
    mutationFn: () => api.submitOrder(order.id),
    onSuccess: settled("Sent to 3D Align", "The lab reads your records and comes back with a price."),
  });
  const resubmit = useMutation({
    mutationFn: () => api.resubmitRecords(order.id),
    onSuccess: settled("Records sent back", "3D Align will look at them again."),
  });
  const acceptQuote = useMutation({
    mutationFn: () => api.acceptQuote(order.id),
    onSuccess: settled("Quote accepted", "Next: send the intraoral scan, however suits the clinic."),
  });
  const approvePlan = useMutation({
    mutationFn: () =>
      api.respondToPlan(order.id, { approve: true, shipping_address_id: deliverTo }),
    onSuccess: settled("Plan approved", "3D Align starts the training aligner."),
  });
  const requestRevision = useMutation({
    mutationFn: () => api.respondToPlan(order.id, { approve: false, revision_notes: revisionNotes }),
    onSuccess: settled("Sent back for revision", "The lab has your notes and will redraw the plan."),
  });
  const confirmFit = useMutation({
    mutationFn: () =>
      api.submitFitReview(order.id, {
        fits: true,
        // Already divided: the division stands, so nothing is re-chosen.
        dispatch_mode: order.phases_divided ? null : dispatchMode,
        phase_count:
          order.phases_divided || dispatchMode !== "PHASED" ? null : phaseCount,
        shipping_address_id: deliverTo,
      }),
    onSuccess: settled("Fit confirmed", "Production of the aligner series has started."),
  });
  const reportIssue = useMutation({
    mutationFn: () => api.submitFitReview(order.id, { fits: false, issue_notes: issueNotes }),
    onSuccess: settled("Fit issue reported", "3D Align will look at it and come back to you."),
  });
  const scanSources = useQuery({
    queryKey: ["scan-sources", order.id],
    queryFn: () => api.scanSources(order.id),
    // Only worth asking while the case is actually waiting for a scan.
    enabled: order.status === "AWAITING_SCAN",
  });
  const reuseScan = useMutation({
    mutationFn: (sourceOrderId: string) => api.reuseScan(order.id, sourceOrderId),
    onSuccess: settled("Scan reused", "The lab will check it is still current before planning from it."),
  });
  const saveScanRoute = useMutation({
    mutationFn: () =>
      api.chooseScanRoute(order.id, {
        route: scanRoute,
        courier_tracking: courierTracking,
      }),
    onSuccess: settled("Tracking saved", "3D Align will confirm when the impression arrives."),
  });
  const book = useMutation({
    mutationFn: () =>
      api.bookAppointment(order.id, {
        starts_at: slot!.starts_at,
        access_notes: accessNotes,
        address_id: visitTo,
      }),
    onSuccess: (booked) => {
      setSlot(null);
      onDone();
      toast({
        title: "Scan visit booked",
        body: booked.appointment
          ? `${new Date(booked.appointment.starts_at).toLocaleString("en-IN", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false })} · ${booked.appointment.technician_name || "a technician"} will attend.`
          : "A technician will attend at the time you picked.",
      });
    },
  });
  const cancelVisit = useMutation({
    mutationFn: () => api.cancelAppointment(order.appointment!.id, "Cancelled by the clinic."),
    onSuccess: settled("Visit cancelled", "Book another time whenever it suits the clinic."),
  });
  /* A case may hold one live visit, so moving one is giving up the old time to
     take the new. Both halves are done here rather than asking the clinic to
     cancel first and then find the calendar again. */
  const reschedule = useMutation({
    mutationFn: async () => {
      await api.cancelAppointment(order.appointment!.id, "Moved by the clinic.");
      return api.bookAppointment(order.id, {
        starts_at: slot!.starts_at,
        access_notes: accessNotes,
        address_id: visitTo,
      });
    },
    onSuccess: (moved) => {
      setSlot(null);
      setMoving(false);
      onDone();
      toast({
        title: "Visit moved",
        body: moved.appointment
          ? `Now ${new Date(moved.appointment.starts_at).toLocaleString("en-IN", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false })} · ${moved.appointment.technician_name || "a technician"} will attend.`
          : "The new time is booked.",
      });
    },
  });
  const markReceived = useMutation({
    mutationFn: (shipmentId: string) => api.confirmDelivery(order.id, shipmentId),
    onSuccess: settled("Parcel marked received", "Thank you — the lab can see it arrived."),
  });
  const cancelDraft = useMutation({
    mutationFn: () => api.cancelDraft(order.id, "Cancelled by the clinic."),
    onSuccess: onCancelled,
  });

  switch (order.status) {
    case "DRAFT":
      return (
        <ActionPanel
          title="Finish and submit"
          why="This case has not reached the lab yet. Add what is missing, then send it."
        >
          {order.submit_blockers.length > 0 && (
            <Banner tone="warn">
              <div>
                <b>Still needed before you can submit</b>
                <ul style={{ margin: "6px 0 0", paddingLeft: "1.1em" }}>
                  {order.submit_blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            </Banner>
          )}
          <Uploads
            order={order}
            categories={order.intake === "SCAN_DIRECT" ? [...RECORD_CATEGORIES, "INTRAORAL_SCAN"] : RECORD_CATEGORIES}
            onDone={onDone}
            fallback={<p className="dim">Upload each view under Records.</p>}
          />
          <ErrorText error={submit.error} />
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={order.submit_blockers.length > 0 || submit.isPending}
              onClick={() => submit.mutate()}
            >
              Submit to 3D Align
            </button>
            <ConfirmButton
              label="Discard case"
              confirmLabel="Discard for good"
              onConfirm={() => cancelDraft.mutate()}
            />
          </div>
        </ActionPanel>
      );

    case "RECORDS_REQUESTED":
      return (
        <ActionPanel title="More records needed" why={order.records_request_note}>
          <Uploads
            order={order}
            categories={RECORD_CATEGORIES}
            onDone={onDone}
            fallback={
              <FileUploader
                orderId={order.id}
                categories={RECORD_CATEGORIES}
                onUploaded={onDone}
              />
            }
          />
          <ErrorText error={resubmit.error} />
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={resubmit.isPending}
              onClick={() => resubmit.mutate()}
            >
              Send back to the lab
            </button>
          </div>
        </ActionPanel>
      );

    case "QUOTED": {
      const quote = order.quotes[order.quotes.length - 1];
      return (
        <ActionPanel
          title="Quote ready"
          why="Production starts once you accept. Show the total to your patient first if you need to."
        >
          <p className="ws-figure num">{formatRange(quote.total, quote.total_max, quote.currency)}</p>
          {/* A discount the clinic is not told about is a discount they cannot
              pass on to the patient, so it is named rather than folded in. */}
          {Number(quote.discount) > 0 && (
            <p className="quote-discount">
              Includes {formatMoney(quote.discount, quote.currency)} off
              {quote.discount_reason ? ` — ${quote.discount_reason}` : ""}
            </p>
          )}
          <ErrorText error={acceptQuote.error} />
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={acceptQuote.isPending}
              onClick={() => acceptQuote.mutate()}
            >
              {acceptQuote.isPending ? "Accepting…" : "Accept quote"}
            </button>
            <span className="dim">
              The breakdown is under Overview. To discuss the price, contact the lab for a
              revised quote.
            </span>
          </div>
        </ActionPanel>
      );
    }

    case "AWAITING_SCAN":
      return (
        <ActionPanel
          title="Send the intraoral scan"
          why="Choose how the scan reaches the lab. Work starts once it arrives."
        >
          {order.records_request_note && (
            <Banner tone="warn">{order.records_request_note}</Banner>
          )}

          {/* A quiet line, because the visit is stated in full — with the two
              things that can be done about it — inside the scan-visit route
              below. Saying it twice made the panel read as two bookings. */}
          {liveVisit && scanRoute !== "APPOINTMENT" && (
            <p className="ws-aside-line">
              <span>
                <b>{liveVisit.status_label}</b> — {formatDate(liveVisit.starts_at)},{" "}
                {liveVisit.technician_name || "a technician"} attending
              </span>
              <button type="button" className="btn-link" onClick={() => setScanRoute("APPOINTMENT")}>
                Move or cancel it
              </button>
            </p>
          )}
          {order.scan_route === "COURIER" && order.scan_courier_tracking && (
            <Banner tone="ok">
              Impression couriered — tracking {order.scan_courier_tracking}. The lab will confirm
              when it arrives.
            </Banner>
          )}

          {scanSources.data && scanSources.data.length > 0 && (
            <div className="ws-reuse">
              <div>
                <b>Use a scan you have already sent</b>
                <p className="dim">
                  We still hold this patient&rsquo;s arches from an earlier case. 3D Align will
                  check the scan is still current before working from it.
                </p>
              </div>
              <ErrorText error={reuseScan.error} />
              {scanSources.data.map((source) => (
                <div key={source.order_id} className="row-between">
                  <div>
                    <span className="mono">{source.reference}</span>{" "}
                    <span className="muted">
                      — {source.status_label}, scanned {formatDate(source.taken_at)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    disabled={reuseScan.isPending}
                    onClick={() => reuseScan.mutate(source.order_id)}
                  >
                    Use this scan
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Three ways, set side by side as a choice rather than hidden in a
              menu — the one that fits the clinic's day is obvious at a glance. */}
          <div className="ws-routes" role="radiogroup" aria-label="How will you send it?">
            {(
              [
                ["UPLOAD", "Upload from my scanner", "STL files, straight into the slots"],
                ["APPOINTMENT", "Book a scan visit", "A technician comes to the clinic"],
                ["COURIER", "Courier an impression", "PVS impression, with tracking"],
              ] as const
            ).map(([value, title, sub]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={scanRoute === value}
                className={scanRoute === value ? "on" : ""}
                onClick={() => setScanRoute(value)}
              >
                <b>{title}</b>
                <span>{sub}</span>
              </button>
            ))}
          </div>

          {scanRoute === "UPLOAD" && (
            <Reveal className="ws-step">
              <p className="ws-step-say">Drop the STL files in — the case moves the moment they land.</p>
              <Uploads
                order={order}
                categories={["INTRAORAL_SCAN"]}
                onDone={onDone}
                fallback={
                  <FileUploader
                    orderId={order.id}
                    categories={["INTRAORAL_SCAN"]}
                    onUploaded={onDone}
                    hint="STL files only."
                  />
                }
              />
            </Reveal>
          )}

          {/* A visit is already booked: choosing this route again shows it,
              with the two things that can be done about it. Rendering nothing
              here is what made the route look broken once a visit existed. */}
          {scanRoute === "APPOINTMENT" && liveVisit && !moving && (
            <Reveal className="ws-booked">
              <div className="ws-booked-say">
                <b>
                  {new Date(liveVisit.starts_at).toLocaleString("en-IN", {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })}
                </b>
                <span>
                  {liveVisit.technician_name || "A technician"} will attend
                  {liveVisit.location ? ` at ${liveVisit.location}` : ""} · {liveVisit.status_label}
                </span>
              </div>
              <ErrorText error={cancelVisit.error} />
              <div className="row">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    setSlot(null);
                    setMoving(true);
                  }}
                >
                  Move to another time
                </button>
                <ConfirmButton
                  label="Cancel this visit"
                  confirmLabel="Yes, cancel it"
                  onConfirm={() => cancelVisit.mutate()}
                />
              </div>
            </Reveal>
          )}

          {scanRoute === "APPOINTMENT" && (!liveVisit || moving) && (
            <Reveal className="ws-step stack-sm">
              <p className="ws-step-say">
                {moving
                  ? "Pick the new time. The time already held is given up the moment the new one is taken."
                  : "A technician is assigned automatically, and only times somebody can actually reach this address by are offered."}
              </p>
              <AddressChooser
                value={visitTo}
                onChange={setVisitTo}
                title="Which clinic is the patient being seen at?"
              />
              <SlotCalendar selected={slot} onPick={setSlot} addressId={visitTo} />
              {slot && (
                <Reveal className="ws-confirm">
                  <Field label="Anything the technician should know">
                    <input
                      value={accessNotes}
                      onChange={(e) => setAccessNotes(e.target.value)}
                      placeholder="Parking, floor, who to ask for"
                    />
                  </Field>
                  <ErrorText error={book.error ?? reschedule.error} />
                  <div className="row">
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={book.isPending || reschedule.isPending}
                      onClick={() => (moving ? reschedule.mutate() : book.mutate())}
                    >
                      {book.isPending || reschedule.isPending
                        ? moving
                          ? "Moving…"
                          : "Booking…"
                        : `${moving ? "Move to" : "Book"} ${new Date(slot.starts_at).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`}
                    </button>
                    {moving && (
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => {
                          setMoving(false);
                          setSlot(null);
                        }}
                      >
                        Keep the time already booked
                      </button>
                    )}
                  </div>
                </Reveal>
              )}
            </Reveal>
          )}

          {scanRoute === "COURIER" && (
            <Reveal className="ws-step" focus>
              <p className="ws-step-say">
                Post the impression, then put the tracking number here so the lab can watch for it.
              </p>
              <Field label="Your courier tracking number">
                <input value={courierTracking} onChange={(e) => setCourierTracking(e.target.value)} />
              </Field>
              <ErrorText error={saveScanRoute.error} />
              <div className="row">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={saveScanRoute.isPending || !courierTracking.trim()}
                  onClick={() => saveScanRoute.mutate()}
                >
                  {saveScanRoute.isPending ? "Saving…" : "Save tracking number"}
                </button>
              </div>
            </Reveal>
          )}
        </ActionPanel>
      );

    case "PLAN_SHARED": {
      // Until the plan fee is settled there is nothing to approve — the clinic
      // has not seen the plan. So the step asks for the one thing that is
      // actually possible, and takes the payment right here.
      const planFee = order.payments.find((p) => p.kind === "TREATMENT_PLAN");
      if (order.plan_locked) {
        return (
          <ActionPanel
            title="Unlock the treatment plan"
            why={
              planFee?.status === "SUBMITTED"
                ? "Your receipt is with 3D Align. The plan opens as soon as it is confirmed."
                : "Your plan and 3D simulation are ready. They open once the plan fee is paid — charged once for the case; revisions, re-scans and refits are not charged again."
            }
          >
            {planFee?.status === "SUBMITTED" ? (
              <Banner tone="warn">
                Receipt sent{planFee.reference && ` · ${planFee.reference}`}. 3D Align is
                checking it — nothing else is needed from you.
              </Banner>
            ) : planFee ? (
              <div className="ws-inline-pay">
                <PaymentRow orderId={order.id} payment={planFee} />
              </div>
            ) : (
              <p className="dim">The plan fee will appear under Payments.</p>
            )}
          </ActionPanel>
        );
      }
      return (
        <ActionPanel
          title="Treatment plan ready"
          why="Read it here, then approve to start the training aligner — or send it back with changes."
        >
          {/* The plan is what the question is about, so it is in the question
              rather than a tab away under Overview. The frame is only drawn
              when there is a plan to put in it — an empty bordered box reads
              as something that failed to load. */}
          {order.plans.length > 0 && (
            <div className="ws-stage-fold">
              <PlanCard order={order} open />
            </div>
          )}
          <AddressChooser
            value={deliverTo}
            onChange={setDeliverTo}
            title="Deliver the training aligner to"
          />
          <ErrorText error={approvePlan.error ?? requestRevision.error} />
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={approvePlan.isPending}
              onClick={() => approvePlan.mutate()}
            >
              Approve plan
            </button>
            {!changing && (
              <button type="button" className="btn-ghost" onClick={() => setChanging(true)}>
                Request changes
              </button>
            )}
          </div>
          {/* The second answer stays folded until it is chosen, so the
              approve button is the only thing competing for attention. */}
          {changing && (
            <Reveal className="ws-alt" focus>
              <Field label="What should the lab change?">
                <textarea
                  value={revisionNotes}
                  onChange={(e) => setRevisionNotes(e.target.value)}
                  placeholder="Be as specific as you can — teeth, movements, staging."
                  autoFocus
                />
              </Field>
              <div className="row">
                <button
                  type="button"
                  className="btn-dark"
                  disabled={!revisionNotes.trim() || requestRevision.isPending}
                  onClick={() => requestRevision.mutate()}
                >
                  Send back for revision
                </button>
                <button type="button" className="btn-link" onClick={() => setChanging(false)}>
                  Cancel
                </button>
              </div>
            </Reveal>
          )}
        </ActionPanel>
      );
    }

    case "FIT_REVIEW": {
      // A case that has already been divided is not asked how to ship again.
      // The phases are fixed and the patient is part-way through them, so
      // confirming the fit simply resumes at the earliest unfinished one.
      const resuming = order.phases_divided;
      const nextPhase = order.phase_plan.find((p) => p.status !== "COMPLETED");
      return (
        <ActionPanel
          title="Confirm the training aligner fit"
          why={
            resuming
              ? "If it fits, the remaining phases carry on from where they stopped."
              : "If it fits, tell us how to ship the rest of the series."
          }
        >
          {resuming ? (
            <Banner tone="ok">
              This case is already split into {order.phase_plan.length} phases.
              {nextPhase ? (
                <>
                  {" "}
                  Confirming the fit resumes at <b>phase {nextPhase.phase}</b> (aligners{" "}
                  {nextPhase.from_step}–{nextPhase.to_step}). Phases already completed stay
                  completed.
                </>
              ) : (
                <> Every phase has already been delivered.</>
              )}
            </Banner>
          ) : (
            <>
              <div className="ws-routes" role="radiogroup" aria-label="How should the remaining aligners ship?">
                {(
                  [
                    ["PHASED", "Phase-wise", "In batches, reviewed between each"],
                    ["FULL", "Full case", "Every aligner at once"],
                  ] as const
                ).map(([value, title, sub]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={dispatchMode === value}
                    className={dispatchMode === value ? "on" : ""}
                    onClick={() => setDispatchMode(value)}
                  >
                    <b>{title}</b>
                    <span>{sub}</span>
                  </button>
                ))}
              </div>
              {dispatchMode === "PHASED" && (
                <PhaseChooser order={order} value={phaseCount} onChange={setPhaseCount} />
              )}
            </>
          )}
          <AddressChooser
            value={deliverTo}
            onChange={setDeliverTo}
            title="Deliver the aligners to"
          />
          <ErrorText error={confirmFit.error ?? reportIssue.error} />
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={confirmFit.isPending}
              onClick={() => confirmFit.mutate()}
            >
              It fits — start production
            </button>
            {!changing && (
              <button type="button" className="btn-ghost" onClick={() => setChanging(true)}>
                It does not fit
              </button>
            )}
          </div>

          {changing && (
            <Reveal className="ws-alt" focus>
              <Field label="What is wrong with the fit?">
                <textarea
                  value={issueNotes}
                  onChange={(e) => setIssueNotes(e.target.value)}
                  placeholder="Describe what is wrong with the fit."
                  autoFocus
                />
              </Field>
              <Uploads
                order={order}
                categories={["FIT_ISSUE_PHOTO"]}
                onDone={onDone}
                fallback={
                  <FileUploader
                    orderId={order.id}
                    categories={["FIT_ISSUE_PHOTO"]}
                    onUploaded={onDone}
                    hint="Photographs help the lab diagnose it faster."
                  />
                }
              />
              <div className="row">
                <button
                  type="button"
                  className="btn-danger"
                  disabled={!issueNotes.trim() || reportIssue.isPending}
                  onClick={() => reportIssue.mutate()}
                >
                  Report fit issue
                </button>
                <button type="button" className="btn-link" onClick={() => setChanging(false)}>
                  Cancel
                </button>
              </div>
            </Reveal>
          )}
        </ActionPanel>
      );
    }
    case "TRAINING_ALIGNER_PRODUCTION": {
      /* The lab will not dispatch a training aligner it has not been paid for
         — its own ship step refuses. The clinic was never told that here; the
         charge simply sat in the payments tab and the case looked stalled. */
      const fee = order.payments.find((p) => p.kind === "TRAINING_FIT");
      if (fee && fee.status !== "VERIFIED") {
        return (
          <ActionPanel
            title="Pay for the training aligner"
            why={
              fee.status === "SUBMITTED"
                ? "Your receipt is with 3D Align. The aligner ships as soon as it is confirmed."
                : "3D Align is making it now and ships it once this is paid — charged once for the case; refits and re-scans are not charged again."
            }
          >
            {fee.status === "SUBMITTED" ? (
              <Banner tone="warn">
                Receipt sent{fee.reference && ` · ${fee.reference}`}. 3D Align is checking it —
                nothing else is needed from you.
              </Banner>
            ) : (
              <div className="ws-gate">
                <div className="ws-gate-say">
                  <b>{formatMoney(fee.total)} — training fit aligner</b>
                  <span>Nothing is dispatched until this is settled.</span>
                </div>
                <PaymentRow orderId={order.id} payment={fee} />
              </div>
            )}
          </ActionPanel>
        );
      }
      return <Waiting>The training aligner is being made. It ships as soon as it is ready.</Waiting>;
    }

    case "TRAINING_ALIGNER_SHIPPED": {
      const parcel =
        [...order.shipments]
          .reverse()
          .find((s) => s.shipment_type === "TRAINING_ALIGNER" && s.status !== "DELIVERED") ?? null;
      return (
        <ActionPanel
          title="The training aligner is on its way"
          why="Mark it received when it arrives — that is what asks you to confirm the fit."
        >
          {parcel ? (
            <Parcel
              shipment={parcel}
              pending={markReceived.isPending}
              onReceived={() => markReceived.mutate(parcel.id)}
            />
          ) : (
            <p className="dim">Tracking appears here as soon as the lab adds it.</p>
          )}
          <ErrorText error={markReceived.error} />
        </ActionPanel>
      );
    }

    case "DISPATCHING": {
      const onTheWay = order.shipments.filter((s) => s.status !== "DELIVERED");
      if (onTheWay.length === 0) {
        return <Waiting>{waitingCopyFor(order.kind, order.status) ?? waitingCopy(order.status)}</Waiting>;
      }
      return (
        <ActionPanel
          title={onTheWay.length === 1 ? "A parcel is on its way" : `${onTheWay.length} parcels are on their way`}
          why="Mark each one received when it arrives, so the lab knows the case can carry on."
        >
          {/* A phased case is somewhere in a series, and which phase it is in
              decides what happens after this parcel. That belonged in the
              stage rather than a tab away. */}
          {order.phases_divided && <PhaseLine order={order} />}
          {onTheWay.map((s) => (
            <Parcel
              key={s.id}
              shipment={s}
              pending={markReceived.isPending}
              onReceived={() => markReceived.mutate(s.id)}
            />
          ))}
          <ErrorText error={markReceived.error} />
        </ActionPanel>
      );
    }

    case "CANCELLED":
      return (
        <ActionPanel title="This case was cancelled" why={order.cancel_reason || undefined}>
          <span />
        </ActionPanel>
      );

    case "COMPLETED":
      return <Waiting>{completedCopy(order.kind)}</Waiting>;

    default:
      return <Waiting>{waitingCopyFor(order.kind, order.status) ?? waitingCopy(order.status)}</Waiting>;
  }
}

/** Where the series has got to, in one line: which phase is live, what it
    carries, and how many are still to come. Reads the case's own phase plan —
    nothing here decides anything, it only says what the plan already holds. */
function PhaseLine({ order }: { order: Order }) {
  const phases = order.phase_plan;
  if (phases.length === 0) return null;
  const live = phases.find((ph) => ph.status === "ACTIVE" || ph.status === "ISSUE") ?? null;
  const done = phases.filter((ph) => ph.status === "COMPLETED").length;
  const left = phases.length - done - (live ? 1 : 0);
  return (
    <div className="ws-phases">
      <span className="ws-phases-say">
        <b>
          {live ? `Phase ${live.phase} of ${phases.length}` : `${done} of ${phases.length} phases delivered`}
          {live ? ` · aligners ${live.from_step}–${live.to_step}` : ""}
        </b>
        <span>
          {left > 0
            ? `${left} more phase${left === 1 ? "" : "s"} after this one.`
            : "This is the last phase of the series."}
        </span>
      </span>
      <span className="ws-phases-bar" aria-hidden="true">
        {phases.map((ph) => (
          <i
            key={ph.phase}
            className={ph.status === "COMPLETED" ? "done" : live && ph.phase === live.phase ? "on" : ""}
            title={`Phase ${ph.phase}: aligners ${ph.from_step}–${ph.to_step}`}
          />
        ))}
      </span>
    </div>
  );
}

/** One parcel, stated where the stage asks about it: what is in it, where it
    is, and the one thing the clinic does when it arrives. */
function Parcel({
  shipment,
  pending,
  onReceived,
}: {
  shipment: Order["shipments"][number];
  pending: boolean;
  onReceived: () => void;
}) {
  const what =
    shipment.shipment_type === "TRAINING_ALIGNER"
      ? "Training aligner"
      : shipment.shipment_type === "PRODUCT"
        ? "Your order"
        : shipment.shipment_type === "FULL_CASE"
          ? "The full series"
          : `Phase ${shipment.phase_number ?? ""}`;
  return (
    <div className="ws-parcel">
      <span className="ws-parcel-say">
        <b>
          {what}
          {shipment.aligner_range_from
            ? ` · aligners ${shipment.aligner_range_from}–${shipment.aligner_range_to}`
            : ""}
        </b>
        {shipment.tracking_number ? (
          <span>
            {shipment.carrier ? `${shipment.carrier} · ` : ""}
            <span className="mono">{shipment.tracking_number}</span>
          </span>
        ) : (
          <span>Tracking to follow.</span>
        )}
      </span>
      <span className="row">
        {shipment.tracking_url && (
          <a className="btn-ghost btn-sm" href={shipment.tracking_url} target="_blank" rel="noreferrer">
            Track it
          </a>
        )}
        <button type="button" className="btn-primary" disabled={pending} onClick={onReceived}>
          {pending ? "Saving…" : "Mark received"}
        </button>
      </span>
    </div>
  );
}

function waitingCopy(status: Order["status"]): string {
  switch (status) {
    case "SUBMITTED":
      return "Submitted. The lab will review your records shortly.";
    case "UNDER_REVIEW":
      return "3D Align is reviewing your records and preparing a quote.";
    case "SCAN_SUBMITTED":
      return "Your scan is with the lab. They will confirm it is usable and begin planning.";
    case "IN_PLANNING":
      return "Treatment planning is under way. Your plan and simulation arrive within 48 hours.";
    case "TRAINING_ALIGNER_PRODUCTION":
      return "The training aligner is being fabricated.";
    case "TRAINING_ALIGNER_SHIPPED":
      return "The training aligner is on its way. Confirm the fit once it arrives.";
    case "FIT_ISSUE":
      return "The lab is reviewing the fit issue you reported.";
    case "ALIGNER_PRODUCTION":
      return "Your aligner series is in production.";
    case "DISPATCHING":
      return "Aligners are shipping. Tracking is under Delivery as each batch goes out.";
    case "PHASE_REVIEW":
      return "The lab is reviewing your progress photographs before making the next batch.";
    case "PRODUCT_FABRICATION":
      return "Your order is with the lab.";
    default:
      return "Nothing needs your attention right now.";
  }
}

/** How many phases the clinic wants the rest of the series split into.

    The cap is the case's own: a phase carrying fewer than five aligners is not
    worth a dispatch, so a thirty-step case can be split at most six ways. What
    each phase would actually contain is shown as it is chosen, so nobody has to
    work out the ranges by hand — and the lab does not have to type them at all.
*/
function PhaseChooser({
  order,
  value,
  onChange,
}: {
  order: Order;
  value: number;
  onChange: (n: number) => void;
}) {
  const max = order.max_phases || 1;
  const chosen = Math.min(Math.max(value, 1), max);
  const steps = order.aligner_steps || 0;

  // Mirrors the split the backend will store: even phases, remainder last.
  const preview = useMemo(() => {
    if (!steps || !chosen) return [];
    const base = Math.floor(steps / chosen);
    const out: { phase: number; from: number; to: number }[] = [];
    let start = 1;
    for (let p = 1; p <= chosen; p += 1) {
      const end = p === chosen ? steps : start + base - 1;
      out.push({ phase: p, from: start, to: end });
      start = end + 1;
    }
    return out;
  }, [steps, chosen]);

  if (!steps) return null;

  return (
    <div className="phase-picker">
      <Field label={`How many phases? (up to ${max} for this case)`}>
        <select value={chosen} onChange={(e) => onChange(Number(e.target.value))}>
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n === 1 ? "1 phase — everything in one batch" : `${n} phases`}
            </option>
          ))}
        </select>
      </Field>
      <p className="dim" style={{ margin: "0 0 8px" }}>
        This case runs {steps} steps, so it can be split at most {max} way(s) while
        keeping at least 5 aligners per phase.
      </p>
      <ol className="phase-list">
        {preview.map((p) => (
          <li key={p.phase}>
            <b>Phase {p.phase}</b>
            <span className="num">
              aligners {p.from}–{p.to}
            </span>
            <span className="dim">{p.to - p.from + 1} steps</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Reporting an aligner inside the delivered phase that does not fit.
 *
 *  Distinct from the training-aligner fit review: that one asks whether the
 *  case can start at all. This interrupts a phase the patient is already
 *  wearing, so it names the arch and the aligner rather than the case, and it
 *  carries the same six views the lab reads progress from.
 *
 *  The last aligner of a phase is not offered here — at that point the phase is
 *  over, and the progress photographs sent at the end of every phase already
 *  carry it to the same reviewer.
 */
function PhaseFitIssuePanel({ order, onDone }: { order: Order; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [arch, setArch] = useState<"UPPER" | "LOWER">("UPPER");
  const [aligner, setAligner] = useState<number | "">("");
  const [notes, setNotes] = useState("");

  const phase = order.phase_plan.find((p) => p.status === "ACTIVE");
  const toast = useToast();
  const report = useMutation({
    mutationFn: () =>
      api.reportPhaseFitIssue(order.id, {
        arch,
        aligner_number: Number(aligner),
        notes,
      }),
    onSuccess: () => {
      onDone();
      toast({
        title: "Fit issue sent",
        body: "Nothing further is made until 3D Align answers it.",
      });
    },
  });

  if (!phase) return null;
  const from = arch === "UPPER" ? phase.upper_from : phase.lower_from;
  const to = arch === "UPPER" ? phase.upper_to : phase.lower_to;
  // Everything except the last aligner of the phase, which goes through the
  // end-of-phase review instead.
  const choices =
    from !== null && to !== null
      ? Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i)
      : [];

  if (!open) {
    /* A quiet line under the main message, not a second card: most phases go
       without one, and it should not compete with what the case is doing. */
    return (
      <div className="ws-aside-line">
        <span>Does an aligner in phase {phase.phase} not fit?</span>
        <button type="button" className="btn-link" onClick={() => setOpen(true)}>
          Report a fit issue
        </button>
      </div>
    );
  }

  return (
    <Reveal as="section" focus>
    <ActionPanel
      title={`Fit issue in phase ${phase.phase}`}
      why="Say which aligner, on which arch, and send the same six views as a progress set."
    >
      <div className="grid-2">
        <Field label="Arch">
          <select value={arch} onChange={(e) => { setArch(e.target.value as "UPPER" | "LOWER"); setAligner(""); }}>
            <option value="UPPER">Upper</option>
            <option value="LOWER">Lower</option>
          </select>
        </Field>
        <Field label="Aligner">
          <select value={aligner} onChange={(e) => setAligner(Number(e.target.value))}>
            <option value="">Choose…</option>
            {choices.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {choices.length === 0 && (
        <Banner tone="warn">
          This phase has no {arch.toLowerCase()} aligners before its last one.
        </Banner>
      )}
      <Field label="What is wrong with it?">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Rocks on the buccal, will not seat at the back, and so on."
        />
      </Field>
      <Uploads
        order={order}
        categories={["PHASE_FIT_PHOTO"]}
        onDone={onDone}
        fallback={
          <Banner tone={order.progress_missing.length === 0 ? "ok" : "warn"}>
            Add the six views under Records — upper, lower and frontal, with the aligners in
            and out.
          </Banner>
        }
      />
      <ErrorText error={report.error} />
      <div className="row">
        <button
          type="button"
          className="btn-primary"
          disabled={!aligner || report.isPending}
          onClick={() => report.mutate()}
        >
          Send the report
        </button>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </ActionPanel>
    </Reveal>
  );
}
