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
 * The page itself was five plain cards under a row of pills: the route was two
 * paragraphs of text that ran off the screen, the patient was a two-hundred-name
 * dropdown, and the arches and priority were selects that made a clinic read
 * three words to answer a question a picture answers. Now the choices are drawn
 * — the two doors, the arches, express against standard — the patient is
 * searched rather than scrolled, and a rail down the side keeps every answer
 * given so far in sight and reachable, with what is still needed counted on it.
 *
 * The draft is created on the server once the clinical detail is in, so uploads
 * have an order to attach to; from there it is resumable from the case list.
 * Coming back to change a clinical answer edits that draft rather than starting
 * a second one. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { api } from "../../api";
import type { AlignerIntake, Address, OrderDetail, Patient } from "../../api";
import Avatar from "../../components/Avatar";
import FileExplorer from "../../components/FileExplorer";
import { useToast } from "../../components/Toast";
import { ErrorText, Field, Loading } from "../../components/ui";

type StepName = "start" | "patient" | "clinical" | "records" | "shipping";
type Arch = "UPPER" | "LOWER" | "BOTH";

/** What the records step asks for, before any scan exists. */
const RECORD_CATEGORIES = ["RECORD_PHOTO", "OPG", "LATERAL_CEPH", "CBCT", "OTHER"] as const;

/** A case that came in with its scan gathers nothing beforehand, so it has no
    records step to show. Named rather than numbered: the two routes have
    different lengths, and index arithmetic over that is how a Back button
    ends up on the wrong screen. */
function stepsFor(intake: AlignerIntake): StepName[] {
  return intake === "SCAN_DIRECT"
    ? ["start", "patient", "clinical", "shipping"]
    : ["start", "patient", "clinical", "records", "shipping"];
}

const Glyph = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const STEP_ICON: Record<StepName, ReactNode> = {
  start: (
    <Glyph>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m15 9-2.2 4.8L8 16l2.2-4.8z" />
    </Glyph>
  ),
  patient: (
    <Glyph>
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
    </Glyph>
  ),
  clinical: (
    <Glyph>
      <path d="M12 20c-1.2 0-1.6-2.4-2-4-.4-1.6-1-2.6-2.4-2.6S5 15 4.6 12.6C4 9.2 5.6 5 8.8 5c1.6 0 2.2.8 3.2.8S13.6 5 15.2 5C18.4 5 20 9.2 19.4 12.6 19 15 17.8 13.4 16.4 13.4S14.4 14.4 14 16c-.4 1.6-.8 4-2 4z" />
    </Glyph>
  ),
  records: (
    <Glyph>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m6 16 3.5-4 3 3.2L15.5 12l2.5 4" />
      <circle cx="9" cy="9.5" r="1.3" />
    </Glyph>
  ),
  shipping: (
    <Glyph>
      <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7" />
      <circle cx="7" cy="17.5" r="1.8" />
      <circle cx="17" cy="17.5" r="1.8" />
    </Glyph>
  ),
};

const STEP_LABEL: Record<StepName, string> = {
  start: "How to start",
  patient: "Patient",
  clinical: "The case",
  records: "Records",
  shipping: "Delivery and review",
};

/* --------------------------------------------------------------- drawings */

/** The two doors, drawn. One is a camera and a price tag; the other is a
    scanner wand over an arch. A clinic picks the picture before it reads the
    paragraph. */
