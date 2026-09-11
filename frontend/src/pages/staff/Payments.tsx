/* The lab's money, across every clinic.
 *
 * The clinic's own ledger answers "what do I owe". This answers a different
 * question over the same rows, and the order matters: the lab's first job is
 * not chasing debt but checking the receipts already sent, because a receipt
 * sitting unread holds up whatever the charge was gating — a treatment plan,
 * a training aligner, a box waiting to be dispatched.
 *
 * So it opens on the receipts waiting, said as a sentence and set large, with
 * the money split into to-check, owed and received, and who owes the most
 * beside it. The receipts themselves follow, oldest first, each with its
 * screenshot beside the decision. Then every charge in the portal's own
 * list-and-filters shape — status, clinic, what it is for, month, search, a
 * file for the accountant — and a row opens the charge in a panel.
 *
 * Confirming a payment is the same act it always was: VerifyRow, the one row
 * shared with the case page, so the moment money is confirmed cannot drift
 * between the two.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { api, formatDate } from "../../api";
import type { LedgerEntry } from "../../api";
import Drawer from "../../components/Drawer";
import { VerifyRow } from "../../components/PaymentReview";
import { Loading } from "../../components/ui";

/** ₹52,130 for a whole amount, ₹16,926.67 when there are paise. */
function money(value: string | number): string {
  const n = Number(value);
  const whole = Number.isInteger(Math.round(n * 100) / 100);
  return `₹${n.toLocaleString("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** One mark per kind of charge, so a list of them reads by shape. */
const KIND_ICON: Record<string, ReactNode> = {
  TREATMENT_PLAN: (
    <Glyph>
      <path d="M12 3 21 8l-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </Glyph>
  ),
  TRAINING_FIT: (
    <Glyph>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </Glyph>
  ),
  PRODUCTION_PHASE: (
    <Glyph>
      <path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5z" />
      <path d="M4 7.5 12 11l8-3.5M12 11v9" />
    </Glyph>
  ),
  PRODUCT_ORDER: (
    <Glyph>
      <path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </Glyph>
  ),
};

const KIND_NAME: Record<string, string> = {
  TREATMENT_PLAN: "Treatment plan",
  TRAINING_FIT: "Training aligner fit",
  PRODUCTION_PHASE: "Production phases",
  PRODUCT_ORDER: "Products and accessories",
};

const STATUS_PILL: Record<string, string> = {
  DUE: "pill pill-warn",
  REJECTED: "pill pill-danger",
  SUBMITTED: "pill pill-gold",
  VERIFIED: "pill pill-ok",
};

/** Which case, and whose. Both are needed here and neither is on the screen
    already, unlike inside a case. */
function CaseLine({ entry }: { entry: LedgerEntry }) {
  return (
    <div className="pay-case">
      <Link to={`/staff/orders/${entry.order_id}`} className="pay-case-ref">
        {entry.order_reference}
      </Link>
      <span className="dim">
        {entry.subject} · {entry.doctor_name}
        {entry.clinic_name ? `, ${entry.clinic_name}` : ""} · {entry.order_status_label}
      </span>
    </div>
  );
}

/** The screenshot the clinic sent, small, beside the decision it supports. A
    PDF will not draw as a picture, so the link stands on its own then. */
function Proof({ entry }: { entry: LedgerEntry }) {
  if (!entry.proof_file_id) return <span className="lp-thumb none">No screenshot</span>;
  const href = api.previewUrl(entry.order_id, entry.proof_file_id);
  return (
    <a className="lp-thumb" href={href} target="_blank" rel="noreferrer" title="Open the receipt">
      <img
        src={href}
        alt="Payment receipt"
        loading="lazy"
        onError={(e) => {
          e.currentTarget.style.display = "none";
        }}
      />
      <span>Open</span>
    </a>
  );
}

/** When anything happened to a charge: confirmed, or at least sent. */
function dateOf(e: LedgerEntry): string | null {
  return e.verified_at ?? e.submitted_at ?? null;
}

function monthKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shortDay(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "2-digit" }) });
}

/** The book as a file, for the lab's accountant. */
function downloadCsv(rows: LedgerEntry[]) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [
    ["Date", "Case", "Clinic", "Doctor", "Patient or item", "For", "Status", "Amount", "Delivery", "Total", "UPI reference"]
      .map(esc)
      .join(","),
    ...rows.map((r) =>
      [
        (dateOf(r) ?? "").slice(0, 10),
        r.order_reference,
        r.clinic_name,
        r.doctor_name,
        r.subject,
        r.label,
        r.status_label,
        Number(r.amount).toFixed(2),
        Number(r.shipping_amount).toFixed(2),
        Number(r.total).toFixed(2),
        r.reference,
      ]
        .map((v) => esc(String(v ?? "")))
        .join(","),
    ),
  ];
  // The byte-order mark makes Excel read the rupee sign and names correctly.
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `3d-align-lab-payments-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function StaffPayments() {
  const [params] = useSearchParams();
  const { data, isLoading } = useQuery({ queryKey: ["staff-payments", ""], queryFn: () => api.labPayments() });
  const [openId, setOpenId] = useState<string | null>(null);
  const [clinic, setClinic] = useState(params.get("doctor") ?? "");

  if (isLoading) return <Loading what="payments" />;
  if (!data) return null;

  const due = Number(data.outstanding);
  const review = Number(data.in_review);
  const paidFy = Number(data.paid_this_year);
  const toCheck = data.to_verify;
  // What is owed, minus anything whose receipt is already on this desk.
  const owed = data.pending.filter((p) => p.status !== "SUBMITTED");
  const checkClinics = new Set(toCheck.map((e) => e.doctor_id)).size;
  const seen = new Set<string>();
  const rows = [...data.to_verify, ...data.pending, ...data.history].filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  const opened = rows.find((r) => r.id === openId) ?? null;
  const top = [...data.owed_by_doctor].sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 5);
  const topMax = Math.max(1, ...top.map((r) => Number(r.amount)));

  function focusClinic(id: string) {
    setClinic(id);
    document.getElementById("lp-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <main className="page py lp">
      <section className="py-hero">
        <div className="py-say">
          <span className="py-eyebrow">Payments · every clinic</span>
          <h1>
            {toCheck.length > 0 ? (
              <>
                <em>
                  {toCheck.length} {toCheck.length === 1 ? "receipt" : "receipts"}
                </em>{" "}
                to check.
              </>
            ) : due > 0 ? (
              <>
                Clinics owe <em>{money(due)}</em>.
              </>
            ) : (
              <>
                Every charge is <em>settled.</em>
              </>
            )}
          </h1>
          <p className="py-sub">
            {toCheck.length > 0
              ? `${money(review)} sent by ${checkClinics} ${checkClinics === 1 ? "clinic" : "clinics"} is waiting on the lab. Check each against the bank before confirming it — confirming is what unlocks whatever the charge was holding.`
              : due > 0
                ? `Across ${owed.length} open ${owed.length === 1 ? "charge" : "charges"}. A clinic whose receipt is already with the lab is not counted — they have paid, and the delay is ours.`
                : "Nothing is owed, and nothing is waiting to be checked."}
          </p>

          {review + due + paidFy > 0 && (
            <div className="py-meter">
              <div
                className="py-meter-bar"
                role="img"
                aria-label={`${money(review)} to check, ${money(due)} owed, ${money(paidFy)} received in ${data.financial_year}`}
              >
                {[
                  ["review", review],
                  ["due", due],
                  ["paid", paidFy],
                ].map(([key, value]) =>
                  Number(value) > 0 ? (
                    <i
                      key={key as string}
                      className={key as string}
                      style={{ width: `${Math.max(2, (Number(value) / (review + due + paidFy)) * 100)}%` }}
                    />
                  ) : null,
                )}
              </div>
              <ul className="py-meter-key">
                <li className="review">
                  <span>To check</span>
                  <b>{money(review)}</b>
                </li>
                <li className="due">
                  <span>Owed</span>
                  <b>{money(due)}</b>
                </li>
                <li className="paid">
                  <span>Received {data.financial_year}</span>
                  <b>{money(paidFy)}</b>
                </li>
              </ul>
            </div>
          )}
        </div>

        <aside className="py-payto lp-owe" aria-label="Who owes the most">
          <span className="py-eyebrow">Who owes the most</span>
          {top.length === 0 ? (
            <p className="py-noupi">No clinic owes the lab anything.</p>
          ) : (
            <ol className="lp-owe-list">
              {top.map((r) => (
                <li key={r.doctor_id || r.doctor_name}>
                  <button type="button" onClick={() => focusClinic(r.doctor_id)} title="Show only this clinic's charges">
                    <span>
                      <b>{r.clinic_name || r.doctor_name}</b>
                      <small>
                        {r.clinic_name ? `${r.doctor_name} · ` : ""}
                        {r.charges} {r.charges === 1 ? "charge" : "charges"}
                      </small>
                    </span>
                    <b className="lp-owe-amt">{money(r.amount)}</b>
                    <i style={{ width: `${(Number(r.amount) / topMax) * 100}%` }} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <span className="lp-total">
            Received in total <b>{money(data.paid_total)}</b>
          </span>
        </aside>
      </section>

      {toCheck.length > 0 && (
        <section className="py-section" aria-labelledby="lp-desk-title">
          <header className="py-head">
            <div>
              <span className="py-kicker">Oldest first — the top one has waited longest</span>
              <h2 id="lp-desk-title">Receipts to check</h2>
            </div>
            <span className="py-head-sum">
              <b>{money(review)}</b> across {toCheck.length} {toCheck.length === 1 ? "receipt" : "receipts"}
            </span>
          </header>
          <div className="lp-desk">
            {toCheck.map((entry) => (
              <article key={entry.id} className="lp-receipt">
                <Proof entry={entry} />
                <div className="lp-receipt-say">
                  <VerifyRow orderId={entry.order_id} payment={entry} header={<CaseLine entry={entry} />} />
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <ChargeList rows={rows} clinic={clinic} setClinic={setClinic} onOpen={setOpenId} />

      {opened && <ChargePanel entry={opened} onClose={() => setOpenId(null)} />}
    </main>
  );
}

type Cut = "all" | "SUBMITTED" | "DUE" | "REJECTED" | "VERIFIED";

const CUTS: { key: Cut; label: string }[] = [
  { key: "all", label: "All" },
  { key: "SUBMITTED", label: "To check" },
  { key: "DUE", label: "Owed" },
  { key: "REJECTED", label: "Not accepted" },
  { key: "VERIFIED", label: "Received" },
];

/** What wants the lab first: receipts to check, then what bounced, then what
    is owed. */
const RANK: Record<string, number> = { SUBMITTED: 0, REJECTED: 1, DUE: 2, VERIFIED: 3 };

const ACTION: Record<string, string> = {
  SUBMITTED: "Check",
  REJECTED: "Open",
  DUE: "Open",
  VERIFIED: "Receipt",
};

type Sort = "action" | "newest" | "amount";

/** Every charge the lab has raised, open and settled, in the same filter strip
    and table as the case and doctor lists. */
function ChargeList({
  rows,
  clinic,
  setClinic,
  onOpen,
}: {
  rows: LedgerEntry[];
  clinic: string;
  setClinic: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const [cut, setCut] = useState<Cut>("all");
  const [kind, setKind] = useState("");
  const [month, setMonth] = useState("");
  const [sort, setSort] = useState<Sort>("action");
  const [search, setSearch] = useState("");

  // Only what the book actually has, so no menu offers an empty answer.
  const clinics = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.doctor_id) seen.set(r.doctor_id, r.clinic_name ? `${r.clinic_name} — ${r.doctor_name}` : r.doctor_name);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);
  const kinds = useMemo(() => [...new Set(rows.map((r) => r.kind))], [rows]);
  const months = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      const d = dateOf(r);
      if (d) seen.set(monthKey(d), new Date(d).toLocaleDateString("en-IN", { month: "long", year: "numeric" }));
    }
    return [...seen.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [rows]);

  const q = search.trim().toLowerCase();
  const base = useMemo(
    () =>
      rows.filter((r) => {
        const d = dateOf(r);
        return (
          (!clinic || r.doctor_id === clinic) &&
          (!kind || r.kind === kind) &&
          (!month || (d !== null && monthKey(d) === month)) &&
          (!q ||
            [r.order_reference, r.subject, r.label, r.reference, r.doctor_name, r.clinic_name].some((v) =>
              (v ?? "").toLowerCase().includes(q),
            ))
        );
      }),
    [rows, clinic, kind, month, q],
  );

  const counts = useMemo(
    () =>
      Object.fromEntries(
        CUTS.map((c) => [c.key, c.key === "all" ? base.length : base.filter((r) => r.status === c.key).length]),
      ) as Record<Cut, number>,
    [base],
  );

  const shown = useMemo(() => {
    const out = base.filter((r) => cut === "all" || r.status === cut);
    return out.sort((a, b) => {
      if (sort === "amount") return Number(b.total) - Number(a.total);
      if (sort === "action") {
        const d = (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9);
        if (d !== 0) return d;
        // Receipts are checked oldest first; everything else newest first.
        if (a.status === "SUBMITTED") return (dateOf(a) ?? "").localeCompare(dateOf(b) ?? "");
      }
      return (dateOf(b) ?? "9999").localeCompare(dateOf(a) ?? "9999");
    });
  }, [base, cut, sort]);

  const total = shown.reduce((n, r) => n + Number(r.total), 0);
  const any = cut !== "all" || Boolean(clinic) || Boolean(kind) || Boolean(month);
  function clear() {
    setCut("all");
    setClinic("");
    setKind("");
    setMonth("");
  }

  return (
    <section className="py-section" id="lp-list" aria-labelledby="lp-list-title">
      <header className="py-head">
        <div>
          <span className="py-kicker">The book</span>
          <h2 id="lp-list-title">Every charge</h2>
        </div>
        <div className="py-tools">
          <span className="search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input
              placeholder="Case, clinic, patient or UPI reference"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search charges"
            />
          </span>
          <label className="pick">
            <span>Order</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="action">Needs the lab first</option>
              <option value="newest">Newest first</option>
              <option value="amount">Largest first</option>
            </select>
          </label>
          <button type="button" className="py-csv" disabled={shown.length === 0} onClick={() => downloadCsv(shown)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />
            </svg>
            Download CSV
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
              {c.key === "SUBMITTED" && counts.SUBMITTED > 0 && <span className="cut-dot" aria-hidden="true" />}
              {c.key === "REJECTED" && counts.REJECTED > 0 && <span className="cut-dot bad" aria-hidden="true" />}
              {c.label}
              <span className="cut-n">{counts[c.key]}</span>
            </button>
          ))}
        </div>

        <span className="console-rule" aria-hidden="true" />

        {clinics.length > 1 && (
          <label className="pick">
            <span>Clinic</span>
            <select value={clinic} onChange={(e) => setClinic(e.target.value)}>
              <option value="">Every clinic</option>
              {clinics.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}

        {kinds.length > 1 && (
          <label className="pick">
            <span>For</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Any charge</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {KIND_NAME[k] ?? k}
                </option>
              ))}
            </select>
          </label>
        )}

        {months.length > 0 && (
          <label className="pick">
            <span>Month</span>
            <select value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="">Any month</option>
              {months.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}

        {any && (
          <button type="button" className="btn-link clear" onClick={clear}>
            Clear filters
          </button>
        )}

        <span className="tally-say">
          {shown.length} {shown.length === 1 ? "charge" : "charges"} · {money(total)}
        </span>
      </section>

      {rows.length === 0 ? (
        <p className="py-empty">The lab has not raised a charge yet.</p>
      ) : shown.length === 0 ? (
        <p className="py-empty">
          No charge matches these filters.{" "}
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              clear();
              setSearch("");
            }}
          >
            Show every charge
          </button>
        </p>
      ) : (
        <div className="case-table pyt lpt">
          <table>
            <thead>
              <tr>
                <th className="col-charge">Charge</th>
                <th className="col-clinic">Clinic</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Date</th>
                <th>Receipt</th>
                <th aria-label="Action" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const d = dateOf(r);
                return (
                  <tr
                    key={r.id}
                    className={`clickable${r.status === "SUBMITTED" ? " wants" : ""}${r.status === "REJECTED" ? " bad" : ""}`}
                    onClick={() => onOpen(r.id)}
                  >
                    <td className="col-charge">
                      <span className="pyt-charge">
                        <span className={`py-kind xs ${r.status.toLowerCase()}`}>{KIND_ICON[r.kind]}</span>
                        <span className="py-what">
                          <b>{r.label}</b>
                          <span>
                            <span className="mono">{r.order_reference}</span> · {r.subject}
                          </span>
                          {r.status === "REJECTED" && r.rejected_reason && <span className="py-why">{r.rejected_reason}</span>}
                        </span>
                      </span>
                    </td>
                    <td className="col-clinic" title={[r.clinic_name, r.doctor_name].filter(Boolean).join(" · ")}>
                      <span className="lc-clinic">
                        <b>{r.clinic_name || r.doctor_name}</b>
                        {r.clinic_name && <span>{r.doctor_name}</span>}
                      </span>
                    </td>
                    <td className="pyt-amt">
                      <b>{money(r.total)}</b>
                      {Number(r.shipping_amount) > 0 && <small>incl. {money(r.shipping_amount)} delivery</small>}
                    </td>
                    <td>
                      <span className={STATUS_PILL[r.status] ?? "pill"}>{r.status_label}</span>
                    </td>
                    <td className="col-when" title={d ? formatDate(d) : undefined}>
                      {d ? shortDay(d) : "—"}
                      {d && <small>{r.status === "VERIFIED" ? "confirmed" : "sent"}</small>}
                    </td>
                    <td className="pyt-ref">
                      {r.proof_file_id ? (
                        <a
                          href={api.previewUrl(r.order_id, r.proof_file_id)}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {r.reference || "Screenshot"}
                        </a>
                      ) : (
                        r.reference || <span className="dim">—</span>
                      )}
                    </td>
                    <td className="pyt-act">
                      <span className={`pyt-btn ${r.status === "SUBMITTED" ? "due" : r.status.toLowerCase()}`}>
                        {ACTION[r.status] ?? "Open"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="col-charge">
                  {shown.length} {shown.length === 1 ? "charge" : "charges"} shown
                </td>
                <td />
                <td className="pyt-amt">
                  <b>{money(total)}</b>
                </td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

/** One charge, opened: whose it is, the screenshot, and the decision. */
function ChargePanel({ entry: e, onClose }: { entry: LedgerEntry; onClose: () => void }) {
  const eyebrow =
    e.status === "SUBMITTED"
      ? "Receipt to check"
      : e.status === "VERIFIED"
        ? "Received"
        : e.status === "REJECTED"
          ? "Receipt not accepted"
          : "Owed to the lab";
  return (
    <Drawer
      eyebrow={eyebrow}
      title={money(e.total)}
      sub={
        <>
          {e.label} ·{" "}
          <Link to={`/staff/orders/${e.order_id}`} onClick={onClose}>
            {e.order_reference}
          </Link>{" "}
          · {e.subject}
        </>
      }
      onClose={onClose}
    >
      <section className="dw-section">
        <h3>Whose</h3>
        <dl className="dw-dl">
          <div>
            <dt>Clinic</dt>
            <dd>{e.clinic_name || "—"}</dd>
          </div>
          <div>
            <dt>Doctor</dt>
            <dd>{e.doctor_name}</dd>
          </div>
          <div>
            <dt>Case stage</dt>
            <dd>{e.order_status_label}</dd>
          </div>
          <div>
            <dt>For</dt>
            <dd>{e.kind_label || KIND_NAME[e.kind] || e.label}</dd>
          </div>
          {e.submitted_at && (
            <div>
              <dt>Receipt sent</dt>
              <dd>{formatDate(e.submitted_at)}</dd>
            </div>
          )}
          {e.verified_at && (
            <div>
              <dt>Confirmed</dt>
              <dd>{formatDate(e.verified_at)}</dd>
            </div>
          )}
        </dl>
      </section>

      {e.proof_file_id && (
        <section className="dw-section">
          <h3>The screenshot</h3>
          <a className="lp-proof" href={api.previewUrl(e.order_id, e.proof_file_id)} target="_blank" rel="noreferrer">
            <img
              src={api.previewUrl(e.order_id, e.proof_file_id)}
              alt="Payment receipt"
              onError={(ev) => {
                ev.currentTarget.style.display = "none";
              }}
            />
            <span>
              <b>Open the receipt</b>
              <small>{e.reference ? `UPI reference ${e.reference}` : "No UPI reference given"}</small>
            </span>
          </a>
        </section>
      )}

      <section className="dw-section">
        <h3>{e.status === "SUBMITTED" ? "Check it against the bank" : "The charge"}</h3>
        <VerifyRow orderId={e.order_id} payment={e} />
      </section>
    </Drawer>
  );
}
