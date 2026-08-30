/* What a clinic sees when they sign in.

   The case list is the right screen for someone auditing forty cases; it is the
   wrong one to land on. A doctor arrives wanting one of three things: to start
   something, to deal with whatever is waiting on them, or to check on a patient
   they have in mind. This puts those first and keeps the table one click away.

   The catalogue is on this page rather than only behind a nav item, because a
   retainer is bought on impulse at the end of a case — not by someone who set
   out to go shopping. */

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { api, formatDate } from "../../api";
import type { OrderStatus, OrderSummary, Product } from "../../api";
import { useAuth } from "../../auth";
import { Skeleton, StatusPill } from "../../components/ui";

function rupees(value: string | number): string {
  return `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/* What the clinic actually has to do, in the words they would use. A status
   name tells them where the case is; this tells them what is being asked. */
const ASK: Partial<Record<OrderStatus, string>> = {
  DRAFT: "Finish and submit this case",
  RECORDS_REQUESTED: "3D Align need better records",
  QUOTED: "Review the quote",
  AWAITING_SCAN: "Send the intraoral scan",
  PLAN_SHARED: "Review the treatment plan",
  FIT_REVIEW: "Tell us how the training aligner fits",
};

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function firstName(full: string): string {
  // "Dr. Anita Mehta" reads better as "Dr. Mehta" than as the whole thing.
  const parts = full.trim().split(/\s+/);
  if (parts.length > 1 && /^dr\.?$/i.test(parts[0])) return `${parts[0]} ${parts[parts.length - 1]}`;
  return parts[0] ?? full;
}

export default function DoctorHome() {
  const { me } = useAuth();
  const navigate = useNavigate();

  const waiting = useQuery({
    queryKey: ["orders", "needs-action"],
    queryFn: () => api.orders(true, { limit: 6 }),
  });
  const recent = useQuery({
    queryKey: ["orders", "recent"],
    queryFn: () => api.orders(false, { limit: 5 }),
  });
  const products = useQuery({ queryKey: ["products"], queryFn: api.products });

  // A case that is waiting on the clinic is already the first thing on the
  // page; listing it again under "In progress" reads as two different cases
  // with the same number.
  // Everything open, not just the handful the page lists, so the count on the
  // panel is the clinic's real book of work.
  const openCases = useQuery({
    queryKey: ["orders", "open-count"],
    queryFn: () => api.orders(false, { limit: 200 }),
  });
  const withLab =
    openCases.data === undefined
      ? null
      : openCases.data.filter(
          (o) =>
            !o.needs_doctor_action &&
            o.status !== "COMPLETED" &&
            o.status !== "CANCELLED",
        ).length;

  const waitingIds = new Set((waiting.data ?? []).map((o) => o.id));
  const open = (recent.data ?? []).filter(
    (o) =>
      o.status !== "COMPLETED" && o.status !== "CANCELLED" && !waitingIds.has(o.id),
  );

  return (
    <main className="page home">
      <section className="welcome">
        <div>
          <h1>
            {greeting()}, {firstName(me?.doctor?.full_name ?? "Doctor")}
          </h1>
          <p className="sub">{me?.doctor?.clinic_name}</p>
        </div>
        {/* The panel was a large dark rectangle saying only the time of day.
            These are the two numbers a clinic opens the portal to check. */}
        <dl className="welcome-stats">
          <div>
            <dt>Waiting on you</dt>
            <dd>{waiting.data?.length ?? "—"}</dd>
          </div>
          <div>
            <dt>With 3D Align</dt>
            <dd>{withLab === null ? "—" : withLab}</dd>
          </div>
        </dl>
      </section>

      <div className="start-grid">
        <button type="button" className="start-card" onClick={() => navigate("/orders/new")}>
          <span className="start-kicker">Clear aligners</span>
          <strong>Start a new case</strong>
          <span className="muted">
            Send records and a scan. We plan the movement, share a 3D simulation, and make the
            series.
          </span>
          <span className="start-go">Begin →</span>
        </button>

        <button type="button" className="start-card" onClick={() => navigate("/catalogue")}>
          <span className="start-kicker">Orthodontic Aligner Integrated Appliances</span>
          <strong>Order a product</strong>
          <span className="muted">
            Retainers, splints, bleaching trays and guards — made from a scan, no planning stage.
            Price plus courier, charged together.
          </span>
          <span className="start-go">See the range →</span>
        </button>
      </div>

      {waiting.isLoading ? (
        <Skeleton rows={3} />
      ) : (waiting.data?.length ?? 0) > 0 ? (
        <section className="stack-sm">
          <div className="row-between">
            <h2 style={{ margin: 0 }}>Waiting on you</h2>
            <Link to="/orders" className="btn-link">
              All cases
            </Link>
          </div>
          <div className="waiting-list">
            {waiting.data?.map((order: OrderSummary) => (
              <button
                key={order.id}
                type="button"
                className="waiting-row"
                onClick={() => navigate(`/orders/${order.id}`)}
              >
                <div>
                  <strong>{order.patient_name}</strong>
                  <div className="dim">
                    <span className="mono">{order.order_number}</span>
                    {order.product_label ? ` · ${order.product_label}` : ""}
                  </div>
                </div>
                <div className="waiting-right">
                  <StatusPill status={order.status} label={order.status_label} />
                  <span className="waiting-ask">
                    {ASK[order.status] ?? order.status_label}
                    <span className="start-go"> →</span>
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <section className="card">
          <strong>Nothing needs you right now.</strong>{" "}
          <span className="muted">
            {open.length > 0
              ? `${open.length} case${open.length === 1 ? "" : "s"} with 3D Align.`
              : "Start a case whenever you are ready."}
          </span>
        </section>
      )}

      <section className="stack-sm">
        <div className="row-between">
          <h2 style={{ margin: 0 }}>Orthodontic Aligner Integrated Appliances</h2>
          <Link to="/catalogue" className="btn-link">
            The full range
          </Link>
        </div>
        {products.isLoading ? (
          <Skeleton rows={6} variant="tile" />
        ) : (
          <div className="product-strip">
            {products.data?.slice(0, 6).map((product: Product) => (
              <button
                key={product.id}
                type="button"
                className="strip-card"
                onClick={() => navigate(`/catalogue?order=${product.id}`)}
              >
                <span className="product-code">{product.code}</span>
                <strong>{product.name}</strong>
                <span className="product-from">
                  from {rupees(Math.min(...product.sizes.map((s) => Number(s.price))))}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {open.length > 0 && (
        <section className="stack-sm">
          <div className="row-between">
            <h2 style={{ margin: 0 }}>In progress</h2>
            <Link to="/orders" className="btn-link">
              All cases
            </Link>
          </div>
          <div className="waiting-list">
            {open.slice(0, 4).map((order) => (
              <button
                key={order.id}
                type="button"
                className="waiting-row"
                onClick={() => navigate(`/orders/${order.id}`)}
              >
                <div>
                  <strong>{order.patient_name}</strong>
                  <div className="dim">
                    <span className="mono">{order.order_number}</span> · updated{" "}
                    {formatDate(order.updated_at)}
                  </div>
                </div>
                <div className="waiting-ask muted">{order.status_label}</div>
              </button>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
