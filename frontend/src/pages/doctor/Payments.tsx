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
 *   the open charges as one list, the ones that went wrong first;
 *   each charge opening into a panel that pays it — a UPI code to scan from
 *   the desk, or the UPI app on a phone, and then the screenshot;
 *   and the paid history by month, with a chart and a file for the accountant.
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
import type { LedgerEntry, StatsBucket } from "../../api";
import { useAuth } from "../../auth";
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
  const year = new Date().getFullYear();
  const stats = useQuery({
    queryKey: ["stats", "payments", year],
    // The month is ignored for a year view; the call asks for one all the same.
    queryFn: () => api.practiceStats({ view: "year", year, month: new Date().getMonth() + 1 }),
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const data = ledger.data;
  const history = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = [...(data?.history ?? [])].sort((a, b) =>
      (b.verified_at ?? b.submitted_at ?? "").localeCompare(a.verified_at ?? a.submitted_at ?? ""),
    );
    if (!q) return rows;
    return rows.filter((r) =>
      [r.order_reference, r.subject, r.label, r.reference].some((v) => (v ?? "").toLowerCase().includes(q)),
    );
  }, [data, search]);

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
  const opened = data.pending.find((p) => p.id === openId) ?? null;
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

      {data.pending.length > 0 && (
        <section className="py-section" aria-labelledby="py-open-title">
          <header className="py-head">
            <div>
              <span className="py-kicker">Open charges</span>
              <h2 id="py-open-title">To pay</h2>
            </div>
            <span className="py-head-sum">
              <b>{data.pending.length}</b> open · <b>{money(due)}</b> due
              {review > 0 && (
                <>
                  {" "}
                  · <b>{money(review)}</b> being checked
                </>
              )}
            </span>
          </header>

          {/* The ones that went wrong first: money has already left the
              account against them and the charge is still open. */}
          {rejected.length > 0 && (
            <ChargeGroup
              title="Receipt not accepted"
              note="Send a new screenshot for these."
              tone="bad"
              rows={rejected}
              onOpen={setOpenId}
            />
          )}
          {toPay.length > 0 && <ChargeGroup title="Awaiting payment" rows={toPay} onOpen={setOpenId} />}
          {checking.length > 0 && (
            <ChargeGroup
              title="Being checked by 3D Align"
              note="Nothing else is needed from you."
              tone="wait"
              rows={checking}
              onOpen={setOpenId}
            />
          )}
        </section>
      )}

      <section className="py-section" aria-labelledby="py-paid-title">
        <header className="py-head">
          <div>
            <span className="py-kicker">History</span>
            <h2 id="py-paid-title">Paid</h2>
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
                aria-label="Search payments"
              />
            </span>
            <button
              type="button"
              className="py-csv"
              disabled={history.length === 0}
              onClick={() => downloadCsv(history, data.financial_year)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />
              </svg>
              Download CSV
            </button>
          </div>
        </header>

        <PaidChart series={stats.data?.series ?? []} year={year} paidTotal={Number(data.paid_total)} />
        <History rows={history} searching={Boolean(search.trim())} />
      </section>

      {opened && <PaySheet entry={opened} onClose={() => setOpenId(null)} />}
    </main>
  );
}

