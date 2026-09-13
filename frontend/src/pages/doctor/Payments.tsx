/* What the practice owes 3D Align, how to pay it, and what it has paid.
 *
 * A doctor comes here with one of three questions: how much do I owe, how do I
 * pay this one, and what did I pay last month. The page used to answer all
 * three with the same stack of cards — every charge carried its own gold pay
 * button, file picker, reference box and send button, so five charges meant
 * twenty controls on the screen at once, and "Pay now" only ever worked on a
 * phone.
 *
 * Now:
 *   the balance, set large, with the money split into due, being checked and
 *   paid, and who to pay;
 *   every charge, open and settled, in one list with the case list's filters —
 *   status, what it is for, month, search — and a file for the accountant;
 *   each charge opening into a panel that pays it — a UPI code to scan from
 *   the desk, or the UPI app on a phone, and then the screenshot;
 *
 * Nothing here raises or settles a charge. The screenshot goes through the same
 * endpoint the case page uses, and the lab still confirms each one.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import qrcode from "qrcode-generator";

import { api, formatDate } from "../../api";
import type { LedgerEntry } from "../../api";
import { useAuth } from "../../auth";
import { useToast } from "../../components/Toast";
import { ErrorText, Loading } from "../../components/ui";

/** ₹52,130 for a whole amount, ₹16,926.67 when there are paise — a doctor pays
    the exact figure, so the paise are never rounded away. */
