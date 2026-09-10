import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { CaseSeries, PAGE_SIZE, api, formatDate, since } from "../../api";
import { LoadMore } from "../../components/LoadMore";
import type { OrderSummary } from "../../api";
import { CategoryPill, Empty, Loading, StatusPill } from "../../components/ui";
import { ASK_ONE, URGENCY, stageIndex, stagesFor } from "../../workflow";

const SERIES: { key: CaseSeries; label: string; hint: string }[] = [
  {
    key: "aligner",
    label: "Aligner cases",
    hint: "Cases in planning or production, carrying an AL number.",
  },
  {
    key: "product",
    label: "Other products",
    hint: "Retainers, splints, trays and guards — made from a scan, no planning stage.",
  },
  {
    key: "accessory",
    label: "Accessories",
    hint: "Stock items — nothing made, nothing scanned, packed and sent.",
  },
  {
    key: "enquiry",
    label: "Enquiries",
    hint: "Submitted for assessment, still on an EN reference.",
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

export default function DoctorOrders() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [series, setSeries] = useState<CaseSeries>("aligner");
  const [branch, setBranch] = useState(storedBranch);
  /* Longest-waiting first by default. A clinic works the case the lab has been
     waiting on, not the one it happened to open most recently. */
  const [oldestFirst, setOldestFirst] = useState(true);
  const [showClosed, setShowClosed] = useState(false);

  const addresses = useQuery({ queryKey: ["addresses"], queryFn: api.addresses });
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
  const orders = useInfiniteQuery({
    queryKey: ["orders", series, search, addressId],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.orders(
        false,
        { limit: PAGE_SIZE + 1, offset: pageParam as number },
        { search, series, addressId },
      ),
    getNextPageParam: (last, all) => (last.length > PAGE_SIZE ? all.length * PAGE_SIZE : undefined),
  });
  const active = SERIES.find((s) => s.key === series)!;

  const all = (orders.data?.pages ?? []).flatMap((p) => p.slice(0, PAGE_SIZE));

  const byAge = (a: OrderSummary, b: OrderSummary) =>
    oldestFirst
      ? a.updated_at.localeCompare(b.updated_at)
      : b.updated_at.localeCompare(a.updated_at);

  /* Within what needs the clinic, the lab's own order of urgency wins over the
     clock: a fit report it is waiting on outranks a draft nobody has sent. */
  const byUrgency = (a: OrderSummary, b: OrderSummary) => {
    const rank = URGENCY.indexOf(a.status) - URGENCY.indexOf(b.status);
    return rank !== 0 ? rank : byAge(a, b);
  };

  const actionable = all
    .filter((o) => o.needs_doctor_action && o.status !== "CANCELLED")
    .sort(byUrgency);
  const inProgress = all
    .filter((o) => !o.needs_doctor_action && o.status !== "COMPLETED" && o.status !== "CANCELLED")
    .sort(byAge);
  const closed = all
    .filter((o) => o.status === "COMPLETED" || o.status === "CANCELLED")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  /* Naming the branch under every case is only worth the space when the rows on
     screen actually come from more than one. A practice can have three clinics
     and still be looking at a list where every case belongs to the same one —
     stamping it on all of them then is a column that never varies, which is the
     fault this page was full of. */
  const mixed = new Set(all.map((o) => o.branch_label).filter(Boolean)).size > 1;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Your cases</h1>
          <p className="sub">{active.hint}</p>
        </div>
        <div className="row">
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
      </div>

      {multiBranch && (
        <div className="branch-bar" role="group" aria-label="Branch">
          <span className="branch-bar-label">Branch</span>
          <div className="branch-pills">
            <button
              type="button"
              aria-pressed={!branch}
              className={!branch ? "active" : ""}
              onClick={() => chooseBranch("")}
            >
              All branches
            </button>
            {branches.map((address) => (
              <button
                key={address.id}
                type="button"
                aria-pressed={branch === address.id}
                className={branch === address.id ? "active" : ""}
                onClick={() => chooseBranch(address.id)}
                title={`${address.line1}, ${address.city}`}
              >
                {address.label || address.city}
                {address.is_default_shipping && <span className="branch-default">Default</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="series-tabs" role="tablist" aria-label="Case series">
        {SERIES.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={series === s.key}
            className={series === s.key ? "active" : ""}
            onClick={() => setSeries(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>

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
      ) : (
        <div className="stack">
          {actionable.length > 0 && (
            <ActionGroup
              orders={actionable}
              onOpen={(id) => navigate(`/orders/${id}`)}
              showBranch={mixed}
            />
          )}

          <LabGroup
            orders={inProgress}
            onOpen={(id) => navigate(`/orders/${id}`)}
            showBranch={mixed}
            oldestFirst={oldestFirst}
            onSort={() => setOldestFirst((v) => !v)}
            allClear={actionable.length === 0}
          />

          {closed.length > 0 && (
            <ClosedGroup
              orders={closed}
              open={showClosed}
              onToggle={() => setShowClosed((v) => !v)}
              onOpen={(id) => navigate(`/orders/${id}`)}
            />
          )}

          <LoadMore query={orders} noun="cases" shown={all.length} />
        </div>
      )}
    </main>
  );
}

function archLabel(arch: OrderSummary["arch"]): string {
  if (arch === "UPPER") return "Upper arch";
  if (arch === "LOWER") return "Lower arch";
  return "Both arches";
}

/** What is being made, and how big it is.
 *
 *  This was cut on the evidence that it read "Not sized yet" twenty-four times
 *  in twenty-five rows — which was the demo data talking, not the design: those
 *  cases were written straight into the database with no plan against them. A
 *  real book of work carries a band on everything past planning, and the size
 *  of the treatment is the first thing a doctor wants beside a name.
 */
function TreatmentCell({ order }: { order: OrderSummary }) {
  if (order.kind !== "ALIGNER") {
    return <span className="cell-treat">{order.product_label || "—"}</span>;
  }
  return (
    <span className="cell-treat">
      {order.category_label ? (
        <CategoryPill label={order.category_label} confirmed={order.category_confirmed} />
      ) : (
        <span className="dim">Sizing with the plan</span>
      )}
      <span className="cell-arch">{archLabel(order.arch)}</span>
    </span>
  );
}

/** Where the case has got to, drawn as the journey rather than named.
 *
 *  The pill and this are not the same fact: the pill says "In planning", this
 *  says planning is the fourth of six stages and two are still to come. Removing
 *  it as a duplicate lost the only thing on the row that showed distance
 *  travelled. Segments rather than a bar, because the stages are counted.
 */
function StageTrack({ order }: { order: OrderSummary }) {
  const stages = stagesFor(order.kind, order.intake);
  const at = stageIndex(order.kind, order.status, order.intake);
  const done = order.status === "COMPLETED";
  const phased = order.phases_total > 0 && order.phases_done < order.phases_total;

  return (
    <span className="track" title={`${stages[at]?.label ?? order.status_label} — stage ${at + 1} of ${stages.length}`}>
      <span className="track-bars" aria-hidden="true">
        {stages.map((stage, i) => (
          <span
            key={stage.key}
            className={done || i < at ? "seg done" : i === at ? "seg on" : "seg"}
          />
        ))}
      </span>
      <span className="track-say">
        {phased
          ? `Phase ${order.phases_done + 1} of ${order.phases_total}`
          : done
            ? "Complete"
            : `Stage ${at + 1} of ${stages.length}`}
      </span>
    </span>
  );
}

/** The reference line under a patient's name — what the case is, where it is
    going, and nothing the clinic cannot act on. The planner's name was here and
    is not: which of 3D Align's people holds the file is the lab's business. */
function CaseRef({ order, showBranch }: { order: OrderSummary; showBranch: boolean }) {
  return (
    <span className="cell-sub">
      <span className="mono">{order.order_number}</span>
      {showBranch && order.branch_label && <span>{order.branch_label}</span>}
    </span>
  );
}

function PatientCell({ order, showBranch }: { order: OrderSummary; showBranch: boolean }) {
  return (
    <div className="cell-stack">
      <span className="cell-title">
        {order.patient_name}
        {order.priority === "EXPRESS" && <span className="pill pill-gold">Express</span>}
      </span>
      <CaseRef order={order} showBranch={showBranch} />
    </div>
  );
}

/** What the clinic owes the lab.
 *
 *  Led by the action rather than by the stage: "Send the intraoral scan" is
 *  what a doctor can act on, where "Awaiting scan" is a state they have to
 *  translate first. Ordered by what the lab is waiting on, not by the clock.
 */
function ActionGroup({
  orders,
  onOpen,
  showBranch,
}: {
  orders: OrderSummary[];
  onOpen: (id: string) => void;
  showBranch: boolean;
}) {
  return (
    <section className="case-group needs">
      <div className="group-head">
        <h2>
          Needs you
          <span className="count">{orders.length}</span>
        </h2>
        <span className="group-note">Longest waiting first</span>
      </div>
      <div className="rows">
        <div className="row act head" aria-hidden="true">
          <span>Patient</span>
          <span>Treatment</span>
          <span className="row-ask">What to do</span>
          <span className="row-age">Waiting</span>
          <span />
        </div>
        {orders.map((order) => (
          <button key={order.id} type="button" className="row act" onClick={() => onOpen(order.id)}>
            <PatientCell order={order} showBranch={showBranch} />
            <TreatmentCell order={order} />
            <span className="row-ask">{ASK_ONE[order.status] ?? order.status_label}</span>
            <span className="row-age" title="Since this case last moved">
              {since(order.updated_at)}
            </span>
            <span className="row-go" aria-hidden="true">
              →
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Everything the lab has. Nothing here is asked of the clinic, so the row is
    led by the stage and carries no call to action — only where it has got to
    and how long it has been there. */
function LabGroup({
  orders,
  onOpen,
  showBranch,
  oldestFirst,
  onSort,
  allClear,
}: {
  orders: OrderSummary[];
  onOpen: (id: string) => void;
  showBranch: boolean;
  oldestFirst: boolean;
  onSort: () => void;
  /** Said here only when there is no group above saying otherwise. */
  allClear: boolean;
}) {
  return (
    <section className="case-group">
      <div className="group-head">
        <h2>
          With 3D Align
          {orders.length > 0 && <span className="count quiet">{orders.length}</span>}
        </h2>
        <div className="group-tools">
          {allClear && <span className="all-clear">Nothing needs you</span>}
          {orders.length > 1 && (
            <button type="button" className="sort" onClick={onSort}>
              {oldestFirst ? "Longest waiting" : "Most recent"}
              <span aria-hidden="true"> ⇅</span>
            </button>
          )}
        </div>
      </div>
      {orders.length === 0 ? (
        <p className="dim">No cases in progress.</p>
      ) : (
        <div className="rows">
          <div className="row lab head" aria-hidden="true">
            <span>Patient</span>
            <span>Treatment</span>
            <span>Stage</span>
            <span>Progress</span>
            <span className="row-age">Waiting</span>
          </div>
          {orders.map((order) => (
            <button key={order.id} type="button" className="row lab" onClick={() => onOpen(order.id)}>
              <PatientCell order={order} showBranch={showBranch} />
              <TreatmentCell order={order} />
              <span className="row-stage">
                <StatusPill status={order.status} label={order.status_label} />
              </span>
              <StageTrack order={order} />
              <span className="row-age" title="Since this case last moved">
                {since(order.updated_at)}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** Finished work, folded away. Seven completed cases took a full screen above
    the cases that were still running. */
function ClosedGroup({
  orders,
  open,
  onToggle,
  onOpen,
}: {
  orders: OrderSummary[];
  open: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="case-group closed">
      <button type="button" className="group-head as-toggle" onClick={onToggle} aria-expanded={open}>
        <h2>
          Closed
          <span className="count quiet">{orders.length}</span>
        </h2>
        <span className="disclose">
          {open ? "Hide" : "Show"}
          <span aria-hidden="true" className={open ? "chev up" : "chev"}>
            ⌄
          </span>
        </span>
      </button>
      {open && (
        <div className="rows">
          {orders.map((order) => (
            <button key={order.id} type="button" className="row" onClick={() => onOpen(order.id)}>
              <span className="cell-title">{order.patient_name}</span>
              <span className="row-stage">
                <StatusPill status={order.status} label={order.status_label} />
              </span>
              <span className="row-age">{formatDate(order.updated_at)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
