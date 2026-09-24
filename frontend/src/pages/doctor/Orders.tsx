import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { CaseSeries, PAGE_SIZE, api, formatDate, formatMoney, since } from "../../api";
import type { OrderSummary } from "../../api";
import { CategoryPill, Empty, Loading, StatusPill } from "../../components/ui";
import { ASK_ONE, URGENCY } from "../../workflow";
import { everyCase } from "../../fetchAll";
import StageTrack from "../../components/StageTrack";

const SERIES: { key: CaseSeries; label: string; hint: string }[] = [
  {
    key: "aligner",
    label: "Aligner Cases",
    hint: "Cases in planning or production, carrying an AL number.",
  },
  {
    key: "enquiry",
    label: "Enquiries",
    hint: "Submitted for assessment, still on an EN reference.",
  },
  {
    key: "product",
    label: "Other Products",
    hint: "Retainers, splints, trays and guards — made from a scan, no planning stage.",
  },
  {
    key: "accessory",
    label: "Accessories",
    hint: "Stock items — nothing made, nothing scanned, packed and sent.",
  },
];

/* A practice running several branches picks one and keeps working from it,
   so the choice outlives the visit. Stored per browser rather than on the
   account: the same login is used from the front desk of each branch. */
const BRANCH_KEY = "3dalign.branch";

function storedBranch(): string {
  try {
    return window.localStorage.getItem(BRANCH_KEY) ?? "";
  } catch {
    return "";
  }
}

type Attention = "all" | "needs" | "lab" | "closed";

const ATTENTION: { key: Attention; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs", label: "Needs you" },
  { key: "lab", label: "With 3D Align" },
  { key: "closed", label: "Closed" },
];

