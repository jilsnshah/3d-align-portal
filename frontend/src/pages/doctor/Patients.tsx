/* The practice's patients.
 *
 * This was a list of names with a form beside it: first name, last name, a
 * date of birth nobody had filled in, and when the record was made. It could
 * not answer the questions a clinic brings to it — who is in treatment, who is
 * waiting on us, who finished last year, who did we register and never start —
 * because it knew nothing about the cases.
 *
 * So each patient is shown with their treatment: how many cases, the one that
 * matters now, where it stands on its journey, and whether it is waiting on
 * the clinic. The same filter strip as the case list narrows it, and a patient
 * opens into a panel with every case they have had and the way to start the
 * next one.
 *
 * Every patient carries their own number, PT-00001, handed out by the system:
 * a name is not unique, and two patients called Isha Trivedi are two people.
 * Cases are matched to patients by id, never by name, for the same reason.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";

import { api, formatDate, since } from "../../api";
import type { OrderSummary, Patient } from "../../api";
import StageTrack from "../../components/StageTrack";
import { CategoryPill, Empty, ErrorText, Field, Loading, StatusPill } from "../../components/ui";
import { everyCase, everyPatient } from "../../fetchAll";
import { ASK_ONE } from "../../workflow";

/** Rows drawn at once; more on request, so a large practice is not one
    thousand-row table on arrival. */
const STEP = 50;

type State = "needs" | "active" | "done" | "new";

type Row = {
  patient: Patient;
  /** Newest first. */
  cases: OrderSummary[];
  active: OrderSummary[];
  needs: OrderSummary[];
  /** The case that matters now: one waiting on the clinic, else the latest
      still running, else the latest of all. */
  current: OrderSummary | null;
  /** When anything last happened for this patient. */
  last: string;
  state: State;
};

const closed = (o: OrderSummary) => o.status === "COMPLETED" || o.status === "CANCELLED";

function build(patient: Patient, cases: OrderSummary[]): Row {
  const sorted = [...cases].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const needs = sorted.filter((o) => o.needs_doctor_action && o.status !== "CANCELLED");
  const active = sorted.filter((o) => !closed(o));
  const current = needs[0] ?? active[0] ?? sorted[0] ?? null;
  return {
    patient,
    cases: sorted,
    active,
    needs,
    current,
    last: sorted[0]?.updated_at ?? patient.created_at,
    state: needs.length ? "needs" : active.length ? "active" : sorted.length ? "done" : "new",
  };
}

type Cut = "all" | "needs" | "active" | "done" | "new";

const CUTS: { key: Cut; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs", label: "Needs you" },
  { key: "active", label: "In treatment" },
  { key: "done", label: "Finished" },
  { key: "new", label: "No case yet" },
];

function inCut(r: Row, cut: Cut): boolean {
  if (cut === "all") return true;
  if (cut === "active") return r.state === "needs" || r.state === "active";
  return r.state === cut;
}

type Sort = "urgent" | "recent" | "name" | "added";

const SEX: Record<string, string> = { F: "Female", M: "Male", OTHER: "Other" };

function age(dob: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob);
  if (!m) return null;
  const born = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  let years = now.getFullYear() - born.getFullYear();
  if (now < new Date(now.getFullYear(), born.getMonth(), born.getDate())) years -= 1;
  return years >= 0 && years < 130 ? years : null;
}

/** "24 · Female" — whatever the clinic recorded, and nothing if it recorded
    nothing. */
