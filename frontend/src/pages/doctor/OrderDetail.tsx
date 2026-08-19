import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import AddressChooser from "../../components/AddressChooser";
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

  return (
    <main className="page">
      <OrderHeader order={data} />
      <ProgressRail order={data} />

      <div className="split">
        <div className="stack">
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
  const [notes, setNotes] = useState("");
  const [deliverTo, setDeliverTo] = useState<string | null>(order.shipping_address?.id ?? null);
  const phase = order.shipments.find((s) => s.id === shipmentId);
  const span =
    phase?.aligner_range_from && phase?.aligner_range_to
      ? `aligners ${phase.aligner_range_from}–${phase.aligner_range_to}`
      : "this phase";
  const isFinal = phase?.is_final_phase ?? false;

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
          : `You have confirmed ${span}. The lab cannot send the next batch until you answer.`
      }
    >
      {!isFinal && (
        <AddressChooser
          value={deliverTo}
          onChange={setDeliverTo}
          title="Deliver the next phase to"
        />
      )}
      <ErrorText error={error} />
      <div className="row">
        <button
          type="button"
          className="btn-primary"
          disabled={pending}
          onClick={() => onDecide("CONTINUE", notes, deliverTo)}
        >
          {isFinal
            ? "All fitting — complete the case"
            : `Start the next phase (from aligner ${order.next_phase_from})`}
        </button>
      </div>
      <Field label={`Or ask for phase ${phase?.phase_number ?? ""} again`}>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What was wrong with this batch?"
        />
      </Field>
      <p className="dim">
        The lab remakes it and ships it back as phase {phase?.phase_number ?? ""} round{" "}
        {(phase?.phase_round ?? 1) + 1}, covering the same aligners.
      </p>
      <button
        type="button"
        className="btn-ghost"
        disabled={pending || !notes.trim()}
        onClick={() => onDecide("REPEAT", notes, deliverTo)}
      >
        Remake phase {phase?.phase_number ?? ""}
      </button>
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
        dispatch_mode: dispatchMode,
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

    case "PLAN_SHARED":
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

    case "FIT_REVIEW":
      return (
        <ActionPanel
          title="Confirm the training aligner fit"
          why="If it fits, tell us how to ship the rest of the series."
        >
          <Field label="How should the remaining aligners ship?">
            <select
              value={dispatchMode}
              onChange={(e) => setDispatchMode(e.target.value as typeof dispatchMode)}
            >
              <option value="PHASED">Phase-wise, in batches</option>
              <option value="FULL">Full case, all at once</option>
            </select>
          </Field>
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
