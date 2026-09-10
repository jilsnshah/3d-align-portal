/* What a clinic sees when they sign in.
 *
 * Laid out as a workspace rather than a stack. Every block used to run the full
 * 1,192px of the page, so a row with a patient at one end and a status at the
 * other had six hundred pixels of nothing down its middle, and anything that
 * did not fit the stack had nowhere to go at all. The work now takes a column
 * of its own and a rail beside it carries what the practice needs to see but
 * does not act on line by line.
 *
 * Three things the portal already knew and never showed here: what has happened
 * since the clinic last looked (sixty notifications, behind a bell), how far
 * through its phases a case in delivery has got, and what the month has cost.
 * All three come from endpoints that already existed.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { api, since } from "../../api";
import type { Notification, OrderStatus, OrderSummary } from "../../api";
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
    that only makes the number harder to read. The exact amount, to the paisa,
    is on the payments page. */
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

/** One figure in the band. Every one leads to what it counts: a number a clinic
    cannot act on is a number this page does not need. */
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

/** The line under a patient's name: what it is, how long it has sat, and — for
    a case being delivered in batches — which batch it has reached. Phase counts
    ride on every list row the portal serves and were never once rendered. */
function CaseMeta({ order, showBranch }: { order: OrderSummary; showBranch: boolean }) {
  const phased = order.phases_total > 0 && order.phases_done < order.phases_total;
  return (
    <div className="case-meta">
      <span className="mono">{order.order_number}</span>
      {order.product_label && <span>{order.product_label}</span>}
      {order.category_label && !order.product_label && <span>{order.category_label}</span>}
      {phased && (
        <span className="case-phase">
          Phase {order.phases_done + 1} of {order.phases_total}
        </span>
      )}
      {showBranch && order.branch_label && <span>{order.branch_label}</span>}
      <span className="case-age" title="Since this case last moved">
        {since(order.updated_at)}
      </span>
    </div>
  );
}

function CaseRow({
  order,
  ask,
  showBranch,
  onOpen,
}: {
  order: OrderSummary;
  /** Only the cases waiting on the clinic spell out what is being asked. */
  ask?: boolean;
  /** A practice with one clinic does not need it named under every case. */
  showBranch: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <button type="button" className="case-row" onClick={() => onOpen(order.id)}>
      <span className="case-name">
        {order.patient_name}
        {/* Carried on every order and never shown to the clinic that paid for
            it — a rush case looks like any other on this page today. */}
        {order.priority === "EXPRESS" && <span className="pill pill-gold case-express">Express</span>}
      </span>
      <CaseMeta order={order} showBranch={showBranch} />
      <span className="case-state">
        <StatusPill status={order.status} label={order.status_label} />
      </span>
      {ask && (
        <span className="case-ask">
          {ASK[order.status] ?? order.status_label}
          <span className="go"> →</span>
        </span>
      )}
    </button>
  );
}

/** What has happened since the clinic last looked.
 *
 *  The portal keeps sixty of these and showed them only in a drawer behind a
 *  bell — so a plan shared this morning was news the clinic had to go looking
 *  for. On the page they land on, it is the answer to "anything new?". */
