/* The clinic's front door.
 *
 * Answers four questions and stops: what needs me, what has happened, where do
 * I go, and what can I order. It is deliberately not a view of the data — the
 * page used to print twelve case rows, which is the Cases page rendered twice
 * and read once.
 *
 * The change that matters is how work is counted. A doctor does not think
 * "Isha Shah, EN-2026-0064"; they think "I owe them three scans". So what needs
 * them is grouped by the thing being asked rather than by the case asking, and
 * the cases themselves live one click away where they belong.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { api, since } from "../../api";
import type { Notification, OrderStatus, OrderSummary, Product } from "../../api";
import { useAuth } from "../../auth";
import { Skeleton } from "../../components/ui";

/* What the clinic has to do, in the words they would use, singular and plural.
   A status name says where a case is; this says what is being asked of them. */
const ASK: Partial<Record<OrderStatus, [string, string]>> = {
  DRAFT: ["Finish and send 1 draft case", "Finish and send {n} draft cases"],
  RECORDS_REQUESTED: ["Add better records to 1 case", "Add better records to {n} cases"],
  QUOTED: ["Review 1 quote", "Review {n} quotes"],
  AWAITING_SCAN: ["Send 1 intraoral scan", "Send {n} intraoral scans"],
  PLAN_SHARED: ["Review 1 treatment plan", "Review {n} treatment plans"],
  FIT_REVIEW: ["Confirm 1 training aligner fit", "Confirm {n} training aligner fits"],
};

/** The order they should be worked in — a draft the clinic has not sent is not
    as pressing as a lab waiting on a fit report. */
const URGENCY: OrderStatus[] = [
  "RECORDS_REQUESTED",
  "FIT_REVIEW",
  "PLAN_SHARED",
  "QUOTED",
  "AWAITING_SCAN",
  "DRAFT",
];

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
 *  left, and the curve of an upper arch with its contact points set large and
 *  faint beneath. The motif belongs to this trade and to no other, which is the
 *  point of drawing it instead of reaching for a gradient.
 */
