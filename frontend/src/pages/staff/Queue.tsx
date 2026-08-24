import { useQuery } from "@tanstack/react-query";
import CaseProgress from "../../components/CaseProgress";
import { useNavigate } from "react-router-dom";

import { api, formatDate } from "../../api";
import { Empty, Loading } from "../../components/ui";

const BUCKETS: { key: keyof ReturnType<typeof bucketKeys>; label: string; status?: string }[] = [
  { key: "new_submissions", label: "New submissions", status: "SUBMITTED" },
  { key: "awaiting_quote", label: "Awaiting quote", status: "UNDER_REVIEW" },
  { key: "awaiting_scan_review", label: "Scans to verify", status: "AWAITING_SCAN" },
  { key: "in_planning", label: "In planning", status: "IN_PLANNING" },
  { key: "in_production", label: "In production", status: "ALIGNER_PRODUCTION" },
  { key: "dispatching", label: "Dispatching", status: "DISPATCHING" },
  { key: "ready_to_invoice", label: "Ready to invoice" },
  { key: "pending_doctors", label: "Doctors to verify" },
];

function bucketKeys() {
  return {} as {
    new_submissions: number;
    awaiting_quote: number;
    awaiting_scan_review: number;
    in_planning: number;
    in_production: number;
    ready_to_ship: number;
    dispatching: number;
    ready_to_invoice: number;
    pending_doctors: number;
  };
}

export default function StaffQueue() {
  const navigate = useNavigate();
  const queue = useQuery({ queryKey: ["queue"], queryFn: api.queue, refetchInterval: 60_000 });
  const active = useQuery({ queryKey: ["staff-orders", "active"], queryFn: () => api.staffOrders() });

  if (queue.isLoading) return <Loading what="queue" />;

  const openOrders = (active.data ?? []).filter(
    (o) => o.status !== "COMPLETED" && o.status !== "CANCELLED",
  );

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Lab queue</h1>
          <p className="sub">Everything waiting on 3D Align today.</p>
        </div>
      </div>

      <div className="tiles">
        {BUCKETS.map((bucket) => {
          const count = queue.data?.[bucket.key] ?? 0;
          return (
            <button
              key={bucket.key}
              type="button"
              className={`tile${count > 0 ? " hot" : ""}`}
              onClick={() => {
                if (bucket.key === "pending_doctors") navigate("/staff/doctors");
                else if (bucket.status) navigate(`/staff/orders?status=${bucket.status}`);
                else navigate("/staff/orders");
              }}
            >
              <span className="n">{count}</span>
              <span className="l">{bucket.label}</span>
            </button>
          );
        })}
      </div>

      <h2 style={{ margin: "30px 0 12px" }}>Open cases</h2>
      {openOrders.length === 0 ? (
        <Empty>Nothing in flight.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Patient</th>
                <th>Doctor</th>
                <th>Orthodontist</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {openOrders.map((order) => (
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
    </main>
  );
}
