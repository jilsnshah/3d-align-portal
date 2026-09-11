/* The clinic's front door.
 *
 * Answers four questions and stops: what needs me, how is the practice doing,
 * what can I order, and what has happened. It is deliberately not a view of the
 * data — the cases themselves live one click away where they belong.
 *
 * It opens as a welcome rather than a dashboard: the doctor's name set large,
 * the practice summed up in one sentence, the three things they come here to
 * do, and — beside it, on a photograph of the work — the single most pressing
 * thing waiting on them. The range follows, shown as the lab's own product
 * shots rather than its flyers, and the desk underneath holds what needs them
 * and what has moved.
 *
 * What needs them is counted by the thing being asked, not by the case asking:
 * a doctor thinks "I owe them three scans", not "EN-2026-0064".
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { api, since } from "../../api";
import { ASK, URGENCY } from "../../workflow";
import type { Notification, OrderStatus, OrderSummary, Product, StatsBucket } from "../../api";
import { useAuth } from "../../auth";
import { Skeleton } from "../../components/ui";
import { FEATURED, LIFE, SHOT, TAGLINE } from "../../productArt";

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

/** "₹700" when every thickness costs the same; "from ₹500" only when not. */
function priced(product: Product): string {
  const prices = product.sizes.map((s) => Number(s.price));
  const low = Math.min(...prices);
  return new Set(prices).size > 1 ? `from ${rupees(low)}` : rupees(low);
}

const Arrow = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

