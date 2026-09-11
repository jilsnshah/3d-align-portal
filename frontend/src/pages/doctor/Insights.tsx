/* Insights — the practice, analysed.
 *
 * The stats endpoint answers one question: how many cases were opened each
 * month. A doctor has more than one. Is the practice growing? Where are my
 * cases stuck, and how many of those are stuck on me? What am I treating —
 * which bands, which arches, how many come in already scanned? Where is the
 * money going, and how quickly does the lab confirm it? Are patients coming
 * back?
 *
 * So this reads the practice itself — every case, every patient, every
 * payment — and works the answers out here, over a window the doctor chooses
 * and against the window before it. Snapshot figures (where cases are now,
 * what is waiting, how old the open ones are) describe today whatever the
 * window; flow figures (cases opened, patients added, money paid) describe the
 * window.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { api } from "../../api";
import type { LedgerEntry, OrderSummary, Patient } from "../../api";
import { useAuth } from "../../auth";
import { ColumnChart, SERIES_A, SERIES_B, formatCount, formatMoney, useWidth } from "../../components/charts";
import { Loading } from "../../components/ui";
import { everyCase, everyPatient } from "../../fetchAll";
import { ASK, URGENCY, stageIndex, stagesFor } from "../../workflow";

/** Accessories: a warm neutral, set apart from the gold and violet by lightness
    rather than by a third hue, and always labelled. */
const SERIES_C = "#a39c8e";

/** The same three kinds on the hero's black: lifted steps of the same hues,
    since the deep gold and violet that read on paper sink into it. */
const HERO_A = "#e3c35a";
const HERO_B = "#a99bf5";
const HERO_C = "#b9b1a1";

/** Aligner bands are ordered, small to large, so they take one hue stepped
    light to dark — a sequence, not a set of unrelated colours. */
const BAND_RAMP = ["#ecdfb6", "#d9bf73", "#b8912f", "#8f6f1f", "#5f4a14", "#3d300d"];
const UNSIZED = "#d8d5cd";

/** Four kinds of charge, four identities, fixed in this order. */
const KIND_COLOR: Record<string, string> = {
  TREATMENT_PLAN: SERIES_A,
  TRAINING_FIT: SERIES_B,
  PRODUCTION_PHASE: "#c9a646",
  PRODUCT_ORDER: SERIES_C,
};
const KIND_NAME: Record<string, string> = {
  TREATMENT_PLAN: "Treatment plan fees",
  TRAINING_FIT: "Training aligner fits",
  PRODUCTION_PHASE: "Production phases",
  PRODUCT_ORDER: "Appliances and accessories",
};

type Range = "30d" | "90d" | "12m" | "all";
const RANGES: { key: Range; label: string; long: string }[] = [
  { key: "30d", label: "30 days", long: "the last 30 days" },
  { key: "90d", label: "90 days", long: "the last 90 days" },
  { key: "12m", label: "12 months", long: "the last 12 months" },
  { key: "all", label: "All time", long: "all time" },
];

const DAY = 86400000;
const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
const inside = (iso: string | null | undefined, a: number, b: number) => {
  const t = ms(iso);
  return t >= a && t < b;
};

type Bucket = { key: string; label: string; full: string; start: number; end: number };

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The window's buckets: days for a month, weeks for a quarter, months beyond. */
function windowFor(range: Range, first: number): { buckets: Bucket[]; from: number; to: number; unit: string } {
  const now = Date.now();
  if (range === "30d") {
    const from = startOfDay(now) - 29 * DAY;
    const buckets = Array.from({ length: 30 }, (_, i) => {
      const s = from + i * DAY;
      const d = new Date(s);
      return {
        key: `d${i}`,
        label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
        full: d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "long" }),
        start: s,
        end: s + DAY,
      };
    });
    return { buckets, from, to: from + 30 * DAY, unit: "day" };
  }
  if (range === "90d") {
    const from = startOfDay(now) - 90 * DAY;
    const buckets = Array.from({ length: 13 }, (_, i) => {
      const s = from + i * 7 * DAY;
      const d = new Date(s);
      return {
        key: `w${i}`,
        label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
        full: `Week of ${d.toLocaleDateString("en-IN", { day: "numeric", month: "long" })}`,
        start: s,
        end: s + 7 * DAY,
      };
    });
    return { buckets, from, to: from + 91 * DAY, unit: "week" };
  }
  const today = new Date(now);
  let count = 12;
  if (range === "all" && Number.isFinite(first)) {
    const f = new Date(first);
    count = Math.max(6, (today.getFullYear() - f.getFullYear()) * 12 + today.getMonth() - f.getMonth() + 1);
  }
  const buckets: Bucket[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const s = new Date(today.getFullYear(), today.getMonth() - i, 1).getTime();
    const e = new Date(today.getFullYear(), today.getMonth() - i + 1, 1).getTime();
    const d = new Date(s);
    buckets.push({
      key: `m${d.getFullYear()}-${d.getMonth()}`,
      label: d.toLocaleDateString("en-IN", { month: "short" }),
      full: d.toLocaleDateString("en-IN", { month: "long", year: "numeric" }),
      start: s,
      end: e,
    });
  }
  return { buckets, from: buckets[0].start, to: buckets[buckets.length - 1].end, unit: "month" };
}

