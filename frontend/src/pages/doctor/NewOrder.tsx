/* Starting an aligner case, by whichever of the two doors the clinic wants.
 *
 * A clinic weighing up whether to treat needs the estimate first: photographs,
 * a band, a figure to accept, and only then a scan. A clinic with the patient
 * in the chair and the scan already taken needs none of that — asking it for a
 * five-view photo series before it may hand over a scan is a queue with
 * nothing at the end of it.
 *
 * So the first question is which door, and the steps after it differ: the
 * direct door has no records step, because nothing is gathered before the scan.
 * Both create the case the same way and meet on the case page, where the scan
 * is uploaded exactly as it always was.
 *
 * The draft is created on the server once the clinical detail is in, so uploads
 * have an order to attach to; from there it is resumable from the case list. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { api } from "../../api";
import type { AlignerIntake, OrderDetail } from "../../api";
import FileExplorer from "../../components/FileExplorer";
import { Banner, ErrorText, Field, Loading } from "../../components/ui";

type StepName = "start" | "patient" | "clinical" | "records" | "shipping";

const STEP_LABEL: Record<StepName, string> = {
  start: "Start",
  patient: "Patient",
  clinical: "Clinical",
  records: "Records",
  shipping: "Shipping",
};

/** A case that came in with its scan gathers nothing beforehand, so it has no
    records step to show. Named rather than numbered: the two routes have
    different lengths, and index arithmetic over that is how a Back button
    ends up on the wrong screen. */
function stepsFor(intake: AlignerIntake): StepName[] {
  return intake === "SCAN_DIRECT"
    ? ["start", "patient", "clinical", "shipping"]
    : ["start", "patient", "clinical", "records", "shipping"];
}