function RouteArt({ kind }: { kind: AlignerIntake }) {
  if (kind === "SCAN_DIRECT") {
    return (
      <svg className="nc-route-art" viewBox="0 0 120 84" role="img" aria-label="An intraoral scanner over an arch" focusable="false">
        <path className="ink-soft" d="M18 66a34 26 0 0 1 84 0" />
        <g className="teeth">
          {Array.from({ length: 9 }, (_, i) => {
            const t = (i + 0.5) / 9;
            const a = Math.PI * (1 - t);
            return <circle key={i} cx={60 + 42 * Math.cos(a)} cy={66 - 26 * Math.sin(a)} r={4.2} />;
          })}
        </g>
        <rect className="ink" x="52" y="8" width="16" height="34" rx="7" transform="rotate(18 60 25)" />
        <path className="gold" d="M74 14c3.4 2.2 5.2 5.4 5.4 9.4M80.5 8.5c5 3.2 7.6 8 7.8 13.8" />
        <path className="gold-fill" d="M56 44h9l-4.5 7z" />
      </svg>
    );
  }
  return (
    <svg className="nc-route-art" viewBox="0 0 120 84" role="img" aria-label="Photographs and a price tag" focusable="false">
      <rect className="ink-soft" x="14" y="20" width="44" height="34" rx="4" transform="rotate(-8 36 37)" />
      <rect className="ink" x="22" y="26" width="44" height="34" rx="4" />
      <circle className="ink" cx="44" cy="43" r="9" />
      <circle className="gold-fill" cx="44" cy="43" r="3.4" />
      <path className="ink" d="M30 26l3-4h10l3 4" />
      <path className="gold" d="M74 30h20l12 12-16 16-12-12z" />
      <circle className="gold-fill" cx="84" cy="40" r="2.6" />
      <path className="gold" d="M86 52c1.8 0 3.2-1.2 3.2-2.8S87.8 46.6 86 46.6s-3.2-1-3.2-2.6 1.4-2.8 3.2-2.8M86 44.8v9.4M86 39.2v2" />
    </svg>
  );
}

/** The arches, drawn as arches: two horseshoes of teeth facing each other
    across the bite, each tooth turned to sit square on the curve and widening
    towards the back. Gold is what will be treated. */
function ArchArt({ arch }: { arch: Arch }) {
  const upper = arch === "UPPER" || arch === "BOTH";
  const lower = arch === "LOWER" || arch === "BOTH";

  const row = (top: boolean, on: boolean) => {
    const count = 10;
    const rx = 31;
    const ry = 17;
    // Far enough apart to read as two arches facing each other across the
    // bite; any closer and the pair closes up into a ring.
    const cy = top ? 31 : 57;
    return Array.from({ length: count }, (_, i) => {
      const t = (i + 0.5) / count;
      const a = Math.PI * (1 - t);
      const x = 50 + rx * Math.cos(a);
      const y = top ? cy - ry * Math.sin(a) : cy + ry * Math.sin(a);
      // Incisors at the front, molars at the back.
      const w = 4.6 + 3.4 * (1 - Math.sin(a));
      const angle = (Math.atan2(y - cy, x - 50) * 180) / Math.PI + 90;
      return (
        <rect
          key={`${top}-${i}`}
          className={on ? "on" : ""}
          x={-w / 2}
          y={-4.6}
          width={w}
          height={9.2}
          rx={2.2}
          transform={`translate(${x} ${y}) rotate(${angle})`}
        />
      );
    });
  };

  return (
    <svg
      className="nc-arch-art"
      viewBox="0 0 100 88"
      role="img"
      aria-label={arch === "BOTH" ? "Both arches" : arch === "UPPER" ? "Upper arch" : "Lower arch"}
      focusable="false"
    >
      <g className="teeth">{row(true, upper)}</g>
      <g className="teeth">{row(false, lower)}</g>
    </svg>
  );
}

