import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { CaseSeries, PAGE_SIZE, api, formatDate } from "../../api";
import { LoadMore } from "../../components/LoadMore";
import type { OrderSummary } from "../../api";
import { CategoryPill, Empty, Loading } from "../../components/ui";
import CaseProgress from "../../components/CaseProgress";

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
  const actionable = all.filter((o) => o.needs_doctor_action && o.status !== "CANCELLED");
  const inProgress = all.filter(
    (o) => !o.needs_doctor_action && o.status !== "COMPLETED" && o.status !== "CANCELLED",
  );
  const closed = all.filter((o) => o.status === "COMPLETED" || o.status === "CANCELLED");
  // Naming the branch on every row is only worth the space while the list
  // actually holds more than one.
  const mixed = multiBranch && !branch;

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
              placeholder="Case number, patient, chart no."
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
          <Section
            title="Needs your action"
            orders={actionable}
            onOpen={(id) => navigate(`/orders/${id}`)}
            emptyText="Nothing waiting on you."
            showHeader
            showBranch={mixed}
          />
          <Section
            title="With the lab"
            orders={inProgress}
            onOpen={(id) => navigate(`/orders/${id}`)}
            emptyText="No cases in progress."
            showBranch={mixed}
          />
          {closed.length > 0 && (
            <Section
              title="Closed"
              orders={closed}
              onOpen={(id) => navigate(`/orders/${id}`)}
              showBranch={mixed}
            />
          )}
          <LoadMore query={orders} noun="cases" shown={all.length} />
        </div>
      )}
    </main>
  );
}

function Section({
  title,
  orders,
  onOpen,
  emptyText,
  showHeader = false,
  showBranch = false,
}: {
  title: string;
  orders: OrderSummary[];
  onOpen: (id: string) => void;
  emptyText?: string;
  /* Printed once, above the first section. Repeating the same six column names
     down the page is noise: the reader learned them at the top. */
  showHeader?: boolean;
  /* Only while the list mixes branches. Stamping every row with the branch the
     reader just filtered to says nothing. */
  showBranch?: boolean;
}) {
  return (
    <section className="case-section">
      <h4 className="case-section-head">
        {title}
        {orders.length > 0 && <span className="count">{orders.length}</span>}
      </h4>
      {orders.length === 0 ? (
        emptyText && <p className="dim">{emptyText}</p>
      ) : (
        <div className="table-wrap">
          <table>
            {showHeader && (
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Treatment</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
            )}
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="clickable" onClick={() => onOpen(order.id)}>
                  <td>
                    <div className="cell-stack">
                      <span className="cell-title">
                        {order.patient_name}
                        {order.priority === "EXPRESS" && (
                          <span className="pill pill-gold">Express</span>
                        )}
                      </span>
                      <span className="cell-sub">
                        <span className="mono">{order.order_number}</span>
                        {showBranch && order.branch_label && (
                          <>
                            {" · "}
                            {order.branch_label}
                          </>
                        )}
                        {order.assigned_to_name && (
                          <>
                            {" · "}
                            {order.assigned_to_name}
                          </>
                        )}
                      </span>
                    </div>
                  </td>
                  <td>
                    {order.kind === "PRODUCT" ? (
                      <span>{order.product_label}</span>
                    ) : order.category_label ? (
                      <CategoryPill
                        label={order.category_label}
                        confirmed={order.category_confirmed}
                      />
                    ) : (
                      <span className="dim">Not sized yet</span>
                    )}
                  </td>
                  <td>
                    <CaseProgress
                      status={order.status}
                      label={order.status_label}
                      phaseDone={order.phases_done}
                      phaseTotal={order.phases_total}
                    />
                  </td>
                  <td className="dim">{formatDate(order.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
