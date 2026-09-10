import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { CaseSeries, PAGE_SIZE, api, formatDate, formatMoney, since } from "../../api";
import { LoadMore } from "../../components/LoadMore";
import type { OrderSummary } from "../../api";
import { CategoryPill, Empty, Loading, StatusPill } from "../../components/ui";
import { URGENCY, stageIndex, stagesFor } from "../../workflow";

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

  return (
    <main className="page page-wide">
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
            <Group
              title="Needs you"
              orders={actionable}
              money={money}
              tone="needs"
              onOpen={(id) => navigate(`/orders/${id}`)}
              tools={<span className="group-note">Longest waiting first</span>}
            />
          )}

          <Group
            title="With 3D Align"
            orders={inProgress}
            money={money}
            onOpen={(id) => navigate(`/orders/${id}`)}
            tools={
              <div className="group-tools">
                {actionable.length === 0 && <span className="all-clear">Nothing needs you</span>}
                {inProgress.length > 1 && (
                  <button type="button" className="sort" onClick={() => setOldestFirst((v) => !v)}>
                    {oldestFirst ? "Longest waiting" : "Most recent"}
                    <span aria-hidden="true"> ⇅</span>
                  </button>
                )}
              </div>
            }
          />

          {closed.length > 0 && (
            <Group
              title="Closed"
              orders={closed}
              money={money}
              tone="closed"
              collapsed={!showClosed}
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
        <span className="dim">Sizing with the plan</span>
      )}
      <span className="cell-arch">{archLabel(order.arch)}</span>
    </span>
  );
}

/** Where the case has got to, drawn as the journey rather than named. The pill
    beside it says "In planning"; this says planning is the fourth of six with
    two still to come — the distance travelled, which no other column shows. */
function StageTrack({ order }: { order: OrderSummary }) {
  const stages = stagesFor(order.kind, order.intake);
  const at = stageIndex(order.kind, order.status, order.intake);
  const done = order.status === "COMPLETED";
  const phased = order.phases_total > 0 && order.phases_done < order.phases_total;
  return (
    <span className="track">
      <span className="track-bars" aria-hidden="true">
        {stages.map((stage, i) => (
          <span key={stage.key} className={done || i < at ? "seg done" : i === at ? "seg on" : "seg"} />
        ))}
      </span>
      <span className="track-say">
        {phased
          ? `Phase ${order.phases_done + 1} of ${order.phases_total}`
          : done
            ? "Complete"
            : `Stage ${Math.max(at + 1, 1)} of ${stages.length}`}
      </span>
    </span>
  );
}

/** One group of cases. The three groups are how the page is read — what needs
    the clinic, what the lab has, what is finished — and they share one set of
    columns so the eye keeps its place moving between them. */
function Group({
  title,
  orders,
  money,
  onOpen,
  tone,
  tools,
  collapsed,
  onToggle,
}: {
  title: string;
  orders: OrderSummary[];
  money: Map<string, Money>;
  onOpen: (id: string) => void;
  tone?: "needs" | "closed";
  tools?: React.ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const Head = onToggle ? "button" : "div";
  return (
    <section className={`case-group${tone ? ` ${tone}` : ""}`}>
      <Head
        className={`group-head${onToggle ? " as-toggle" : ""}`}
        {...(onToggle ? { type: "button" as const, onClick: onToggle, "aria-expanded": !collapsed } : {})}
      >
        <h2>
          {title}
          {orders.length > 0 && (
            <span className={tone === "needs" ? "count" : "count quiet"}>{orders.length}</span>
          )}
        </h2>
        {onToggle ? (
          <span className="disclose">
            {collapsed ? "Show" : "Hide"}
            <span aria-hidden="true" className={collapsed ? "chev" : "chev up"}>
              ⌄
            </span>
          </span>
        ) : (
          tools
        )}
      </Head>

      {collapsed ? null : orders.length === 0 ? (
        <p className="dim">No cases here.</p>
      ) : (
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
                <th>Last updated</th>
                <th className="col-branch">Branch</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="clickable" onClick={() => onOpen(order.id)}>
                  <td className="col-case mono">{order.order_number}</td>
                  <td className="col-patient">
                    <span className="cell-title">
                      {order.patient_name}
                      {order.priority === "EXPRESS" && <span className="pill pill-gold">Express</span>}
                    </span>
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
                  {/* The date and time as asked for, with how long ago it was
                      on the hover — the figure that decides which case to open
                      first, kept without spending a column on it. */}
                  <td className="col-when" title={`${since(order.updated_at)} ago`}>
                    {formatDate(order.updated_at)}
                  </td>
                  {/* The label already carries the city, which is the same for
                      every branch of one practice; the name is what tells them
                      apart. The whole of it stays on the hover. */}
                  <td className="col-branch dim" title={order.branch_label}>
                    {order.branch_label ? order.branch_label.split(" · ")[0] : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
