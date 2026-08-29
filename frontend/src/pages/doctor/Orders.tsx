import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
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
    key: "enquiry",
    label: "Enquiries",
    hint: "Submitted for assessment, still on an EN reference.",
  },
];

export default function DoctorOrders() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [series, setSeries] = useState<CaseSeries>("aligner");
  const orders = useInfiniteQuery({
    queryKey: ["orders", series, search],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.orders(
        false,
        { limit: PAGE_SIZE + 1, offset: pageParam as number },
        { search, series },
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
        ) : series === "enquiry" ? (
          <Empty>No open enquiries — everything has moved into planning.</Empty>
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
          />
          <Section
            title="With the lab"
            orders={inProgress}
            onOpen={(id) => navigate(`/orders/${id}`)}
            emptyText="No cases in progress."
          />
          {closed.length > 0 && (
            <Section title="Closed" orders={closed} onOpen={(id) => navigate(`/orders/${id}`)} />
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
}: {
  title: string;
  orders: OrderSummary[];
  onOpen: (id: string) => void;
  emptyText?: string;
  /* Printed once, above the first section. Repeating the same six column names
     down the page is noise: the reader learned them at the top. */
  showHeader?: boolean;
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
                  <th>Align category</th>
                  <th>Your orthodontist</th>
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
                      <span className="cell-sub mono">{order.order_number}</span>
                    </div>
                  </td>
                  <td>
                    {order.kind === "PRODUCT" ? (
                      // A product has no Align band — what it is *is* the answer.
                      <span>{order.product_label}</span>
                    ) : (
                      <CategoryPill
                        label={order.category_label}
                        confirmed={order.category_confirmed}
                      />
                    )}
                  </td>
                  <td>
                    {order.assigned_to_name || <span className="dim">3D Align</span>}
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
