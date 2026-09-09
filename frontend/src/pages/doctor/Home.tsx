/* What a clinic sees when they sign in.

   A doctor opens this to answer three questions, in this order: is anything
   waiting on me, what does it cost me, and is the rest moving. The page used to
   open with a greeting and two numbers, then spend a third of its height on
   three large cards inviting them to go shopping — so the work they came for
   started below the fold.

   Now the band at the top carries the practice's actual state, money included,
   and every figure in it is a way through to the thing it counts. Ordering is
   still one click away at the foot: a retainer is bought on impulse at the end
   of a case, not by someone who set out to go shopping. */

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { api, since } from "../../api";
import type { OrderStatus, OrderSummary } from "../../api";
import { useAuth } from "../../auth";
import { Skeleton, StatusPill } from "../../components/ui";

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

/** A headline figure, not a line item — paise on a balance this size is noise
    that only makes the number harder to read at a glance. The exact amount is
    on the payments page, to the paisa. */
function roundedRupees(value: number): string {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

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

/** One figure in the band at the top. Every one of them leads somewhere: a
    number a clinic cannot act on is a number they do not need on this page. */
function Figure({
  label,
  value,
  to,
  hint,
  lit,
}: {
  label: string;
  value: string;
  to: string;
  hint: string;
  /** Gold, for the figure that is asking for something. */
  lit?: boolean;
}) {
  return (
    <Link to={to} className={`figure${lit ? " lit" : ""}`}>
      <span className="figure-n">{value}</span>
      <span className="figure-l">{label}</span>
      <span className="figure-h">{hint}</span>
    </Link>
  );
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
    queryFn: () => api.orders(false, { limit: 8 }),
  });
  // The money the clinic owes belongs on the page they land on, not only on the
  // one they would have to remember to open.
  const ledger = useQuery({ queryKey: ["payment-ledger"], queryFn: api.paymentLedger });

  // A case that is waiting on the clinic is already the first thing on the
  // page; listing it again under "In progress" reads as two different cases
  // with the same number.
  // Everything open, not just the handful the page lists, so the count on the
  // band is the clinic's real book of work.
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

  const due = ledger.data ? Number(ledger.data.outstanding) : null;
  const inReview = ledger.data ? Number(ledger.data.in_review) : 0;
  const needing = waiting.data?.length ?? 0;

  return (
    <main className="page home">
      <section className="standing">
        <div className="standing-who">
          <span className="standing-greet">{greeting()}</span>
          <h1>{firstName(me?.doctor?.full_name ?? "Doctor")}</h1>
          <p className="standing-clinic">{me?.doctor?.clinic_name}</p>
        </div>

        <div className="standing-figures">
          <Figure
            label="Waiting on you"
            value={waiting.isLoading ? "—" : String(needing)}
            to="/orders"
            hint={needing === 0 ? "All clear" : needing === 1 ? "1 case to act on" : `${needing} cases to act on`}
            lit={needing > 0}
          />
          <Figure
            label="With 3D Align"
            value={withLab === null ? "—" : String(withLab)}
            to="/orders"
            hint="In planning or production"
          />
          <Figure
            label="Due to pay"
            value={due === null ? "—" : roundedRupees(due)}
            to="/payments"
            hint={
              due === null
                ? "Loading"
                : due === 0
                  ? inReview > 0
                    ? "Receipts being checked"
                    : "Nothing outstanding"
                  : "Pay by UPI"
            }
            lit={(due ?? 0) > 0}
          />
        </div>
      </section>

      {waiting.isLoading ? (
        <Skeleton rows={3} />
      ) : needing > 0 ? (
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
                <div className="waiting-who">
                  <strong>{order.patient_name}</strong>
                  <div className="dim">
                    <span className="mono">{order.order_number}</span>
                    {order.product_label ? ` · ${order.product_label}` : ""}
                    {/* How long it has been sitting with them, which is what
                        decides which one they open first. */}
                    <span className="waiting-age" title="Since this case last moved">
                      {since(order.updated_at)}
                    </span>
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
        <section className="all-clear">
          <strong>Nothing needs you right now.</strong>
          <span className="muted">
            {(withLab ?? 0) > 0
              ? `${withLab} case${withLab === 1 ? "" : "s"} with 3D Align.`
              : "Start a case whenever you are ready."}
          </span>
        </section>
      )}

      {open.length > 0 && (
        <section className="stack-sm">
          <div className="row-between">
            <h2 style={{ margin: 0 }}>With 3D Align</h2>
            <Link to="/orders" className="btn-link">
              All cases
            </Link>
          </div>
          <div className="waiting-list">
            {open.slice(0, 5).map((order) => (
              <button
                key={order.id}
                type="button"
                className="waiting-row"
                onClick={() => navigate(`/orders/${order.id}`)}
              >
                <div className="waiting-who">
                  <strong>{order.patient_name}</strong>
                  <div className="dim">
                    <span className="mono">{order.order_number}</span>
                    {order.product_label ? ` · ${order.product_label}` : ""}
                    <span className="waiting-age" title="Since this case last moved">
                      {since(order.updated_at)}
                    </span>
                  </div>
                </div>
                {/* The same pill the section above uses. These rows used to set
                    the status as plain grey text, so one screen said the same
                    thing two different ways. */}
                <div className="waiting-right">
                  <StatusPill status={order.status} label={order.status_label} />
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Ordering, kept to one quiet row. It was three large cards and a strip
          of six products above the work — two shop windows in front of the
          desk. All three destinations survive; none of them shouts. */}
      <section className="stack-sm">
        <div className="row-between">
          <h2 style={{ margin: 0 }}>Place an order</h2>
          <Link to="/catalogue" className="btn-link">
            The full range
          </Link>
        </div>
        <div className="order-row">
          <button type="button" className="order-tile" onClick={() => navigate("/orders/new")}>
            <strong>New aligner case</strong>
            <span className="muted">Records and a scan — we plan and make the series.</span>
            <span className="start-go">Begin →</span>
          </button>
          <button type="button" className="order-tile" onClick={() => navigate("/catalogue")}>
            <strong>Appliance</strong>
            <span className="muted">Retainers, splints, trays and guards, made from a scan.</span>
            <span className="start-go">See the range →</span>
          </button>
          <button
            type="button"
            className="order-tile"
            onClick={() => navigate("/catalogue?tab=accessories")}
          >
            <strong>Accessories</strong>
            <span className="muted">IPR strips, cleanser, cases and kits — straight off the shelf.</span>
            <span className="start-go">Open the shelf →</span>
          </button>
        </div>
      </section>
    </main>
  );
}
