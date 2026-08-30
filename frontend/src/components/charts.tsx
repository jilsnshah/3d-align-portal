/* Charts for the stat pages.

   Hand-drawn SVG rather than a charting library: the bundle is already large,
   and four chart forms drawn to this design system is less code than bending a
   general-purpose library to match it.

   The palette is two hues — gold for the lab's own work, violet for everything
   else — validated for colour-vision deficiency against a white surface before
   it was used, rather than picked by eye. Every chart also carries a table
   view, so nothing here is readable only in colour. */

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export const SERIES_A = "#8f6f1f"; // aligner cases — the brand's own gold, deepened
export const SERIES_B = "#4a3aa7"; // product orders

/** Measures the box a chart is drawn into, so text is set at real pixels
    rather than scaled by a viewBox until it is unreadable on a phone. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A column with a rounded data end and a square baseline: the cap says which
    end is the value, the flat foot says where zero is. */
function columnPath(x: number, y: number, w: number, h: number, r = 4): string {
  const radius = Math.min(r, w / 2, h);
  if (h <= 0) return "";
  return [
    `M${x},${y + h}`,
    `L${x},${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `L${x + w - radius},${y}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `L${x + w},${y + h}`,
    "Z",
  ].join(" ");
}

/** Axis ticks a person would actually write down. */
function ticksFor(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const rough = max / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? magnitude * 10;
  const out: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) out.push(v);
  return out;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-IN");
}

export function formatMoney(value: number, short = false): string {
  if (short && value >= 100000) return `₹${(value / 100000).toFixed(1)}L`;
  if (short && value >= 1000) return `₹${Math.round(value / 1000)}k`;
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}

type Tip = { x: number; y: number; rows: { swatch?: string; label: string; value: string }[]; head: string };

