/* Every case the lab holds.
 *
 * It was four tabs of the same table, a free-text status menu in capitals and
 * a search box, with the orthodontist menu the only thing on a row that did
 * anything. Now it reads the way the clinic's case list does: a masthead that
 * sums up what is shown, one console of filters — who the case is waiting on,
 * what kind it is, which stage, whose plan it is, express — and the lab's case
 * table, where the gold rail marks what is on the lab's desk and the line
 * under each patient says what has to happen next.
 *
 * The queue links here with a stage in the address, and the stage and type
 * stay in the address as they change, so a filtered list can be sent to a
 * colleague as a link.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { PAGE_SIZE, api } from "../../api";
import type { CaseSeries, OrderSummary } from "../../api";
import { useAuth } from "../../auth";
import LabCaseTable from "../../components/LabCaseTable";
import { everyStaffCase } from "../../fetchAll";
import { Empty, Loading } from "../../components/ui";
import { onLabDesk } from "../../workflow";

const STATUSES = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "RECORDS_REQUESTED",
  "QUOTED",
  "AWAITING_SCAN",
  "SCAN_SUBMITTED",
  "IN_PLANNING",
  "PLAN_SHARED",
  "TRAINING_ALIGNER_PRODUCTION",
  "TRAINING_ALIGNER_SHIPPED",
  "FIT_REVIEW",
  "FIT_ISSUE",
  "ALIGNER_PRODUCTION",
  "DISPATCHING",
  "PHASE_REVIEW",
  "COMPLETED",
  "CANCELLED",
];

// An enquiry has not reached planning, so it can only be in the early
// statuses. Splitting the list means the status filter should split too.
const ENQUIRY_STATUSES = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "RECORDS_REQUESTED",
  "QUOTED",
  "AWAITING_SCAN",
  "SCAN_SUBMITTED",
  "CANCELLED",
];

// A product is made from the scan, so it never sees planning, a training fit or
// phases. Offering those as filters would be offering an empty table.
const PRODUCT_STATUSES = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "RECORDS_REQUESTED",
  "QUOTED",
  "AWAITING_SCAN",
  "SCAN_SUBMITTED",
  "PRODUCT_FABRICATION",
  "DISPATCHING",
  "COMPLETED",
  "CANCELLED",
];

// Nothing is made for an accessory order, so the bench's stages never apply:
// it is ordered, packed, sent.
const ACCESSORY_STATUSES = ["DRAFT", "SUBMITTED", "PRODUCT_FABRICATION", "DISPATCHING", "COMPLETED", "CANCELLED"];

const EVERY_STATUS = [
  "DRAFT",
  ...STATUSES.slice(0, 13),
  "PRODUCT_FABRICATION",
  ...STATUSES.slice(13),
];

type Series = CaseSeries | "all";

function statusesFor(series: Series): string[] {
  if (series === "enquiry") return ENQUIRY_STATUSES;
  if (series === "accessory") return ACCESSORY_STATUSES;
  if (series === "product") return PRODUCT_STATUSES;
  if (series === "aligner") return STATUSES;
  return EVERY_STATUS;
}

/** "ALIGNER_PRODUCTION" as a person would write it. */
function statusName(status: string): string {
  const words = status.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const SERIES: { key: Series; label: string; noun: string }[] = [
  { key: "all", label: "Every type", noun: "cases" },
  { key: "aligner", label: "Aligner cases", noun: "aligner cases" },
  // An enquiry becomes an aligner case, so it reads next to one rather than
  // below the shelf items.
  { key: "enquiry", label: "Enquiries", noun: "enquiries" },
  { key: "product", label: "Other products", noun: "product orders" },
  { key: "accessory", label: "Accessories", noun: "accessory orders" },
];

type Cut = "all" | "desk" | "clinic" | "closed";

const CUTS: { key: Cut; label: string }[] = [
  { key: "all", label: "All" },
  { key: "desk", label: "On our desk" },
  { key: "clinic", label: "With clinics" },
  { key: "closed", label: "Closed" },
];

const isClosed = (o: OrderSummary) => o.status === "COMPLETED" || o.status === "CANCELLED";
const isClinic = (o: OrderSummary) => !isClosed(o) && o.needs_doctor_action;

function inCut(o: OrderSummary, cut: Cut): boolean {
  if (cut === "desk") return onLabDesk(o);
  if (cut === "clinic") return isClinic(o);
  if (cut === "closed") return isClosed(o);
  return true;
}

export default function StaffOrders() {
  const navigate = useNavigate();
  const { me } = useAuth();
  const canAssign = me?.role === "ADMIN";
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const requested = params.get("series");
  /* Arriving with a stage but no type — from the queue — means every type at
     that stage: a new submission has no AL number yet, so the aligner series
     alone would hide it. */
  const series: Series = SERIES.some((s) => s.key === requested)
    ? (requested as Series)
    : status
      ? "all"
      : "aligner";

  const [search, setSearch] = useState(params.get("q") ?? "");
  const [cut, setCut] = useState<Cut>("all");
  const [planner, setPlanner] = useState("");
  const [express, setExpress] = useState(false);
  const [oldestFirst, setOldestFirst] = useState(true);
  /* Which appliance or shelf item, not merely "a product". The bench works by
     the thing being made. */
  const [item, setItem] = useState("");

  /* Both catalogues, always. The type menu names every appliance and every
     shelf item, so picking one is a single choice rather than a choice of kind
     followed by a choice of thing. Matched against the line the case already
     carries, so the server is asked for nothing new. */
  const madeThings = useQuery({
    queryKey: ["catalogue", "products"],
    queryFn: api.products,
    staleTime: 5 * 60 * 1000,
  });
  const shelfThings = useQuery({
    queryKey: ["catalogue", "accessories"],
    queryFn: api.accessories,
    staleTime: 5 * 60 * 1000,
  });

  const people = useQuery({
    queryKey: ["orthodontists"],
    queryFn: api.orthodontists,
    enabled: canAssign,
    staleTime: 5 * 60 * 1000,
  });

  /** The type and stage live in the address; a stage that only exists on the
      other side is dropped on the way across rather than left to empty the
      table. */
  function setFilter(next: { series?: Series; status?: string }) {
    const s = next.series ?? series;
    const st = next.status ?? status;
    const p: Record<string, string> = { series: s };
    if (st && statusesFor(s).includes(st)) p.status = st;
    setParams(p, { replace: true });
  }

  /* Everything that matches the filters, not the first page of it: the counts
     on the cuts and the figure under the heading are counts of the lab's work,
     and they used to grow with every press of "load more" — which made them
     counts of how far the reader had scrolled. The table still draws a page at
     a time, locally. */
  const orders = useQuery({
    queryKey: ["staff-orders", "every", series, status, search, planner],
    queryFn: () =>
      everyStaffCase({
        series: series === "all" ? undefined : series,
        status: status || undefined,
        search: search || undefined,
        assignedTo: planner || undefined,
      }),
  });

  /* Everything the server matched, then everything the name menu matches, so
     the figure under the heading counts what is actually in the table. */
  const fetched = useMemo(() => orders.data ?? [], [orders.data]);
  const all = useMemo(
    () =>
      item
        ? fetched.filter((o) => o.product_label.toLowerCase().includes(item.toLowerCase()))
        : fetched,
    [fetched, item],
  );
  const [limit, setLimit] = useState(PAGE_SIZE);
  const active = SERIES.find((s) => s.key === series)!;

  const base = useMemo(() => (express ? all.filter((o) => o.priority === "EXPRESS") : all), [all, express]);

  const named = useMemo(
    () => ({
      product: (madeThings.data ?? []).map((p) => p.name).sort((a, b) => a.localeCompare(b)),
      accessory: (shelfThings.data ?? []).map((a) => a.name).sort((a, b) => a.localeCompare(b)),
    }),
    [madeThings.data, shelfThings.data],
  );

  // A new filter starts the table at the top again.
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [series, status, search, planner, cut, express, item, oldestFirst]);
  const counts = useMemo(
    () => Object.fromEntries(CUTS.map((c) => [c.key, base.filter((o) => inCut(o, c.key)).length])) as Record<Cut, number>,
    [base],
  );

  /* One table, so the order carries what sections would have said: what is on
     the lab's desk floats up, then what waits on a clinic, and finished work
     sinks. Within each, the longest waiting first — or the most recent. */
  const shown = useMemo(() => {
    const band = (o: OrderSummary) => (onLabDesk(o) ? 0 : isClosed(o) ? 2 : 1);
    return base
      .filter((o) => inCut(o, cut))
      .sort((a, b) => {
        const d = band(a) - band(b);
        if (d !== 0) return d;
        return oldestFirst ? a.updated_at.localeCompare(b.updated_at) : b.updated_at.localeCompare(a.updated_at);
      });
  }, [base, cut, oldestFirst]);

  const filtered = cut !== "all" || express || Boolean(status) || Boolean(planner) || Boolean(item);
  function clearFilters() {
    setCut("all");
    setExpress(false);
    setPlanner("");
    setItem("");
    setFilter({ status: "" });
  }

  return (
    <main className="page page-wide">
      <header className="masthead">
        <div className="masthead-say">
          <span className="masthead-eyebrow">3D Align lab</span>
          <h1>Cases</h1>
          <p className="masthead-sum">
            {orders.isLoading ? (
              "Loading…"
            ) : (
              <>
                <b>{all.length}</b>{" "}
                {active.noun}
                {status && (
                  <>
                    {" "}
                    at <b>{statusName(status)}</b>
                  </>
                )}
                {counts.desk > 0 && (
                  <>
                    {" · "}
                    <b className="lit">{counts.desk}</b> on our desk
                  </>
                )}
                {counts.clinic > 0 && (
                  <>
                    {" · "}
                    <b>{counts.clinic}</b> with clinics
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
              placeholder="Case, patient, doctor or clinic"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search cases"
            />
          </span>
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
              {c.key === "desk" && <span className="cut-dot" aria-hidden="true" />}
              {c.label}
              <span className="cut-n">{orders.isLoading ? "…" : counts[c.key]}</span>
            </button>
          ))}
        </div>

        <span className="console-rule" aria-hidden="true" />

        <label className="pick">
          <span>Type</span>
          <select
            value={item ? `${series}:${item}` : series}
            onChange={(e) => {
              // "product:Essix Retainer" — the kind, and which one of it.
              const value = e.target.value;
              const cut = value.indexOf(":");
              setItem(cut < 0 ? "" : value.slice(cut + 1));
              setFilter({ series: (cut < 0 ? value : value.slice(0, cut)) as Series });
            }}
          >
            {SERIES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
            {named.product.length > 0 && (
              <optgroup label="Which product">
                {named.product.map((n) => (
                  <option key={`product:${n}`} value={`product:${n}`}>
                    {n}
                  </option>
                ))}
              </optgroup>
            )}
            {named.accessory.length > 0 && (
              <optgroup label="Which accessory">
                {named.accessory.map((n) => (
                  <option key={`accessory:${n}`} value={`accessory:${n}`}>
                    {n}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        <label className="pick">
          <span>Stage</span>
          <select value={status} onChange={(e) => setFilter({ status: e.target.value })}>
            <option value="">Any stage</option>
            {statusesFor(series).map((s) => (
              <option key={s} value={s}>
                {statusName(s)}
              </option>
            ))}
          </select>
        </label>

        {canAssign && (
          <label className="pick">
            <span>Planned by</span>
            <select value={planner} onChange={(e) => setPlanner(e.target.value)}>
              <option value="">Anyone</option>
              <option value="unassigned">3D Align (unassigned)</option>
              {(people.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name || p.email}
                  {p.is_active ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          </label>
        )}

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

        {filtered && (
          <button type="button" className="btn-link clear" onClick={clearFilters}>
            Clear filters
          </button>
        )}

        <span className="tally-say">
          {shown.length === all.length ? `${all.length} shown` : `${shown.length} of ${all.length}`}
        </span>

        <button type="button" className="sort" onClick={() => setOldestFirst((v) => !v)} title="Change the order of the list">
          {oldestFirst ? "Longest waiting" : "Most recent"}
          <span aria-hidden="true"> ⇅</span>
        </button>
      </section>

      {orders.isLoading ? (
        <Loading what="cases" />
      ) : all.length === 0 ? (
        <Empty>
          {search ? (
            <>No case matches “{search}”.</>
          ) : status ? (
            <>
              Nothing at {statusName(status)}.{" "}
              <button type="button" className="btn-link" onClick={() => setFilter({ status: "" })}>
                Show every stage
              </button>
            </>
          ) : series === "enquiry" ? (
            "No enquiries."
          ) : series === "product" ? (
            "No product orders yet. Retainers, splints and trays appear here once a clinic orders one."
          ) : series === "accessory" ? (
            "No accessory orders yet."
          ) : (
            "No cases in the aligner series yet."
          )}
        </Empty>
      ) : shown.length === 0 ? (
        <Empty>
          No cases match these filters.{" "}
          <button type="button" className="btn-link" onClick={clearFilters}>
            Clear them
          </button>
        </Empty>
      ) : (
        <div className="stack">
          <LabCaseTable
            orders={shown.slice(0, limit)}
            canAssign={canAssign}
            planner={series === "all" || series === "aligner"}
            onOpen={(id) => navigate(`/staff/orders/${id}`)}
          />
          {shown.length > limit ? (
            <div className="pt-more">
              <button type="button" className="btn-ghost" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                Show {Math.min(PAGE_SIZE, shown.length - limit)} more
              </button>
              <span className="dim">
                {limit} of {shown.length} shown
              </span>
            </div>
          ) : (
            shown.length > PAGE_SIZE && (
              <p className="dim" style={{ textAlign: "center", padding: "10px 0" }}>
                All {shown.length} cases shown.
              </p>
            )
          )}
        </div>
      )}
    </main>
  );
}