export default function NewOrder() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [intake, setIntake] = useState<AlignerIntake>("QUOTE_FIRST");
  const [step, setStep] = useState<StepName>("start");
  const [draft, setDraft] = useState<OrderDetail | null>(null);

  const steps = stepsFor(intake);
  const stepAt = steps.indexOf(step);
  const go = (delta: number) => setStep(steps[Math.min(Math.max(stepAt + delta, 0), steps.length - 1)]);
  const direct = intake === "SCAN_DIRECT";

  // A picker, not a browse list — take a generous slice rather than paging.
  const patients = useQuery({
    queryKey: ["patients", "picker"],
    queryFn: () => api.patients({ limit: 200 }),
  });
  const addresses = useQuery({ queryKey: ["addresses"], queryFn: api.addresses });

  // Arriving from a patient's panel with ?patient=<id> starts the case
  // for them rather than making the clinic find them again in the picker.
  const [params] = useSearchParams();
  const [patientId, setPatientId] = useState(() => params.get("patient") ?? "");
  const [newPatient, setNewPatient] = useState({
    first_name: "",
    last_name: "",
    date_of_birth: "",
    sex: "",
  });
  const [arch, setArch] = useState<"UPPER" | "LOWER" | "BOTH">("BOTH");
  const [priority, setPriority] = useState<"STANDARD" | "EXPRESS">("STANDARD");
  const [chiefComplaint, setChiefComplaint] = useState("");
  const [clinicalNotes, setClinicalNotes] = useState("");
  const [addressId, setAddressId] = useState("");
  // The direct route creates the case with this address, so it cannot start
  // empty — the select would show the first branch while sending nothing.
  const defaultAddressId =
    addresses.data?.find((a) => a.is_default_shipping)?.id ?? addresses.data?.[0]?.id ?? "";
  const chosenAddressId = addressId || defaultAddressId;

  const createDraft = useMutation({
    mutationFn: () =>
      api.createOrder({
        patient_id: patientId || null,
        new_patient: patientId ? null : newPatient,
        intake,
        arch,
        priority,
        chief_complaint: chiefComplaint,
        clinical_notes: clinicalNotes,
        // A direct case starts the moment it is placed, so the branch has to
        // be settled before that rather than patched on afterwards.
        shipping_address_id: chosenAddressId || null,
      }),
    onSuccess: (order) => {
      setDraft(order);
      setAddressId(order.shipping_address?.id ?? "");
      setStep("records");
    },
  });

  /* The direct route has nothing to gather, so the case is not created until
     the clinic has finished choosing — and creating it is what starts it. The
     quoted route still creates a draft early, because its records need an
     order to attach to. */
  const placeDirect = useMutation({
    mutationFn: () => createDraft.mutateAsync(),
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      navigate(`/orders/${order.id}`);
    },
  });

  const saveShipping = useMutation({
    mutationFn: () => api.updateOrder(draft!.id, { shipping_address_id: addressId }),
    onSuccess: (order) => setDraft(order),
  });

  const submit = useMutation({
    mutationFn: async () => {
      if (addressId && addressId !== draft?.shipping_address?.id) {
        await api.updateOrder(draft!.id, { shipping_address_id: addressId });
      }
      return api.submitOrder(draft!.id);
    },
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      navigate(`/orders/${order.id}`);
    },
  });

  const refreshDraft = async () => {
    if (draft) setDraft(await api.order(draft.id));
  };

  if (patients.isLoading || addresses.isLoading) return <Loading />;

  const patientReady = patientId !== "" || newPatient.first_name.trim() !== "";
  const blockers = draft?.submit_blockers ?? [];
  // Before the case exists there is no patient record to read the name off, so
  // the review shows what was chosen or typed.
  const reviewPatientName =
    patients.data?.find((p) => p.id === patientId)?.full_name ??
    [newPatient.first_name, newPatient.last_name].filter(Boolean).join(" ");

  return (
    <main className="page page-narrow">
      <div className="page-head">
        <div>
          <h1>New aligner case</h1>
          <p className="sub">
            {draft ? (
              <>
                Draft <span className="mono">{draft.order_number}</span> — saved automatically.
              </>
            ) : direct ? (
              "Your scan is all 3D Align needs to start."
            ) : (
              "Records are needed before the lab can quote."
            )}
          </p>
        </div>
      </div>

      <div className="steps">
        {steps.map((name, index) => (
          <span
            key={name}
            className={`step${index === stepAt ? " on" : index < stepAt ? " done" : ""}`}
          >
            {index + 1}. {STEP_LABEL[name]}
          </span>
        ))}
      </div>

      {step === "start" && (
        <div className="card stack-sm">
          <h2>How would you like to start?</h2>
          <p className="muted" style={{ fontSize: "0.9rem", marginTop: -4 }}>
            Both routes end in the same treatment. The difference is only whether you
            want a price before you scan.
          </p>

          <div className="intake-choice">
            {(
              [
                {
                  value: "QUOTE_FIRST" as const,
                  title: "I need an expected quote",
                  blurb:
                    "Send photographs and an OPG. 3D Align reads them, picks the aligner band and sends a price. You scan once you have accepted it.",
                  needs: "Photographs and OPG now, scan later",
                },
                {
                  value: "SCAN_DIRECT" as const,
                  title: "I already have the scan",
                  blurb:
                    "Go straight to the intraoral scan. Nothing else is asked for, and the price is confirmed with the treatment plan.",
                  needs: "Intraoral scan only",
                },
              ]
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                className={`intake-card${intake === option.value ? " on" : ""}`}
                aria-pressed={intake === option.value}
                onClick={() => setIntake(option.value)}
              >
                <b>{option.title}</b>
                <span className="intake-blurb">{option.blurb}</span>
                <span className="intake-needs">{option.needs}</span>
              </button>
            ))}
          </div>

          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" className="btn-primary" onClick={() => setStep("patient")}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "patient" && (
        <div className="card stack-sm">
          <h2>Patient</h2>
          {patients.data && patients.data.length > 0 && (
            <Field label="Existing patient">
              <select
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
              >
                <option value="">Add a new patient</option>
                {patients.data.map((patient) => (
                  <option key={patient.id} value={patient.id}>
                    {patient.full_name}
                    {patient.patient_number ? ` · ${patient.patient_number}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {!patientId && (
            <>
              {/* Two fields, not one. A single box got "riya" from one clinic
                  and "Mehta, Riya J." from the next, and neither sorted nor
                  matched the other. */}
              <div className="grid-2">
                <Field label="First name">
                  <input
                    value={newPatient.first_name}
                    onChange={(e) =>
                      setNewPatient({ ...newPatient, first_name: e.target.value })
                    }
                  />
                </Field>
                <Field label="Last name">
                  <input
                    value={newPatient.last_name}
                    onChange={(e) =>
                      setNewPatient({ ...newPatient, last_name: e.target.value })
                    }
                  />
                </Field>
              </div>
              {/* The same name already on file: offered back before a second
                  record is made. Still allowed — two people can share a name,
                  and each gets their own number. */}
              {(() => {
                const typed = [newPatient.first_name.trim(), newPatient.last_name.trim()]
                  .filter(Boolean)
                  .join(" ")
                  .toLowerCase();
                const same =
                  typed.length > 1
                    ? (patients.data ?? []).filter((p) => p.full_name.toLowerCase() === typed)
                    : [];
                if (same.length === 0) return null;
                return (
                  <Banner tone="warn">
                    <div>
                      <b>Already on file:</b>{" "}
                      {same.map((p, i) => (
                        <span key={p.id}>
                          {i > 0 && ", "}
                          <button type="button" className="btn-link" onClick={() => setPatientId(p.id)}>
                            {p.full_name} · {p.patient_number || "no number yet"}
                          </button>
                        </span>
                      ))}
                      . Choose them to continue their record, or carry on if this is someone new.
                    </div>
                  </Banner>
                );
              })()}
              <div className="grid-2">
                <Field label="Date of birth">
                  <input
                    type="date"
                    value={newPatient.date_of_birth}
                    onChange={(e) =>
                      setNewPatient({ ...newPatient, date_of_birth: e.target.value })
                    }
                  />
                </Field>
                <Field label="Sex">
                  <select
                    value={newPatient.sex}
                    onChange={(e) => setNewPatient({ ...newPatient, sex: e.target.value })}
                  >
                    <option value="">Not stated</option>
                    <option value="F">Female</option>
                    <option value="M">Male</option>
                    <option value="OTHER">Other</option>
                  </select>
                </Field>
              </div>
            </>
          )}

          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" className="btn-ghost" onClick={() => setStep("start")}>
              Back
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!patientReady}
              onClick={() => setStep("clinical")}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "clinical" && (
        <div className="card stack-sm">
          <h2>Clinical detail</h2>
          <div className="grid-2">
            <Field label="Arches">
              <select value={arch} onChange={(e) => setArch(e.target.value as typeof arch)}>
                <option value="BOTH">Both arches</option>
                <option value="UPPER">Upper only</option>
                <option value="LOWER">Lower only</option>
              </select>
            </Field>
            <Field label="Priority">
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as typeof priority)}
              >
                <option value="STANDARD">Standard</option>
                <option value="EXPRESS">Express</option>
              </select>
            </Field>
          </div>
          <Field label="Chief complaint">
            <textarea
              value={chiefComplaint}
              onChange={(e) => setChiefComplaint(e.target.value)}
              placeholder="What the patient wants corrected."
            />
          </Field>
          <Field label="Clinical notes for the lab">
            <textarea
              value={clinicalNotes}
              onChange={(e) => setClinicalNotes(e.target.value)}
              placeholder="Restorations, extractions planned, periodontal status, anything the lab should know."
            />
          </Field>
          <ErrorText error={createDraft.error} />
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" className="btn-ghost" onClick={() => setStep("patient")}>
              Back
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={createDraft.isPending}
              onClick={() => (direct ? setStep("shipping") : createDraft.mutate())}
            >
              {createDraft.isPending ? "Saving…" : direct ? "Continue" : "Save and continue"}
            </button>
          </div>
        </div>
      )}

      {step === "records" && draft && (
        <div className="stack">
          <div className="card stack-sm">
            <h2>Records</h2>
            <p className="muted" style={{ fontSize: "0.9rem" }}>
              Intraoral and extraoral photographs and an OPG are required. Add a lateral
              cephalogram or CBCT if your case needs one.
            </p>
            {blockers.length > 0 && (
              <Banner tone="warn">
                <div>
                  <b>Still needed</b>
                  <ul style={{ margin: "6px 0 0", paddingLeft: "1.1em" }}>
                    {blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              </Banner>
            )}
          </div>

          <div className="card">
            <FileExplorer order={draft} onChanged={refreshDraft} />
          </div>

          <div className="row">
            <button type="button" className="btn-ghost" onClick={() => setStep("clinical")}>
              Back
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={blockers.length > 0}
              onClick={() => setStep("shipping")}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "shipping" && (draft || direct) && (
        <div className="stack">
          <div className="card stack-sm">
            <h2>Shipping</h2>
            <p className="muted" style={{ fontSize: "0.9rem" }}>
              Aligners and the training aligner ship to this address.
            </p>
            {direct && (
              <Banner tone="ok">
                Placing this case opens it straight at the scan stage. Nothing else is
                asked for, and 3D Align confirms the price with the treatment plan
                rather than an estimate beforehand.
              </Banner>
            )}
            <Field label="Deliver to">
              <select
                value={chosenAddressId}
                onChange={(e) => {
                  setAddressId(e.target.value);
                  // Nothing exists to save against yet on the direct route —
                  // the case is created with this address a moment later.
                  if (draft) saveShipping.mutate();
                }}
              >
                {addresses.data?.map((address) => (
                  <option key={address.id} value={address.id}>
                    {address.label} — {address.line1}, {address.city} {address.pincode}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="card">
            <h4 style={{ marginBottom: 10 }}>Review</h4>
            <dl className="kv">
              {draft && (
                <>
                  <dt>Case</dt>
                  <dd className="mono">{draft.order_number}</dd>
                </>
              )}
              <dt>Patient</dt>
              <dd>{draft ? draft.patient_name : reviewPatientName}</dd>
              <dt>Arches</dt>
              <dd>{arch === "BOTH" ? "Both" : arch}</dd>
              <dt>Priority</dt>
              <dd>{priority === "EXPRESS" ? "Express" : "Standard"}</dd>
              <dt>Started with</dt>
              <dd>{direct ? "Your own intraoral scan" : "Photographs for an expected quote"}</dd>
              {!direct && draft && (
                <>
                  <dt>Files</dt>
                  <dd className="num">{draft.files.length}</dd>
                </>
              )}
            </dl>
          </div>

          <ErrorText error={direct ? placeDirect.error : submit.error} />
          <div className="row">
            <button type="button" className="btn-ghost" onClick={() => go(-1)}>
              Back
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={
                (direct ? placeDirect.isPending : submit.isPending) || !chosenAddressId
              }
              onClick={() => (direct ? placeDirect.mutate() : submit.mutate())}
            >
              {direct
                ? placeDirect.isPending
                  ? "Placing…"
                  : "Place case and add the scan"
                : submit.isPending
                  ? "Submitting…"
                  : "Submit to 3D Align"}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