function Tooltip({ tip, width }: { tip: Tip; width: number }) {
  // Kept inside the plot rather than allowed to run off the edge, where the
  // last column's tooltip would be the one you cannot read.
  const clamped = Math.min(Math.max(tip.x, 80), Math.max(width - 80, 80));
  return (
    <div className="chart-tip" style={{ left: clamped, top: tip.y }} role="presentation">
      <div className="chart-tip-head">{tip.head}</div>
      {tip.rows.map((row) => (
        <div key={row.label} className="chart-tip-row">
          {row.swatch && <i style={{ background: row.swatch }} />}
          <span>{row.label}</span>
          <b>{row.value}</b>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="chart-legend">
      {items.map((item) => (
        <span key={item.label}>
          <i style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- columns */

/* `label` rides the axis and has to stay short; `full` is what the tooltip
   says, where "24" alone does not tell anyone which month. */
export type Column = { key: string; label: string; full?: string; a: number; b?: number };

/** Cases over time. Two series sit side by side rather than stacked, because
    the question is "how much of each", not "how much altogether". */
export function ColumnChart({
  data,
  labelA,
  labelB,
  money = false,
  height = 220,
}: {
  data: Column[];
  labelA: string;
  labelB?: string;
  money?: boolean;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const grouped = labelB !== undefined;

  const padL = 44;
  const padR = 8;
  const padB = 22;
  const padT = 10;
  const plotW = Math.max(width - padL - padR, 10);
  const plotH = height - padT - padB;

  const max = Math.max(...data.map((d) => Math.max(d.a, d.b ?? 0)), 1);
  const ticks = ticksFor(max);
  const top = ticks[ticks.length - 1];
  const scale = (value: number) => (value / top) * plotH;

  const band = plotW / Math.max(data.length, 1);
  // Marks stay thin and the band's leftover is air, rather than fat bars that
  // fill the slot and turn the chart into a wall.
  const barW = Math.min(grouped ? (band - 8) / 2 - 1 : band - 10, 24);

  const format = money ? (v: number) => formatMoney(v) : formatCount;

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${labelA} over time`}>
          {ticks.map((value) => {
            const y = padT + plotH - scale(value);
            return (
              <g key={value}>
                <line x1={padL} x2={width - padR} y1={y} y2={y} className="chart-grid" />
                <text x={padL - 8} y={y + 4} className="chart-axis" textAnchor="end">
                  {money ? formatMoney(value, true) : formatCount(value)}
                </text>
              </g>
            );
          })}
          {data.map((point, index) => {
            const x0 = padL + index * band;
            const bars = grouped
              ? [
                  { value: point.a, color: SERIES_A, label: labelA, x: x0 + band / 2 - barW - 1 },
                  { value: point.b ?? 0, color: SERIES_B, label: labelB!, x: x0 + band / 2 + 1 },
                ]
              : [{ value: point.a, color: SERIES_A, label: labelA, x: x0 + (band - barW) / 2 }];
            return (
              <g
                key={point.key}
                onPointerEnter={() =>
                  setTip({
                    x: x0 + band / 2,
                    y: 4,
                    head: point.full ?? point.label,
                    rows: bars.map((bar) => ({
                      swatch: bar.color,
                      label: bar.label,
                      value: format(bar.value),
                    })),
                  })
                }
                onPointerLeave={() => setTip(null)}
              >
                {/* A hit target the width of the whole band: pointing at a
                    one-pixel column is not a thing anyone should have to do. */}
                <rect x={x0} y={padT} width={band} height={plotH} fill="transparent" />
                {bars.map((bar) => {
                  const h = scale(bar.value);
                  return h > 0 ? (
                    <path
                      key={bar.label}
                      d={columnPath(bar.x, padT + plotH - h, barW, h)}
                      fill={bar.color}
                    />
                  ) : null;
                })}
              </g>
            );
          })}
          {data.map((point, index) => {
            // Every label on a 31-day month is a smear, so only every third
            // day is written and the tooltip carries the rest.
            const skip = data.length > 14 && index % 3 !== 0;
            return skip ? null : (
              <text
                key={point.key}
                x={padL + index * band + band / 2}
                y={height - 6}
                className="chart-axis"
                textAnchor="middle"
              >
                {point.label}
              </text>
            );
          })}
        </svg>
      )}
      {tip && <Tooltip tip={tip} width={width} />}
    </div>
  );
}

/* ------------------------------------------------------------ ranked bars */

export type Rank = { key: string; label: string; note?: string; value: number; extra?: string };

/** A ranked breakdown. Horizontal because the names are words, and a word
    turned on its side is a name nobody reads. */
export function RankBars({
  rows,
  unit,
  limit = 8,
}: {
  rows: Rank[];
  unit: string;
  /* Past eight bars the eye stops ranking and starts scanning, and the panel
     grows a storey taller than the ones beside it. The tail is counted, and
     the table view still carries every row. */
  limit?: number;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  const shown = rows.slice(0, limit);
  const rest = rows.length - shown.length;
  return (
    <div className="rank-list">
      {shown.map((row) => (
        <div key={row.key} className="rank-row">
          <div className="rank-head">
            <span className="rank-label">
              {row.label}
              {row.note && <small>{row.note}</small>}
            </span>
            {/* The value is written, not only drawn: gold sits under 3:1
                against white, so the bar alone must not be the only way to
                read it. */}
            <span className="rank-value">
              {formatCount(row.value)}
              <small>
                {" "}
                {unit}
                {row.extra ? ` · ${row.extra}` : ""}
              </small>
            </span>
          </div>
          <div className="rank-track">
            <span style={{ width: `${Math.max((row.value / max) * 100, 1.5)}%` }} />
          </div>
        </div>
      ))}
      {rest > 0 && (
        <p className="dim rank-rest">
          {rest} more, in the numbers below.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- stat tile */

export function StatTile({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "gold";
}) {
  return (
    <div className={`stat-tile${tone === "gold" ? " gold" : ""}`}>
      <span className="stat-label">{label}</span>
      <b className="stat-value">{value}</b>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}

/** Every chart on these pages can be read as numbers instead. Colour is never
    the only channel, and a screen reader gets the figures rather than an SVG. */
export function TableToggle({ children, label }: { children: ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="table-toggle">
      <button type="button" className="btn-link" onClick={() => setOpen((was) => !was)}>
        {open ? "Hide the numbers" : `Show ${label} as numbers`}
      </button>
      {open && <div className="table-wrap">{children}</div>}
    </div>
  );
}
