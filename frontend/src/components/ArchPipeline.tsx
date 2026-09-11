/* The aligner journey laid along the curve of an upper arch: each stage a
   point on it, sized by how many cases stand there, and lit gold where the
   reader is the one holding them up — the clinic on its home page, the lab on
   its queue. It says in one look what a table of stages says in six rows.

   Shared so the two sides draw the same picture from opposite ends of it. */

import type { CSSProperties, ReactNode } from "react";

import type { OrderSummary } from "../api";
import { stageIndex, stagesFor } from "../workflow";

const ARCH = { W: 680, H: 400, cx: 340, cy: 350, rx: 230, ry: 250 };
/** Where each of the six stages sits on the curve, left to right. */
const ANGLES = [168, 136, 104, 76, 44, 12];
/** Which side of its point each label goes, so none crosses the curve. The
    two at the crown lean away from each other — side by side they collide
    once the arch is narrower than a laptop screen. */
const PLACE = ["below", "left", "above-l", "above-r", "right", "below"] as const;

function archPoint(deg: number, grow = 0): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [ARCH.cx + (ARCH.rx + grow) * Math.cos(a), ARCH.cy - (ARCH.ry + grow) * Math.sin(a)];
}

export type ArchStage = { key: string; label: string; total: number; lit: number };

/** Open aligner cases counted by stage, with how many of them are lit. A case
    that came in with its own scan has no quote stage, and its stages are
    matched to the full journey by key, so it lands on the same point as every
    other case at that step. Everything that is not an aligner case is counted
    apart. */
export function stageCounts(
  orders: OrderSummary[],
  lit: (order: OrderSummary) => boolean,
): { stages: ArchStage[]; other: number } {
  const counts = new Map<string, ArchStage>(
    stagesFor("ALIGNER").map((s) => [s.key, { key: s.key, label: s.label, total: 0, lit: 0 }]),
  );
  let other = 0;
  for (const o of orders) {
    if (o.status === "COMPLETED" || o.status === "CANCELLED") continue;
    if (o.kind !== "ALIGNER") {
      other += 1;
      continue;
    }
    const key = stagesFor(o.kind, o.intake)[stageIndex(o.kind, o.status, o.intake)]?.key;
    const c = key ? counts.get(key) : undefined;
    if (!c) continue;
    c.total += 1;
    if (lit(o)) c.lit += 1;
  }
  return { stages: [...counts.values()], other };
}

export default function ArchPipeline({
  stages,
  loading,
  label,
  centerLabel,
  centerNote,
  litNote,
  keys,
  onPick,
}: {
  stages: ArchStage[];
  loading: boolean;
  /** What the picture shows, for a screen reader. */
  label: string;
  centerLabel: string;
  centerNote?: string;
  /** How a lit count reads under its stage: "2 with you", "3 on our desk". */
  litNote: (n: number) => string;
  /** The legend: what gold means, then what the rest means. */
  keys: [string, string];
  onPick: (stageKey: string) => void;
}) {
  const total = stages.reduce((n, s) => n + s.total, 0);
  const max = Math.max(1, ...stages.map((s) => s.total));
  const { W, H, cx, cy, rx, ry } = ARCH;
  const arc = `M ${cx - rx} ${cy} A ${rx} ${ry} 0 0 1 ${cx + rx} ${cy}`;

  // The contact points between teeth, stepped round the inside of the curve.
  const ticks: ReactNode[] = [];
  for (let deg = 176; deg >= 4; deg -= 4) {
    const [x1, y1] = archPoint(deg, -30);
    const [x2, y2] = archPoint(deg, -19);
    ticks.push(<line key={deg} x1={x1} y1={y1} x2={x2} y2={y2} />);
  }

  return (
    <figure className="hm-pipe" role="group" aria-label={label}>
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <defs>
          <linearGradient id="pipeInk" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#d4af37" stopOpacity="0.25" />
            <stop offset="50%" stopColor="#f1d57a" stopOpacity="1" />
            <stop offset="100%" stopColor="#d4af37" stopOpacity="0.25" />
          </linearGradient>
          <radialGradient id="pipeGlow" cx="50%" cy="100%" r="75%">
            <stop offset="0%" stopColor="#d4af37" stopOpacity="0.26" />
            <stop offset="100%" stopColor="#d4af37" stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="url(#pipeGlow)" />
        <g className="pipe-ticks">{ticks}</g>
        <path d={arc} className="pipe-track" />
        <path d={arc} className="pipe-line" pathLength={1} />
      </svg>

      <div className="pipe-center" style={{ "--top": `${((cy - 118) / H) * 100}%` } as CSSProperties}>
        <b>{loading ? "—" : total}</b>
        <span>{centerLabel}</span>
        {centerNote && <small>{centerNote}</small>}
      </div>

      {stages.map((s, i) => {
        const [x, y] = archPoint(ANGLES[i]);
        const r = s.total === 0 ? 8 : 15 + 12 * Math.sqrt(s.total / max);
        const state = s.lit > 0 ? "you" : s.total > 0 ? "lab" : "none";
        const title = `${s.total} at ${s.label}` + (s.lit > 0 ? ` — ${litNote(s.lit)}` : "");
        return (
          <button
            key={s.key}
            type="button"
            className={`pipe-node ${state} ${PLACE[i]}`}
            style={
              {
                left: `${(x / W) * 100}%`,
                top: `${(y / H) * 100}%`,
                "--r": `${r}px`,
                "--d": `${400 + i * 110}ms`,
              } as CSSProperties
            }
            onClick={() => onPick(s.key)}
            aria-label={title}
            title={title}
          >
            <span className="pipe-dot">{s.total > 0 ? s.total : ""}</span>
            <span className="pipe-say">
              <b>{s.label}</b>
              {s.lit > 0 && <small>{litNote(s.lit)}</small>}
            </span>
          </button>
        );
      })}

      <figcaption className="hm-pipe-key">
        <span className="k-you">{keys[0]}</span>
        <span className="k-lab">{keys[1]}</span>
      </figcaption>
    </figure>
  );
}
