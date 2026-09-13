/* The lab's front door.
 *
 * It was eight tiles of equal weight — new submissions beside doctors to
 * verify beside things in production — and a table of every open case under
 * them. Every number was the same size, so none of them said what to do first.
 *
 * Now it opens the way the clinic's home does, from the other side of the
 * counter: how much is on the lab's desk and what to start with, beside the
 * aligner journey drawn as an arch and lit where the lab is the one holding
 * cases up. Four figures follow, then the desk — the lab's work counted by
 * what has to be done, and today's scan visits — and every open case in the
 * same table as the case list.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api, formatMoney, formatTime, since, toISODate } from "../../api";
import type { OrderKind, OrderStatus, OrderSummary } from "../../api";
import { useAuth } from "../../auth";
import ArchPipeline, { stageCounts } from "../../components/ArchPipeline";
import LabCaseTable from "../../components/LabCaseTable";
import { Empty, Skeleton } from "../../components/ui";
import { everyStaffCase } from "../../fetchAll";
import { LAB_ASK, LAB_URGENCY, onLabDesk } from "../../workflow";

/** Rows drawn at once; more on request, so a busy lab is not one long page. */
const STEP = 25;

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function firstName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length > 1 && /^dr\.?$/i.test(parts[0])) return `${parts[0]} ${parts[parts.length - 1]}`;
  return parts[0];
}

const closed = (o: OrderSummary) => o.status === "COMPLETED" || o.status === "CANCELLED";

const Arrow = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