const Chevron = ({ className = "go" }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** One mark per kind of ask, so a list of them can be read by shape. */
const ASK_ICON: Partial<Record<OrderStatus, ReactNode>> = {
  DRAFT: (
    <Glyph>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </Glyph>
  ),
  RECORDS_REQUESTED: (
    <Glyph>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </Glyph>
  ),
  QUOTED: (
    <Glyph>
      <path d="M20 12 12 20l-8-8V4h8z" />
      <circle cx="8.5" cy="8.5" r="1.4" />
    </Glyph>
  ),
  AWAITING_SCAN: (
    <Glyph>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h10" />
    </Glyph>
  ),
  PLAN_SHARED: (
    <Glyph>
      <path d="M12 3 21 8l-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </Glyph>
  ),
  FIT_REVIEW: (
    <Glyph>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </Glyph>
  ),
};

const KPI_ICON = {
  lab: (
    <Glyph>
      <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9V3" />
      <path d="M7.5 14h9" />
    </Glyph>
  ),
  you: (
    <Glyph>
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
    </Glyph>
  ),
  money: (
    <Glyph>
      <path d="M6 5h12M6 9.5h12M9.5 5v3a4 4 0 0 1-4 4h-.5l7 7" />
    </Glyph>
  ),
  chart: (
    <Glyph>
      <path d="M4 20V10M10 20V5M16 20v-7M22 20H2" />
    </Glyph>
  ),
};

type Group = { status: OrderStatus; cases: OrderSummary[] };

/** What the clinic owes, gathered by the thing being asked and ordered by what
    the lab is actually waiting on. */
function group(orders: OrderSummary[]): Group[] {
  const by = new Map<OrderStatus, OrderSummary[]>();
  for (const o of orders) {
    if (!ASK[o.status]) continue;
    by.set(o.status, [...(by.get(o.status) ?? []), o]);
  }
  return URGENCY.filter((s) => by.has(s)).map((s) => ({ status: s, cases: by.get(s)! }));
}

/** How a group reads, and where it leads. One case opens that case; several
    open the list. */
function say(g: Group): { label: string; to: string; oldest: OrderSummary } {
  const [one, many] = ASK[g.status]!;
  const oldest = g.cases.reduce((a, b) => (a.updated_at < b.updated_at ? a : b));
  return {
    label: g.cases.length === 1 ? one : many.replace("{n}", String(g.cases.length)),
    to: g.cases.length === 1 ? `/orders/${g.cases[0].id}` : "/orders",
    oldest,
  };
}

/** The single most pressing thing, set on the photograph beside the greeting
    so it can be acted on without scrolling. The full list is on the desk. */
function NextUp({ orders, loading }: { orders: OrderSummary[]; loading: boolean }) {
  const navigate = useNavigate();
  const top = group(orders)[0];

  if (loading) return <div className="hm-next wait" aria-hidden="true" />;

  if (!top) {
    return (
      <div className="hm-next clear">
        <span className="hm-next-eyebrow">All clear</span>
        <p className="hm-next-say">Nothing is waiting on you.</p>
        <p className="hm-next-note">We will tell you the moment something moves.</p>
      </div>
    );
  }

  const { label, to, oldest } = say(top);
  return (
    <div className="hm-next">
      <span className="hm-next-eyebrow">Next up</span>
      <p className="hm-next-say">{label}</p>
      <p className="hm-next-note">
        {top.cases.length === 1 ? oldest.patient_name : `${top.cases.length} cases`} · waiting{" "}
        {since(oldest.updated_at)}
      </p>
      <button type="button" className="hm-next-go" onClick={() => navigate(to)}>
        {top.cases.length === 1 ? "Open this case" : "Work through them"}
        <Arrow />
      </button>
    </div>
  );
}

/** One figure about the practice, and the way to its detail. */
function Kpi({
  to,
  label,
  value,
  note,
  lit,
  icon,
  children,
}: {
  to: string;
  label: string;
  value: string;
  note: string;
  lit?: boolean;
  icon: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Link to={to} className={`hm-kpi${lit ? " lit" : ""}`}>
      <span className="hm-kpi-top">
        <span className="hm-kpi-icon">{icon}</span>
        <span className="hm-kpi-label">{label}</span>
      </span>
      <b className="hm-kpi-value">{value}</b>
      <span className="hm-kpi-note">{note}</span>
      {children}
      <Chevron />
    </Link>
  );
}

/** Orders placed each day this month, as a strip of bars. A single series, so
    it needs no legend — the tile's label names it, and each bar says its own
    day and count on hover. Days still to come are drawn flat and faint. */
function MonthBars({ series }: { series: StatsBucket[] }) {
  if (series.length === 0) return null;
  const counts = series.map((b) => b.aligners + b.products + b.accessories);
  const max = Math.max(1, ...counts);
  const today = new Date().getDate();
  return (
    <span className="hm-bars" aria-hidden="true">
      {series.map((b, i) => {
        const ahead = i + 1 > today;
        return (
          <i
            key={b.key}
            title={`${b.label}: ${counts[i]} order${counts[i] === 1 ? "" : "s"}`}
            className={i + 1 === today ? "now" : ahead ? "ahead" : ""}
            style={{ height: ahead ? "8%" : `${Math.max(10, (counts[i] / max) * 100)}%` }}
          />
        );
      })}
    </span>
  );
}

/** The range, as the lab's own product shots on lit stages — a shelf you can
    push along. Native scroll with snap points, so a phone flicks through it
    the way a phone expects to and the arrows are an addition. */
function Range({
  products,
  held,
}: {
  products: Product[];
  held: { reference: string; reason: string } | null;
}) {
  const navigate = useNavigate();
  const track = useRef<HTMLDivElement | null>(null);
  const [paused, setPaused] = useState(false);
  const [at, setAt] = useState(0);
  const stilled = useRef(false);

  // Only what has a picture worth showing, in the order a clinic buys them.
  const shown = useMemo(
    () =>
      FEATURED.map((code) => products.find((p) => p.code === code)).filter(
        (p): p is Product => Boolean(p) && Boolean(SHOT[p!.code] || LIFE[p!.code]),
      ),
    [products],
  );

  useEffect(() => {
    stilled.current =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const step = (dir: number) => {
    const el = track.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>(".hm-pc");
    const by = card ? card.offsetWidth + 16 : el.clientWidth;
    // Wrap rather than stop dead at either end — a shelf that will not come
    // back round reads as broken.
    const max = el.scrollWidth - el.clientWidth;
    let to = el.scrollLeft + by * dir;
    if (to > max + 4) to = 0;
    if (to < -4) to = max;
    el.scrollTo({ left: to, behavior: stilled.current ? "auto" : "smooth" });
  };

  useEffect(() => {
    if (paused || stilled.current || shown.length < 2) return;
    const timer = window.setInterval(() => step(1), 5000);
    return () => window.clearInterval(timer);
  }, [paused, shown.length]);

  const onScroll = () => {
    const el = track.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>(".hm-pc");
    const by = card ? card.offsetWidth + 16 : 1;
    setAt(Math.round(el.scrollLeft / by));
  };

  if (shown.length === 0) return null;

  return (
    <section
      className="hm-range"
      aria-labelledby="hm-range-title"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <header className="hm-range-head">
        <div>
          <span className="hm-eyebrow">From the 3D Align lab</span>
          <h2 id="hm-range-title">
            Finish every case <em>with us.</em>
          </h2>
          <p>Retainers, guards, splints and trays — made from one scan, priced before you order.</p>
        </div>
        <div className="hm-range-nav">
          <button type="button" onClick={() => step(-1)} aria-label="Previous products">
            <Chevron className="back" />
          </button>
          <button type="button" onClick={() => step(1)} aria-label="Next products">
            <Chevron className="fwd" />
          </button>
          <Link to="/catalogue" className="hm-range-all">
            Visit the shop
            <Arrow />
          </Link>
        </div>
      </header>

      {held && (
        /* One quiet line where the buying is, not a banner across the page. */
        <p className="hm-hold">
          <i aria-hidden="true" />
          <span>
            <b>New appliance orders are paused</b> until {held.reference} is settled.
          </span>
          <Link to="/payments">Go to payments</Link>
        </p>
      )}

      <div className="hm-track" ref={track} onScroll={onScroll}>
        {shown.map((p) => (
          <button
            key={p.id}
            type="button"
            className="hm-pc"
            onClick={() => navigate(`/catalogue?order=${p.id}`)}
          >
            <span className={SHOT[p.code] ? "hm-pc-stage" : "hm-pc-stage photo"}>
              {SHOT[p.code] ? (
                <img className="hm-pc-shot" src={SHOT[p.code]} alt="" loading="lazy" />
              ) : (
                <img className="hm-pc-photo" src={LIFE[p.code]} alt="" loading="lazy" />
              )}
            </span>
            <span className="hm-pc-name">{p.name}</span>
            <span className="hm-pc-line">{TAGLINE[p.code]}</span>
            <span className="hm-pc-price">{priced(p)}</span>
          </button>
        ))}
      </div>

      <div className="hm-dots" aria-hidden="true">
        {shown.map((p, i) => (
          <span key={p.id} className={i === at ? "on" : ""} />
        ))}
      </div>
    </section>
  );
}

/** What the clinic owes the lab, counted by the thing being asked. */
function Attention({ orders, loading }: { orders: OrderSummary[]; loading: boolean }) {
  const navigate = useNavigate();
  const groups = useMemo(() => group(orders), [orders]);

  return (
    <section className="hm-panel" aria-labelledby="hm-needs-title">
      <div className="hm-panel-head">
        <h2 id="hm-needs-title">Needs you</h2>
        {orders.length > 0 && (
          <Link to="/orders" className="btn-link">
            All cases
          </Link>
        )}
      </div>

      {loading ? (
        <Skeleton rows={3} />
      ) : groups.length === 0 ? (
        <div className="hm-clear">
          <span className="hm-clear-tick" aria-hidden="true">
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
        <ul className="hm-asks">
          {groups.map((g) => {
            const { label, to, oldest } = say(g);
            return (
              <li key={g.status}>
                <button type="button" onClick={() => navigate(to)}>
                  <span className="hm-ask-icon">{ASK_ICON[g.status]}</span>
                  <span className="hm-ask-say">
                    <b>{label}</b>
                    <span>
                      {g.cases.length === 1
                        ? `${g.cases[0].patient_name} · waiting ${since(oldest.updated_at)}`
                        : `Oldest waiting ${since(oldest.updated_at)}`}
                    </span>
                  </span>
                  <span className="hm-ask-n">{g.cases.length}</span>
                  <Chevron className="hm-ask-go" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** What has happened since the clinic last looked. */
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
    <section className="hm-panel" aria-labelledby="hm-activity-title">
      <div className="hm-panel-head">
        <h2 id="hm-activity-title">Recent activity</h2>
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
        <ul className="hm-feed">
          {items.map((n: Notification) => {
            const body = (
              <>
                <b>{n.title}</b>
                <span className="hm-feed-when">{since(n.created_at)}</span>
                <span className="hm-feed-body">{n.body}</span>
              </>
            );
            return (
              <li key={n.id} className={n.read_at ? "" : "new"}>
                {n.order_id ? (
                  <button type="button" onClick={() => navigate(`/orders/${n.order_id}`)}>
                    {body}
                  </button>
                ) : (
                  <div>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
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
  // Whether an unsettled appliance is holding the next one. Said where the
  // range is, rather than discovered at the end of an order form.
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
  const oldestWaiting = (waiting.data ?? []).reduce<OrderSummary | null>(
    (a, b) => (!a || b.updated_at < a.updated_at ? b : a),
    null,
  );
  const held = hold.data && !hold.data.can_order_products ? hold.data : null;
  const t = stats.data?.totals;
  const loaded = !waiting.isLoading && openCases.data !== undefined;

  return (
    <main className="page hm">
      <section className="hm-hero">
        <div className="hm-say">
          <span className="hm-greet">
            {greeting()}
            {me?.doctor?.clinic_name ? ` · ${me.doctor.clinic_name}` : ""}
          </span>
          <h1>{firstName(me?.doctor?.full_name ?? "Doctor")}</h1>

          {/* The practice in one sentence, so the figures below confirm what
              has already been read rather than having to be added up. */}
          <p className="hm-sum">
            {!loaded ? (
              "Getting your practice ready…"
            ) : needing === 0 && (due ?? 0) === 0 ? (
              <>
                Everything is with 3D Align — <b>{withLab}</b> case{withLab === 1 ? "" : "s"} in
                progress and nothing waiting on you.
              </>
            ) : (
              <>
                {needing > 0 && (
                  <>
                    <b className="lit">{needing}</b> {needing === 1 ? "case needs" : "cases need"} you
                  </>
                )}
                {needing > 0 && " · "}
                <b>{withLab}</b> with 3D Align
                {(due ?? 0) > 0 && (
                  <>
                    {" · "}
                    <b>{rupees(due!)}</b> to pay
                  </>
                )}
              </>
            )}
          </p>

          {/* The one action a clinic takes more than any other, at the size
              that says so — then the two next most, at the size they are. */}
          <div className="hm-do">
            <button type="button" className="hm-cta" onClick={() => navigate("/orders/new")}>
              Start a new aligner case
              <Arrow />
            </button>
            <button type="button" className="hm-ghost" onClick={() => navigate("/catalogue")}>
              Order an appliance
            </button>
            <button type="button" className="hm-ghost" onClick={() => navigate("/orders")}>
              View cases
            </button>
          </div>
        </div>

        {/* The work itself, in an arch-shaped frame — a clear retainer being
            seated, from the lab's own catalogue — with the box it comes in and
            the one thing waiting on the clinic set over it. */}
        <div className="hm-art">
          <span className="hm-arcs" aria-hidden="true" />
          <figure className="hm-arch" aria-hidden="true">
            <img src={LIFE.ER} alt="" />
          </figure>
          <img className="hm-box" src={SHOT.ER} alt="" aria-hidden="true" />
          <NextUp orders={waiting.data ?? []} loading={waiting.isLoading} />
        </div>
      </section>

      <section className="hm-kpis" aria-label="Your practice">
        <Kpi
          to="/orders"
          label="With 3D Align"
          value={withLab === null ? "—" : String(withLab)}
          note="Cases in progress"
          icon={KPI_ICON.lab}
        />
        <Kpi
          to="/orders"
          label="Waiting on you"
          value={waiting.isLoading ? "—" : String(needing)}
          note={
            needing > 0 && oldestWaiting
              ? `Oldest waiting ${since(oldestWaiting.updated_at)}`
              : "Nothing to do"
          }
          lit={needing > 0}
          icon={KPI_ICON.you}
        />
        <Kpi
          to="/payments"
          label="To pay"
          value={due === null ? "—" : rupees(due)}
          note={due === 0 ? "Nothing outstanding" : "Across your cases"}
          lit={(due ?? 0) > 0}
          icon={KPI_ICON.money}
        />
        <Kpi
          to="/stats"
          label={stats.data?.period_label ?? "This month"}
          value={t ? String(t.orders) : "—"}
          note={t ? `Orders · ${rupees(t.paid)} paid` : "Orders placed"}
          icon={KPI_ICON.chart}
        >
          <MonthBars series={stats.data?.series ?? []} />
        </Kpi>
      </section>

      {!products.isLoading && <Range products={products.data ?? []} held={held} />}

      <div className="hm-desk">
        <Attention orders={waiting.data ?? []} loading={waiting.isLoading} />
        <Activity />
      </div>
    </main>
  );
}
