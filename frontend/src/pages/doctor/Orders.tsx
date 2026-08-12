import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { api, formatDate } from "../../api";
import type { OrderSummary } from "../../api";
import { Empty, Loading, StatusPill } from "../../components/ui";

export default function DoctorOrders() {
  const navigate = useNavigate();
  const orders = useQuery({ queryKey: ["orders"], queryFn: () => api.orders() });

  if (orders.isLoading) return <Loading what="cases" />;

  const all = orders.data ?? [];
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
          <p className="sub">Clear aligner cases submitted to 3D Align.</p>
        </div>
        <Link to="/orders/new">
          <button type="button" className="btn-primary">
            New case
          </button>
        </Link>
      </div>

      {all.length === 0 ? (
        <Empty>
          No cases yet. <Link to="/orders/new">Start your first one.</Link>
        </Empty>
      ) : (
        <div className="stack">
          <Section
            title="Needs your action"
            orders={actionable}
            onOpen={(id) => navigate(`/orders/${id}`)}
            emptyText="Nothing waiting on you."
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
}: {
  title: string;
  orders: OrderSummary[];
  onOpen: (id: string) => void;
  emptyText?: string;
}) {
  return (
    <section>
      <h4 style={{ marginBottom: 10 }}>{title}</h4>
      {orders.length === 0 ? (
        emptyText && <p className="dim">{emptyText}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Patient</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="clickable" onClick={() => onOpen(order.id)}>
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
                    <StatusPill status={order.status} label={order.status_label} />
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
