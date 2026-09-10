/* The clinic's front door.
 *
 * Read as a website with a workspace inside it rather than as a dashboard. A
 * doctor arrives for one of two reasons — something is waiting on them, or they
 * want to order — and the page has to answer both without either burying the
 * other. So: a hero that says whose practice this is and puts the one action
 * they take most within reach, a ribbon of the three figures that describe the
 * practice, then the desk, then the range.
 *
 * The slideshow is 3D Align's own catalogue artwork, which the portal already
 * ships. Showing it here is the difference between a tool a clinic logs into
 * and a supplier they buy from.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { api, since } from "../../api";
import type { Notification, OrderStatus, OrderSummary, Product } from "../../api";
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

/** A headline figure, not a line item — paise on a balance this size only make
    the number harder to read. The exact amount is on the payments page. */
function rupees(value: number | string): string {
  return `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
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

function cheapest(product: Product): number {
  return Math.min(...product.sizes.map((s) => Number(s.price)));
}

/** The decoration behind the hero.
 *
 *  Drawn rather than dropped in: a honeycomb of fine gold hexagons, which is the
 *  texture 3D Align prints on its own catalogue cards, a soft light off the top
 *  left, and — set large and faint across the lower half — the curve of a dental
 *  arch with its teeth marked. The motif belongs to this trade and to no other,
 *  which is the point of drawing it instead of reaching for a gradient.
 *
 *  Entirely presentational: aria-hidden, and it never takes a pointer event.
 */
function HeroArt() {
  return (
    <svg className="hero-art" viewBox="0 0 1200 420" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <pattern id="comb" width="28" height="48" patternUnits="userSpaceOnUse">
          {/* Three hexagons per tile — one whole, two half-dropped — which is
              what makes the grid continue across the seam. */}
          <g fill="none" stroke="#d4af37" strokeWidth="0.9">
            <path d="M14 0 L28 8 L28 24 L14 32 L0 24 L0 8 Z" />
            <path d="M28 24 L42 32 L42 48 L28 56 L14 48 L14 32 Z" />
            <path d="M0 24 L14 32 L14 48 L0 56 L-14 48 L-14 32 Z" />
          </g>
        </pattern>

        <radialGradient id="lamp" cx="12%" cy="0%" r="62%">
          <stop offset="0%" stopColor="#d4af37" stopOpacity="0.30" />
          <stop offset="55%" stopColor="#d4af37" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#d4af37" stopOpacity="0" />
        </radialGradient>

        {/* The comb is strongest where the light falls and gone by the right
            edge, so the texture reads as lit rather than as wallpaper. */}
        <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0.6">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.30" />
          <stop offset="45%" stopColor="#fff" stopOpacity="0.10" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="combMask">
          <rect width="1200" height="420" fill="url(#fade)" />
        </mask>

        <linearGradient id="archInk" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#d4af37" stopOpacity="0" />
          <stop offset="35%" stopColor="#d4af37" stopOpacity="0.5" />
          <stop offset="70%" stopColor="#d4af37" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#d4af37" stopOpacity="0" />
        </linearGradient>
      </defs>

      <rect width="1200" height="420" fill="url(#comb)" mask="url(#combMask)" />
      <rect width="1200" height="420" fill="url(#lamp)" />

      {/* An upper arch, seen from below: the outline, then the contact points
          between the teeth stepping round it. */}
      <g className="hero-arch" fill="none" stroke="url(#archInk)">
        <path d="M120 392 C 150 250, 250 168, 420 168 C 590 168, 690 250, 720 392" strokeWidth="1.6" />
        <path d="M168 396 C 194 282, 282 212, 420 212 C 558 212, 646 282, 672 396" strokeWidth="1" />
        <g strokeWidth="1" opacity="0.7">
          <path d="M133 330 L181 342" /><path d="M152 282 L197 300" />
          <path d="M182 240 L221 265" /><path d="M223 206 L253 239" />
          <path d="M274 184 L293 224" /><path d="M330 172 L340 215" />
          <path d="M390 168 L392 212" /><path d="M450 168 L448 212" />
          <path d="M510 172 L500 215" /><path d="M566 184 L547 224" />
          <path d="M617 206 L587 239" /><path d="M658 240 L619 265" />
          <path d="M688 282 L643 300" /><path d="M707 330 L659 342" />
        </g>
      </g>
    </svg>
  );
}

/** 3D Align's own catalogue cards, turning over.
 *
 *  Only products that actually have a card: the lettered placeholder is the
 *  right answer on a shelf and the wrong one in a shop window. It stops on
 *  hover and on focus, and never starts at all for a reader who has asked the
 *  system for less motion.
 */
function Showcase({ products }: { products: Product[] }) {
  const navigate = useNavigate();
  const shown = useMemo(() => products.filter((p) => p.image_url), [products]);
  const [at, setAt] = useState(0);
  const [held, setHeld] = useState(false);
  const stilled = useRef(false);

  useEffect(() => {
    stilled.current =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }, []);

  useEffect(() => {
    if (held || stilled.current || shown.length < 2) return;
    const t = window.setInterval(() => setAt((i) => (i + 1) % shown.length), 5200);
    return () => window.clearInterval(t);
  }, [held, shown.length]);

  if (shown.length === 0) return null;
  const product = shown[Math.min(at, shown.length - 1)];

  return (
    <div
      className="showcase"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocusCapture={() => setHeld(true)}
      onBlurCapture={() => setHeld(false)}
    >
      <button
        type="button"
        className="showcase-card"
        onClick={() => navigate(`/catalogue?order=${product.id}`)}
        aria-label={`Order the ${product.name}`}
      >
        {shown.map((p, i) => (
          <img
            key={p.id}
            src={p.image_url}
            alt=""
            aria-hidden={i !== at}
            className={i === at ? "on" : ""}
            loading={i === 0 ? "eager" : "lazy"}
          />
        ))}
      </button>

      <div className="showcase-foot">
        <div className="showcase-name">
          <b>{product.name}</b>
          <span>from {rupees(cheapest(product))}</span>
        </div>
        <div className="showcase-dots" role="tablist" aria-label="Products">
          {shown.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={i === at}
              aria-label={p.name}
              className={i === at ? "on" : ""}
              onClick={() => setAt(i)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** One figure in the ribbon. Every one leads to what it counts: a number a
    clinic cannot act on is a number this page does not need. */
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
    a case delivered in batches — which batch it has reached. */
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
 *  bell, so a plan shared this morning was news they had to go looking for. */
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
  const items = (notes.data ?? []).slice(0, 6);

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

/** The month so far, and what it costs this clinic to have something sent.
 *  The delivery rate is worth saying out loud: it is charged on every appliance
 *  and the clinic could only find it by starting an order. */
function Practice() {
  const now = new Date();
  const stats = useQuery({
    queryKey: ["stats", "home", now.getFullYear(), now.getMonth()],
    queryFn: () =>
      api.practiceStats({ view: "month", year: now.getFullYear(), month: now.getMonth() + 1 }),
  });
  const delivery = useQuery({ queryKey: ["delivery-charge"], queryFn: api.deliveryCharge });
  const t = stats.data?.totals;
  const d = delivery.data;

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
          <dd>{t ? rupees(t.paid) : "—"}</dd>
        </div>
        {d?.has_address && (
          <div>
            <dt>Delivery to {d.city}</dt>
            <dd>{rupees(d.amount)}</dd>
          </div>
        )}
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
  const ledger = useQuery({ queryKey: ["payment-ledger"], queryFn: api.paymentLedger });
  const openCases = useQuery({
    queryKey: ["orders", "open-count"],
    queryFn: () => api.orders(false, { limit: 200 }),
  });
  const addresses = useQuery({ queryKey: ["addresses"], queryFn: api.addresses });
  const products = useQuery({ queryKey: ["products"], queryFn: api.products });
  // Whether an unsettled appliance is holding the next one. Said here rather
  // than discovered at the end of an order form the clinic has already filled.
  const hold = useQuery({ queryKey: ["ordering-hold"], queryFn: api.orderingHold });

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
  const blocked = hold.data && !hold.data.can_order_products;

  return (
    <main className="page home">
      <section className="hero">
        <HeroArt />

        <div className="hero-say">
          <div className="hero-top">
            <span className="hero-greet">{greeting()}</span>
            <h1>{firstName(me?.doctor?.full_name ?? "Doctor")}</h1>
            <p className="hero-clinic">{me?.doctor?.clinic_name}</p>
          </div>

          {/* The one action a clinic takes more than any other, at the size
              that says so. It used to be a link inside a card among three. */}
          <div className="hero-do">
            <button type="button" className="btn-hero" onClick={() => navigate("/orders/new")}>
              Start a new aligner case
              <span className="go"> →</span>
            </button>
            <button type="button" className="btn-hero ghost" onClick={() => navigate("/catalogue")}>
              Order an appliance
            </button>
          </div>

          {/* The three figures that describe the practice, in the band rather
              than in a strip of their own beneath it. */}
          <div className="hero-figures">
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
              value={due === null ? "—" : rupees(due)}
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
        </div>

        {products.isLoading ? (
          <div className="showcase showcase-wait" aria-hidden="true" />
        ) : (
          <Showcase products={products.data ?? []} />
        )}
      </section>

      {blocked && (
        <p className="hold-note">
          <b>{hold.data?.reference}</b> — {hold.data?.reason}. Settle it before starting
          another appliance. <Link to="/payments">Go to payments →</Link>
        </p>
      )}

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
                  <CaseRow
                    key={order.id}
                    order={order}
                    ask
                    showBranch={multiBranch}
                    onOpen={open}
                  />
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
                  <CaseRow
                    key={order.id}
                    order={order}
                    showBranch={multiBranch}
                    onOpen={open}
                  />
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="desk-rail">
          <Activity />
          <Practice />

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
