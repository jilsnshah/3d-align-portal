import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { PAGE_SIZE, api, formatDate } from "../../api";
import { LoadMore } from "../../components/LoadMore";
import { Empty, Loading, StatusPill } from "../../components/ui";

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

export default function StaffOrders() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const [search, setSearch] = useState("");

  const orders = useInfiniteQuery({
    queryKey: ["staff-orders", status, search],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.staffOrders(
        { status: status || undefined, search: search || undefined },
        { limit: PAGE_SIZE + 1, offset: pageParam as number },
      ),
    getNextPageParam: (last, all) => (last.length > PAGE_SIZE ? all.length * PAGE_SIZE : undefined),
  });
  const rows = (orders.data?.pages ?? []).flatMap((p) => p.slice(0, PAGE_SIZE));

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>All cases</h1>
          <p className="sub">{rows.length} case(s) shown.</p>
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
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
        </div>
      </div>

      {orders.isLoading ? (
        <Loading what="cases" />
      ) : rows.length === 0 ? (
        <Empty>No cases match.</Empty>
      ) : (
        <>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Patient</th>
                <th>Doctor</th>
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
                    <StatusPill status={order.status} label={order.status_label} />
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