type Change = { text: string; tone: "up" | "down" | "flat" | "new" };

/** How a figure moved against the window before. Down is drawn quiet rather
    than red: a slower month is not a fault. */
function change(current: number, previous: number | null): Change | null {
  if (previous === null) return null;
  if (current === 0 && previous === 0) return null;
  if (previous === 0) return { text: "New", tone: "new" };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: "Level", tone: "flat" };
  return { text: `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%`, tone: pct > 0 ? "up" : "down" };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

function money(v: number): string {
  return formatMoney(v);
}

const closed = (o: OrderSummary) => o.status === "COMPLETED" || o.status === "CANCELLED";

/* --------------------------------------------------------------- charts */

/** The shape of a figure across the window, drawn under it. */
function Spark({ values, color = "var(--gold)" }: { values: number[]; color?: string }) {
  if (values.length < 2 || values.every((v) => v === 0)) return <span className="ia-spark empty" aria-hidden="true" />;
  const max = Math.max(...values);
  const w = 100;
  const h = 30;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - (v / max) * (h - 4) - 2]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  return (
    <svg className="ia-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" style={{ color }}>
      <path d={`${line}L${w},${h}L0,${h}Z`} className="area" />
      <path d={line} className="line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

type Series = { key: string; label: string; color: string; values: number[] };

/** Cases opened over the window, stacked by kind: the area is the total, the
    bands are what it was made of. A crosshair reads any bucket exactly. */
function AreaChart({ buckets, series, height = 250, dark = false }: { buckets: Bucket[]; series: Series[]; height?: number; dark?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [at, setAt] = useState<number | null>(null);
  const padL = 36;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const n = buckets.length;
  const plotW = Math.max(width - padL - padR, 10);
  const plotH = height - padT - padB;
  const totals = buckets.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));
  const max = Math.max(1, ...totals);
  const step = max <= 4 ? 1 : max <= 10 ? 2 : Math.ceil(max / 4 / 5) * 5;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  const x = (i: number) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / top) * plotH;

  let base = buckets.map(() => 0);
  const layers = series.map((s) => {
    const lower = base;
    const upper = base.map((b, i) => b + s.values[i]);
    base = upper;
    return { s, lower, upper };
  });
  const labelEvery = Math.max(1, Math.ceil(n / 7));

  return (
    <div className={`ia-area${dark ? " dark" : ""}`} ref={ref}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Cases opened per ${n > 20 ? "day" : "period"}: ${totals.join(", ")}`}
          onPointerMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const px = e.clientX - r.left;
            const i = Math.round(((px - padL) / plotW) * (n - 1));
            setAt(Math.min(n - 1, Math.max(0, i)));
          }}
          onPointerLeave={() => setAt(null)}
        >
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`ia-fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.55" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0.12" />
              </linearGradient>
            ))}
          </defs>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={padL} x2={width - padR} y1={y(v)} y2={y(v)} className="chart-grid" />
              <text x={padL - 8} y={y(v) + 4} textAnchor="end" className="chart-axis">
                {v}
              </text>
            </g>
          ))}
          {layers.map(({ s, lower, upper }) => {
            const up = upper.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("");
            const down = lower
              .map((v, i) => [x(i), y(v)] as const)
              .reverse()
              .map(([a, b]) => `L${a},${b}`)
              .join("");
            return (
              <g key={s.key}>
                <path d={`${up}${down}Z`} fill={`url(#ia-fill-${s.key})`} />
                <path d={up} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
              </g>
            );
          })}
          {buckets.map((b, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text key={b.key} x={x(i)} y={height - 8} textAnchor="middle" className="chart-axis">
                {b.label}
              </text>
            ) : null,
          )}
          {at !== null && (
            <g>
              <line x1={x(at)} x2={x(at)} y1={padT} y2={padT + plotH} className="ia-cross" />
              {layers.map(({ s, upper }) => (
                <circle key={s.key} cx={x(at)} cy={y(upper[at])} r={4} fill={s.color} stroke="var(--white)" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
      )}
      {at !== null && (
        <div
          className="chart-tip"
          style={{ left: Math.min(Math.max(x(at), 90), Math.max(width - 90, 90)), top: 4 }}
          role="presentation"
        >
          <div className="chart-tip-head">{buckets[at].full}</div>
          {[...series].reverse().map((s) => (
            <div key={s.key} className="chart-tip-row">
              <i style={{ background: s.color }} />
              <span>{s.label}</span>
              <b>{formatCount(s.values[at])}</b>
            </div>
          ))}
          <div className="chart-tip-row total">
            <span>Total</span>
            <b>{formatCount(totals[at])}</b>
          </div>
        </div>
      )}
    </div>
  );
}

type Part = { key: string; label: string; value: number; color: string; note?: string };

/** Part of a whole, for a handful of parts. The legend carries every value, so
    nothing here is read from colour or angle alone. */
function Donut({ parts, center, sub, format = formatCount }: { parts: Part[]; center: string; sub: string; format?: (v: number) => string }) {
  const [active, setActive] = useState<string | null>(null);
  const total = parts.reduce((s, p) => s + p.value, 0);
  const r = 40;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="ia-donut">
      <div className="ia-donut-ring">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--paper-2)" strokeWidth="13" />
          {total > 0 &&
            parts.map((p) => {
              const len = (p.value / total) * c;
              const gap = parts.filter((q) => q.value > 0).length > 1 ? Math.min(1.4, len / 3) : 0;
              const el = (
                <circle
                  key={p.key}
                  cx="50"
                  cy="50"
                  r={r}
                  fill="none"
                  stroke={p.color}
                  strokeWidth={active === p.key ? 15 : 13}
                  strokeDasharray={`${Math.max(len - gap, 0)} ${c}`}
                  strokeDashoffset={-offset}
                  transform="rotate(-90 50 50)"
                  opacity={active && active !== p.key ? 0.35 : 1}
                  onPointerEnter={() => setActive(p.key)}
                  onPointerLeave={() => setActive(null)}
                >
                  <title>{`${p.label}: ${format(p.value)}`}</title>
                </circle>
              );
              offset += len;
              return el;
            })}
        </svg>
        <span className="ia-donut-center">
          <b>{center}</b>
          <small>{sub}</small>
        </span>
      </div>
      <ul className="ia-legend">
        {parts.map((p) => (
          <li
            key={p.key}
            className={active === p.key ? "on" : ""}
            onPointerEnter={() => setActive(p.key)}
            onPointerLeave={() => setActive(null)}
          >
            <i style={{ background: p.color }} />
            <span>
              {p.label}
              {p.note && <small>{p.note}</small>}
            </span>
            <b>{format(p.value)}</b>
            <em>{total ? `${Math.round((p.value / total) * 100)}%` : "—"}</em>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A share, as a ring with the percentage inside it. */
function Ring({ value, label }: { value: number; label: string }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div className="ia-ring">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--paper-2)" strokeWidth="7" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke="var(--gold)"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${pct * c} ${c}`}
          transform="rotate(-90 32 32)"
        />
      </svg>
      <b>{Math.round(pct * 100)}%</b>
      <span>{label}</span>
    </div>
  );
}

/** Two or three shares of one thing, side by side on one bar. */
function Split({ title, parts }: { title: string; parts: Part[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className="ia-split">
      <span className="ia-split-title">{title}</span>
      <div className="ia-split-bar" role="img" aria-label={`${title}: ${parts.map((p) => `${p.label} ${p.value}`).join(", ")}`}>
        {total > 0 &&
          parts.map((p) =>
            p.value > 0 ? <i key={p.key} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label}: ${p.value}`} /> : null,
          )}
      </div>
      <ul>
        {parts.map((p) => (
          <li key={p.key}>
            <i style={{ background: p.color }} />
            {p.label}
            <b>{total ? `${Math.round((p.value / total) * 100)}%` : "—"}</b>
            <small>{formatCount(p.value)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Card({
  title,
  hint,
  span,
  tone,
  aside,
  children,
}: {
  title: string;
  hint?: string;
  span: string;
  tone?: "dark";
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`ia-card ${span}${tone ? ` ${tone}` : ""}`}>
      <header className="ia-card-head">
        <div>
          <h2>{title}</h2>
          {hint && <p>{hint}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ page */

export default function Insights() {
  const { me } = useAuth();
  const [range, setRange] = useState<Range>("90d");
  const cases = useQuery({ queryKey: ["orders", "every-case"], queryFn: everyCase });
  const patients = useQuery({ queryKey: ["patients", "all"], queryFn: everyPatient });
  const ledger = useQuery({ queryKey: ["payment-ledger"], queryFn: api.paymentLedger });
  const addresses = useQuery({ queryKey: ["addresses"], queryFn: api.addresses });

  const all = cases.data ?? [];
  const people = patients.data ?? [];
  const history: LedgerEntry[] = ledger.data?.history ?? [];

  const a = useMemo(() => analyse(all, people, history, range), [all, people, history, range]);

  if (cases.isLoading || patients.isLoading || ledger.isLoading) return <Loading what="your practice" />;

  const rangeInfo = RANGES.find((r) => r.key === range)!;
  const multiBranch = (addresses.data?.length ?? 0) > 1;
  const sinceFirst = Number.isFinite(a.first)
    ? new Date(a.first).toLocaleDateString("en-IN", { month: "long", year: "numeric" })
    : "";

  /* The window, told as a story: what came in, what it was, what is waiting,
     and when it was busiest. */
  const made = [
    a.now.aligners ? plural(a.now.aligners, "aligner case") : "",
    a.now.products ? plural(a.now.products, "appliance order") : "",
    a.now.accessories ? plural(a.now.accessories, "accessory order") : "",
  ].filter(Boolean);
  const story = [
    made.length > 1 ? `${made.slice(0, -1).join(", ")} and ${made[made.length - 1]}.` : made.length ? `All ${made[0]}.` : "",
    a.waiting ? `${plural(a.waiting, "case")} ${a.waiting === 1 ? "is" : "are"} waiting on you today.` : "Nothing is waiting on you today.",
    a.busiest ? `Busiest ${a.unit}: ${a.busiest}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const kpis = [
    { label: "New patients", value: formatCount(a.now.patients), cur: a.now.patients, prev: a.prev?.patients ?? null, spark: a.series.patients, note: `${formatCount(people.length)} on file` },
    { label: "Paid to 3D Align", value: money(a.now.spend), cur: a.now.spend, prev: a.prev?.spend ?? null, spark: a.series.spend, note: `${money(Number(ledger.data?.outstanding ?? 0))} due now` },
    { label: "Cases finished", value: formatCount(a.now.completed), cur: a.now.completed, prev: a.prev?.completed ?? null, spark: a.series.completed, note: `${plural(a.open.length, "case")} open` },
    { label: "Waiting on you", value: formatCount(a.waiting), cur: 0, prev: null, spark: [], note: a.asks[0] ? a.asks[0].label : "All with 3D Align" },
  ];

  return (
    <main className="page page-wide ia">
      <section className="ia-hero">
        <div className="ia-hero-top">
          <span className="ia-kicker">Insights · {me?.doctor?.clinic_name || "Your practice"}</span>
          <div className="ia-range" role="tablist" aria-label="Window">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                role="tab"
                aria-selected={range === r.key}
                className={range === r.key ? "on" : ""}
                onClick={() => setRange(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="ia-hero-body">
          <div className="ia-hero-say">
            <h1>
              {a.now.cases === 0 ? (
                <>
                  A quiet stretch — <em>no new cases</em> in {rangeInfo.long}.
                </>
              ) : range === "all" ? (
                <>
                  <em>{plural(a.now.cases, "case")}</em> since {sinceFirst}.
                </>
              ) : (
                <>
                  <em>{plural(a.now.cases, "new case")}</em> in {rangeInfo.long}.
                </>
              )}
            </h1>
            <p>{story}</p>
            <div className="ia-key dark">
              <span><i style={{ background: HERO_A }} />Aligners</span>
              <span><i style={{ background: HERO_B }} />Appliances</span>
              <span><i style={{ background: HERO_C }} />Accessories</span>
            </div>
          </div>
          <div className="ia-hero-chart">
            <AreaChart
              dark
              height={230}
              buckets={a.buckets}
              series={[
                { key: "al", label: "Aligners", color: HERO_A, values: a.series.aligners },
                { key: "pr", label: "Appliances", color: HERO_B, values: a.series.products },
                { key: "ac", label: "Accessories", color: HERO_C, values: a.series.accessories },
              ]}
            />
          </div>
        </div>

        <div className="ia-kpis" aria-label="The window in figures">
          {kpis.map((k) => {
            const d = change(k.cur, k.prev);
            return (
              <div key={k.label} className="ia-kpi">
                <span className="ia-kpi-label">{k.label}</span>
                <b className="ia-kpi-value">{k.value}</b>
                <span className="ia-kpi-foot">
                  {d && (
                    <span className={`ia-delta ${d.tone}`} title={`Compared with the ${rangeInfo.label.toLowerCase()} before`}>
                      {d.text}
                    </span>
                  )}
                  <span className="ia-kpi-note">{k.note}</span>
                </span>
                <Spark values={k.spark} color={HERO_A} />
              </div>
            );
          })}
        </div>
      </section>

      {a.facts.length > 0 && (
        <section className="ia-facts" aria-label="What stands out">
          {a.facts.map((f) => (
            <div key={f.label} className="ia-fact">
              <span>{f.label}</span>
              <b>{f.value}</b>
              <small>{f.note}</small>
            </div>
          ))}
        </section>
      )}

      <div className="ia-grid">
        <Card
          span="s8"
          title="Where your cases are"
          hint="Every open aligner case, by stage — gold is waiting on you, dark is with 3D Align."
          aside={<Link className="ia-link" to="/orders">Open Cases →</Link>}
        >
          <div className="ia-pipe">
            {a.pipeline.map((s) => (
              <div key={s.key} className="ia-pipe-row">
                <span className="ia-pipe-label">{s.label}</span>
                <span className="ia-pipe-bar">
                  {s.you > 0 && <i className="you" style={{ width: `${(s.you / a.pipeMax) * 100}%` }} title={`${s.you} waiting on you`} />}
                  {s.total - s.you > 0 && (
                    <i className="lab" style={{ width: `${((s.total - s.you) / a.pipeMax) * 100}%` }} title={`${s.total - s.you} with 3D Align`} />
                  )}
                </span>
                <b className="ia-pipe-n">{s.total}</b>
                <small className="ia-pipe-you">{s.you > 0 ? `${s.you} on you` : ""}</small>
              </div>
            ))}
          </div>
          {a.otherOpen > 0 && (
            <p className="ia-foot-note">
              Plus {plural(a.otherOpen, "appliance or accessory order")} in progress.
            </p>
          )}
        </Card>

        <Card span="s4" title="Waiting on you" hint="What the lab needs from the clinic, today.">
          {a.asks.length === 0 ? (
            <div className="ia-clear">
              <b>Nothing is waiting on you.</b>
              <span>Every open case is with 3D Align.</span>
            </div>
          ) : (
            <ul className="ia-asks">
              {a.asks.map((q) => (
                <li key={q.status}>
                  <b>{q.count}</b>
                  <span>{q.label}</span>
                  <i style={{ width: `${(q.count / a.asks[0].count) * 100}%` }} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card span="s4" title="Treatment mix" hint={`Aligner cases opened in ${rangeInfo.long}, by band.`}>
          {a.bands.length === 0 ? (
            <p className="ia-none">No aligner cases in this window.</p>
          ) : (
            <Donut parts={a.bands} center={formatCount(a.now.aligners)} sub="aligner cases" />
          )}
        </Card>

        <Card span="s4" title="How cases are set up" hint="The same aligner cases, three ways.">
          {a.now.aligners === 0 ? (
            <p className="ia-none">No aligner cases in this window.</p>
          ) : (
            <div className="ia-stack">
              <Split title="Arches" parts={a.arches} />
              <Split title="How they started" parts={a.intake} />
              <Ring value={a.expressShare} label="sent as express" />
            </div>
          )}
        </Card>

        <Card span="s4" title="Age of open cases" hint="How long each open case has been running.">
          {a.open.length === 0 ? (
            <p className="ia-none">No open cases.</p>
          ) : (
            <>
              <div className="ia-age">
                {a.ages.map((g) => (
                  <div key={g.label} className="ia-age-col" title={`${g.label}: ${g.count}`}>
                    <b>{g.count}</b>
                    <span className="ia-age-bar">
                      <i style={{ height: `${a.ageMax ? Math.max(g.count ? 6 : 0, (g.count / a.ageMax) * 100) : 0}%` }} />
                    </span>
                    <small>{g.label}</small>
                  </div>
                ))}
              </div>
              <p className="ia-foot-note">
                The average open case is <b>{plural(Math.round(a.avgAge), "day")}</b> old.
              </p>
            </>
          )}
        </Card>

        <Card
          span="s8"
          title="Money paid"
          hint={`Confirmed each ${a.unit} — by the day the lab confirmed it.`}
          aside={<Link className="ia-link" to="/payments">Payments →</Link>}
        >
          <div className="ia-money-sum">
            <div>
              <span>Paid in the window</span>
              <b>{money(a.now.spend)}</b>
            </div>
            <div>
              <span>Due now</span>
              <b className="due">{money(Number(ledger.data?.outstanding ?? 0))}</b>
            </div>
            <div>
              <span>Being checked</span>
              <b>{money(Number(ledger.data?.in_review ?? 0))}</b>
            </div>
            <div>
              <span>Receipts confirmed in</span>
              <b>{a.confirmTime}</b>
            </div>
          </div>
          <ColumnChart
            data={a.buckets.map((b, i) => ({ key: b.key, label: b.label, full: b.full, a: a.series.spend[i] }))}
            labelA="Paid"
            money
            height={190}
          />
        </Card>

        <Card span="s4" title="Where the money went" hint={`What was paid for in ${rangeInfo.long}.`}>
          {a.kinds.length === 0 ? (
            <p className="ia-none">Nothing confirmed in this window.</p>
          ) : (
            <Donut parts={a.kinds} center={formatMoney(a.now.spend, true)} sub="paid" format={money} />
          )}
        </Card>

        <Card span="s6" title="Patients" hint="New patients in the window, and who comes back.">
          <div className="ia-patients">
            <div className="ia-bars-wrap">
              <span className="ia-bars-peak">{a.patientMax ? `Most in one ${a.unit}: ${a.patientMax}` : `No new patients in ${RANGES.find((r) => r.key === range)!.long}`}</span>
              <div className="ia-bars">
                {a.buckets.map((b, i) => (
                  <span key={b.key} className="ia-bar" title={`${b.full}: ${a.series.patients[i]} new`}>
                    <i style={{ height: `${a.patientMax ? (a.series.patients[i] / a.patientMax) * 100 : 0}%` }} />
                  </span>
                ))}
              </div>
              <div className="ia-bars-axis">
                <span>{a.buckets[0]?.label}</span>
                <span>{a.buckets[a.buckets.length - 1]?.label}</span>
              </div>
            </div>
            <div className="ia-patient-facts">
              <Ring value={a.repeatShare} label="have had more than one case" />
              <dl>
                <div>
                  <dt>On file</dt>
                  <dd>{formatCount(people.length)}</dd>
                </div>
                <div>
                  <dt>In treatment</dt>
                  <dd>{formatCount(a.inTreatment)}</dd>
                </div>
                <div>
                  <dt>Never started</dt>
                  <dd>{formatCount(a.neverStarted)}</dd>
                </div>
              </dl>
            </div>
          </div>
        </Card>

        <Card span="s6" title="Appliances ordered" hint={`Retainers, guards and splints in ${rangeInfo.long}.`}>
          {a.appliances.length === 0 ? (
            <p className="ia-none">No appliance orders in this window.</p>
          ) : (
            <ul className="ia-rank">
              {a.appliances.map((p) => (
                <li key={p.label}>
                  <span className="ia-rank-head">
                    <b>{p.label}</b>
                    <span>
                      {plural(p.orders, "order")} · {formatCount(p.units)} made
                    </span>
                  </span>
                  <span className="ia-rank-track">
                    <i style={{ width: `${(p.orders / a.appliances[0].orders) * 100}%` }} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {multiBranch && a.branches.length > 0 && (
          <Card span="s12" title="Branches" hint={`Where the cases opened in ${rangeInfo.long} were sent from.`}>
            <ul className="ia-rank cols">
              {a.branches.map((b) => (
                <li key={b.label}>
                  <span className="ia-rank-head">
                    <b>{b.label}</b>
                    <span>{plural(b.count, "case")}</span>
                  </span>
                  <span className="ia-rank-track">
                    <i style={{ width: `${(b.count / a.branches[0].count) * 100}%` }} />
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </main>
  );
}

/* -------------------------------------------------------------- analysis */

function analyse(all: OrderSummary[], people: Patient[], history: LedgerEntry[], range: Range) {
  const first = Math.min(...all.map((o) => ms(o.created_at)).filter(Number.isFinite), Date.now());
  const { buckets, from, to, unit } = windowFor(range, first);
  const length = to - from;

  const measure = (a: number, b: number) => {
    const opened = all.filter((o) => inside(o.created_at, a, b));
    return {
      opened,
      cases: opened.length,
      aligners: opened.filter((o) => o.kind === "ALIGNER").length,
      products: opened.filter((o) => o.kind === "PRODUCT").length,
      accessories: opened.filter((o) => o.kind === "ACCESSORY").length,
      patients: people.filter((p) => inside(p.created_at, a, b)).length,
      completed: all.filter((o) => o.status === "COMPLETED" && inside(o.updated_at, a, b)).length,
      spend: history.filter((h) => inside(h.verified_at, a, b)).reduce((s, h) => s + Number(h.total), 0),
      paid: history.filter((h) => inside(h.verified_at, a, b)),
    };
  };
  const now = measure(from, to);
  const prev = range === "all" ? null : measure(from - length, from);

  const per = <T,>(rows: T[], when: (r: T) => string | null | undefined, value: (r: T) => number = () => 1) =>
    buckets.map((b) => rows.reduce((s, r) => s + (inside(when(r), b.start, b.end) ? value(r) : 0), 0));
  const series = {
    cases: per(all, (o) => o.created_at),
    aligners: per(all.filter((o) => o.kind === "ALIGNER"), (o) => o.created_at),
    products: per(all.filter((o) => o.kind === "PRODUCT"), (o) => o.created_at),
    accessories: per(all.filter((o) => o.kind === "ACCESSORY"), (o) => o.created_at),
    patients: per(people, (p) => p.created_at),
    spend: per(history, (h) => h.verified_at, (h) => Number(h.total)),
    completed: per(all.filter((o) => o.status === "COMPLETED"), (o) => o.updated_at),
  };

  // --- today: where the open cases are, and what is waiting
  const open = all.filter((o) => !closed(o));
  const stages = stagesFor("ALIGNER").map((s) => ({ key: s.key, label: s.label, total: 0, you: 0 }));
  let otherOpen = 0;
  for (const o of open) {
    if (o.kind !== "ALIGNER") {
      otherOpen += 1;
      continue;
    }
    const key = stagesFor(o.kind, o.intake)[stageIndex(o.kind, o.status, o.intake)]?.key;
    const row = stages.find((s) => s.key === key);
    if (!row) continue;
    row.total += 1;
    if (o.needs_doctor_action) row.you += 1;
  }
  const pipeMax = Math.max(1, ...stages.map((s) => s.total));

  const waiting = open.filter((o) => o.needs_doctor_action);
  const asks = URGENCY.map((status) => {
    const count = waiting.filter((o) => o.status === status).length;
    const words = ASK[status];
    return { status, count, label: words ? (count === 1 ? words[0] : words[1].replace("{n}", String(count))) : status };
  })
    .filter((q) => q.count > 0)
    .sort((x, y) => y.count - x.count);

  const ageDays = open.map((o) => (Date.now() - ms(o.created_at)) / DAY);
  const ages = [
    { label: "< 1 week", test: (d: number) => d < 7 },
    { label: "1–4 weeks", test: (d: number) => d >= 7 && d < 28 },
    { label: "1–3 months", test: (d: number) => d >= 28 && d < 91 },
    { label: "3+ months", test: (d: number) => d >= 91 },
  ].map((g) => ({ label: g.label, count: ageDays.filter(g.test).length }));
  const ageMax = Math.max(0, ...ages.map((g) => g.count));
  const avgAge = ageDays.length ? ageDays.reduce((s, d) => s + d, 0) / ageDays.length : 0;

  // --- what is being treated, in the window
  const aligners = now.opened.filter((o) => o.kind === "ALIGNER");
  const bandCount = new Map<string, number>();
  for (const o of aligners) {
    const band = o.category_label || "Not sized yet";
    bandCount.set(band, (bandCount.get(band) ?? 0) + 1);
  }
  const bandNames = [...bandCount.keys()]
    .filter((b) => b !== "Not sized yet")
    .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  const bands: Part[] = [
    ...bandNames.map((b, i) => ({
      key: b,
      label: b,
      value: bandCount.get(b)!,
      color: BAND_RAMP[Math.min(BAND_RAMP.length - 1, Math.round((i / Math.max(1, bandNames.length - 1)) * (BAND_RAMP.length - 2)) + 1)],
    })),
    ...(bandCount.has("Not sized yet")
      ? [{ key: "unsized", label: "Not sized yet", value: bandCount.get("Not sized yet")!, color: UNSIZED, note: "set by the plan" }]
      : []),
  ];
  const arches: Part[] = [
    { key: "BOTH", label: "Both arches", value: aligners.filter((o) => o.arch === "BOTH").length, color: SERIES_A },
    { key: "UPPER", label: "Upper only", value: aligners.filter((o) => o.arch === "UPPER").length, color: "#c9a646" },
    { key: "LOWER", label: "Lower only", value: aligners.filter((o) => o.arch === "LOWER").length, color: SERIES_C },
  ];
  const intake: Part[] = [
    { key: "QUOTE_FIRST", label: "Quote first", value: aligners.filter((o) => o.intake !== "SCAN_DIRECT").length, color: SERIES_A },
    { key: "SCAN_DIRECT", label: "Scan straight in", value: aligners.filter((o) => o.intake === "SCAN_DIRECT").length, color: SERIES_B },
  ];
  const expressShare = now.cases ? now.opened.filter((o) => o.priority === "EXPRESS").length / now.cases : 0;

  const applianceMap = new Map<string, { label: string; orders: number; units: number }>();
  for (const o of now.opened.filter((x) => x.kind === "PRODUCT")) {
    const label = (o.product_label || "Appliance").split(" · ")[0];
    const row = applianceMap.get(label) ?? { label, orders: 0, units: 0 };
    row.orders += 1;
    row.units += o.quantity || 1;
    applianceMap.set(label, row);
  }
  const appliances = [...applianceMap.values()].sort((x, y) => y.orders - x.orders);

  const branchMap = new Map<string, number>();
  for (const o of now.opened) {
    const b = (o.branch_label || "").split(" · ")[0];
    if (b) branchMap.set(b, (branchMap.get(b) ?? 0) + 1);
  }
  const branches = [...branchMap.entries()].map(([label, count]) => ({ label, count })).sort((x, y) => y.count - x.count);

  // --- money
  const kindMap = new Map<string, number>();
  for (const h of now.paid) kindMap.set(h.kind, (kindMap.get(h.kind) ?? 0) + Number(h.total));
  const kinds: Part[] = Object.keys(KIND_NAME)
    .filter((k) => (kindMap.get(k) ?? 0) > 0)
    .map((k) => ({ key: k, label: KIND_NAME[k], value: kindMap.get(k)!, color: KIND_COLOR[k] }));
  const waits = history
    .filter((h) => h.submitted_at && h.verified_at)
    .map((h) => (ms(h.verified_at) - ms(h.submitted_at)) / 3600000)
    .filter((hrs) => hrs >= 0)
    .sort((x, y) => x - y);
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;
  const confirmTime =
    median === null ? "—" : median < 1 ? "Under an hour" : median < 48 ? `${Math.round(median)} hours` : `${Math.round(median / 24)} days`;

  // --- patients
  const casesPer = new Map<string, number>();
  for (const o of all) if (o.patient_id) casesPer.set(o.patient_id, (casesPer.get(o.patient_id) ?? 0) + 1);
  const withCases = people.filter((p) => (casesPer.get(p.id) ?? 0) > 0);
  const repeatShare = withCases.length ? withCases.filter((p) => (casesPer.get(p.id) ?? 0) > 1).length / withCases.length : 0;
  const neverStarted = people.length - withCases.length;
  const openBy = new Set(open.map((o) => o.patient_id).filter(Boolean));
  const inTreatment = people.filter((p) => openBy.has(p.id)).length;
  const patientMax = Math.max(0, ...series.patients);

  // --- what stands out, in words
  const facts: { label: string; value: string; note: string }[] = [];
  const busiest = series.cases.reduce((best, v, i) => (v > (best === -1 ? 0 : series.cases[best]) ? i : best), -1);
  const topBand = bands.filter((b) => b.key !== "unsized").sort((x, y) => y.value - x.value)[0];
  if (topBand) {
    facts.push({
      label: "Most common band",
      value: topBand.label,
      note: `${plural(topBand.value, "aligner case")} of ${formatCount(aligners.length)}`,
    });
  }
  if (aligners.length > 0) {
    const direct = intake[1].value;
    facts.push({
      label: "Scanned before quoting",
      value: `${Math.round((direct / aligners.length) * 100)}% of aligner cases`,
      note: `${plural(direct, "case")} came in with the scan already taken`,
    });
  }
  if (appliances[0]) {
    facts.push({ label: "Most-ordered appliance", value: appliances[0].label, note: `${plural(appliances[0].orders, "order")}` });
  }
  if (median !== null) {
    facts.push({ label: "Receipts confirmed", value: confirmTime.toLowerCase() === "under an hour" ? "Within the hour" : `In ${confirmTime}`, note: "typical time from sending a screenshot to confirmation" });
  }
  if (withCases.length > 0) {
    facts.push({ label: "Returning patients", value: `${Math.round(repeatShare * 100)}%`, note: "of treated patients have had more than one case" });
  }

  return {
    first,
    waiting: waiting.length,
    busiest: busiest >= 0 && series.cases.filter((v) => v > 0).length > 1 ? buckets[busiest].full : "",
    buckets,
    unit,
    now,
    prev,
    series,
    open,
    pipeline: stages,
    pipeMax,
    otherOpen,
    asks,
    ages,
    ageMax,
    avgAge,
    bands,
    arches,
    intake,
    expressShare,
    appliances,
    branches,
    kinds,
    confirmTime,
    repeatShare,
    neverStarted,
    inTreatment,
    patientMax,
    facts: facts.slice(0, 6),
  };
}