/** How far through the records the draft is, as a ring. */
function Ring({ done, total }: { done: number; total: number }) {
  const pct = total ? done / total : 0;
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <span className="nc-ring">
      <svg viewBox="0 0 56 56" aria-hidden="true">
        <circle cx="28" cy="28" r={r} fill="none" stroke="var(--paper-2)" strokeWidth="6" />
        <circle
          cx="28"
          cy="28"
          r={r}
          fill="none"
          stroke={pct === 1 ? "var(--ok)" : "var(--gold)"}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${pct * c} ${c}`}
          transform="rotate(-90 28 28)"
        />
      </svg>
      <b>
        {done}/{total}
      </b>
    </span>
  );
}

const Tick = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

/* ------------------------------------------------------------------ page */

const COMPLAINTS = [
  "Crowding",
  "Spacing",
  "Increased overjet",
  "Deep bite",
  "Open bite",
  "Crossbite",
  "Midline shift",
  "Relapse after treatment",
];

const ARCH_LABEL: Record<Arch, string> = { BOTH: "Both arches", UPPER: "Upper only", LOWER: "Lower only" };

function age(dob: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob);
  if (!m) return null;
  const born = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  let years = now.getFullYear() - born.getFullYear();
  if (now < new Date(now.getFullYear(), born.getMonth(), born.getDate())) years -= 1;
  return years >= 0 && years < 130 ? years : null;
}

const SEX: Record<string, string> = { F: "Female", M: "Male", OTHER: "Other" };

function patientFacts(p: Patient): string {
  const years = age(p.date_of_birth);
  return [p.patient_number, years !== null ? `${years} yrs` : "", SEX[p.sex] ?? ""].filter(Boolean).join(" · ");
}

function addressLine(a: Address): string {
  return [a.line1, a.city, a.pincode].filter(Boolean).join(", ");
}

export default function NewOrder() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [intake, setIntake] = useState<AlignerIntake>("QUOTE_FIRST");
  const [step, setStep] = useState<StepName>("start");
  const [draft, setDraft] = useState<OrderDetail | null>(null);

  const steps = stepsFor(intake);
  const stepAt = steps.indexOf(step);
  const direct = intake === "SCAN_DIRECT";

  // A picker, not a browse list — take a generous slice rather than paging.
  const patients = useQuery({ queryKey: ["patients", "picker"], queryFn: () => api.patients({ limit: 200 }) });
  const addresses = useQuery({ queryKey: ["addresses"], queryFn: api.addresses });

  // Arriving from a patient's panel with ?patient=<id> starts the case
  // for them rather than making the clinic find them again in the picker.
  const [params] = useSearchParams();
  const [patientId, setPatientId] = useState(() => params.get("patient") ?? "");
  const [makingNew, setMakingNew] = useState(false);
  const [search, setSearch] = useState("");
  const [newPatient, setNewPatient] = useState({ first_name: "", last_name: "", date_of_birth: "", sex: "" });
  const [arch, setArch] = useState<Arch>("BOTH");
  const [priority, setPriority] = useState<"STANDARD" | "EXPRESS">("STANDARD");
  const [chiefComplaint, setChiefComplaint] = useState("");
  const [clinicalNotes, setClinicalNotes] = useState("");
  const [addressId, setAddressId] = useState("");

  // The direct route creates the case with this address, so it cannot start
  // empty — the picker would show the first branch while sending nothing.
  const defaultAddressId = addresses.data?.find((a) => a.is_default_shipping)?.id ?? addresses.data?.[0]?.id ?? "";
  const chosenAddressId = addressId || defaultAddressId;

  const body = () => ({
    patient_id: patientId || null,
    new_patient: patientId ? null : newPatient,
    intake,
    arch,
    priority,
    chief_complaint: chiefComplaint,
    clinical_notes: clinicalNotes,
    // A direct case starts the moment it is placed, so the branch has to be
    // settled before that rather than patched on afterwards.
    shipping_address_id: chosenAddressId || null,
  });

  const createDraft = useMutation({
    mutationFn: () => api.createOrder(body()),
    onSuccess: (order) => {
      setDraft(order);
      setAddressId(order.shipping_address?.id ?? "");
      setStep("records");
    },
  });

  /* Coming back to change an answer edits the draft that already exists.
     Creating a second one would leave the first behind in the case list as a
     half-filled ghost of the same patient. */
  const updateDraft = useMutation({
    mutationFn: () =>
      api.updateOrder(draft!.id, {
        arch,
        priority,
        chief_complaint: chiefComplaint,
        clinical_notes: clinicalNotes,
      }),
    onSuccess: (order) => {
      setDraft(order);
      setStep("records");
    },
  });

  /* The direct route has nothing to gather, so the case is not created until
     the clinic has finished choosing — and creating it is what starts it. The
     quoted route still creates a draft early, because its records need an
     order to attach to. */
  const placeDirect = useMutation({
    mutationFn: () => api.createOrder(body()),
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      navigate(`/orders/${order.id}`);
      toast({
        title: "Case placed",
        body: `${order.order_number} · send the intraoral scan when you are ready.`,
      });
    },
  });

  const saveShipping = useMutation({
    mutationFn: (id: string) => api.updateOrder(draft!.id, { shipping_address_id: id }),
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
      toast({
        title: "Sent to 3D Align",
        body: `${order.order_number} · the lab reads your records and comes back with a price.`,
      });
    },
  });

  const refreshDraft = async () => {
    if (draft) setDraft(await api.order(draft.id));
  };

  const everyone = useMemo(() => patients.data ?? [], [patients.data]);
  const chosen = everyone.find((p) => p.id === patientId) ?? null;
  const q = search.trim().toLowerCase();
  const found = useMemo(
    () =>
      q
        ? everyone.filter(
            (p) => p.full_name.toLowerCase().includes(q) || (p.patient_number ?? "").toLowerCase().includes(q),
          )
        : everyone,
    [everyone, q],
  );

  /* The same name already on file, offered back before a second record is
     made. Still allowed — two people can share a name, and each gets their
     own number. */
  const typedName = [newPatient.first_name.trim(), newPatient.last_name.trim()].filter(Boolean).join(" ").toLowerCase();
  const sameName = typedName.length > 1 ? everyone.filter((p) => p.full_name.toLowerCase() === typedName) : [];

  if (patients.isLoading || addresses.isLoading) return <Loading />;

  const patientReady = patientId !== "" || newPatient.first_name.trim() !== "";
  const blockers = draft?.submit_blockers ?? [];
  const needed = (draft?.record_sets ?? []).filter((s) => s.required && RECORD_CATEGORIES.includes(s.category as never));
  const doneSets = needed.filter((s) => s.complete).length;
  // Before the case exists there is no patient record to read the name off, so
  // the review shows what was chosen or typed.
  const patientName = chosen?.full_name || [newPatient.first_name, newPatient.last_name].filter(Boolean).join(" ");
  const deliverTo = addresses.data?.find((a) => a.id === chosenAddressId) ?? null;

  const summary: Record<StepName, string> = {
    start: direct ? "Scan straight in" : "Quote first",
    patient: patientName || "Not chosen yet",
    clinical: `${ARCH_LABEL[arch]} · ${priority === "EXPRESS" ? "Express" : "Standard"}`,
    records: draft ? `${doneSets} of ${needed.length || 0} sets ready` : "Nothing yet",
    shipping: deliverTo ? deliverTo.label : "Not chosen yet",
  };

  function goTo(name: StepName) {
    const to = steps.indexOf(name);
    if (to <= stepAt) setStep(name);
  }

  return (
    <main className="page page-wide nc">
      <section className="nc-hero">
        <div className="nc-hero-say">
          <span className="nc-kicker">New case</span>
          <h1>
            Start an <em>aligner case</em>
          </h1>
          <p>
            {direct
              ? "You have the scan. 3D Align plans from it and confirms the price with the treatment plan."
              : "Send photographs and an OPG first; 3D Align reads them and sends a price before anything is scanned."}
          </p>
        </div>
        <div className="nc-hero-side">
          {draft ? (
            <span className="nc-draft">
              <Tick />
              Draft <b className="mono">{draft.order_number}</b> saved
            </span>
          ) : (
            <span className="nc-draft quiet">Nothing is sent until you submit</span>
          )}
          <Link className="nc-leave" to="/orders">
            Cancel
          </Link>
        </div>
      </section>

      <div className="nc-body">
        <aside className="nc-rail" aria-label="Steps">
          <ol>
            {steps.map((name, index) => {
              const state = index === stepAt ? "on" : index < stepAt ? "done" : "todo";
              return (
                <li key={name} className={state}>
                  <button type="button" disabled={index > stepAt} onClick={() => goTo(name)}>
                    <span className="nc-rail-mark" aria-hidden="true">
                      {index < stepAt ? <Tick /> : STEP_ICON[name]}
                    </span>
                    <span className="nc-rail-say">
                      <small>Step {index + 1}</small>
                      <b>{STEP_LABEL[name]}</b>
                      <span>{summary[name]}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="nc-rail-note">
            Everything here can be changed until you submit. A draft stays in your case list if you leave.
          </p>
        </aside>

        <div className="nc-pane">
          {step === "start" && (
            <section className="nc-step">
              <header className="nc-step-head">
                <h2>How would you like to start?</h2>
                <p>Both doors end in the same treatment. The difference is only whether you want a price before you scan.</p>
              </header>

              <div className="nc-routes">
                {(
                  [
                    {
                      value: "QUOTE_FIRST" as const,
                      title: "I need a price first",
                      blurb: "3D Align reads your records, picks the aligner band and sends a price. You scan once you have accepted it.",
                      send: ["Photographs", "OPG"],
                      flow: ["Records", "Price", "Scan", "Plan"],
                    },
                    {
                      value: "SCAN_DIRECT" as const,
                      title: "I already have the scan",
                      blurb: "Go straight to the intraoral scan. Nothing else is asked for, and the price is confirmed with the treatment plan.",
                      send: ["Intraoral scan"],
                      flow: ["Scan", "Plan", "Price"],
                    },
                  ]
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`nc-route${intake === option.value ? " on" : ""}`}
                    aria-pressed={intake === option.value}
                    onClick={() => setIntake(option.value)}
                  >
                    <RouteArt kind={option.value} />
                    <b>{option.title}</b>
                    <span className="nc-route-blurb">{option.blurb}</span>
                    <span className="nc-route-send">
                      {option.send.map((s) => (
                        <i key={s}>{s}</i>
                      ))}
                    </span>
                    <span className="nc-flow">
                      {option.flow.map((f) => (
                        <i key={f}>{f}</i>
                      ))}
                    </span>
                    <span className="nc-picked" aria-hidden="true">
                      <Tick />
                    </span>
                  </button>
                ))}
              </div>

              <footer className="nc-foot">
                <span className="nc-foot-say">{direct ? "Nothing is gathered before the scan." : "Records first, then a price."}</span>
                <button type="button" className="btn-primary" onClick={() => setStep("patient")}>
                  Continue
                </button>
              </footer>
            </section>
          )}

          {step === "patient" && (
            <section className="nc-step">
              <header className="nc-step-head">
                <h2>Who is it for?</h2>
                <p>Search the patients on file, or add someone new. Every patient keeps their own number.</p>
              </header>

              <div className="nc-seg" role="tablist" aria-label="Patient">
                <button
                  type="button"
                  role="tab"
                  aria-selected={!makingNew}
                  className={!makingNew ? "on" : ""}
                  onClick={() => setMakingNew(false)}
                >
                  On file
                  <span>{everyone.length}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={makingNew}
                  className={makingNew ? "on" : ""}
                  onClick={() => {
                    setMakingNew(true);
                    setPatientId("");
                  }}
                >
                  New patient
                </button>
              </div>

              {!makingNew ? (
                everyone.length === 0 ? (
                  <p className="nc-none">
                    No patients on file yet.{" "}
                    <button type="button" className="btn-link" onClick={() => setMakingNew(true)}>
                      Add the first one
                    </button>
                  </p>
                ) : (
                  <>
                    <span className="search nc-search">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <circle cx="11" cy="11" r="7" />
                        <path d="m20 20-3.5-3.5" strokeLinecap="round" />
                      </svg>
                      <input
                        placeholder="Name or patient number"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        aria-label="Search patients"
                      />
                    </span>
                    {found.length === 0 ? (
                      <p className="nc-none">
                        Nobody matches “{search}”.{" "}
                        <button type="button" className="btn-link" onClick={() => setMakingNew(true)}>
                          Add them as a new patient
                        </button>
                      </p>
                    ) : (
                      <ul className="nc-people">
                        {found.slice(0, 40).map((p) => (
                          <li key={p.id}>
                            <button
                              type="button"
                              className={patientId === p.id ? "on" : ""}
                              aria-pressed={patientId === p.id}
                              onClick={() => setPatientId(p.id)}
                            >
                              <Avatar name={p.full_name} />
                              <span className="nc-person">
                                <b>{p.full_name}</b>
                                <small>{patientFacts(p) || "No details recorded"}</small>
                              </span>
                              <span className="nc-picked" aria-hidden="true">
                                <Tick />
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {found.length > 40 && <p className="nc-none">{found.length - 40} more — narrow the search to find them.</p>}
                  </>
                )
              ) : (
                <div className="nc-form">
                  {/* Two fields, not one. A single box got "riya" from one clinic
                      and "Mehta, Riya J." from the next, and neither sorted nor
                      matched the other. */}
                  <div className="nc-form-row">
                    <Field label="First name">
                      <input
                        autoFocus
                        value={newPatient.first_name}
                        onChange={(e) => setNewPatient({ ...newPatient, first_name: e.target.value })}
                      />
                    </Field>
                    <Field label="Last name">
                      <input
                        value={newPatient.last_name}
                        onChange={(e) => setNewPatient({ ...newPatient, last_name: e.target.value })}
                      />
                    </Field>
                  </div>
                  <div className="nc-form-row">
                    <Field label="Date of birth">
                      <input
                        type="date"
                        value={newPatient.date_of_birth}
                        onChange={(e) => setNewPatient({ ...newPatient, date_of_birth: e.target.value })}
                      />
                    </Field>
                    <Field label="Sex">
                      <select value={newPatient.sex} onChange={(e) => setNewPatient({ ...newPatient, sex: e.target.value })}>
                        <option value="">Not stated</option>
                        <option value="F">Female</option>
                        <option value="M">Male</option>
                        <option value="OTHER">Other</option>
                      </select>
                    </Field>
                  </div>

                  {sameName.length > 0 && (
                    <div className="nc-dup" role="status">
                      <b>{sameName.length === 1 ? "A patient with this name is already on file" : `${sameName.length} patients with this name are already on file`}</b>
                      <ul>
                        {sameName.map((p) => (
                          <li key={p.id}>
                            <span>
                              {p.full_name} <span className="pt-no">{p.patient_number}</span>
                            </span>
                            <button
                              type="button"
                              className="btn-link"
                              onClick={() => {
                                setPatientId(p.id);
                                setMakingNew(false);
                              }}
                            >
                              Use this record
                            </button>
                          </li>
                        ))}
                      </ul>
                      <small>If this is someone new, carry on — they get their own number.</small>
                    </div>
                  )}
                </div>
              )}

              <footer className="nc-foot">
                <button type="button" className="btn-ghost" onClick={() => setStep("start")}>
                  Back
                </button>
                <span className="nc-foot-say">{patientReady ? patientName : "Choose a patient, or add a new one"}</span>
                <button type="button" className="btn-primary" disabled={!patientReady} onClick={() => setStep("clinical")}>
                  Continue
                </button>
              </footer>
            </section>
          )}

          {step === "clinical" && (
            <section className="nc-step">
              <header className="nc-step-head">
                <h2>What are we treating?</h2>
                <p>Which arches, how quickly, and anything the lab should know before it plans.</p>
              </header>

              <fieldset className="nc-fieldset">
                <legend>Arches</legend>
                <div className="nc-arches">
                  {(["BOTH", "UPPER", "LOWER"] as Arch[]).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`nc-arch${arch === value ? " on" : ""}`}
                      aria-pressed={arch === value}
                      onClick={() => setArch(value)}
                    >
                      <ArchArt arch={value} />
                      <b>{ARCH_LABEL[value]}</b>
                      <span className="nc-picked" aria-hidden="true">
                        <Tick />
                      </span>
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset className="nc-fieldset">
                <legend>How quickly</legend>
                <div className="nc-pair">
                  {(
                    [
                      { value: "STANDARD" as const, title: "Standard", note: "The lab's usual queue." },
                      { value: "EXPRESS" as const, title: "Express", note: "Worked ahead of standard cases at every stage." },
                    ]
                  ).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`nc-choice${priority === option.value ? " on" : ""}`}
                      aria-pressed={priority === option.value}
                      onClick={() => setPriority(option.value)}
                    >
                      {option.value === "EXPRESS" && (
                        <svg className="nc-bolt" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                          <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" strokeLinejoin="round" />
                        </svg>
                      )}
                      <b>{option.title}</b>
                      <span>{option.note}</span>
                      <span className="nc-picked" aria-hidden="true">
                        <Tick />
                      </span>
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset className="nc-fieldset">
                <legend>Chief complaint</legend>
                <p className="nc-hint">What the patient wants corrected. Tap what fits, then add anything else.</p>
                <div className="nc-chips">
                  {COMPLAINTS.map((c) => {
                    const on = chiefComplaint.toLowerCase().includes(c.toLowerCase());
                    return (
                      <button
                        key={c}
                        type="button"
                        className={on ? "nc-chip on" : "nc-chip"}
                        aria-pressed={on}
                        onClick={() =>
                          setChiefComplaint((prev) => {
                            if (on) {
                              return prev
                                .split(/,\s*/)
                                .filter((part) => part.trim().toLowerCase() !== c.toLowerCase())
                                .join(", ")
                                .replace(/^,\s*/, "");
                            }
                            return prev.trim() ? `${prev.replace(/,\s*$/, "")}, ${c}` : c;
                          })
                        }
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
                <textarea
                  value={chiefComplaint}
                  onChange={(e) => setChiefComplaint(e.target.value)}
                  placeholder="In your own words, if you prefer."
                  aria-label="Chief complaint"
                />
              </fieldset>

              <fieldset className="nc-fieldset">
                <legend>Notes for the lab</legend>
                <p className="nc-hint">Restorations, planned extractions, periodontal status — anything that changes how the case is planned.</p>
                <textarea
                  value={clinicalNotes}
                  onChange={(e) => setClinicalNotes(e.target.value)}
                  placeholder="Optional, but it saves a round trip."
                  aria-label="Clinical notes for the lab"
                />
              </fieldset>

              <ErrorText error={createDraft.error ?? updateDraft.error} />
              <footer className="nc-foot">
                <button type="button" className="btn-ghost" onClick={() => setStep("patient")}>
                  Back
                </button>
                <span className="nc-foot-say">{direct ? "Next: where it ships" : "Next: your records"}</span>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={createDraft.isPending || updateDraft.isPending}
                  onClick={() => {
                    if (direct) setStep("shipping");
                    else if (draft) updateDraft.mutate();
                    else createDraft.mutate();
                  }}
                >
                  {createDraft.isPending || updateDraft.isPending ? "Saving…" : direct ? "Continue" : "Save and continue"}
                </button>
              </footer>
            </section>
          )}

          {step === "records" && draft && (
            <section className="nc-step">
              <header className="nc-step-head">
                <h2>Your records</h2>
                <p>Photographs and an OPG are what 3D Align reads to price the case. Add a lateral ceph or CBCT if the case needs one.</p>
              </header>

              <div className="nc-progress">
                <Ring done={doneSets} total={needed.length} />
                <div>
                  <b>
                    {needed.length === 0
                      ? "Nothing outstanding"
                      : doneSets === needed.length
                        ? "Every required record is in"
                        : `${needed.length - doneSets} of ${needed.length} still to add`}
                  </b>
                  <ul className="nc-checks">
                    {needed.map((s) => (
                      <li key={s.category} className={s.complete ? "done" : ""}>
                        <i aria-hidden="true">{s.complete ? <Tick /> : null}</i>
                        <span>{s.label}</span>
                        {!s.complete && s.missing.length > 0 && <small>{s.missing.length} missing</small>}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="nc-files">
                <FileExplorer order={draft} onChanged={refreshDraft} only={[...RECORD_CATEGORIES]} embedded />
              </div>

              <footer className="nc-foot">
                <button type="button" className="btn-ghost" onClick={() => setStep("clinical")}>
                  Back
                </button>
                <span className="nc-foot-say">
                  {blockers.length > 0 ? blockers[0] : "Everything the lab needs is here"}
                </span>
                <button type="button" className="btn-primary" disabled={blockers.length > 0} onClick={() => setStep("shipping")}>
                  Continue
                </button>
              </footer>
            </section>
          )}

          {step === "shipping" && (draft || direct) && (
            <section className="nc-step">
              <header className="nc-step-head">
                <h2>Where it ships, and what you are sending</h2>
                <p>The training aligner and every phase go to the clinic you choose here.</p>
              </header>

              <fieldset className="nc-fieldset">
                <legend>Deliver to</legend>
                {(addresses.data ?? []).length === 0 ? (
                  <p className="nc-none">
                    No clinic address yet. <Link to="/profile?tab=clinics">Add one in your profile</Link> before placing the case.
                  </p>
                ) : (
                  <div className="nc-addresses">
                    {(addresses.data ?? []).map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className={`nc-choice${chosenAddressId === a.id ? " on" : ""}`}
                        aria-pressed={chosenAddressId === a.id}
                        onClick={() => {
                          setAddressId(a.id);
                          // Nothing exists to save against yet on the direct
                          // route — the case is created with this address a
                          // moment later.
                          if (draft) saveShipping.mutate(a.id);
                        }}
                      >
                        <b>
                          {a.label}
                          {a.is_default_shipping && <em>Default</em>}
                        </b>
                        <span>{addressLine(a)}</span>
                        <span className="nc-picked" aria-hidden="true">
                          <Tick />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </fieldset>

              <div className="nc-review">
                <h3>What you are sending</h3>
                <dl>
                  {draft && (
                    <div>
                      <dt>Case</dt>
                      <dd className="mono">{draft.order_number}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Patient</dt>
                    <dd>{draft ? draft.patient_name : patientName}</dd>
                  </div>
                  <div>
                    <dt>Arches</dt>
                    <dd>{ARCH_LABEL[arch]}</dd>
                  </div>
                  <div>
                    <dt>Priority</dt>
                    <dd>{priority === "EXPRESS" ? "Express" : "Standard"}</dd>
                  </div>
                  <div>
                    <dt>Starting with</dt>
                    <dd>{direct ? "Your own intraoral scan" : "Photographs for a price"}</dd>
                  </div>
                  {!direct && draft && (
                    <div>
                      <dt>Records attached</dt>
                      <dd>{draft.files.length}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Delivering to</dt>
                    <dd>{deliverTo ? `${deliverTo.label} · ${addressLine(deliverTo)}` : "Not chosen"}</dd>
                  </div>
                </dl>
                <p className="nc-next">
                  {direct
                    ? "Placing this case opens it at the scan stage. 3D Align confirms the price with the treatment plan rather than an estimate beforehand."
                    : "3D Align reads your records, picks the aligner band and sends a price. Nothing is charged until you accept it."}
                </p>
              </div>

              <ErrorText error={direct ? placeDirect.error : submit.error} />
              <footer className="nc-foot">
                <button type="button" className="btn-ghost" onClick={() => setStep(direct ? "clinical" : "records")}>
                  Back
                </button>
                <span className="nc-foot-say">{deliverTo ? `To ${deliverTo.label}` : "Choose where it ships"}</span>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={(direct ? placeDirect.isPending : submit.isPending) || !chosenAddressId}
                  onClick={() => (direct ? placeDirect.mutate() : submit.mutate())}
                >
                  {direct
                    ? placeDirect.isPending
                      ? "Placing…"
                      : "Place case and add the scan"
                    : submit.isPending
                      ? "Sending…"
                      : "Send to 3D Align"}
                </button>
              </footer>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
