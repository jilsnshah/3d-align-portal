import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";

import { api, formatDate, formatMoney, formatRange } from "../../api";
import type { OrderDetail as Order } from "../../api";
import FileUploader from "../../components/FileUploader";
import FileExplorer from "../../components/FileExplorer";
import {
  ActionPanel,
  CaseSummary,
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
import { Banner, Checklist, ConfirmButton, ErrorText, Field, Loading } from "../../components/ui";
import { useAuth } from "../../auth";

export default function StaffOrderDetail() {
  const { orderId = "" } = useParams();
  const queryClient = useQueryClient();
  const { me } = useAuth();
  const isTechnician = me?.role === "TECHNICIAN";

  const order = useQuery({
    queryKey: ["staff-order", orderId],
    queryFn: () => (isTechnician ? api.technicianCase(orderId) : api.staffOrder(orderId)),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["staff-order", orderId] });
    void queryClient.invalidateQueries({ queryKey: ["staff-orders"] });
    void queryClient.invalidateQueries({ queryKey: ["queue"] });
  };

  const markDelivered = useMutation({
    mutationFn: (shipmentId: string) => api.updateShipment(shipmentId, { mark_delivered: true }),
    onSuccess: invalidate,
  });

  const invoice = useMutation({
    mutationFn: () => api.generateInvoice(orderId),
    onSuccess: invalidate,
  });

  const cancel = useMutation({
    mutationFn: (reason: string) => api.cancelOrder(orderId, reason),
    onSuccess: invalidate,
  });

  if (order.isLoading) return <Loading what="case" />;
  if (order.isError || !order.data) return <div className="page">Case not found.</div>;

  const data = order.data;
  const closed = data.status === "COMPLETED" || data.status === "CANCELLED";
  const acceptedQuote = data.quotes.find((q) => q.status === "ACCEPTED");
  const billedTotal = acceptedQuote?.total;
  const planningOpen = data.status === "IN_PLANNING" || data.status === "PLAN_SHARED";
  const canInvoice =
    !data.invoice && (data.status === "DISPATCHING" || data.status === "COMPLETED");

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
            onMarkDelivered={closed ? undefined : (id) => markDelivered.mutate(id)}
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
          {isTechnician ? (
            <TechnicianPanel order={data} onDone={invalidate} />
          ) : (
            <StaffActions order={data} onDone={invalidate} />
          )}

          {sections.map((key, index) => render(key, index === 0))}

          {!isTechnician && canInvoice && (
            <div className="card">
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
            </div>
          )}

          <div className="card">
            <h4 style={{ marginBottom: 10 }}>Add a file</h4>
            <FileUploader
              orderId={data.id}
              categories={
                planningOpen
                  ? ["TREATMENT_PLAN", "SIMULATION_VIDEO", "RECORD_PHOTO", "INTRAORAL_SCAN", "OTHER"]
                  : ["RECORD_PHOTO", "INTRAORAL_SCAN", "OTHER"]
              }
              onUploaded={invalidate}
              hint={
                planningOpen
                  ? undefined
                  : "Treatment plans and simulations can only be added once the case is in planning."
              }
            />
          </div>

          {!isTechnician && !closed && (
            <div className="card">
              <h4 style={{ marginBottom: 10 }}>Cancel this case</h4>
              <ErrorText error={cancel.error} />
              <ConfirmButton
                label="Cancel case"
                confirmLabel="Yes, cancel it"
                onConfirm={() => cancel.mutate("Cancelled by the lab.")}
              />
            </div>
          )}
        </div>

        <div className="stack">
          <CaseSummary order={data} />
          <Timeline order={data} />
        </div>
      </div>
    </main>
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

function StaffActions({ order, onDone }: { order: Order; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [category, setCategory] = useState("");
  const [extras, setExtras] = useState<{ description: string; unit_price: string; quantity: number }[]>([]);
  const [tax, setTax] = useState("");
  const prices = useQuery({ queryKey: ["pricing"], queryFn: api.pricing });
  const [plan, setPlan] = useState({
    aligners_upper: "",
    aligners_lower: "",
    final_price: "",
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
    onSuccess: onDone,
  });
  const requestRecords = useMutation({
    mutationFn: () => api.requestRecords(order.id, note),
    onSuccess: () => {
      setNote("");
      onDone();
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
        tax: tax || "0",
      }),
    onSuccess: onDone,
  });
  const acceptScan = useMutation({
    mutationFn: () => api.acceptScan(order.id, note),
    onSuccess: () => {
      setNote("");
      onDone();
    },
  });
  const rejectScan = useMutation({
    mutationFn: () => api.rejectScan(order.id, note),
    onSuccess: () => {
      setNote("");
      onDone();
    },
  });
  const sharePlan = useMutation({
    mutationFn: () =>
      api.sharePlan(order.id, {
        aligners_upper: Number(plan.aligners_upper || 0),
        aligners_lower: Number(plan.aligners_lower || 0),
        final_price: plan.final_price || "0",
        final_tax: plan.final_tax || "0",
        ipr_required: plan.ipr_required,
        attachments_required: plan.attachments_required,
        summary: plan.summary,
      }),
    onSuccess: onDone,
  });
  const resolveFit = useMutation({
    mutationFn: (resolution: "rescan" | "replan" | "refabricate") =>
      api.resolveFitIssue(order.id, resolution),
    onSuccess: onDone,
  });
  const shipTraining = useMutation({
    mutationFn: () =>
      api.createShipment(order.id, {
        shipment_type: "TRAINING_ALIGNER",
        carrier: shipment.carrier,
        tracking_number: shipment.tracking_number,
        tracking_url: shipment.tracking_url,
      }),
    onSuccess: onDone,
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
    },
  });
  const complete = useMutation({
    mutationFn: () => api.completeOrder(order.id),
    onSuccess: onDone,
  });

  const chosen = prices.data?.find((p) => p.category === category);
  const extrasTotal = extras.reduce(
    (sum, item) => sum + (Number(item.unit_price) || 0) * (Number(item.quantity) || 0),
    0,
  );
  const totalLow = (Number(chosen?.price_min) || 0) + extrasTotal + (Number(tax) || 0);
  const totalHigh = (Number(chosen?.price_max) || 0) + extrasTotal + (Number(tax) || 0);

  const planTotalAligners =
    Number(plan.aligners_upper || 0) + Number(plan.aligners_lower || 0);
  const suggested = prices.data?.find(
    (p) =>
      planTotalAligners >= p.range_from &&
      (p.range_to === null ? true : planTotalAligners <= p.range_to),
  );
  const planTotal = (Number(plan.final_price) || 0) + (Number(plan.final_tax) || 0);
  const acceptedQuote = order.quotes.find((q) => q.status === "ACCEPTED");
  const quotedTotal = acceptedQuote ? Number(acceptedQuote.total) : null;

  switch (order.status) {
    case "SUBMITTED":
      return (
        <ActionPanel title="Review this submission" why="Check the records are adequate to plan from.">
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
            <Field label="Tax">
              <input type="number" value={tax} onChange={(e) => setTax(e.target.value)} />
            </Field>
            <div>
              <h4>Expected range</h4>
              <p className="num" style={{ fontSize: "1.2rem", fontWeight: 680 }}>
                {chosen ? formatRange(totalLow, totalHigh) : "—"}
              </p>
            </div>
          </div>

          <ErrorText error={sendQuote.error} />
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={sendQuote.isPending || !category}
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
          why="Upload the plan document and simulation below first, then publish."
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
                done: order.files.some((f) => f.category === "SIMULATION_VIDEO"),
                label: "Simulation video attached (optional)",
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

          <div className="card" style={{ background: "var(--paper)" }}>
            <h4 style={{ marginBottom: 8 }}>Final price</h4>
            <p className="dim" style={{ marginBottom: 10 }}>
              {planTotalAligners > 0
                ? `${planTotalAligners} aligner(s) in total.`
                : "Enter the aligner counts above."}
              {suggested && ` ${suggested.label} quotes ${formatRange(suggested.price_min, suggested.price_max)}.`}
              {" "}This replaces the expected quote once the plan is shared.
            </p>
            <div className="grid-2">
              <Field label="Final price">
                <input
                  type="number"
                  min={0}
                  value={plan.final_price}
                  placeholder={suggested ? String(Number(suggested.price_min)) : ""}
                  onChange={(e) => setPlan({ ...plan, final_price: e.target.value })}
                />
              </Field>
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
            disabled={sharePlan.isPending || planTotalAligners === 0 || !Number(plan.final_price)}
            onClick={() => sharePlan.mutate()}
          >
            Share plan with the doctor
          </button>
        </ActionPanel>
      );

    case "FIT_ISSUE":
      return (
        <ActionPanel
          title="Fit issue reported"
          why={`All three routes produce a fresh training aligner — this case moves to round ${order.fit_round + 1}.`}
        >
          {order.files
            .filter((f) => f.category === "FIT_ISSUE_PHOTO" && f.is_current)
            .length > 0 && (
            <p className="dim">The doctor attached photographs — see the files section below.</p>
          )}
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

    case "ALIGNER_PRODUCTION":
    case "DISPATCHING":
      return (
        <ActionPanel
          title={order.dispatch_mode === "FULL" ? "Dispatch the full case" : "Dispatch a phase"}
          why={
            order.dispatch_mode === "FULL"
              ? "The doctor chose one shipment for the whole series."
              : "The doctor chose phase-wise dispatch. Add one shipment per batch."
          }
        >
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
                  starts at aligner <b>{order.next_phase_from}</b> — the plan has{" "}
                  {order.total_aligners} in total. You only say how far it runs.
                  {order.next_phase_round > 1 &&
                    " This is a remake, so it covers the same aligners as before."}
                </p>
                <Field label={`Runs to aligner (max ${order.next_phase_max})`}>
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
      return <Waiting>Waiting on the doctor to supply better records.</Waiting>;
    case "PLAN_SHARED":
      return <Waiting>Waiting on the doctor to approve the treatment plan.</Waiting>;
    case "TRAINING_ALIGNER_SHIPPED":
      return <Waiting>In transit. Mark it delivered below once it arrives.</Waiting>;
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
