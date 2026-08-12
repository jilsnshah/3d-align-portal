import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { CATEGORY_LABEL, api, formatDate, formatMoney } from "../../api";
import type { OrderDetail as Order } from "../../api";
import FileUploader from "../../components/FileUploader";
import {
  ActionPanel,
  CaseSummary,
  FileList,
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
        return <ShipmentsCard key={key} order={data} open={isLive} />;
      case "invoice":
        return <InvoiceCard key={key} order={data} />;
      case "files":
        return (
          <FileList
            key={key}
            order={data}
            open={isLive}
            canDelete={data.status === "DRAFT" || data.status === "RECORDS_REQUESTED"}
            onDeleted={invalidate}
          />
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
          {sections.map((key, index) => render(key, index === 0))}
        </div>
        <div className="stack">
          <CaseSummary order={data} />
          <Timeline order={data} />
        </div>
      </div>
    </main>
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
  const [scanRoute, setScanRoute] = useState<"UPLOAD" | "APPOINTMENT" | "COURIER">(
    order.scan_route ?? "UPLOAD",
  );
  const [courierTracking, setCourierTracking] = useState(order.scan_courier_tracking);
  const [scheduledAt, setScheduledAt] = useState("");
  const [location, setLocation] = useState("");

  const submit = useMutation({ mutationFn: () => api.submitOrder(order.id), onSuccess: onDone });
  const resubmit = useMutation({
    mutationFn: () => api.resubmitRecords(order.id),
    onSuccess: onDone,
  });
  const acceptQuote = useMutation({ mutationFn: () => api.acceptQuote(order.id), onSuccess: onDone });
  const approvePlan = useMutation({
    mutationFn: () => api.respondToPlan(order.id, { approve: true }),
    onSuccess: onDone,
  });
  const requestRevision = useMutation({
    mutationFn: () => api.respondToPlan(order.id, { approve: false, revision_notes: revisionNotes }),
    onSuccess: onDone,
  });
  const confirmFit = useMutation({
    mutationFn: () => api.submitFitReview(order.id, { fits: true, dispatch_mode: dispatchMode }),
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
        scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        location,
      }),
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
          {order.missing_categories.length > 0 && (
            <Banner tone="warn">
              Still required:{" "}
              {order.missing_categories.map((c) => CATEGORY_LABEL[c]).join(", ")}
            </Banner>
          )}
          <FileUploader
            orderId={order.id}
            categories={["RECORD_PHOTO", "OPG", "LATERAL_CEPH", "CBCT", "OTHER"]}
            onUploaded={onDone}
          />
          <ErrorText error={submit.error} />
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={order.missing_categories.length > 0 || submit.isPending}
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

          {order.appointment && order.appointment.status === "BOOKED" && (
            <Banner tone="ok">
              Scan appointment booked for {formatDate(order.appointment.scheduled_at)}
              {order.appointment.location ? ` at ${order.appointment.location}` : ""}. 3D Align will
              confirm once the scan has been taken. Pick a new slot below to change it.
            </Banner>
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

          {scanRoute === "APPOINTMENT" && (
            <>
              <Field label="Preferred date and time">
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
              </Field>
              <Field label="Where">
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Clinic address or landmark"
                />
              </Field>
            </>
          )}

          {scanRoute === "COURIER" && (
            <Field label="Your courier tracking number">
              <input value={courierTracking} onChange={(e) => setCourierTracking(e.target.value)} />
            </Field>
          )}

          <ErrorText error={saveScanRoute.error} />
          {scanRoute !== "UPLOAD" && (
            <button
              type="button"
              className="btn-primary"
              disabled={
                saveScanRoute.isPending ||
                (scanRoute === "APPOINTMENT" && !scheduledAt) ||
                (scanRoute === "COURIER" && !courierTracking.trim())
              }
              onClick={() => saveScanRoute.mutate()}
            >
              {saveScanRoute.isPending
                ? "Saving…"
                : scanRoute === "APPOINTMENT"
                  ? "Book this slot"
                  : "Save tracking number"}
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