function ChargeGroup({
  title,
  note,
  tone,
  rows,
  onOpen,
}: {
  title: string;
  note?: string;
  tone?: "bad" | "wait";
  rows: LedgerEntry[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className={`py-group${tone ? ` ${tone}` : ""}`}>
      <div className="py-group-head">
        <b>{title}</b>
        {note && <span>{note}</span>}
      </div>
      <ul className="py-rows">
        {rows.map((e) => (
          <li key={e.id} className={`py-row ${e.status.toLowerCase()}`}>
            <button type="button" className="py-row-hit" onClick={() => onOpen(e.id)}>
              <span className="py-kind">{KIND_ICON[e.kind]}</span>
              <span className="py-what">
                <b>{e.label}</b>
                <span>
                  <span className="mono">{e.order_reference}</span> · {e.subject} · {e.order_status_label}
                </span>
                {e.status === "REJECTED" && e.rejected_reason && <span className="py-why">{e.rejected_reason}</span>}
              </span>
              <span className="py-amt">
                <b>{money(e.total)}</b>
                {Number(e.shipping_amount) > 0 && (
                  <small>
                    {money(e.amount)} + {money(e.shipping_amount)} delivery
                  </small>
                )}
              </span>
              <span className="py-act">
                {e.status === "SUBMITTED" ? "View receipt" : e.status === "REJECTED" ? "Send again" : "Pay"}
                <Arrow />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the practice paid each month this year. A single series, so no legend
    — the caption names it — and each bar says its month and amount on hover.
    Months still to come are drawn flat. */
function PaidChart({ series, year, paidTotal }: { series: StatsBucket[]; year: number; paidTotal: number }) {
  if (series.length === 0) return null;
  const values = series.map((b) => Number(b.paid));
  const max = Math.max(...values);
  const total = values.reduce((a, b) => a + b, 0);
  const now = new Date().getMonth();
  return (
    <figure className="py-chart">
      <figcaption>
        <span>Paid by month, {year}</span>
        <span className="py-chart-sum">
          <b>{money(total)}</b> this year · {money(paidTotal)} in all
        </span>
      </figcaption>
      <div className="py-bars">
        {series.map((b, i) => {
          const value = values[i];
          const ahead = series.length === 12 && i > now;
          const current = series.length === 12 && i === now;
          return (
            <div
              key={b.key}
              className={`py-bar${current ? " now" : ""}${ahead ? " ahead" : ""}`}
              title={`${b.label}: ${money(value)}`}
            >
              <span className="py-bar-val">{value > 0 && (current || value === max) ? money(value) : ""}</span>
              <span className="py-bar-col">
                <i style={{ height: max > 0 ? `${value > 0 ? Math.max(6, (value / max) * 100) : 0}%` : "0%" }} />
              </span>
              <span className="py-bar-m">{b.label.slice(0, 3)}</span>
            </div>
          );
        })}
      </div>
    </figure>
  );
}

/** Settled charges by the month they were confirmed, newest first. */
function History({ rows, searching }: { rows: LedgerEntry[]; searching: boolean }) {
  if (rows.length === 0) {
    return <p className="py-empty">{searching ? "No payment matches that." : "No confirmed payments yet."}</p>;
  }
  const months: { key: string; label: string; rows: LedgerEntry[]; total: number }[] = [];
  for (const r of rows) {
    const when = new Date(r.verified_at ?? r.submitted_at ?? "");
    const key = `${when.getFullYear()}-${when.getMonth()}`;
    let m = months.find((x) => x.key === key);
    if (!m) {
      m = {
        key,
        label: when.toLocaleDateString("en-IN", { month: "long", year: "numeric" }),
        rows: [],
        total: 0,
      };
      months.push(m);
    }
    m.rows.push(r);
    m.total += Number(r.total);
  }
  return (
    <div className="py-history">
      {months.map((m) => (
        <section key={m.key} className="py-month">
          <header>
            <b>{m.label}</b>
            <span>
              {m.rows.length} payment{m.rows.length === 1 ? "" : "s"} · {money(m.total)}
            </span>
          </header>
          <ul>
            {m.rows.map((r) => {
              const when = new Date(r.verified_at ?? r.submitted_at ?? "");
              return (
                <li key={r.id}>
                  <span className="py-h-date">
                    <b>{when.getDate()}</b>
                    <small>{when.toLocaleDateString("en-IN", { weekday: "short" })}</small>
                  </span>
                  <span className="py-kind sm">{KIND_ICON[r.kind]}</span>
                  <span className="py-what">
                    <b>{r.label}</b>
                    <span>
                      <Link to={`/orders/${r.order_id}`} className="mono">
                        {r.order_reference}
                      </Link>{" "}
                      · {r.subject}
                    </span>
                  </span>
                  <span className="py-h-ref">
                    {r.proof_file_id ? (
                      <a href={`/api/orders/${r.order_id}/files/${r.proof_file_id}`} target="_blank" rel="noreferrer">
                        {r.reference || "Receipt"}
                      </a>
                    ) : (
                      r.reference || "—"
                    )}
                  </span>
                  <span className="py-h-amt">{money(r.total)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** One charge, opened to be paid: the code to scan or the app to open, then
    the screenshot. A charge whose receipt is with the lab shows that instead. */
function PaySheet({ entry: e, onClose }: { entry: LedgerEntry; onClose: () => void }) {
  const queryClient = useQueryClient();
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
            <span className="py-eyebrow">{e.status === "SUBMITTED" ? "Receipt with 3D Align" : "Pay 3D Align"}</span>
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