function HeroArt() {
  return (
    <svg className="hero-art" viewBox="0 0 1200 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
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

        <radialGradient id="lamp" cx="10%" cy="0%" r="62%">
          <stop offset="0%" stopColor="#d4af37" stopOpacity="0.28" />
          <stop offset="55%" stopColor="#d4af37" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#d4af37" stopOpacity="0" />
        </radialGradient>

        {/* The comb is strongest where the light falls and gone by the right
            edge, so the texture reads as lit rather than as wallpaper. */}
        <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0.6">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="45%" stopColor="#fff" stopOpacity="0.09" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="combMask">
          <rect width="1200" height="300" fill="url(#fade)" />
        </mask>

        <linearGradient id="archInk" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#d4af37" stopOpacity="0" />
          <stop offset="40%" stopColor="#d4af37" stopOpacity="0.42" />
          <stop offset="75%" stopColor="#d4af37" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#d4af37" stopOpacity="0" />
        </linearGradient>
      </defs>

      <rect width="1200" height="300" fill="url(#comb)" mask="url(#combMask)" />
      <rect width="1200" height="300" fill="url(#lamp)" />

      {/* An upper arch seen from below: the outline, then the contact points
          between the teeth stepping round it. */}
      <g fill="none" stroke="url(#archInk)" transform="translate(430 -30)">
        <path d="M120 392 C 150 250, 250 168, 420 168 C 590 168, 690 250, 720 392" strokeWidth="1.5" />
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

/** What the clinic owes the lab, counted by the thing being asked.
 *
 *  This was six case rows — the Cases page, printed a second time. A doctor
 *  reads "send three intraoral scans" and knows their afternoon; they do not
 *  read six reference numbers and add them up.
 */
function Attention({ orders, loading }: { orders: OrderSummary[]; loading: boolean }) {
  const navigate = useNavigate();

  const groups = useMemo(() => {
    const by = new Map<OrderStatus, OrderSummary[]>();
    for (const o of orders) {
      if (!ASK[o.status]) continue;
      by.set(o.status, [...(by.get(o.status) ?? []), o]);
    }
    return URGENCY.filter((s) => by.has(s)).map((s) => ({ status: s, cases: by.get(s)! }));
  }, [orders]);

  if (loading) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Needs you</h2>
        </div>
        <Skeleton rows={3} />
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Needs you</h2>
        {orders.length > 0 && (
          <Link to="/orders" className="btn-link">
            All cases
          </Link>
        )}
      </div>

      {groups.length === 0 ? (
        <div className="clear">
          <span className="clear-tick" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M5 13l4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <strong>Nothing needs you.</strong>
            <p>Everything you have sent is with 3D Align. We will tell you when something moves.</p>
          </div>
        </div>
      ) : (
        <ul className="asks">
          {groups.map(({ status, cases }) => {
            const [one, many] = ASK[status]!;
            const label = cases.length === 1 ? one : many.replace("{n}", String(cases.length));
            // One case goes straight there; several go to the list.
            const to = cases.length === 1 ? `/orders/${cases[0].id}` : "/orders";
            // The longest a case in this group has been sitting, which is the
            // reason to do this one before that one.
            const oldest = cases.reduce((a, b) => (a.updated_at < b.updated_at ? a : b));
            return (
              <li key={status}>
                <button type="button" onClick={() => navigate(to)}>
                  <span className="ask-n">{cases.length}</span>
                  <span className="ask-say">
                    <b>{label}</b>
                    <span>
                      {cases.length === 1
                        ? `${cases[0].patient_name} · ${since(oldest.updated_at)}`
                        : `Oldest ${since(oldest.updated_at)}`}
                    </span>
                  </span>
                  <span className="ask-go" aria-hidden="true">
                    →
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
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
    <section className="panel">
      <div className="panel-head">
        <h2>Recent activity</h2>
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
        <Skeleton rows={4} />
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

/** Where to go, and the one number that says whether to go there.
 *
 *  A tile that only navigates makes the reader open it to find out whether it
 *  was worth opening. These carry their own headline, so the row is both the
 *  way through the portal and the state of the practice.
 */
function Jump({
  to,
  label,
  value,
  note,
  lit,
  icon,
}: {
  to: string;
  label: string;
  value: string;
  note: string;
  lit?: boolean;
  icon: React.ReactNode;
}) {
  return (
    <Link to={to} className={`jump${lit ? " lit" : ""}`}>
      <span className="jump-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="jump-value">{value}</span>
      <span className="jump-label">{label}</span>
      <span className="jump-note">{note}</span>
    </Link>
  );
}

const ICON = {
  cases: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M8 3v4M16 3v4M3.5 10h17" strokeLinecap="round" />
    </svg>
  ),
  money: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M6 5h12M6 9.5h12M9.5 5v3a4 4 0 0 1-4 4h-.5l7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  patients: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" strokeLinecap="round" />
    </svg>
  ),
  chart: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 20V10M10 20V5M16 20v-7M22 20H2" strokeLinecap="round" />
    </svg>
  ),
};

/** The range, as a shelf you can push along.
 *
 *  Native scroll with snap points, so a phone flicks through it the way a phone
 *  expects to and the arrows are an addition rather than the only way through.
 */
function Range({ products }: { products: Product[] }) {
  const navigate = useNavigate();
  const track = useRef<HTMLDivElement | null>(null);
  const [held, setHeld] = useState(false);
  const [at, setAt] = useState(0);
  const stilled = useRef(false);

  // Only what has a card. The lettered placeholder is the right answer on a
  // shelf and the wrong one in a shop window.
  const shown = useMemo(() => products.filter((p) => p.image_url), [products]);

  useEffect(() => {
    stilled.current =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const step = (dir: number) => {
    const el = track.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>(".range-card");
    const by = card ? card.offsetWidth + 14 : el.clientWidth;
    // Wrap rather than stop dead at either end — a shelf that will not come
    // back round reads as broken.
    const max = el.scrollWidth - el.clientWidth;
    let to = el.scrollLeft + by * dir;
    if (to > max + 4) to = 0;
    if (to < -4) to = max;
    el.scrollTo({ left: to, behavior: stilled.current ? "auto" : "smooth" });
  };

  useEffect(() => {
    if (held || stilled.current || shown.length < 2) return;
    const t = window.setInterval(() => step(1), 5000);
    return () => window.clearInterval(t);
  }, [held, shown.length]);

  const onScroll = () => {
    const el = track.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>(".range-card");
    const by = card ? card.offsetWidth + 14 : 1;
    setAt(Math.round(el.scrollLeft / by));
  };

  if (shown.length === 0) return null;

  return (
    <section
      className="range"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocusCapture={() => setHeld(true)}
      onBlurCapture={() => setHeld(false)}
    >
      <div className="range-head">
        <div>
          <h2>The range</h2>
          <p>Everything 3D Align makes, built from a scan and priced before you order.</p>
        </div>
        <div className="range-nav">
          <button type="button" onClick={() => step(-1)} aria-label="Previous products">
            ‹
          </button>
          <button type="button" onClick={() => step(1)} aria-label="Next products">
            ›
          </button>
          <Link to="/catalogue" className="btn-link">
            All products
          </Link>
        </div>
      </div>

      <div className="range-wrap">
        <div className="range-track" ref={track} onScroll={onScroll}>
          {shown.map((p) => (
            <button
              key={p.id}
              type="button"
              className="range-card"
              onClick={() => navigate(`/catalogue?order=${p.id}`)}
            >
              <span className="range-shot">
                <img src={p.image_url} alt="" loading="lazy" />
              </span>
              <span className="range-name">{p.name}</span>
              <span className="range-price">from {rupees(cheapest(p))}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="range-dots" aria-hidden="true">
        {shown.map((p, i) => (
          <span key={p.id} className={i === at ? "on" : ""} />
        ))}
      </div>
    </section>
  );
}

export default function DoctorHome() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const now = new Date();

  const waiting = useQuery({
    queryKey: ["orders", "needs-action"],
    queryFn: () => api.orders(true, { limit: 60 }),
  });
  const ledger = useQuery({ queryKey: ["payment-ledger"], queryFn: api.paymentLedger });
  const openCases = useQuery({
    queryKey: ["orders", "open-count"],
    queryFn: () => api.orders(false, { limit: 200 }),
  });
  const products = useQuery({ queryKey: ["products"], queryFn: api.products });
  const stats = useQuery({
    queryKey: ["stats", "home", now.getFullYear(), now.getMonth()],
    queryFn: () =>
      api.practiceStats({ view: "month", year: now.getFullYear(), month: now.getMonth() + 1 }),
  });
  // Whether an unsettled appliance is holding the next one. Said here rather
  // than discovered at the end of an order form already filled in.
  const hold = useQuery({ queryKey: ["ordering-hold"], queryFn: api.orderingHold });

  const withLab =
    openCases.data === undefined
      ? null
      : openCases.data.filter(
          (o) =>
            !o.needs_doctor_action &&
            o.status !== "COMPLETED" &&
            o.status !== "CANCELLED",
        ).length;

  const due = ledger.data ? Number(ledger.data.outstanding) : null;
  const needing = waiting.data?.length ?? 0;
  const blocked = hold.data && !hold.data.can_order_products;
  const t = stats.data?.totals;

  return (
    <main className="page home">
      <section className="hero">
        <HeroArt />
        <div className="hero-say">
          <span className="hero-greet">{greeting()}</span>
          <h1>{firstName(me?.doctor?.full_name ?? "Doctor")}</h1>
          <p className="hero-clinic">{me?.doctor?.clinic_name}</p>

          {/* The one action a clinic takes more than any other, at the size
              that says so — then the two next most, at the size they are. */}
          <div className="hero-do">
            <button type="button" className="btn-hero" onClick={() => navigate("/orders/new")}>
              Start a new aligner case
              <span className="go"> →</span>
            </button>
            <button type="button" className="btn-hero ghost" onClick={() => navigate("/catalogue")}>
              Order an appliance
            </button>
            <button type="button" className="btn-hero ghost" onClick={() => navigate("/orders")}>
              View cases
            </button>
          </div>
        </div>

        {/* The state of the practice, in the band rather than in a row of tiles
            below it — the hero was a name and two buttons on a wide dark field,
            and these are the figures a clinic opens the portal to read. */}
        <div className="hero-stats">
          <Jump
            to="/orders"
            label="Cases"
            value={withLab === null ? "—" : String(withLab)}
            note={needing > 0 ? `${needing} waiting on you` : "All with 3D Align"}
            lit={needing > 0}
            icon={ICON.cases}
          />
          <Jump
            to="/payments"
            label="Payments"
            value={due === null ? "—" : rupees(due)}
            note={due === 0 ? "Nothing outstanding" : "Due to pay"}
            lit={(due ?? 0) > 0}
            icon={ICON.money}
          />
          <Jump
            to="/patients"
            label="Patients"
            value={t ? String(t.patients) : "—"}
            note="Seen this month"
            icon={ICON.patients}
          />
          <Jump
            to="/stats"
            label="Insights"
            value={t ? rupees(t.paid) : "—"}
            note="Paid this month"
            icon={ICON.chart}
          />
        </div>
      </section>

      {blocked && (
        <p className="hold-note">
          <b>{hold.data?.reference}</b> — {hold.data?.reason}. Settle it before starting
          another appliance. <Link to="/payments">Go to payments →</Link>
        </p>
      )}

      {!products.isLoading && <Range products={products.data ?? []} />}

      <div className="split">
        <Attention orders={waiting.data ?? []} loading={waiting.isLoading} />
        <Activity />
      </div>

    </main>
  );
}