const Chevron = ({ className = "go" }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** One mark per kind of work, so the desk can be read by shape. */
const ICON = {
  review: (
    <Glyph>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </Glyph>
  ),
  quote: (
    <Glyph>
      <path d="M20 12 12 20l-8-8V4h8z" />
      <circle cx="8.5" cy="8.5" r="1.4" />
    </Glyph>
  ),
  scan: (
    <Glyph>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h10" />
    </Glyph>
  ),
  plan: (
    <Glyph>
      <path d="M12 3 21 8l-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </Glyph>
  ),
  photo: (
    <Glyph>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </Glyph>
  ),
  make: (
    <Glyph>
      <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9V3" />
      <path d="M7.5 14h9" />
    </Glyph>
  ),
  ship: (
    <Glyph>
      <path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5z" />
      <path d="M4 7.5 12 11l8-3.5M12 11v9" />
    </Glyph>
  ),
  issue: (
    <Glyph>
      <path d="M12 3.5 2.8 19.5h18.4z" />
      <path d="M12 10v4.5M12 17.2v.01" />
    </Glyph>
  ),
  money: (
    <Glyph>
      <path d="M6 5h12M6 9.5h12M9.5 5v3a4 4 0 0 1-4 4h-.5l7 7" />
    </Glyph>
  ),
  doctor: (
    <Glyph>
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
    </Glyph>
  ),
  visit: (
    <Glyph>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </Glyph>
  ),
  invoice: (
    <Glyph>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6" />
    </Glyph>
  ),
  clinic: (
    <Glyph>
      <path d="M4 20V9l8-5 8 5v11" />
      <path d="M10 20v-5h4v5" />
    </Glyph>
  ),
};

const STATUS_ICON: Partial<Record<OrderStatus, ReactNode>> = {
  FIT_ISSUE: ICON.issue,
  SCAN_SUBMITTED: ICON.scan,
  SUBMITTED: ICON.review,
  UNDER_REVIEW: ICON.quote,
  PHASE_REVIEW: ICON.photo,
  IN_PLANNING: ICON.plan,
  DISPATCHING: ICON.ship,
  TRAINING_ALIGNER_PRODUCTION: ICON.make,
  ALIGNER_PRODUCTION: ICON.make,
  PRODUCT_FABRICATION: ICON.make,
};

const VISIT_PILL: Record<string, string> = {
  ASSIGNED: "pill pill-gold",
  EN_ROUTE: "pill pill-dark",
  COMPLETED: "pill pill-ok",
  CANCELLED: "pill pill-danger",
  NO_SHOW: "pill pill-danger",
};

type Group = { status: OrderStatus; cases: OrderSummary[] };

/** What is on the desk, gathered by the thing to be done and ordered by what
    holds a patient up the most. */
function deskGroups(desk: OrderSummary[]): Group[] {
  const by = new Map<OrderStatus, OrderSummary[]>();
  for (const o of desk) by.set(o.status, [...(by.get(o.status) ?? []), o]);
  return LAB_URGENCY.filter((s) => by.has(s)).map((s) => ({ status: s, cases: by.get(s)! }));
}

/** How a group reads, and where it leads. One case opens that case; several
    open the case list at that stage. */
function sayGroup(g: Group): { label: string; to: string; oldest: OrderSummary } {
  const [one, many] = LAB_ASK[g.status]!;
  const oldest = g.cases.reduce((a, b) => (a.updated_at < b.updated_at ? a : b));
  return {
    label: g.cases.length === 1 ? one : many.replace("{n}", String(g.cases.length)),
    to: g.cases.length === 1 ? `/staff/orders/${g.cases[0].id}` : `/staff/orders?status=${g.status}`,
    oldest,
  };
}

/** The single most pressing thing, under the headline, so it can be acted on
    without scrolling. */
function LabNext({ group, loading }: { group?: Group; loading: boolean }) {
  const navigate = useNavigate();

  if (loading) return <div className="hm-next wait" aria-hidden="true" />;

  if (!group) {
    return (
      <div className="hm-next clear">
        <span className="hm-next-icon" aria-hidden="true">
          <Glyph>
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </Glyph>
        </span>
        <p className="hm-next-say">Nothing is waiting on the lab.</p>
        <p className="hm-next-note">New work lands here the moment a clinic sends it.</p>
      </div>
    );
  }

  const { label, to, oldest } = sayGroup(group);
  return (
    <div className="hm-next">
      <span className="hm-next-icon" aria-hidden="true">
        {STATUS_ICON[group.status] ?? ICON.make}
      </span>
      <p className="hm-next-say">
        <small>Start with</small>
        {label}
      </p>
      <p className="hm-next-note">
        {group.cases.length === 1
          ? `${oldest.patient_name || "Practice stock"} · ${oldest.clinic_name || oldest.doctor_name}`
          : `${group.cases.length} cases`}{" "}
        · waiting {since(oldest.updated_at)}
      </p>
      <button type="button" className="hm-next-go" onClick={() => navigate(to)}>
        {group.cases.length === 1 ? "Open" : "Work through"}
        <Arrow />
      </button>
    </div>
  );
}

/** One figure about the lab today, and the way to its detail. */
function Kpi({
  to,
  label,
  value,
  note,
  lit,
  icon,
}: {
  to: string;
  label: string;
  value: string;
  note: string;
  lit?: boolean;
  icon: ReactNode;
}) {
  return (
    <Link to={to} className={`hm-kpi${lit ? " lit" : ""}`}>
      <span className="hm-kpi-top">
        <span className="hm-kpi-icon">{icon}</span>
        <span className="hm-kpi-label">{label}</span>
      </span>
      <b className="hm-kpi-value">{value}</b>
      <span className="hm-kpi-note">{note}</span>
      <Chevron />
    </Link>
  );
}

type Cut = "desk" | "clinic" | "all";

const CUTS: { key: Cut; label: string }[] = [
  { key: "desk", label: "On our desk" },
  { key: "clinic", label: "With clinics" },
  { key: "all", label: "All open" },
];

/** Every open case, in the case list's own table, opened on what the lab has
    to do. Express work floats up; then the longest waiting. */
function OpenCases({ rows, loading, canAssign }: { rows: OrderSummary[]; loading: boolean; canAssign: boolean }) {
  const navigate = useNavigate();
  const [cut, setCut] = useState<Cut>("desk");
  const [kind, setKind] = useState<"" | OrderKind>("");
  const [express, setExpress] = useState(false);
  const [oldestFirst, setOldestFirst] = useState(true);
  const [shown, setShown] = useState(STEP);

  const base = useMemo(
    () => rows.filter((o) => (!kind || o.kind === kind) && (!express || o.priority === "EXPRESS")),
    [rows, kind, express],
  );
  const counts = useMemo(
    () => ({
      desk: base.filter(onLabDesk).length,
      clinic: base.filter((o) => o.needs_doctor_action).length,
      all: base.length,
    }),
    [base],
  );
  const list = useMemo(() => {
    const out = base.filter((o) => (cut === "all" ? true : cut === "desk" ? onLabDesk(o) : o.needs_doctor_action));
    return out.sort((a, b) => {
      const e = (a.priority === "EXPRESS" ? 0 : 1) - (b.priority === "EXPRESS" ? 0 : 1);
      if (e !== 0) return e;
      return oldestFirst ? a.updated_at.localeCompare(b.updated_at) : b.updated_at.localeCompare(a.updated_at);
    });
  }, [base, cut, oldestFirst]);

  // A new filter starts the list from the top again.
  useEffect(() => setShown(STEP), [cut, kind, express, oldestFirst]);

  return (
    <section className="lq-open" aria-labelledby="lq-open-title">
      <header className="py-head">
        <div>
          <span className="py-kicker">In flight</span>
          <h2 id="lq-open-title">Open cases</h2>
        </div>
        <Link to="/staff/orders" className="btn-link">
          Every case, open and closed
        </Link>
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
              {c.key === "desk" && <span className="cut-dot" aria-hidden="true" />}
              {c.label}
              <span className="cut-n">{loading ? "…" : counts[c.key]}</span>
            </button>
          ))}
        </div>

        <span className="console-rule" aria-hidden="true" />

        <label className="pick">
          <span>Type</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as "" | OrderKind)}>
            <option value="">Every type</option>
            <option value="ALIGNER">Aligner cases</option>
            <option value="PRODUCT">Appliances</option>
            <option value="ACCESSORY">Accessories</option>
          </select>
        </label>

        <button
          type="button"
          className={express ? "flag on" : "flag"}
          aria-pressed={express}
          onClick={() => setExpress((v) => !v)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" strokeLinejoin="round" />
          </svg>
          Express
        </button>

        <span className="tally-say">
          {list.length} {list.length === 1 ? "case" : "cases"}
        </span>

        <button type="button" className="sort" onClick={() => setOldestFirst((v) => !v)} title="Change the order of the list">
          {oldestFirst ? "Longest waiting" : "Most recent"}
          <span aria-hidden="true"> ⇅</span>
        </button>
      </section>

      {loading ? (
        <Skeleton rows={5} />
      ) : list.length === 0 ? (
        <Empty>
          {cut === "desk"
            ? "Nothing is on the lab's desk."
            : cut === "clinic"
              ? "No case is waiting on a clinic."
              : "Nothing in flight."}
        </Empty>
      ) : (
        <div className="stack">
          <LabCaseTable
            orders={list.slice(0, shown)}
            canAssign={canAssign}
            onOpen={(id) => navigate(`/staff/orders/${id}`)}
          />
          {list.length > shown && (
            <div className="pt-more">
              <button type="button" className="btn-ghost" onClick={() => setShown((n) => n + STEP)}>
                Show {Math.min(STEP, list.length - shown)} more
              </button>
              <span className="dim">
                {shown} of {list.length} shown
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default function StaffQueue() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const isOrtho = me?.role === "ORTHODONTIST";
  const canAssign = me?.role === "ADMIN";
  const today = toISODate(new Date());

  const queue = useQuery({ queryKey: ["queue"], queryFn: api.queue, refetchInterval: 60_000 });
  const cases = useQuery({
    queryKey: ["staff-orders", "every-case"],
    queryFn: () => everyStaffCase(),
    refetchInterval: 120_000,
  });
  const ledger = useQuery({ queryKey: ["staff-payments", ""], queryFn: () => api.labPayments() });
  const visits = useQuery({
    queryKey: ["bookings", "day", today],
    queryFn: () => api.bookings({ from: today, to: today }),
  });

  const all = useMemo(() => cases.data ?? [], [cases.data]);
  const open = useMemo(() => all.filter((o) => !closed(o)), [all]);
  const desk = useMemo(() => open.filter(onLabDesk), [open]);
  const withClinics = useMemo(() => open.filter((o) => o.needs_doctor_action), [open]);
  const groups = useMemo(() => deskGroups(desk), [desk]);
  const { stages, other } = useMemo(() => stageCounts(all, onLabDesk), [all]);

  const receipts = ledger.data?.to_verify ?? [];
  const pendingDoctors = queue.data?.pending_doctors ?? 0;
  const invoice = queue.data?.ready_to_invoice ?? 0;
  const dayVisits = [...(visits.data ?? [])].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const liveVisits = dayVisits.filter((v) => v.status !== "CANCELLED");
  const nextVisit = liveVisits.find(
    (v) => (v.status === "ASSIGNED" || v.status === "EN_ROUTE") && new Date(v.ends_at).getTime() > Date.now(),
  );
  const oldestDesk = desk.reduce<OrderSummary | null>((a, b) => (!a || b.updated_at < a.updated_at ? b : a), null);
  const loaded = !cases.isLoading;
  const name = firstName(me?.full_name ?? "");

  /* Work that is not a case at a stage, but still the lab's to do. */
  const extras = [
    receipts.length > 0 && {
      key: "receipts",
      icon: ICON.money,
      label: receipts.length === 1 ? "Check 1 payment receipt" : `Check ${receipts.length} payment receipts`,
      sub: `${formatMoney(ledger.data?.in_review ?? 0)} sent by clinics`,
      n: receipts.length,
      to: "/staff/payments",
    },
    pendingDoctors > 0 && {
      key: "doctors",
      icon: ICON.doctor,
      label: pendingDoctors === 1 ? "Verify 1 new doctor" : `Verify ${pendingDoctors} new doctors`,
      sub: "Council registration to check",
      n: pendingDoctors,
      to: "/staff/doctors",
    },
    invoice > 0 && {
      key: "invoice",
      icon: ICON.invoice,
      label: invoice === 1 ? "Invoice 1 delivered case" : `Invoice ${invoice} delivered cases`,
      sub: "Delivered and not yet invoiced",
      n: invoice,
      to: "/staff/orders",
    },
  ].filter(Boolean) as { key: string; icon: ReactNode; label: string; sub: string; n: number; to: string }[];

  return (
    <main className="page hm lq">
      <section className="hm-hero">
        <div className="hm-say">
          <span className="hm-greet">
            {greeting()} · {isOrtho ? "Planning" : "3D Align lab"}
          </span>

          <h1>
            {name && <>{name}, </>}
            {!loaded ? (
              name ? "welcome back." : "Welcome back."
            ) : desk.length > 0 ? (
              <>
                <em>
                  {desk.length} {desk.length === 1 ? "case is" : "cases are"}
                </em>{" "}
                on {isOrtho ? "your" : "the lab's"} desk.
              </>
            ) : (
              <>
                {name ? "the desk is" : "The desk is"} <em>clear.</em>
              </>
            )}
          </h1>

          <LabNext group={groups[0]} loading={cases.isLoading} />

          <div className="hm-do">
            <button type="button" className="hm-cta" onClick={() => navigate("/staff/orders")}>
              Open the case list
              <Arrow />
            </button>
            {receipts.length > 0 && (
              <button type="button" className="hm-ghost" onClick={() => navigate("/staff/payments")}>
                Check {receipts.length} {receipts.length === 1 ? "receipt" : "receipts"}
              </button>
            )}
            {pendingDoctors > 0 && (
              <button type="button" className="hm-ghost" onClick={() => navigate("/staff/doctors")}>
                Verify {pendingDoctors} {pendingDoctors === 1 ? "doctor" : "doctors"}
              </button>
            )}
          </div>
        </div>

        <ArchPipeline
          stages={stages}
          loading={cases.isLoading}
          label="Where the lab's aligner cases stand"
          centerLabel="Aligner cases in progress"
          centerNote={other > 0 ? `and ${other} product ${other === 1 ? "order" : "orders"}` : undefined}
          litNote={(n) => `${n} on our desk`}
          keys={["On the lab's desk", "With the clinic"]}
          onPick={() => navigate("/staff/orders")}
        />
      </section>

      <section className="hm-kpis" aria-label="The lab today">
        <Kpi
          to="/staff/orders"
          label="On our desk"
          value={loaded ? String(desk.length) : "—"}
          note={oldestDesk ? `Oldest waiting ${since(oldestDesk.updated_at)}` : "Nothing waiting"}
          lit={desk.length > 0}
          icon={ICON.make}
        />
        <Kpi
          to="/staff/orders"
          label="With clinics"
          value={loaded ? String(withClinics.length) : "—"}
          note="Waiting on a clinic to act"
          icon={ICON.clinic}
        />
        <Kpi
          to="/staff/payments"
          label="Receipts to check"
          value={ledger.isLoading ? "—" : String(receipts.length)}
          note={receipts.length > 0 ? `${formatMoney(ledger.data?.in_review ?? 0)} waiting on us` : "Nothing to check"}
          lit={receipts.length > 0}
          icon={ICON.money}
        />
        <Kpi
          to="/staff/bookings"
          label="Scan visits today"
          value={visits.isLoading ? "—" : String(liveVisits.length)}
          note={
            nextVisit
              ? `Next at ${formatTime(nextVisit.starts_at)}`
              : liveVisits.length > 0
                ? "All done for today"
                : "None booked"
          }
          icon={ICON.visit}
        />
      </section>

      <div className="hm-desk">
        <section className="hm-panel" aria-labelledby="lq-work-title">
          <div className="hm-panel-head">
            <h2 id="lq-work-title">The lab's work</h2>
            <Link to="/staff/orders" className="btn-link">
              All cases
            </Link>
          </div>

          {cases.isLoading ? (
            <Skeleton rows={4} />
          ) : groups.length + extras.length === 0 ? (
            <div className="hm-clear">
              <span className="hm-clear-tick" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                  <path d="M5 13l4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div>
                <strong>The desk is clear.</strong>
                <p>Every open case is with a clinic, and nothing is waiting to be checked.</p>
              </div>
            </div>
          ) : (
            <ul className="hm-asks">
              {groups.map((g) => {
                const { label, to, oldest } = sayGroup(g);
                return (
                  <li key={g.status}>
                    <button type="button" onClick={() => navigate(to)}>
                      <span className="hm-ask-icon">{STATUS_ICON[g.status] ?? ICON.make}</span>
                      <span className="hm-ask-say">
                        <b>{label}</b>
                        <span>
                          {g.cases.length === 1
                            ? `${oldest.patient_name || "Practice stock"} · ${oldest.clinic_name || oldest.doctor_name}`
                            : `Oldest waiting ${since(oldest.updated_at)}`}
                        </span>
                      </span>
                      <span className="hm-ask-n">{g.cases.length}</span>
                      <Chevron className="hm-ask-go" />
                    </button>
                  </li>
                );
              })}
              {extras.map((x) => (
                <li key={x.key}>
                  <button type="button" onClick={() => navigate(x.to)}>
                    <span className="hm-ask-icon">{x.icon}</span>
                    <span className="hm-ask-say">
                      <b>{x.label}</b>
                      <span>{x.sub}</span>
                    </span>
                    <span className="hm-ask-n">{x.n}</span>
                    <Chevron className="hm-ask-go" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="hm-panel" aria-labelledby="lq-visits-title">
          <div className="hm-panel-head">
            <h2 id="lq-visits-title">Today's scan visits</h2>
            <Link to="/staff/bookings" className="btn-link">
              Bookings
            </Link>
          </div>

          {visits.isLoading ? (
            <Skeleton rows={4} />
          ) : dayVisits.length === 0 ? (
            <p className="dim">No scan visits are booked for today.</p>
          ) : (
            <ul className="lq-visits">
              {dayVisits.map((v) => (
                <li key={v.id} className={v.status.toLowerCase()}>
                  <button type="button" onClick={() => navigate(`/staff/orders/${v.order.id}`)}>
                    <span className="lq-time">{formatTime(v.starts_at)}</span>
                    <span className="lq-visit-say">
                      <b>{v.order.patient_name}</b>
                      <span>
                        {v.order.clinic_name || v.order.doctor_name} · {v.technician_name}
                      </span>
                    </span>
                    <span className={VISIT_PILL[v.status] ?? "pill"}>{v.status_label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <OpenCases rows={open} loading={cases.isLoading} canAssign={canAssign} />
    </main>
  );
}