function facts(p: Patient): string {
  const years = age(p.date_of_birth);
  return [years !== null ? `${years} yrs` : "", SEX[p.sex] ?? ""].filter(Boolean).join(" · ");
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** "11 Sep, 10:30" — the year only when it is not this one. */
function shortWhen(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const day = d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "2-digit" }),
  });
  const time = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day}, ${time}`;
}

function archShort(arch: OrderSummary["arch"]): string {
  return arch === "UPPER" ? "Upper" : arch === "LOWER" ? "Lower" : "Both arches";
}

/** What is being made, in a few words. */
function treatment(o: OrderSummary): string {
  if (o.kind === "ACCESSORY") return "Accessories";
  if (o.kind === "PRODUCT") return o.product_label || "Appliance";
  return `Aligners · ${archShort(o.arch)}`;
}

/* A face for each name, so a long list can be scanned by shape as well as by
   reading. The tone follows the person, never the row it happens to sit on. */
const TONES: [string, string][] = [
  ["#f3ead4", "#8f6f1f"],
  ["#e5efe8", "#2f6f4f"],
  ["#e7ebf3", "#3c4f6e"],
  ["#f3e5e0", "#8a4a3a"],
  ["#ece7f3", "#5b4a7a"],
  ["#e5eef0", "#3d5f66"],
];

function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  const parts = name.trim().split(/\s+/);
  const initials = ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, ink] = TONES[h % TONES.length];
  return (
    <span
      className={large ? "pt-avatar lg" : "pt-avatar"}
      style={{ "--av-bg": bg, "--av-ink": ink } as CSSProperties}
      aria-hidden="true"
    >
      {initials || "?"}
    </span>
  );
}

export default function Patients() {
  const patients = useQuery({ queryKey: ["patients", "all"], queryFn: everyPatient });
  const cases = useQuery({ queryKey: ["orders", "every-case"], queryFn: everyCase });
  const addresses = useQuery({ queryKey: ["addresses"], queryFn: api.addresses });

  const [search, setSearch] = useState("");
  const [cut, setCut] = useState<Cut>("all");
  const [kind, setKind] = useState<"" | "ALIGNER" | "OTHER">("");
  const [sex, setSex] = useState("");
  const [branch, setBranch] = useState("");
  const [sort, setSort] = useState<Sort>("urgent");
  const [shown, setShown] = useState(STEP);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const list = patients.data ?? [];

  /* Each case names its patient by id, so it lands on the right person even
     when two patients share a name. */
  const rows = useMemo(() => {
    const byPatient = new Map<string, OrderSummary[]>();
    for (const o of cases.data ?? []) {
      if (!o.patient_id) continue;
      byPatient.set(o.patient_id, [...(byPatient.get(o.patient_id) ?? []), o]);
    }
    return list.map((p) => build(p, byPatient.get(p.id) ?? []));
  }, [list, cases.data]);

  // One clinic is not a choice worth putting on the page.
  const branches = addresses.data ?? [];
  const multiBranch = branches.length > 1;
  // A filter that cannot narrow anything is furniture: sex is only offered
  // once the practice has recorded it for somebody.
  const sexes = useMemo(() => new Set(list.map((p) => p.sex).filter(Boolean)), [list]);

  const q = search.trim().toLowerCase();
  const base = useMemo(
    () =>
      rows.filter(
        (r) =>
          (!q ||
            r.patient.full_name.toLowerCase().includes(q) ||
            r.patient.patient_number.toLowerCase().includes(q) ||
            r.cases.some((o) => o.order_number.toLowerCase().includes(q))) &&
          (!kind || r.cases.some((o) => (kind === "ALIGNER" ? o.kind === "ALIGNER" : o.kind !== "ALIGNER"))) &&
          (!sex || (sex === "none" ? !r.patient.sex : r.patient.sex === sex)) &&
          (!branch || r.cases.some((o) => o.branch_id === branch)),
      ),
    [rows, q, kind, sex, branch],
  );

  const counts = useMemo(
    () => Object.fromEntries(CUTS.map((c) => [c.key, base.filter((r) => inCut(r, c.key)).length])) as Record<Cut, number>,
    [base],
  );

  const filtered = useMemo(() => {
    const out = base.filter((r) => inCut(r, cut));
    const rank: Record<State, number> = { needs: 0, active: 1, new: 2, done: 3 };
    return out.sort((a, b) => {
      if (sort === "name") return a.patient.full_name.localeCompare(b.patient.full_name);
      if (sort === "added") return b.patient.created_at.localeCompare(a.patient.created_at);
      if (sort === "urgent") {
        const d = rank[a.state] - rank[b.state];
        if (d !== 0) return d;
      }
      return b.last.localeCompare(a.last);
    });
  }, [base, cut, sort]);

  // A new filter starts the list from the top again.
  useEffect(() => setShown(STEP), [cut, q, kind, sex, branch, sort]);

  const any = cut !== "all" || Boolean(kind) || Boolean(sex) || Boolean(branch);
  function clearFilters() {
    setCut("all");
    setKind("");
    setSex("");
    setBranch("");
  }

  const total = rows.length;
  const inTreatment = rows.filter((r) => r.state === "needs" || r.state === "active").length;
  const waiting = rows.filter((r) => r.state === "needs").length;
  const notStarted = rows.filter((r) => r.state === "new").length;
  const openRow = openId ? rows.find((r) => r.patient.id === openId) ?? null : null;

  if (patients.isLoading) return <Loading what="patients" />;

  return (
    <main className="page page-wide">
      <header className="masthead">
        <div className="masthead-say">
          <span className="masthead-eyebrow">Your practice</span>
          <h1>Patients</h1>
          <p className="masthead-sum">
            <b>{total}</b> {total === 1 ? "patient" : "patients"}
            {cases.data && (
              <>
                {" · "}
                <b>{inTreatment}</b> in treatment
                {waiting > 0 && (
                  <>
                    {" · "}
                    <b className="lit">{waiting}</b> waiting on you
                  </>
                )}
                {notStarted > 0 && (
                  <>
                    {" · "}
                    <b>{notStarted}</b> not started
                  </>
                )}
              </>
            )}
          </p>
        </div>

        <div className="masthead-do">
          <span className="search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input
              placeholder="Name, patient or case number"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search patients"
            />
          </span>
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            Add patient
          </button>
        </div>
      </header>

      <section className="console" aria-label="Filters">
        <div className="cut" role="tablist" aria-label="Show">
          {CUTS.map((c) => (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={cut === c.key}
              className={cut === c.key ? "on" : ""}
              onClick={() => setCut(c.key)}
            >
              {c.key === "needs" && <span className="cut-dot" aria-hidden="true" />}
              {c.label}
              <span className="cut-n">{cases.data ? counts[c.key] : "…"}</span>
            </button>
          ))}
        </div>

        <span className="console-rule" aria-hidden="true" />

        <label className="pick">
          <span>Treatment</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="">Any treatment</option>
            <option value="ALIGNER">Aligners</option>
            <option value="OTHER">Appliances and stock</option>
          </select>
        </label>

        {multiBranch && (
          <label className="pick">
            <span>Branch</span>
            <select value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="">All branches</option>
              {branches.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label || a.city}
                </option>
              ))}
            </select>
          </label>
        )}

        {sexes.size > 0 && (
          <label className="pick">
            <span>Sex</span>
            <select value={sex} onChange={(e) => setSex(e.target.value)}>
              <option value="">Anyone</option>
              {[...sexes].map((s) => (
                <option key={s} value={s}>
                  {SEX[s] ?? s}
                </option>
              ))}
              <option value="none">Not recorded</option>
            </select>
          </label>
        )}

        {any && (
          <button type="button" className="btn-link clear" onClick={clearFilters}>
            Clear filters
          </button>
        )}

        <span className="tally-say">
          {filtered.length === total ? `${total} patients` : `${filtered.length} of ${total}`}
        </span>

        <label className="pick">
          <span>Order</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="urgent">Needs you first</option>
            <option value="recent">Recently active</option>
            <option value="name">Name, A to Z</option>
            <option value="added">Newest added</option>
          </select>
        </label>
      </section>

      {total === 0 ? (
        <Empty>
          No patients yet.{" "}
          <button type="button" className="btn-link" onClick={() => setAdding(true)}>
            Add the first one
          </button>
        </Empty>
      ) : filtered.length === 0 ? (
        <Empty>
          {q ? <>No patient matches “{search}”.</> : "No patients match these filters."}{" "}
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              clearFilters();
              setSearch("");
            }}
          >
            Show everyone
          </button>
        </Empty>
      ) : (
        <div className="stack">
          <div className="case-table pt-table">
            <table>
              <thead>
                <tr>
                  <th className="col-who">Patient</th>
                  <th>Cases</th>
                  <th>Current case</th>
                  <th>Stage</th>
                  <th className="col-progress">Progress</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, shown).map((r) => (
                  <PatientRow key={r.patient.id} row={r} loading={cases.isLoading} onOpen={() => setOpenId(r.patient.id)} />
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length > shown && (
            <div className="pt-more">
              <button type="button" className="btn-ghost" onClick={() => setShown((n) => n + STEP)}>
                Show {Math.min(STEP, filtered.length - shown)} more
              </button>
              <span className="dim">
                {shown} of {filtered.length} shown
              </span>
            </div>
          )}
        </div>
      )}

      {openRow && <PatientPanel row={openRow} onClose={() => setOpenId(null)} />}
      {adding && (
        <AddPatient
          existing={list}
          onOpen={(id) => {
            setAdding(false);
            setOpenId(id);
          }}
          onClose={() => setAdding(false)}
          onAdded={(p) => {
            setAdding(false);
            setOpenId(p.id);
          }}
        />
      )}
    </main>
  );
}

function PatientRow({ row, loading, onOpen }: { row: Row; loading: boolean; onOpen: () => void }) {
  const { patient: p, current } = row;
  const aligners = row.cases.filter((o) => o.kind === "ALIGNER").length;
  const others = row.cases.length - aligners;
  const fact = facts(p);
  return (
    <tr
      className={`clickable${row.state === "needs" ? " wants" : ""}${row.state === "done" ? " done" : ""}`}
      onClick={onOpen}
    >
      <td className="col-who">
        <span className="pt-who">
          <Avatar name={p.full_name} />
          <span className="pt-who-say">
            <span className="cell-title">
              {p.full_name}
              {p.patient_number && <span className="pt-no">{p.patient_number}</span>}
            </span>
            {/* What the patient is waiting on the clinic for, where they are;
                otherwise what the clinic recorded about them. */}
            {row.state === "needs" && current ? (
              <span className="cell-ask">{ASK_ONE[current.status] ?? current.status_label}</span>
            ) : (
              <span className="pt-meta">{fact || `Added ${shortDate(p.created_at)}`}</span>
            )}
          </span>
        </span>
      </td>
      <td>
        {loading ? (
          <span className="dim">…</span>
        ) : row.cases.length === 0 ? (
          <span className="dim">None</span>
        ) : (
          <span
            className="pt-count"
            title={[
              aligners ? `${aligners} aligner` : "",
              others ? `${others} appliance or stock` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            <b>{row.cases.length}</b>
            {row.active.length > 0 ? `${row.active.length} open` : "all closed"}
          </span>
        )}
      </td>
      <td>
        {current ? (
          <span className="pt-case">
            <span className="mono">{current.order_number}</span>
            <span className="pt-treat">
              {current.kind === "ALIGNER" && current.category_label ? (
                <CategoryPill label={current.category_label} confirmed={current.category_confirmed} />
              ) : (
                treatment(current)
              )}
            </span>
          </span>
        ) : (
          <span className="dim">{loading ? "" : "No case yet"}</span>
        )}
      </td>
      <td>{current && <StatusPill status={current.status} label={current.status_label} />}</td>
      <td className="col-progress">
        {current && !closed(current) ? <StageTrack order={current} /> : current ? <span className="dim">Closed</span> : null}
      </td>
      <td className="col-when" title={`${since(row.last)} ago`}>
        {shortWhen(row.last)}
      </td>
    </tr>
  );
}

/** One patient, opened: who they are, every case they have had, and the way
    to start the next one without going back to find them in a picker. */
function PatientPanel({ row, onClose }: { row: Row; onClose: () => void }) {
  const navigate = useNavigate();
  const p = row.patient;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const about = [p.patient_number, facts(p), p.date_of_birth ? `Born ${p.date_of_birth}` : "", `Added ${formatDate(p.created_at)}`]
    .filter(Boolean)
    .join(" · ");

  /* Into the body: `.page` animates a transform, which would otherwise make it
     the containing block for this fixed panel. */
  return createPortal(
    <div
      className="pt-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="pt-panel" role="dialog" aria-modal="true" aria-label={p.full_name}>
        <header className="pt-panel-head">
          <Avatar name={p.full_name} large />
          <div className="pt-panel-title">
            <span className="pt-eyebrow">Patient</span>
            <h2>{p.full_name}</h2>
            <p>{about}</p>
          </div>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className="pt-stats">
          <div>
            <b>{row.cases.length}</b>
            <span>Cases</span>
          </div>
          <div>
            <b>{row.active.length}</b>
            <span>In treatment</span>
          </div>
          <div>
            <b className={row.needs.length ? "lit" : ""}>{row.needs.length}</b>
            <span>Waiting on you</span>
          </div>
        </div>

        <div className="pt-panel-body">
          <div className="pt-actions">
            <Link className="primary" to={`/orders/new?patient=${p.id}`}>
              New aligner case
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </Link>
            <Link className="ghost" to={`/catalogue?patient=${p.id}`}>
              Order an appliance
            </Link>
          </div>

          <h3>Cases</h3>
          {row.cases.length === 0 ? (
            <p className="pt-none">No cases for {p.first_name || p.full_name} yet — start one above.</p>
          ) : (
            <ul className="pt-cases">
              {row.cases.map((o) => {
                const wants = o.needs_doctor_action && o.status !== "CANCELLED";
                return (
                  <li key={o.id} className={wants ? "wants" : ""}>
                    <button type="button" onClick={() => navigate(`/orders/${o.id}`)}>
                      <span className="pt-case-top">
                        <span className="mono">{o.order_number}</span>
                        <b>{treatment(o)}</b>
                      </span>
                      <span className="pt-case-when">{since(o.updated_at)} ago</span>
                      <span className="pt-case-row">
                        <StatusPill status={o.status} label={o.status_label} />
                        {!closed(o) && <StageTrack order={o} />}
                      </span>
                      {wants && <span className="pt-case-ask">{ASK_ONE[o.status] ?? o.status_label}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

const BLANK = { first_name: "", last_name: "", date_of_birth: "", sex: "" };

/** Adding a patient, in a dialog raised from the masthead rather than a form
    standing permanently beside the list. */
function AddPatient({
  existing,
  onOpen,
  onClose,
  onAdded,
}: {
  existing: Patient[];
  onOpen: (id: string) => void;
  onClose: () => void;
  onAdded: (p: Patient) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(BLANK);
  /* Someone of this name is already on file. Said before the second record is
     made rather than discovered later as two half-histories — and still
     allowed, because two people can share a name; each gets their own number. */
  const typed = [form.first_name.trim(), form.last_name.trim()].filter(Boolean).join(" ").toLowerCase();
  const same = typed.length > 1 ? existing.filter((p) => p.full_name.toLowerCase() === typed) : [];
  const create = useMutation({
    mutationFn: () => api.createPatient(form),
    onSuccess: (patient) => {
      void queryClient.invalidateQueries({ queryKey: ["patients"] });
      onAdded(patient);
    },
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="modal stack-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Add a patient"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="row-between">
          <h2 style={{ margin: 0 }}>Add a patient</h2>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
        </div>
        {/* Two fields, not one: a single box got "riya" from one clinic and
            "Mehta, Riya J." from the next, and neither sorted nor matched. */}
        <div className="grid-2">
          <Field label="First name">
            <input
              required
              autoFocus
              value={form.first_name}
              onChange={(e) => setForm({ ...form, first_name: e.target.value })}
            />
          </Field>
          <Field label="Last name">
            <input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          </Field>
          <Field label="Date of birth">
            <input
              type="date"
              value={form.date_of_birth}
              onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
            />
          </Field>
          <Field label="Sex">
            <select value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value })}>
              <option value="">Not stated</option>
              <option value="F">Female</option>
              <option value="M">Male</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
        </div>
        {same.length > 0 && (
          <div className="pt-dup" role="status">
            <b>
              {same.length === 1
                ? "A patient with this name is already on file"
                : `${same.length} patients with this name are already on file`}
            </b>
            <ul>
              {same.map((p) => (
                <li key={p.id}>
                  <span>
                    {p.full_name} <span className="pt-no">{p.patient_number}</span>
                    {facts(p) && <span className="dim"> · {facts(p)}</span>}
                  </span>
                  <button type="button" className="btn-link" onClick={() => onOpen(p.id)}>
                    Open
                  </button>
                </li>
              ))}
            </ul>
            <span className="dim">If this is someone new, add them — they get their own number.</span>
          </div>
        )}
        <ErrorText error={create.error} />
        <div className="row-between">
          <span className="dim">Patients are private to your clinic.</span>
          <button type="submit" className="btn-primary" disabled={create.isPending}>
            {create.isPending ? "Adding…" : same.length ? "Add as a new patient" : "Add patient"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