function money(value: string | number): string {
  const n = Number(value);
  const whole = Number.isInteger(Math.round(n * 100) / 100);
  return `₹${n.toLocaleString("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Who the money goes to, read off the UPI link the lab publishes. */
function payee(link: string): { vpa: string; name: string } | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    const vpa = url.searchParams.get("pa") ?? "";
    return vpa ? { vpa, name: url.searchParams.get("pn") ?? "" } : null;
  } catch {
    return null;
  }
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const Arrow = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

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

/** A UPI code for one charge. The same upi:// link a phone opens, drawn as a
    code a phone can read off the desk screen — payee and amount filled in. */
function Qr({ text }: { text: string }) {
  const code = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    }
    return { n, d };
  }, [text]);
  return (
    <svg className="py-qr" viewBox={`-2 -2 ${code.n + 4} ${code.n + 4}`} role="img" aria-label="UPI payment code">
      <rect x={-2} y={-2} width={code.n + 4} height={code.n + 4} fill="#ffffff" />
      <path d={code.d} fill="#0b0b0c" shapeRendering="crispEdges" />
    </svg>
  );
}

function CopyButton({ value, label, className = "py-copy" }: { value: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        } catch {
          /* A browser refusing the clipboard leaves the value on screen to copy by hand. */
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

/** The paid history as a file, for whoever keeps the practice's books. */
function downloadCsv(rows: LedgerEntry[], fy: string) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [
    ["Paid on", "Case", "Patient or item", "For", "Amount", "Delivery", "Total", "UPI reference"].map(esc).join(","),
    ...rows.map((r) =>
      [
        (r.verified_at ?? r.submitted_at ?? "").slice(0, 10),
        r.order_reference,
        r.subject,
        r.label,
        Number(r.amount).toFixed(2),
        Number(r.shipping_amount).toFixed(2),
        Number(r.total).toFixed(2),
        r.reference,
      ]
        .map((v) => esc(String(v)))
        .join(","),
    ),
  ];
  // The byte-order mark makes Excel read the rupee sign and names correctly.
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // Plain ASCII in the name: "FY 2026–27" carries an en dash some systems mangle.
  a.download = `3d-align-payments-${fy.replace(/[\s–—]+/g, "-").toLowerCase() || "all"}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Payments() {
  const { me } = useAuth();
  const ledger = useQuery({ queryKey: ["payment-ledger"], queryFn: api.paymentLedger });
  const [openId, setOpenId] = useState<string | null>(null);

  const data = ledger.data;

  if (ledger.isLoading) return <Loading what="payments" />;
  if (!data) return null;

  const due = Number(data.outstanding);
  const review = Number(data.in_review);
  const paidFy = Number(data.paid_this_year);
  const rejected = data.pending.filter((p) => p.status === "REJECTED");
  const toPay = data.pending.filter((p) => p.status === "DUE").sort((a, b) => Number(b.total) - Number(a.total));
  const checking = data.pending.filter((p) => p.status === "SUBMITTED");
  const owing = [...rejected, ...toPay];
  const owingCases = new Set(owing.map((p) => p.order_id)).size;
  const to = payee(data.pending.find((p) => p.upi_link)?.upi_link ?? "");
  const opened = [...data.pending, ...data.history].find((p) => p.id === openId) ?? null;
  const clinic = me?.doctor?.clinic_name;

  return (
    <main className="page py">
      {/* The balance, said as a sentence and set large — the one figure the
          page exists for — with the money it is part of drawn under it. */}
      <section className="py-hero">
        <div className="py-say">
          <span className="py-eyebrow">Payments{clinic ? ` · ${clinic}` : ""}</span>
          <h1>
            {due > 0 ? (
              <>
                You owe 3D Align <em>{money(due)}</em>.
              </>
            ) : review > 0 ? (
              <>
                Nothing to pay. <em>{money(review)}</em> is with the lab.
              </>
            ) : (
              <>
                You are all <em>settled.</em>
              </>
            )}
          </h1>
          <p className="py-sub">
            {owing.length > 0
              ? `Across ${owing.length} charge${owing.length === 1 ? "" : "s"} on ${owingCases} case${owingCases === 1 ? "" : "s"}. Pay each by UPI and send the screenshot — 3D Align confirms it and the case moves on.`
              : checking.length > 0
                ? "Your receipts are being checked. Nothing else is needed from you."
                : "Every charge on this practice has been paid and confirmed."}
          </p>

          {due + review + paidFy > 0 && (
            <div className="py-meter">
              <div
                className="py-meter-bar"
                role="img"
                aria-label={`${money(due)} due, ${money(review)} being checked, ${money(paidFy)} paid in ${data.financial_year}`}
              >
                {[
                  ["due", due],
                  ["review", review],
                  ["paid", paidFy],
                ].map(([key, value]) =>
                  Number(value) > 0 ? (
                    <i
                      key={key as string}
                      className={key as string}
                      style={{ width: `${Math.max(2, (Number(value) / (due + review + paidFy)) * 100)}%` }}
                    />
                  ) : null,
                )}
              </div>
              <ul className="py-meter-key">
                <li className="due">
                  <span>Due now</span>
                  <b>{money(due)}</b>
                </li>
                <li className="review">
                  <span>Being checked</span>
                  <b>{money(review)}</b>
                </li>
                <li className="paid">
                  <span>Paid {data.financial_year}</span>
                  <b>{money(paidFy)}</b>
                </li>
              </ul>
            </div>
          )}
        </div>

        <aside className="py-payto" aria-label="How to pay">
          <span className="py-eyebrow">Pay to</span>
          {to ? (
            <>
              <b className="py-payee">{to.name || "3D Align"}</b>
              <div className="py-vpa">
                <span className="mono">{to.vpa}</span>
                <CopyButton value={to.vpa} label="Copy UPI ID" />
              </div>
            </>
          ) : (
            <p className="py-noupi">3D Align has not published a UPI ID yet. Contact the lab to pay.</p>
          )}
          {to && owing.length > 0 && (
            /* The code for the charge that is next to pay, in the panel that
               says who to pay. The page told clinics to scan "a charge's code"
               and then made them hunt one down the list; the commonest case is
               one charge, and this is it. Each charge keeps its own code, so
               nothing here replaces them. */
            <div className="py-payqr">
              <Qr text={owing[0].upi_link} />
              <div className="py-payqr-say">
                <b>{money(Number(owing[0].total))}</b>
                <span>
                  {owing[0].label}
                  {owing[0].order_reference ? ` · ${owing[0].order_reference}` : ""}
                </span>
                <small>
                  {owing.length === 1
                    ? "Scan it, then send the screenshot below."
                    : `The first of ${owing.length} charges — the rest carry their own codes below.`}
                </small>
              </div>
            </div>
          )}

          <ol className="py-steps">
            <li>
              <b>Pay by UPI</b>
              <span>Scan a charge's code from this screen, or open your UPI app on a phone — the amount is filled in.</span>
            </li>
            <li>
              <b>Send the screenshot</b>
              <span>Attach it to the charge, here.</span>
            </li>
            <li>
              <b>3D Align confirms it</b>
              <span>And the case carries on.</span>
            </li>
          </ol>
        </aside>
      </section>

      {/* Every charge, open and settled, in the same list-and-filters shape as
          the case and patient lists. */}
      <ChargeList rows={[...data.pending, ...data.history]} fy={data.financial_year} onOpen={setOpenId} />

      {opened && <PaySheet entry={opened} onClose={() => setOpenId(null)} />}
    </main>
  );
}

type Cut = "all" | "DUE" | "REJECTED" | "SUBMITTED" | "VERIFIED";

const CUTS: { key: Cut; label: string }[] = [
  { key: "all", label: "All" },
  { key: "DUE", label: "To pay" },
  { key: "REJECTED", label: "Not accepted" },
  { key: "SUBMITTED", label: "Being checked" },
  { key: "VERIFIED", label: "Paid" },
];

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

/** What wants the clinic first: a receipt that bounced, then what is owed. */
const RANK: Record<string, number> = { REJECTED: 0, DUE: 1, SUBMITTED: 2, VERIFIED: 3 };

const ACTION: Record<string, string> = {
  DUE: "Pay",
  REJECTED: "Send again",
  SUBMITTED: "View",
  VERIFIED: "Receipt",
};

/** When anything happened to a charge: confirmed, or at least sent. A charge
    still waiting to be paid has neither. */
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

type Sort = "action" | "newest" | "amount";

/** Every charge on the practice, open and settled, in one list — the same
    filter strip and table as the case and patient lists, so money reads the
    way the rest of the portal does. A row opens the charge: to pay it, to see
    the receipt that is being checked, or to see what was paid. */
function ChargeList({
  rows,
  fy,
  onOpen,
}: {
  rows: LedgerEntry[];
  fy: string;
  onOpen: (id: string) => void;
}) {
  const [cut, setCut] = useState<Cut>("all");
  const [kind, setKind] = useState("");
  const [month, setMonth] = useState("");
  const [sort, setSort] = useState<Sort>("action");
  const [search, setSearch] = useState("");

  // Only what the practice actually has, so no menu offers an empty answer.
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
          (!kind || r.kind === kind) &&
          (!month || (d !== null && monthKey(d) === month)) &&
          (!q || [r.order_reference, r.subject, r.label, r.reference].some((v) => (v ?? "").toLowerCase().includes(q)))
        );
      }),
    [rows, kind, month, q],
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
        const d = RANK[a.status] - RANK[b.status];
        if (d !== 0) return d;
      }
      // A charge still open has no date yet; it is the newest thing there is.
      return (dateOf(b) ?? "9999").localeCompare(dateOf(a) ?? "9999");
    });
  }, [base, cut, sort]);

  const total = shown.reduce((n, r) => n + Number(r.total), 0);
  const any = cut !== "all" || Boolean(kind) || Boolean(month);
  function clear() {
    setCut("all");
    setKind("");
    setMonth("");
  }

  return (
    <section className="py-section" aria-labelledby="py-list-title">
      <header className="py-head">
        <div>
          <span className="py-kicker">Every charge</span>
          <h2 id="py-list-title">Charges and payments</h2>
        </div>
        <div className="py-tools">
          <span className="search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input
              placeholder="Case, patient or UPI reference"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search charges"
            />
          </span>
          <label className="pick">
            <span>Order</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="action">Needs you first</option>
              <option value="newest">Newest first</option>
              <option value="amount">Largest first</option>
            </select>
          </label>
          <button type="button" className="py-csv" disabled={shown.length === 0} onClick={() => downloadCsv(shown, fy)}>
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
              {c.key === "DUE" && <span className="cut-dot" aria-hidden="true" />}
              {c.key === "REJECTED" && counts.REJECTED > 0 && <span className="cut-dot bad" aria-hidden="true" />}
              {c.label}
              <span className="cut-n">{counts[c.key]}</span>
            </button>
          ))}
        </div>

        <span className="console-rule" aria-hidden="true" />

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
        <p className="py-empty">Nothing has been charged to this practice yet.</p>
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
        <div className="case-table pyt">
          <table>
            <thead>
              <tr>
                <th className="col-charge">Charge</th>
                <th>Case stage</th>
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
                    className={`clickable${r.status === "DUE" ? " wants" : ""}${r.status === "REJECTED" ? " bad" : ""}`}
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
                          {r.status === "REJECTED" && r.rejected_reason && (
                            <span className="py-why">{r.rejected_reason}</span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td className="pyt-stage">{r.order_status_label}</td>
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
                          href={`/api/orders/${r.order_id}/files/${r.proof_file_id}`}
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
                      <span className={`pyt-btn ${r.status.toLowerCase()}`}>{ACTION[r.status] ?? "Open"}</span>
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

/** One charge, opened to be paid: the code to scan or the app to open, then
    the screenshot. A charge whose receipt is with the lab shows that instead. */
function PaySheet({ entry: e, onClose }: { entry: LedgerEntry; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [reference, setReference] = useState("");
  const [dragging, setDragging] = useState(false);
  const [sent, setSent] = useState(false);
  const to = payee(e.upi_link);
  const delivery = Number(e.shipping_amount) > 0;

  // A picked screenshot is shown back, so the clinic can see it chose the
  // right one before sending it.
  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const send = useMutation({
    mutationFn: () => api.payProof(e.order_id, e.id, file!, reference),
    onSuccess: () => {
      setSent(true);
      toast({ title: "Receipt sent", body: `${money(e.total)} · ${e.label}. 3D Align will confirm it.` });
      void queryClient.invalidateQueries({ queryKey: ["order", e.order_id] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["payment-ledger"] });
    },
  });

  /* Into the body: `.page` animates a transform, which would otherwise make it
     the containing block for this fixed panel. */
  return createPortal(
    <div
      className="pt-backdrop"
      role="presentation"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <aside className="py-sheet" role="dialog" aria-modal="true" aria-label={`Pay ${e.label}`}>
        <header className="py-sheet-head">
          <div>
            <span className="py-eyebrow">{e.status === "VERIFIED" ? "Paid to 3D Align" : e.status === "SUBMITTED" ? "Receipt with 3D Align" : "Pay 3D Align"}</span>
            <b className="py-sheet-amt">{money(e.total)}</b>
            <p>
              {e.label} ·{" "}
              <Link to={`/orders/${e.order_id}`} onClick={onClose}>
                {e.order_reference}
              </Link>{" "}
              · {e.subject}
            </p>
          </div>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className="py-sheet-body">
          {sent ? (
            <div className="py-done">
              <i aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
              </i>
              <b>Receipt sent</b>
              <p>3D Align will check it and confirm the payment. Nothing else is needed from you.</p>
              <button type="button" className="py-send" onClick={onClose}>
                Done
              </button>
            </div>
          ) : e.status === "VERIFIED" ? (
            <div className="py-done">
              <i aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
              </i>
              <b>Paid</b>
              <p>
                Confirmed by 3D Align{e.verified_at ? ` on ${formatDate(e.verified_at)}` : ""}
                {e.reference ? ` · UPI reference ${e.reference}` : ""}.
              </p>
              {e.proof_file_id && (
                <a className="py-csv" href={`/api/orders/${e.order_id}/files/${e.proof_file_id}`} target="_blank" rel="noreferrer">
                  View the screenshot
                </a>
              )}
            </div>
          ) : e.status === "SUBMITTED" ? (
            <div className="py-done wait">
              <i aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="8.5" />
                  <path d="M12 7.5V12l3 2" />
                </svg>
              </i>
              <b>Being checked</b>
              <p>
                Receipt sent{e.submitted_at ? ` ${formatDate(e.submitted_at)}` : ""}
                {e.reference ? ` · UPI reference ${e.reference}` : ""}. 3D Align is checking it — nothing else is
                needed from you.
              </p>
              {e.proof_file_id && (
                <a className="py-csv" href={`/api/orders/${e.order_id}/files/${e.proof_file_id}`} target="_blank" rel="noreferrer">
                  View the screenshot you sent
                </a>
              )}
            </div>
          ) : (
            <>
              {e.status === "REJECTED" && (
                <p className="py-rejected">
                  <b>The last receipt was not accepted.</b> {e.rejected_reason}
                </p>
              )}

              <section className="py-step">
                <span className="py-step-n">Step 1</span>
                <h3>Pay {money(e.total)} by UPI</h3>
                {e.upi_link ? (
                  <div className="py-upi">
                    <div className="py-qr-wrap">
                      <Qr text={e.upi_link} />
                      <span>Scan with any UPI app</span>
                    </div>
                    <div className="py-upi-say">
                      <dl className="py-break">
                        <div>
                          <dt>{e.kind_label || e.label}</dt>
                          <dd>{money(e.amount)}</dd>
                        </div>
                        {delivery && (
                          <div>
                            <dt>Delivery</dt>
                            <dd>{money(e.shipping_amount)}</dd>
                          </div>
                        )}
                        <div className="total">
                          <dt>Total</dt>
                          <dd>{money(e.total)}</dd>
                        </div>
                      </dl>
                      {to && (
                        <div className="py-vpa">
                          <span className="mono">{to.vpa}</span>
                          <CopyButton value={to.vpa} label="Copy" />
                        </div>
                      )}
                      <div className="py-upi-do">
                        <a className="py-upi-open" href={e.upi_link}>
                          Open UPI app
                          <Arrow />
                        </a>
                        <CopyButton value={Number(e.total).toFixed(2)} label="Copy amount" className="py-copy ghost" />
                      </div>
                      <p className="py-hint">
                        On a phone, Open UPI app fills in the payee and amount. At a computer, scan the code with
                        your phone.
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="py-rejected">3D Align has not published a UPI ID yet. Please contact the lab to pay.</p>
                )}
              </section>

              <section className="py-step">
                <span className="py-step-n">Step 2</span>
                <h3>Send the screenshot</h3>
                <label
                  className={`py-drop${dragging ? " on" : ""}${file ? " has" : ""}`}
                  onDragOver={(ev) => {
                    ev.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(ev) => {
                    ev.preventDefault();
                    setDragging(false);
                    const dropped = ev.dataTransfer.files?.[0];
                    if (dropped) setFile(dropped);
                  }}
                >
                  <input
                    ref={input}
                    type="file"
                    accept="image/*,application/pdf"
                    onChange={(ev) => setFile(ev.target.files?.[0] ?? null)}
                  />
                  {preview ? (
                    <img src={preview} alt="" />
                  ) : (
                    <svg className="up" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 16V5m0 0L8 9m4-4 4 4" />
                      <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
                    </svg>
                  )}
                  <span>
                    <b>{file ? file.name : "Choose the payment screenshot"}</b>
                    <small>{file ? "Click to choose a different one" : "or drop it here — an image or a PDF"}</small>
                  </span>
                </label>
                <label className="py-ref">
                  <span>UPI reference (optional)</span>
                  <input
                    value={reference}
                    onChange={(ev) => setReference(ev.target.value)}
                    placeholder="The 12-digit UTR from your UPI app"
                  />
                </label>
                <ErrorText error={send.error} />
                <button
                  type="button"
                  className="py-send"
                  disabled={!file || send.isPending}
                  onClick={() => send.mutate()}
                >
                  {send.isPending ? "Sending…" : "Send the receipt"}
                </button>
              </section>
            </>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
