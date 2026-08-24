import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import AddressChooser from "../../components/AddressChooser";
import PaymentPanel from "../../components/PaymentPanel";
import PhaseTracker from "../../components/PhaseTracker";
import FitIssueThread from "../../components/FitIssueThread";
import { api, formatDate, formatMoney } from "../../api";
import type { OrderDetail as Order, Slot } from "../../api";
import FileUploader from "../../components/FileUploader";
import FileExplorer from "../../components/FileExplorer";
import SlotCalendar from "../../components/SlotCalendar";
import {
  ActionPanel,
  CaseSummary,
  SimulationCard,
  InvoiceCard,
  OrderHeader,
  PlanCard,
  ProgressRail,
  QuoteCard,
  ShipmentsCard,
  Timeline,
  Waiting,
  sectionOrder,
} from "../../components/OrderView";
import type { SectionKey } from "../../components/OrderView";
import { Banner, ConfirmButton, ErrorText, Field, Loading } from "../../components/ui";

export default function DoctorOrderDetail() {
  const { orderId = "" } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const order = useQuery({
    queryKey: ["order", orderId],
    queryFn: () => api.order(orderId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
    void queryClient.invalidateQueries({ queryKey: ["orders"] });
    void queryClient.invalidateQueries({ queryKey: ["unread"] });
  };

  const confirmDelivery = useMutation({
    mutationFn: (shipmentId: string) => api.confirmDelivery(orderId, shipmentId),
    onSuccess: invalidate,
  });
  const decidePhase = useMutation({
    mutationFn: (v: {
      id: string;
      decision: "CONTINUE" | "REPEAT";
      notes: string;
      addressId: string | null;
    }) => api.decidePhase(orderId, v.id, v.decision, v.notes, v.addressId),
    onSuccess: invalidate,
  });

  if (order.isLoading) return <Loading what="case" />;
  if (order.isError || !order.data) return <div className="page">Case not found.</div>;

  const data = order.data;
  const sections = sectionOrder(data.status);

  const render = (key: SectionKey, isLive: boolean) => {
    switch (key) {
      case "quote":
        return <QuoteCard key={key} order={data} open={isLive} />;
      case "plan":
        return <PlanCard key={key} order={data} open={isLive} />;
      case "shipments":
        return (
          <ShipmentsCard
            key={key}
            order={data}
            open={isLive}
            // The clinic receives the parcel, so it confirms arrival.
            onMarkDelivered={
              data.status === "COMPLETED" || data.status === "CANCELLED"
                ? undefined
                : (id) => confirmDelivery.mutate(id)
            }
            deliverLabel="Mark received"
          />
        );
      case "invoice":
        return <InvoiceCard key={key} order={data} />;
      case "files":
        return (
          <div className="card" key={key}>
            <FileExplorer order={data} onChanged={invalidate} />
          </div>
        );
    }
  };

  const openIssue = data.phase_issues.find((i) => i.status === "OPEN") ?? null;

  return (
    <main className="page">
      <OrderHeader order={data} />
      <ProgressRail order={data} />

      <div className="split">
        <div className="stack">
          {/* A batch that does not fit is the most urgent thing on the page, so
              it is offered before anything else the clinic might do. */}
          {openIssue ? (
            <FitIssueThread order={data} issue={openIssue} onDone={invalidate} />
          ) : (
            data.status === "DISPATCHING" &&
            data.phases_divided && <PhaseFitIssuePanel order={data} onDone={invalidate} />
          )}
          <DoctorActions order={data} onDone={invalidate} onCancelled={() => navigate("/orders")} />
          {data.awaiting_phase_decision && (
            <PhaseDecisionPanel
              order={data}
              shipmentId={data.awaiting_phase_decision}
              pending={decidePhase.isPending}
              error={decidePhase.error}
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
          {sections.map((key, index) => render(key, index === 0))}
        </div>
        <div className="stack">
          <PhaseTracker order={data} />
          <PaymentPanel order={data} />
          <SimulationCard order={data} />
          <CaseSummary order={data} />
          <Timeline order={data} />
        </div>
      </div>
    </main>
  );
}

function PhaseDecisionPanel({
  order,
  shipmentId,
  pending,
  error,
  onDecide,
}: {
  order: Order;
  shipmentId: string;
  pending: boolean;
  error: unknown;
  onDecide: (decision: "CONTINUE" | "REPEAT", notes: string, addressId: string | null) => void;
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
      {!isFinal && (
        <>
          {/* The lab needs to see how the teeth actually moved before it makes
              the next batch, so the photographs come before the handover. */}
          <Banner tone={ready ? "ok" : "warn"}>
            {ready ? (
              <span>All six progress photographs are in — the lab can review this phase.</span>
            ) : (
              <span>
                Send progress photographs before the next phase: upper, lower and frontal,
                each with the aligners in and out. Add them in the{" "}
                <b>Progress photographs</b> section below. Still needed:{" "}
                {order.progress_missing.join(", ")}.
              </span>
            )}
          </Banner>
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

  const submit = useMutation({ mutationFn: () => api.submitOrder(order.id), onSuccess: onDone });
  const resubmit = useMutation({
    mutationFn: () => api.resubmitRecords(order.id),
    onSuccess: onDone,
  });
  const acceptQuote = useMutation({ mutationFn: () => api.acceptQuote(order.id), onSuccess: onDone });
  const approvePlan = useMutation({
    mutationFn: () =>
      api.respondToPlan(order.id, { approve: true, shipping_address_id: deliverTo }),
    onSuccess: onDone,
  });
  const requestRevision = useMutation({
    mutationFn: () => api.respondToPlan(order.id, { approve: false, revision_notes: revisionNotes }),
    onSuccess: onDone,
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
    onSuccess: onDone,
  });
  const reportIssue = useMutation({
    mutationFn: () => api.submitFitReview(order.id, { fits: false, issue_notes: issueNotes }),
    onSuccess: onDone,
  });
  const saveScanRoute = useMutation({
    mutationFn: () =>
      api.chooseScanRoute(order.id, {
        route: scanRoute,
        courier_tracking: courierTracking,
      }),
    onSuccess: onDone,
  });
  const book = useMutation({
    mutationFn: () =>
      api.bookAppointment(order.id, {
        starts_at: slot!.starts_at,
        access_notes: accessNotes,
        address_id: visitTo,
      }),
    onSuccess: () => {
      setSlot(null);
      onDone();
    },
  });
  const cancelVisit = useMutation({
    mutationFn: () => api.cancelAppointment(order.appointment!.id, "Cancelled by the clinic."),
    onSuccess: onDone,
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
          why="This case has not reached the lab yet."
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
          <p className="dim">Upload each view from the Records section below.</p>
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
          <FileUploader
            orderId={order.id}
            categories={["RECORD_PHOTO", "OPG", "LATERAL_CEPH", "CBCT", "OTHER"]}
            onUploaded={onDone}
          />
          <ErrorText error={resubmit.error} />
          <button
            type="button"
            className="btn-primary"
            disabled={resubmit.isPending}
            onClick={() => resubmit.mutate()}
          >
            Send back to the lab
          </button>
        </ActionPanel>
      );

    case "QUOTED": {
      const quote = order.quotes[order.quotes.length - 1];
      return (
        <ActionPanel
          title="Quote ready"
          why="Production starts once you accept. Show the total to your patient first if you need to."
        >
          <p style={{ fontSize: "1.35rem", fontWeight: 680 }} className="num">
            {formatMoney(quote.total, quote.currency)}
          </p>
          <ErrorText error={acceptQuote.error} />
          <button
            type="button"
            className="btn-primary"
            disabled={acceptQuote.isPending}
            onClick={() => acceptQuote.mutate()}
          >
            {acceptQuote.isPending ? "Accepting…" : "Accept quote"}
          </button>
          <p className="dim">
            To discuss the price, contact the lab and they will issue a revised quote.
          </p>
        </ActionPanel>
      );
    }

    case "AWAITING_SCAN":
      return (
        <ActionPanel
          title="Send the intraoral scan"
          why="Choose how the scan reaches the lab. Treatment planning starts once it arrives."
        >
          {order.records_request_note && (
            <Banner tone="warn">{order.records_request_note}</Banner>
          )}

          {order.appointment && (order.appointment.status === "ASSIGNED" || order.appointment.status === "EN_ROUTE") && (
            <div className="stack-sm">
              <Banner tone="ok">
                <div>
                  <b>{order.appointment.status_label}</b> — {formatDate(order.appointment.starts_at)}
                  <br />
                  {order.appointment.technician_name} will attend
                  {order.appointment.location ? ` at ${order.appointment.location}` : ""}.
                </div>
              </Banner>
              <ErrorText error={cancelVisit.error} />
              <div>
                <ConfirmButton
                  label="Cancel this visit"
                  confirmLabel="Yes, cancel it"
                  onConfirm={() => cancelVisit.mutate()}
                />
              </div>
            </div>
          )}
          {order.scan_route === "COURIER" && order.scan_courier_tracking && (
            <Banner tone="ok">
              Impression couriered — tracking {order.scan_courier_tracking}. The lab will confirm
              when it arrives.
            </Banner>
          )}

          <Field label="How will you send it?">
            <select value={scanRoute} onChange={(e) => setScanRoute(e.target.value as typeof scanRoute)}>
              <option value="UPLOAD">Upload an STL from my scanner</option>
              <option value="APPOINTMENT">Book a scan appointment</option>
              <option value="COURIER">Courier a PVS impression</option>
            </select>
          </Field>

          {scanRoute === "UPLOAD" && (
            <FileUploader
              orderId={order.id}
              categories={["INTRAORAL_SCAN"]}
              onUploaded={onDone}
              hint="STL files only."
            />
          )}

          {scanRoute === "APPOINTMENT" && !order.appointment?.status.match(/ASSIGNED|EN_ROUTE/) && (
            <div className="stack-sm">
              <AddressChooser
                value={visitTo}
                onChange={setVisitTo}
                title="Which clinic is the patient being seen at?"
              />
              <p className="dim">
                Pick a free slot. A technician is assigned automatically, and the times offered are
                the ones somebody can actually reach this address by.
              </p>
              <SlotCalendar selected={slot} onPick={setSlot} addressId={visitTo} />
              {slot && (
                <>
                  <Field label="Anything the technician should know">
                    <input
                      value={accessNotes}
                      onChange={(e) => setAccessNotes(e.target.value)}
                      placeholder="Parking, floor, who to ask for"
                    />
                  </Field>
                  <ErrorText error={book.error} />
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={book.isPending}
                    onClick={() => book.mutate()}
                  >
                    {book.isPending
                      ? "Booking…"
                      : `Book ${new Date(slot.starts_at).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`}
                  </button>
                </>
              )}
            </div>
          )}

          {scanRoute === "COURIER" && (
            <Field label="Your courier tracking number">
              <input value={courierTracking} onChange={(e) => setCourierTracking(e.target.value)} />
            </Field>
          )}

          <ErrorText error={saveScanRoute.error} />
          {scanRoute === "COURIER" && (
            <button
              type="button"
              className="btn-primary"
              disabled={saveScanRoute.isPending || !courierTracking.trim()}
              onClick={() => saveScanRoute.mutate()}
            >
              {saveScanRoute.isPending ? "Saving…" : "Save tracking number"}
            </button>
          )}
        </ActionPanel>
      );

    case "PLAN_SHARED": {
      // Until the plan fee is settled there is nothing to approve — the clinic
      // has not seen the plan. Offering "Approve plan" and then refusing the
      // click reads as a broken button, so the panel asks for the one thing
      // that is actually possible.
      const planFee = order.payments.find((p) => p.kind === "TREATMENT_PLAN");
      if (order.plan_locked) {
        return (
          <ActionPanel
            title="Unlock the treatment plan"
            why={
              planFee?.status === "SUBMITTED"
                ? "Your receipt is with 3D Align. The plan opens as soon as it is confirmed."
                : "Your plan and 3D simulation are ready. They open once the plan fee is paid."
            }
          >
            {planFee?.status === "REJECTED" && (
              <Banner tone="danger">{planFee.rejected_reason}</Banner>
            )}
            {planFee?.status === "SUBMITTED" ? (
              <Banner tone="warn">
                Receipt sent{planFee.reference && ` · ${planFee.reference}`}. 3D Align is
                checking it — nothing else is needed from you.
              </Banner>
            ) : (
              <>
                <p className="dim" style={{ marginBottom: 10 }}>
                  This covers the treatment plan and the 3D simulation, and is charged
                  once for the case. Revisions, re-scans and refits are not charged
                  again. Pay it in <b>Payments</b> on the right, then come back here to
                  approve the plan.
                </p>
                {planFee?.upi_link && (
                  <a className="btn-primary pay-now" href={planFee.upi_link}>
                    Pay {formatMoney(planFee.total)} now
                  </a>
                )}
              </>
            )}
          </ActionPanel>
        );
      }
      return (
        <ActionPanel
          title="Treatment plan ready"
          why="Approve to start fabrication of the training aligner, or send it back with changes."
        >
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
          </div>
          <Field label="Or request changes">
            <textarea
              value={revisionNotes}
              onChange={(e) => setRevisionNotes(e.target.value)}
              placeholder="What should the lab change?"
            />
          </Field>
          <button
            type="button"
            className="btn-ghost"
            disabled={!revisionNotes.trim() || requestRevision.isPending}
            onClick={() => requestRevision.mutate()}
          >
            Request revision
          </button>
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
              <Field label="How should the remaining aligners ship?">
                <select
                  value={dispatchMode}
                  onChange={(e) => setDispatchMode(e.target.value as typeof dispatchMode)}
                >
                  <option value="PHASED">Phase-wise, in batches</option>
                  <option value="FULL">Full case, all at once</option>
                </select>
              </Field>
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
          <button
            type="button"
            className="btn-primary"
            disabled={confirmFit.isPending}
            onClick={() => confirmFit.mutate()}
          >
            It fits — start production
          </button>

          <Field label="Or report a fit problem">
            <textarea
              value={issueNotes}
              onChange={(e) => setIssueNotes(e.target.value)}
              placeholder="Describe what is wrong with the fit."
            />
          </Field>
          <FileUploader
            orderId={order.id}
            categories={["FIT_ISSUE_PHOTO"]}
            onUploaded={onDone}
            hint="Photographs help the lab diagnose it faster."
          />
          <button
            type="button"
            className="btn-danger"
            disabled={!issueNotes.trim() || reportIssue.isPending}
            onClick={() => reportIssue.mutate()}
          >
            Report fit issue
          </button>
        </ActionPanel>
      );

    }
    case "CANCELLED":
      return <Banner tone="danger">This case was cancelled. {order.cancel_reason}</Banner>;

    case "COMPLETED":
      return <Banner tone="ok">Case complete. All aligners have been delivered.</Banner>;

    default:
      return <Waiting>{waitingCopy(order.status)}</Waiting>;
  }
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
      return "Aligners are shipping. Tracking appears above as each batch goes out.";
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
  const report = useMutation({
    mutationFn: () =>
      api.reportPhaseFitIssue(order.id, {
        arch,
        aligner_number: Number(aligner),
        notes,
      }),
    onSuccess: onDone,
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
    return (
      <div className="card row-between">
        <div>
          <h4 style={{ marginBottom: 4 }}>Does an aligner not fit?</h4>
          <p className="dim">
            Report it against the aligner it happened on and 3D Align will answer before
            the next batch is made.
          </p>
        </div>
        <button type="button" className="btn-ghost" onClick={() => setOpen(true)}>
          Report a fit issue
        </button>
      </div>
    );
  }

  return (
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
      <Banner tone={order.progress_missing.length === 0 ? "ok" : "warn"}>
        Add the six views in <b>Phase fit issue photographs</b> below — upper, lower and
        frontal, with the aligners in and out.
      </Banner>
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
  );
}
