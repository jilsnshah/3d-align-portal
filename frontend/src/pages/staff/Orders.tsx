import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { CaseSeries, PAGE_SIZE, api, formatDate } from "../../api";
import { LoadMore } from "../../components/LoadMore";
import { CategoryPill, Empty, Loading } from "../../components/ui";
import { useAuth } from "../../auth";
import CaseProgress from "../../components/CaseProgress";
import type { OrderSummary } from "../../api";

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

const SERIES: { key: CaseSeries; label: string; hint: string }[] = [
  {
    key: "aligner",
    label: "Aligner series",
    hint: "AL numbers — cases in planning or production.",
  },
  {
    key: "product",
    label: "Other products",
    hint: "Retainers, splints, trays and guards — made from the scan, no planning.",
  },
  {
    key: "enquiry",
    label: "Enquiries",
    hint: "EN numbers — not yet through planning, no AL number spent.",
  },
];

export default function StaffOrders() {
  const navigate = useNavigate();
  const { me } = useAuth();
  const canAssign = me?.role === "ADMIN";
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const series: CaseSeries = params.get("series") === "enquiry" ? "enquiry" : "aligner";
  const [search, setSearch] = useState("");

  const statusOptions = series === "enquiry" ? ENQUIRY_STATUSES : STATUSES;

  function switchSeries(next: CaseSeries) {
    // A status that only exists on the other side would show an empty table
    // and look like a bug, so it is dropped on the way across.
    const keep =
      status && (next === "enquiry" ? ENQUIRY_STATUSES : STATUSES).includes(status)
        ? status
        : "";
    const p: Record<string, string> = { series: next };
    if (keep) p.status = keep;
    setParams(p);
  }

  const orders = useInfiniteQuery({
    queryKey: ["staff-orders", series, status, search],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.staffOrders(
        { series, status: status || undefined, search: search || undefined },
        { limit: PAGE_SIZE + 1, offset: pageParam as number },
      ),
    getNextPageParam: (last, all) => (last.length > PAGE_SIZE ? all.length * PAGE_SIZE : undefined),
  });
  const rows = (orders.data?.pages ?? []).flatMap((p) => p.slice(0, PAGE_SIZE));
  const active = SERIES.find((s) => s.key === series)!;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>{active.label}</h1>
          <p className="sub">
            {active.hint} {rows.length} shown.
          </p>
        </div>
        <div className="row">
          <input
            placeholder="Case number, patient, doctor, clinic"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ minWidth: 260 }}
          />
          <select
            value={status}
            onChange={(e) => {
              const next = e.target.value;
              setParams(next ? { status: next } : {});
            }}
          >
            <option value="">Every status</option>
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
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
            onClick={() => switchSeries(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {orders.isLoading ? (
        <Loading what="cases" />
      ) : rows.length === 0 ? (
        <Empty>
          {series === "enquiry"
            ? "No enquiries match."
            : "No cases in the aligner series match."}
        </Empty>
      ) : (
        <>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Patient</th>
                <th>Doctor</th>
                <th>Align category</th>
                {series === "aligner" && <th>Orthodontist</th>}
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((order) => (
                <tr
                  key={order.id}
                  className="clickable"
                  onClick={() => navigate(`/staff/orders/${order.id}`)}
                >
                  <td className="mono">
                    {order.order_number}
                    {order.priority === "EXPRESS" && (
                      <span className="pill pill-gold" style={{ marginLeft: 8 }}>
                        Express
                      </span>
                    )}
                  </td>
                  <td>{order.patient_name}</td>
                  <td>
                    {order.doctor_name}
                    {order.clinic_name && <div className="dim">{order.clinic_name}</div>}
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
                  {series === "aligner" && (
                    // Stops the click reaching the row, which would open the case.
                    <td onClick={(e) => e.stopPropagation()}>
                      <AssigneeCell order={order} canAssign={canAssign} />
                    </td>
                  )}
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
        <LoadMore query={orders} noun="cases" shown={rows.length} />
        </>
      )}
    </main>
  );
}

/** Who is planning a case, changed from the board itself.
 *
 *  The admin picks from the list; an orthodontist sees the name and cannot
 *  move it, because handing cases around is what divides the board in the
 *  first place. The roster is fetched once for the whole table rather than per
 *  row.
 */
function AssigneeCell({
  order,
  canAssign,
}: {
  order: OrderSummary;
  canAssign: boolean;
}) {
  const queryClient = useQueryClient();
  const people = useQuery({
    queryKey: ["orthodontists"],
    queryFn: api.orthodontists,
    enabled: canAssign,
    staleTime: 5 * 60 * 1000,
  });

  const assign = useMutation({
    mutationFn: (userId: string | null) => api.assignCase(order.id, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["staff-orders"] });
      void queryClient.invalidateQueries({ queryKey: ["queue"] });
    },
  });

  if (!canAssign) {
    return order.assigned_to_name ? (
      <span>{order.assigned_to_name}</span>
    ) : (
      <span className="dim">3D Align</span>
    );
  }

  return (
    <select
      className="assignee-select"
      value={order.assigned_to_id ?? ""}
      disabled={assign.isPending}
      onChange={(e) => assign.mutate(e.target.value || null)}
      title={assign.error ? String(assign.error) : undefined}
    >
      <option value="">3D Align</option>
      {(people.data ?? [])
        .filter((p) => p.is_active || p.id === order.assigned_to_id)
        .map((p) => (
          <option key={p.id} value={p.id}>
            {p.full_name || p.email}
            {p.is_active ? "" : " (inactive)"}
          </option>
        ))}
    </select>
  );
}
