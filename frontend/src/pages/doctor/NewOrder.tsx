/* Four-step intake: patient → clinical detail → records → shipping.
   The draft is created on the server at the end of step 2 so uploads have an
   order to attach to; from there it is resumable from the case list. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../../api";
import type { OrderDetail } from "../../api";
import FileExplorer from "../../components/FileExplorer";
import ProductPicker, { totalFor } from "../../components/ProductPicker";
import type { ProductChoice } from "../../components/ProductPicker";
import { Banner, ErrorText, Field, Loading } from "../../components/ui";

const STEPS = ["Patient", "Clinical", "Records", "Shipping"];

export default function NewOrder() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<OrderDetail | null>(null);

  // A picker, not a browse list — take a generous slice rather than paging.
  const patients = useQuery({
    queryKey: ["patients", "picker"],
    queryFn: () => api.patients({ limit: 200 }),
  });
  const addresses = useQuery({ queryKey: ["addresses"], queryFn: api.addresses });
  const products = useQuery({ queryKey: ["products"], queryFn: api.products });

  const [patientId, setPatientId] = useState("");
  const [newPatient, setNewPatient] = useState({ full_name: "", date_of_birth: "", sex: "", external_ref: "" });
  const [arch, setArch] = useState<"UPPER" | "LOWER" | "BOTH">("BOTH");
  const [priority, setPriority] = useState<"STANDARD" | "EXPRESS">("STANDARD");
  const [chiefComplaint, setChiefComplaint] = useState("");
  const [clinicalNotes, setClinicalNotes] = useState("");
  const [addressId, setAddressId] = useState("");
  // Empty productId means a staged aligner series, which is the default.
  const [choice, setChoice] = useState<ProductChoice>({
    productId: "", sizeId: "", quantity: 1, extraTeeth: 0,
  });
  const isProduct = choice.productId !== "";

  const createDraft = useMutation({
    mutationFn: () =>
      api.createOrder({
        patient_id: patientId || null,
        new_patient: patientId ? null : newPatient,
        arch,
        priority,
        chief_complaint: chiefComplaint,
        clinical_notes: clinicalNotes,
        product_id: choice.productId || null,
        product_size_id: choice.sizeId || null,
        quantity: choice.quantity,
        extra_teeth: choice.extraTeeth,
      }),
    onSuccess: (order) => {
      setDraft(order);
      setAddressId(order.shipping_address?.id ?? "");
      setStep(2);
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

  const patientReady = patientId !== "" || newPatient.full_name.trim() !== "";
  const blockers = draft?.submit_blockers ?? [];

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
            ) : (
              "Records are needed before the lab can quote."
            )}
          </p>
        </div>
      </div>

      <div className="steps">
        {STEPS.map((name, index) => (
          <span
            key={name}
            className={`step${index === step ? " on" : index < step ? " done" : ""}`}
          >
            {index + 1}. {name}
          </span>
        ))}
      </div>

      {step === 0 && (
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
                    {patient.external_ref ? ` (${patient.external_ref})` : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {!patientId && (
            <>
              <Field label="Patient name">
                <input
                  value={newPatient.full_name}
                  onChange={(e) => setNewPatient({ ...newPatient, full_name: e.target.value })}
                />
              </Field>
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
                <Field label="Your chart number">
                  <input
                    value={newPatient.external_ref}
                    onChange={(e) =>
                      setNewPatient({ ...newPatient, external_ref: e.target.value })
                    }
                  />
                </Field>
              </div>
            </>
          )}

          <div className="row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn-primary"
              disabled={!patientReady}
              onClick={() => setStep(1)}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="card stack-sm">
          <h2>Clinical detail</h2>
          {products.data && (
            <ProductPicker products={products.data} value={choice} onChange={setChoice} />
          )}
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
            <button type="button" className="btn-ghost" onClick={() => setStep(0)}>
              Back
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={createDraft.isPending || (isProduct && !choice.sizeId)}
              onClick={() => createDraft.mutate()}
            >
              {createDraft.isPending ? "Saving…" : "Save and continue"}
            </button>
          </div>
        </div>
      )}

      {step === 2 && draft && (
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
            <button type="button" className="btn-ghost" onClick={() => setStep(1)}>
              Back
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={blockers.length > 0}
              onClick={() => setStep(3)}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 3 && draft && (
        <div className="stack">
          <div className="card stack-sm">
            <h2>Shipping</h2>
            <p className="muted" style={{ fontSize: "0.9rem" }}>
              Aligners and the training aligner ship to this address.
            </p>
            <Field label="Deliver to">
              <select
                value={addressId}
                onChange={(e) => {
                  setAddressId(e.target.value);
                  saveShipping.mutate();
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
              <dt>Case</dt>
              <dd className="mono">{draft.order_number}</dd>
              <dt>Patient</dt>
              <dd>{draft.patient_name}</dd>
              {draft.product_label ? (
                <>
                  <dt>Product</dt>
                  <dd>
                    {draft.product_label}
                    {products.data
                      ? ` — ₹${totalFor(products.data, choice).total.toLocaleString("en-IN")}`
                      : ""}
                  </dd>
                </>
              ) : null}
              <dt>Arches</dt>
              <dd>{draft.arch === "BOTH" ? "Both" : draft.arch}</dd>
              <dt>Priority</dt>
              <dd>{draft.priority === "EXPRESS" ? "Express" : "Standard"}</dd>
              <dt>Files</dt>
              <dd className="num">{draft.files.length}</dd>
            </dl>
          </div>

          <ErrorText error={submit.error} />
          <div className="row">
            <button type="button" className="btn-ghost" onClick={() => setStep(2)}>
              Back
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={submit.isPending || !addressId}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? "Submitting…" : "Submit to 3D Align"}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