export default function DoctorOrders() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [series, setSeries] = useState<CaseSeries>("aligner");
  const [branch, setBranch] = useState(storedBranch);
  /* What the clinic is looking for, rather than which of three tables it has
     scrolled to. The page used to answer this by splitting the cases into
     sections, which meant a doctor hunting one patient read three lists. */
  const [attention, setAttention] = useState<Attention>("all");
  const [stage, setStage] = useState("");
  const [express, setExpress] = useState(false);
  const [oldestFirst, setOldestFirst] = useState(true);
  /* "Products" as one lump answers "have we ordered any appliances", never
     "where are the Essix retainers". The catalogue names what was ordered, so
     the list can be cut by the thing itself. */
  const [item, setItem] = useState("");

  const addresses = useQuery({ queryKey: ["addresses"], queryFn: api.addresses });
  /* The names to offer. Only fetched for the two kinds that have any, and
     matched against the line the case already carries — "Essix Retainer ·
     0.8 mm · x3" for an appliance, the shelf items themselves for a box of
     accessories — so nothing new is asked of the server. */
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
  /* Where each case stands on money. The list endpoint does not carry it, but
     the practice's own ledger names the case every charge belongs to, so the
     two are joined here rather than asking the server for something new. */
  const ledger = useQuery({ queryKey: ["payment-ledger"], queryFn: api.paymentLedger });
  const money = useMemo(() => {
    const by = new Map<string, { due: number; review: number; paid: number }>();
    const add = (id: string, key: "due" | "review" | "paid", amount: string) => {
      const row = by.get(id) ?? { due: 0, review: 0, paid: 0 };
      row[key] += Number(amount);
      by.set(id, row);
    };
    for (const e of ledger.data?.pending ?? []) {
      add(e.order_id, e.status === "SUBMITTED" ? "review" : "due", e.total);
    }
    for (const e of ledger.data?.history ?? []) add(e.order_id, "paid", e.total);
    return by;
  }, [ledger.data]);

  // One clinic is not a choice worth putting on the page.
  const branches = addresses.data ?? [];
  const multiBranch = branches.length > 1;

  /* A branch that has been deleted, or one remembered from another account on
     this browser, would otherwise filter every case away and look like an
     empty practice. */
  useEffect(() => {
    if (!addresses.data || !branch) return;
    if (!addresses.data.some((a) => a.id === branch)) setBranch("");
  }, [addresses.data, branch]);

  function chooseBranch(id: string) {
    setBranch(id);
    try {
      if (id) window.localStorage.setItem(BRANCH_KEY, id);
      else window.localStorage.removeItem(BRANCH_KEY);
    } catch {
      /* A browser refusing storage still filters, it just forgets. */
    }
  }

  const addressId = multiBranch ? branch : "";
  /* The whole of what matches, rather than a page of it. Every figure on this
     page — the tally under the heading, the number on each cut, what is
     outstanding — counts across the practice, and a count that grew every time
     the reader pressed "load more" was not counting anything. The table still
     draws a page at a time; only the paging moved off the server. */
  const orders = useQuery({
    queryKey: ["orders", "every", series, search, addressId],
    queryFn: () => everyCase({ search, series, addressId }),
  });
  const active = SERIES.find((s) => s.key === series)!;

  /* Everything the server matched, then everything the name menu matches:
     the figures under the heading and on the cuts count what the reader has
     asked for, not the type it belongs to. */
  const fetched = useMemo(() => orders.data ?? [], [orders.data]);
  const all = useMemo(
    () =>
      item
        ? fetched.filter((o) => o.product_label.toLowerCase().includes(item.toLowerCase()))
        : fetched,
    [fetched, item],
  );
  const [limit, setLimit] = useState(PAGE_SIZE);

  const isClosed = (o: OrderSummary) => o.status === "COMPLETED" || o.status === "CANCELLED";
  const isNeeds = (o: OrderSummary) => o.needs_doctor_action && o.status !== "CANCELLED";

  const counts = useMemo(
    () => ({
      all: all.length,
      needs: all.filter(isNeeds).length,
      lab: all.filter((o) => !isNeeds(o) && !isClosed(o)).length,
      closed: all.filter(isClosed).length,
    }),
    [all],
  );

  /* Only the stages present under the cut in force, so the menu never offers a
     filter that would empty the table — picking "Needs you" and then a stage
     that exists nowhere in it is a dead end the reader has to back out of. */
  const stages = useMemo(() => {
    const inCut = all.filter((o) =>
      attention === "needs"
        ? isNeeds(o)
        : attention === "lab"
          ? !isNeeds(o) && !isClosed(o)
          : attention === "closed"
            ? isClosed(o)
            : true,
    );
    const seen = new Map<string, string>();
    for (const o of inCut) seen.set(o.status, o.status_label);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all, attention]);

  /* A stage chosen under one cut may not exist under the next. Dropping it
     beats showing an empty table with a filter the menu no longer lists. */
  useEffect(() => {
    if (stage && !stages.some(([value]) => value === stage)) setStage("");
  }, [stages, stage]);

  const shown = useMemo(() => {
    let rows = all;
    if (attention === "needs") rows = rows.filter(isNeeds);
    else if (attention === "lab") rows = rows.filter((o) => !isNeeds(o) && !isClosed(o));
    else if (attention === "closed") rows = rows.filter(isClosed);
    if (stage) rows = rows.filter((o) => o.status === stage);
    if (express) rows = rows.filter((o) => o.priority === "EXPRESS");

    const byAge = (a: OrderSummary, b: OrderSummary) =>
      oldestFirst
        ? a.updated_at.localeCompare(b.updated_at)
        : b.updated_at.localeCompare(a.updated_at);

    /* One table, so the order has to carry what the section headings used to
       say: what wants the clinic floats up, ranked by what the lab is waiting
       on, and everything finished sinks. */
    return [...rows].sort((a, b) => {
      const band = (o: OrderSummary) => (isNeeds(o) ? 0 : isClosed(o) ? 2 : 1);
      const d = band(a) - band(b);
      if (d !== 0) return d;
      if (band(a) === 0) {
        const r = URGENCY.indexOf(a.status) - URGENCY.indexOf(b.status);
        if (r !== 0) return r;
      }
      return byAge(a, b);
    });
  }, [all, attention, stage, express, oldestFirst]);

  /* Every appliance and every shelf item, named. The menu offers them
     whatever type the list is showing, so "which one" is a single choice
     rather than a choice made after another choice. */
  const named = useMemo(
    () => ({
      product: (madeThings.data ?? []).map((p) => p.name).sort((a, b) => a.localeCompare(b)),
      accessory: (shelfThings.data ?? []).map((a) => a.name).sort((a, b) => a.localeCompare(b)),
    }),
    [madeThings.data, shelfThings.data],
  );

  /* What the practice owes across the cases on this page, for the line under
     the masthead. */
  const dueTotal = useMemo(
    () => all.reduce((sum, o) => sum + (money.get(o.id)?.due ?? 0), 0),
    [all, money],
  );

  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [series, search, addressId, attention, stage, express, item, oldestFirst]);

  const filtered = attention !== "all" || Boolean(stage) || express || Boolean(item);
  function clearFilters() {
    setAttention("all");
    setStage("");
    setExpress(false);
    setItem("");
  }

  return (
    <main className="page page-wide">
      {/* A masthead, because the page had none: a 1.4rem heading sat directly on
          a two-thousand-pixel table, so nothing anchored the eye and every line
          on the screen carried the same weight. The word is set large in the
          display face and the practice is summed up under it in a sentence. */}
      <header className="masthead">
        <div className="masthead-say">
          <span className="masthead-eyebrow">Your practice</span>
          <h1>Cases</h1>
          <p className="masthead-sum">
            {orders.isLoading ? (
              "Loading…"
            ) : (
              <>
                <b>{counts.all}</b> {active.label.toLowerCase()}
                {counts.needs > 0 && (
                  <>
                    {" · "}
                    <b className="lit">{counts.needs}</b> waiting on you
                  </>
                )}
                {dueTotal > 0 && (
                  <>
                    {" · "}
                    {/* A headline figure, not a line item — paise here only make
                        the number harder to read. The exact amount is on the
                        payments page and in the row's own cell. */}
                    <b>₹{dueTotal.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</b>{" "}
                    outstanding
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
              placeholder="Patient or case number"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search cases"
            />
          </span>
          <Link to="/orders/new">
            <button type="button" className="btn-primary">
              New case
            </button>
          </Link>
        </div>
      </header>

      {/* One console rather than a stack of pill rows. The cut a clinic makes
          most often is on top and set as a segment; the rest are quiet menus
          under it, and what is currently on can be cleared in one place. */}
      <section className="console" aria-label="Filters">
        <div className="cut" role="tablist" aria-label="Show">
          {ATTENTION.map((a) => (
            <button
              key={a.key}
              type="button"
              role="tab"
              aria-selected={attention === a.key}
              className={attention === a.key ? "on" : ""}
              onClick={() => setAttention(a.key)}
            >
              {a.key === "needs" && (
                <span className="cut-dot" aria-hidden="true" />
              )}
              {a.label}
              <span className="cut-n">{counts[a.key]}</span>
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
                setSeries((cut < 0 ? value : value.slice(0, cut)) as CaseSeries);
                setItem(cut < 0 ? "" : value.slice(cut + 1));
              }}
            >
              {SERIES.map((s) => (
                <option
                  key={s.key}
                  value={s.key}
                  style={s.key === "aligner" || s.key === "enquiry" ? { fontWeight: 700 } : undefined}
                >
                  {s.label}
                </option>
              ))}
              {named.product.length > 0 && (
                <optgroup label="Aligner Product Range">
                  {named.product.map((n) => (
                    <option key={`product:${n}`} value={`product:${n}`}>
                      {n}
                    </option>
                  ))}
                </optgroup>
              )}
              {named.accessory.length > 0 && (
                <optgroup label="Aligner Accessory">
                  {named.accessory.map((n) => (
                    <option key={`accessory:${n}`} value={`accessory:${n}`}>
                      {n}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>

          {multiBranch && (
            <label className="pick">
              <span>Branch</span>
              <select value={branch} onChange={(e) => chooseBranch(e.target.value)}>
                <option value="">All branches</option>
                {branches.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label || a.city}
                    {a.is_default_shipping ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="pick">
            <span>Stage</span>
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">Any stage</option>
              {stages.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
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

          {filtered && (
            <button type="button" className="btn-link clear" onClick={clearFilters}>
              Clear filters
            </button>
          )}

          <span className="tally-say">
            {shown.length === all.length
              ? `${all.length} case${all.length === 1 ? "" : "s"}`
              : `${shown.length} of ${all.length}`}
          </span>

          <button
            type="button"
            className="sort"
            onClick={() => setOldestFirst((v) => !v)}
            title="Change the order of the list"
          >
            {oldestFirst ? "Longest waiting" : "Most recent"}
            <span aria-hidden="true"> ⇅</span>
          </button>
      </section>

      {orders.isLoading ? (
        <Loading what="cases" />
      ) : all.length === 0 ? (
        search ? (
          <Empty>No cases match “{search}”.</Empty>
        ) : branch ? (
          /* Blaming the practice for having no cases when a filter is on is
             how a doctor concludes the portal has lost their work. */
          <Empty>
            Nothing here for {branches.find((a) => a.id === branch)?.label || "this branch"}.{" "}
            <button type="button" className="btn-link" onClick={() => chooseBranch("")}>
              Show every branch
            </button>
          </Empty>
        ) : series === "enquiry" ? (
          <Empty>No open enquiries — everything has moved into planning.</Empty>
        ) : series === "accessory" ? (
          <Empty>
            No accessory orders yet. <Link to="/catalogue">See what is on the shelf.</Link>
          </Empty>
        ) : series === "product" ? (
          <Empty>
            No product orders yet. <Link to="/catalogue">See what 3D Align makes.</Link>
          </Empty>
        ) : (
          <Empty>
            No aligner cases yet. <Link to="/orders/new">Start your first one.</Link>
          </Empty>
        )
      ) : shown.length === 0 ? (
        <Empty>
          No cases match these filters.{" "}
          <button type="button" className="btn-link" onClick={clearFilters}>
            Clear them
          </button>
        </Empty>
      ) : (
        <div className="stack">
          <CaseTable
            orders={shown.slice(0, limit)}
            money={money}
            onOpen={(id: string) => navigate(`/orders/${id}`)}
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

function archLabel(arch: OrderSummary["arch"]): string {
  if (arch === "UPPER") return "Upper";
  if (arch === "LOWER") return "Lower";
  return "Both";
}

/** "11 Sep, 10:30" — the year only when it is not this one. The full stamp is
    on the hover, so the column can be a third of the width. */
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

type Money = { due: number; review: number; paid: number };

/** Where a case stands on money, in four words or fewer. Joined from the
    practice's own ledger, which names the case each charge belongs to. */
function PaymentCell({ m }: { m?: Money }) {
  if (!m) return <span className="dim">—</span>;
  if (m.due > 0) return <span className="pay due">{formatMoney(m.due)} due</span>;
  if (m.review > 0) return <span className="pay check">Receipt with 3D Align</span>;
  if (m.paid > 0) return <span className="pay ok">Paid {formatMoney(m.paid)}</span>;
  return <span className="dim">—</span>;
}

/** What is being made, and how big. Degrades to a quiet line rather than to
    nothing while the plan is still deciding the size. */
function TreatmentCell({ order }: { order: OrderSummary }) {
  if (order.kind !== "ALIGNER") {
    return <span className="cell-treat">{order.product_label || "—"}</span>;
  }
  return (
    <span className="cell-treat">
      {order.category_label ? (
        <CategoryPill label={order.category_label} confirmed={order.category_confirmed} />
      ) : (
        <span className="dim" title="The band is set when the treatment plan is made">
          Not sized yet
        </span>
      )}
      <span className="cell-arch">{archLabel(order.arch)}</span>
    </span>
  );
}

/** Every case in one table.
 *
 *  It used to be three — what needs the clinic, what the lab has, what is
 *  finished — which meant a doctor looking for one patient read three lists and
 *  a filter could only ever narrow one of them. The split is a filter now, and
 *  what the headings used to say is carried by the row itself: the ones wanting
 *  something float to the top and wear a gold rail.
 */
function CaseTable({
  orders,
  money,
  onOpen,
}: {
  orders: OrderSummary[];
  money: Map<string, Money>;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="case-table">
      <table>
        <thead>
          <tr>
            <th className="col-case">Case</th>
            <th className="col-patient">Patient</th>
            <th className="col-plan">Planned by</th>
            <th>Treatment</th>
            <th>Payment</th>
            <th>Stage</th>
            <th className="col-progress">Progress</th>
            <th>Date</th>
            <th className="col-branch">Branch</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const needs = order.needs_doctor_action && order.status !== "CANCELLED";
            const closed = order.status === "COMPLETED" || order.status === "CANCELLED";
            return (
              <tr
                key={order.id}
                className={`clickable${needs ? " wants" : ""}${closed ? " done" : ""}`}
                onClick={() => onOpen(order.id)}
                title={needs ? ASK_ONE[order.status] ?? order.status_label : undefined}
              >
                <td className="col-case mono">{order.order_number}</td>
                <td className="col-patient">
                  <span className="cell-title" title={order.patient_number || undefined}>
                    {order.patient_name}
                    {order.priority === "EXPRESS" && (
                      <span className="tag-express" title="Express">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" strokeLinejoin="round" />
                        </svg>
                        Express
                      </span>
                    )}
                  </span>
                  {/* With the sections gone, the row has to say for itself that
                      it is waiting on the clinic — and what for. */}
                  {needs && <span className="cell-ask">{ASK_ONE[order.status] ?? order.status_label}</span>}
                </td>
                <td className="col-plan">
                  {order.assigned_to_name ? (
                    order.assigned_to_name
                  ) : (
                    <span className="dim">Unassigned</span>
                  )}
                </td>
                <td>
                  <TreatmentCell order={order} />
                </td>
                <td>
                  <PaymentCell m={money.get(order.id)} />
                </td>
                <td>
                  <StatusPill status={order.status} label={order.status_label} />
                </td>
                <td className="col-progress">
                  <StageTrack order={order} />
                </td>
                {/* The date and time as asked for, with how long ago on the
                    hover — the figure that decides what to open first, kept
                    without spending a column on it. */}
                <td
                  className="col-when"
                  title={
                    order.submitted_at
                      ? `Sent ${formatDate(order.submitted_at)}`
                      : `Not sent yet · last change ${since(order.updated_at)} ago`
                  }
                >
                  {order.submitted_at ? shortWhen(order.submitted_at) : "—"}
                </td>
                <td className="col-branch dim" title={order.branch_label}>
                  {order.branch_label ? order.branch_label.split(" · ")[0] : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