function Activity() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const notes = useQuery({ queryKey: ["notifications"], queryFn: api.notifications });
  const unread = useQuery({ queryKey: ["unread"], queryFn: api.unreadCount });

  const clear = useMutation({
    mutationFn: api.markAllRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["unread"] });
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  const count = unread.data?.count ?? 0;
  const items = (notes.data ?? []).slice(0, 7);

  return (
    <section className="rail-block">
      <div className="rail-head">
        <h3>Activity</h3>
        {count > 0 ? (
          <button
            type="button"
            className="btn-link"
            disabled={clear.isPending}
            onClick={() => clear.mutate()}
          >
            Mark {count} read
          </button>
        ) : (
          <span className="dim">Up to date</span>
        )}
      </div>

      {notes.isLoading ? (
        <Skeleton rows={3} />
      ) : items.length === 0 ? (
        <p className="dim">Nothing has happened yet.</p>
      ) : (
        <ul className="feed">
          {items.map((n: Notification) => (
            <li key={n.id} className={n.read_at ? "feed-item" : "feed-item new"}>
              {/* Only a note that belongs to a case can open one. */}
              {n.order_id ? (
                <button type="button" onClick={() => navigate(`/orders/${n.order_id}`)}>
                  <b>{n.title}</b>
                  <span className="feed-body">{n.body}</span>
                  <span className="feed-when">{since(n.created_at)}</span>
                </button>
              ) : (
                <div>
                  <b>{n.title}</b>
                  <span className="feed-body">{n.body}</span>
                  <span className="feed-when">{since(n.created_at)}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The month so far. Not a chart — three figures a practice can read at a
    glance, with the charts a click away where they belong. */
function ThisMonth() {
  const now = new Date();
  const stats = useQuery({
    queryKey: ["stats", "home", now.getFullYear(), now.getMonth()],
    queryFn: () =>
      api.practiceStats({ view: "month", year: now.getFullYear(), month: now.getMonth() + 1 }),
  });
  const t = stats.data?.totals;

  return (
    <section className="rail-block">
      <div className="rail-head">
        <h3>This month</h3>
        <Link to="/stats" className="btn-link">
          Insights
        </Link>
      </div>
      <dl className="tally">
        <div>
          <dt>Cases started</dt>
          <dd>{t ? t.aligners : "—"}</dd>
        </div>
        <div>
          <dt>Appliances</dt>
          <dd>{t ? t.products + t.accessories : "—"}</dd>
        </div>
        <div>
          <dt>Paid</dt>
          <dd>{t ? roundedRupees(Number(t.paid)) : "—"}</dd>
        </div>
      </dl>
    </section>
  );
}

export default function DoctorHome() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const open = (id: string) => navigate(`/orders/${id}`);

  const waiting = useQuery({
    queryKey: ["orders", "needs-action"],
    queryFn: () => api.orders(true, { limit: 6 }),
  });
  const recent = useQuery({
    queryKey: ["orders", "recent"],
    queryFn: () => api.orders(false, { limit: 10 }),
  });
  // The money the clinic owes belongs on the page they land on, not only on the
  // one they would have to remember to open.
  const ledger = useQuery({ queryKey: ["payment-ledger"], queryFn: api.paymentLedger });
  // Everything open, not just the handful the page lists, so the count on the
  // band is the clinic's real book of work.
  const openCases = useQuery({
    queryKey: ["orders", "open-count"],
    queryFn: () => api.orders(false, { limit: 200 }),
  });
  const addresses = useQuery({ queryKey: ["addresses"], queryFn: api.addresses });
  const multiBranch = (addresses.data?.length ?? 0) > 1;

  const withLab =
    openCases.data === undefined
      ? null
      : openCases.data.filter(
          (o) =>
            !o.needs_doctor_action &&
            o.status !== "COMPLETED" &&
            o.status !== "CANCELLED",
        ).length;

  // A case waiting on the clinic is already the first thing on the page;
  // listing it again below reads as two different cases with one number.
  const waitingIds = new Set((waiting.data ?? []).map((o) => o.id));
  const inFlight = (recent.data ?? []).filter(
    (o) => o.status !== "COMPLETED" && o.status !== "CANCELLED" && !waitingIds.has(o.id),
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
            hint={
              needing === 0
                ? "All clear"
                : needing === 1
                  ? "1 case to act on"
                  : `${needing} cases to act on`
            }
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

      <div className="desk">
        <div className="desk-main">
          <section className="board">
            <div className="board-head">
              <h2>
                Waiting on you
                {needing > 0 && <span className="count">{needing}</span>}
              </h2>
              <Link to="/orders" className="btn-link">
                All cases
              </Link>
            </div>

            {waiting.isLoading ? (
              <Skeleton rows={3} />
            ) : needing === 0 ? (
              <p className="board-clear">
                <strong>Nothing needs you.</strong>{" "}
                <span className="muted">
                  {(withLab ?? 0) > 0
                    ? `${withLab} case${withLab === 1 ? "" : "s"} are with 3D Align.`
                    : "Start a case whenever you are ready."}
                </span>
              </p>
            ) : (
              <div className="case-list">
                {waiting.data?.map((order) => (
                  <CaseRow key={order.id} order={order} ask showBranch={multiBranch} onOpen={open} />
                ))}
              </div>
            )}
          </section>

          {inFlight.length > 0 && (
            <section className="board">
              <div className="board-head">
                <h2>
                  With 3D Align
                  {withLab ? <span className="count quiet">{withLab}</span> : null}
                </h2>
                <Link to="/orders" className="btn-link">
                  All cases
                </Link>
              </div>
              <div className="case-list">
                {inFlight.slice(0, 6).map((order) => (
                  <CaseRow key={order.id} order={order} showBranch={multiBranch} onOpen={open} />
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="desk-rail">
          <Activity />
          <ThisMonth />

          {/* Ordering, at the foot of the rail. It was three large cards and a
              strip of six products above the work — two shop windows in front
              of the desk. Every destination survives; none of them shouts. */}
          <section className="rail-block">
            <div className="rail-head">
              <h3>Place an order</h3>
              <Link to="/catalogue" className="btn-link">
                Range
              </Link>
            </div>
            <div className="rail-actions">
              <button type="button" onClick={() => navigate("/orders/new")}>
                <b>New aligner case</b>
                <span>Records and a scan</span>
              </button>
              <button type="button" onClick={() => navigate("/catalogue")}>
                <b>An appliance</b>
                <span>Retainers, splints, trays, guards</span>
              </button>
              <button type="button" onClick={() => navigate("/catalogue?tab=accessories")}>
                <b>Accessories</b>
                <span>Straight off the shelf</span>
              </button>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
