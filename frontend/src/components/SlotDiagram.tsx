/** A small schematic of the view a slot wants.
 *
 *  The labels are unambiguous only if you already know the vocabulary — "buccal
 *  right" and "occlusal upper" are not words a busy clinic reads carefully at
 *  the point of uploading. A wrong photograph in the right slot is worse than a
 *  missing one, because the lab plans from it, so each slot shows what it is
 *  after rather than only naming it.
 *
 *  Drawn rather than photographed on purpose: a line diagram cannot be mistaken
 *  for the patient's own record, and it carries no one's clinical images.
 */

const LINE = "var(--ink-2)";
const FAINT = "var(--ink-3)";
const GOLD = "var(--gold)";

/** Teeth laid along half an ellipse, so the arch reads as an arch rather than a
 *  row of squares. Molars at the back are drawn larger than the incisors. */
function archTeeth(opening: "down" | "up") {
  const cx = 40;
  const cy = opening === "down" ? 40 : 20;
  const rx = 24;
  const ry = 17;
  const teeth = [];
  const count = 12;
  for (let i = 0; i < count; i += 1) {
    // Sweep the half that curves away from the opening.
    const t = i / (count - 1);
    const deg = opening === "down" ? 180 + t * 180 : t * 180;
    const rad = (deg * Math.PI) / 180;
    const x = cx + rx * Math.cos(rad);
    const y = cy + ry * Math.sin(rad);
    // Front teeth are narrow, back teeth broad.
    const front = Math.abs(t - 0.5) * 2; // 0 at the back, 1 at the front
    const w = 3.6 + (1 - front) * 2.2;
    const h = 4.4 + (1 - front) * 1.6;
    const rotate = (deg + 90) % 360;
    teeth.push(
      <rect
        key={i}
        x={x - w / 2}
        y={y - h / 2}
        width={w}
        height={h}
        rx={1.2}
        transform={`rotate(${rotate} ${x} ${y})`}
        fill="none"
        stroke={LINE}
        strokeWidth={1.2}
      />,
    );
  }
  return teeth;
}

/** The outline an aligner traces over the arch — what tells "tray in" from
 *  "tray out" at a glance. */
function alignerShell(opening: "down" | "up") {
  const cy = opening === "down" ? 40 : 20;
  const sweep = opening === "down" ? 1 : 0;
  const outer = `M ${40 - 28} ${cy} A 28 21 0 0 ${sweep} ${40 + 28} ${cy}`;
  const inner = `M ${40 - 19} ${cy} A 19 12 0 0 ${sweep} ${40 + 19} ${cy}`;
  return (
    <>
      <path d={outer} fill="none" stroke={GOLD} strokeWidth={1.6} />
      <path d={inner} fill="none" stroke={GOLD} strokeWidth={1.6} />
    </>
  );
}

function Arch({
  opening,
  fill,
  shell,
}: {
  opening: "down" | "up";
  fill: "palate" | "tongue" | "none";
  shell?: boolean;
}) {
  const cy = opening === "down" ? 40 : 20;
  const sweep = opening === "down" ? 1 : 0;
  return (
    <>
      {fill === "palate" && (
        // The roof of the mouth fills the whole arch — the giveaway that this is
        // the upper.
        <path
          d={`M 12 ${cy} A 28 20 0 0 ${sweep} 68 ${cy} Z`}
          fill={FAINT}
          opacity={0.18}
        />
      )}
      {fill === "tongue" && (
        // The lower arch has a tongue sitting in it, not a palate.
        <ellipse cx={40} cy={opening === "down" ? 30 : 30} rx={13} ry={9} fill={FAINT} opacity={0.3} />
      )}
      {archTeeth(opening)}
      {shell && alignerShell(opening)}
    </>
  );
}

/** Head seen from above, with the side being photographed picked out. Left and
 *  right are the one thing a side-on drawing cannot show on its own. */
function SideKey({ side }: { side: "left" | "right" }) {
  // Patient's own left and right, seen from above with the nose at the top.
  const cx = 40;
  const cy = 10;
  const dotX = side === "right" ? cx - 8 : cx + 8;
  return (
    <g>
      <circle cx={cx} cy={cy} r={6.5} fill="none" stroke={FAINT} strokeWidth={1} />
      <path d={`M ${cx - 2} ${cy - 6.2} L ${cx} ${cy - 9} L ${cx + 2} ${cy - 6.2}`} fill="none" stroke={FAINT} strokeWidth={1} />
      {/* The side the camera is on. */}
      <path
        d={`M ${cx + (side === "right" ? -6.5 : 6.5)} ${cy - 4} A 6.5 6.5 0 0 ${side === "right" ? 0 : 1} ${cx + (side === "right" ? -6.5 : 6.5)} ${cy + 4}`}
        fill="none"
        stroke={GOLD}
        strokeWidth={2.4}
      />
      <circle cx={dotX} cy={cy} r={2} fill={GOLD} />
    </g>
  );
}

/** Teeth in occlusion seen from the side.
 *
 *  Drawn front-to-back — a flat incisor at the lip, a pointed canine, then
 *  broadening premolars and molars — so that mirroring the drawing actually
 *  looks mirrored. A symmetric row of squares would not. */
function BuccalTeeth({ side }: { side: "left" | "right" }) {
  // width, upper height, lower height, per tooth from the front backwards
  const shape = [
    [5, 9, 7],
    [4, 10, 7.5],
    [5.5, 8, 6.5],
    [6, 7.5, 6.5],
    [8, 7, 6],
    [8.5, 6.5, 5.5],
  ];
  let x = 13;
  const teeth = shape.map(([w, hu, hl], i) => {
    const el = (
      <g key={i}>
        {/* Upper row sits over the lower, as it does in occlusion. */}
        <rect x={x} y={32 - hu} width={w} height={hu} rx={1.6} fill="none" stroke={LINE} strokeWidth={1.2} />
        <rect x={x + 1.2} y={33} width={w} height={hl} rx={1.6} fill="none" stroke={LINE} strokeWidth={1.2} />
      </g>
    );
    x += w + 1.4;
    return el;
  });
  return (
    <g transform={side === "left" ? "translate(80 0) scale(-1 1)" : undefined}>
      {/* The corner of the lip, marking the front of the mouth. */}
      <path d="M 9 24 Q 6 32.5 9 41" fill="none" stroke={FAINT} strokeWidth={1.3} />
      {teeth}
      <path d="M 12 32.5 L 66 32.5" stroke={FAINT} strokeWidth={0.9} />
    </g>
  );
}

function Frontal({ shell }: { shell?: boolean }) {
  // Central incisors are the widest; the arch narrows towards the corners.
  const widths = [4.2, 6.2, 7.4, 7.4, 6.2, 4.2];
  let x = 22;
  const upper = widths.map((w, i) => {
    const el = (
      <rect key={`u${i}`} x={x} y={22.5} width={w} height={9} rx={1.4}
            fill="none" stroke={LINE} strokeWidth={1.2} />
    );
    x += w + 0.8;
    return el;
  });
  x = 23;
  const lower = widths.map((w, i) => {
    const el = (
      <rect key={`l${i}`} x={x} y={32.5} width={w * 0.86} height={7} rx={1.4}
            fill="none" stroke={LINE} strokeWidth={1.2} />
    );
    x += w * 0.86 + 0.8;
    return el;
  });
  return (
    <>
      {/* Lips, open on the bite. Drawn wide and deep so the shape reads as a
          mouth rather than an eye. */}
      <path
        d="M 8 32 C 16 15 64 15 72 32 C 64 47 16 47 8 32 Z"
        fill="none"
        stroke={FAINT}
        strokeWidth={1.4}
      />
      {upper}
      {lower}
      {/* The occlusal line, and the midline between the central incisors. */}
      <path d="M 15 32 L 65 32" stroke={FAINT} strokeWidth={0.9} />
      <path d="M 40 21 L 40 40" stroke={FAINT} strokeWidth={0.8} strokeDasharray="2 2" />
      {shell && (
        <path
          d="M 20 21 Q 40 17.5 60 21 M 20 40 Q 40 43.5 60 40"
          fill="none"
          stroke={GOLD}
          strokeWidth={1.8}
        />
      )}
    </>
  );
}

function FaceOutline() {
  return (
    <>
      <path
        d="M 40 6 C 52 6 58 15 58 24 C 58 36 50 46 40 46 C 30 46 22 36 22 24 C 22 15 28 6 40 6 Z"
        fill="none"
        stroke={FAINT}
        strokeWidth={1.3}
      />
      <circle cx={33} cy={22} r={1.6} fill={LINE} />
      <circle cx={47} cy={22} r={1.6} fill={LINE} />
    </>
  );
}

const DIAGRAMS: Record<string, JSX.Element> = {
  INTRAORAL_FRONTAL: <Frontal />,
  BUCCAL_RIGHT: (
    <>
      <SideKey side="right" />
      <BuccalTeeth side="right" />
    </>
  ),
  BUCCAL_LEFT: (
    <>
      <SideKey side="left" />
      <BuccalTeeth side="left" />
    </>
  ),
  OCCLUSAL_UPPER: <Arch opening="down" fill="palate" />,
  OCCLUSAL_LOWER: <Arch opening="up" fill="tongue" />,

  FACE_REST: (
    <>
      <FaceOutline />
      <path d="M 33 35 L 47 35" stroke={LINE} strokeWidth={1.4} />
    </>
  ),
  FACE_SMILE: (
    <>
      <FaceOutline />
      <path d="M 31 32 Q 40 41 49 32 Z" fill="none" stroke={LINE} strokeWidth={1.4} />
      <path d="M 33 33.4 L 47 33.4" stroke={FAINT} strokeWidth={1.1} />
    </>
  ),
  PROFILE: (
    <>
      {/* A side-on head. Filled rather than outlined: at tile size a thin
          contour loses the shape, and what the clinic needs to recognise is
          "the whole face, from the side" — not an anatomical tracing. */}
      <path
        d="M 38 8
           C 45 8 49 13 49 20
           L 49 22.4
           C 51 24 53.4 26.2 53.4 27.4
           C 53.4 28.4 50.6 28.9 48.6 29.1
           C 49.3 30.2 48.6 31 47.6 31.5
           C 49.4 32.4 49.2 33.9 47.4 34.7
           C 48.8 36.2 48.4 38.7 45.2 40.2
           C 41.6 41.9 36 42.2 32.4 41.3
           C 29.4 38.9 27.6 34 27.6 28
           C 27.6 18 30.6 8.6 38 8 Z"
        fill={FAINT}
        opacity={0.22}
      />
      <path
        d="M 38 8
           C 45 8 49 13 49 20
           L 49 22.4
           C 51 24 53.4 26.2 53.4 27.4
           C 53.4 28.4 50.6 28.9 48.6 29.1
           C 49.3 30.2 48.6 31 47.6 31.5
           C 49.4 32.4 49.2 33.9 47.4 34.7
           C 48.8 36.2 48.4 38.7 45.2 40.2
           C 41.6 41.9 36 42.2 32.4 41.3
           C 29.4 38.9 27.6 34 27.6 28
           C 27.6 18 30.6 8.6 38 8 Z"
        fill="none"
        stroke={FAINT}
        strokeWidth={1.3}
        strokeLinejoin="round"
      />
      <circle cx={44} cy={22} r={1.4} fill={LINE} />
      <path d="M 36 27 C 32.5 27 32.5 33 36 33" fill="none" stroke={LINE} strokeWidth={1.1} opacity={0.7} />
    </>
  ),

  // Intraoral scan files — the same arches, as geometry rather than photographs.
  UPPER_ARCH: <Arch opening="down" fill="palate" />,
  LOWER_ARCH: <Arch opening="up" fill="tongue" />,
  BITE: (
    <>
      <g opacity={0.55}>
        <Arch opening="down" fill="none" />
      </g>
      <g transform="translate(0 6)">
        <Arch opening="up" fill="none" />
      </g>
    </>
  ),

  // Progress photographs: same three views, with and without the trays. The
  // gold outline is the aligner.
  PROGRESS_UPPER_IN: <Arch opening="down" fill="palate" shell />,
  PROGRESS_LOWER_IN: <Arch opening="up" fill="tongue" shell />,
  PROGRESS_FRONTAL_IN: <Frontal shell />,
  PROGRESS_UPPER_OUT: <Arch opening="down" fill="palate" />,
  PROGRESS_LOWER_OUT: <Arch opening="up" fill="tongue" />,
  PROGRESS_FRONTAL_OUT: <Frontal />,
};

export function hasDiagram(slot: string): boolean {
  return Boolean(DIAGRAMS[slot]);
}

export default function SlotDiagram({
  slot,
  className,
}: {
  slot: string;
  className?: string;
}) {
  const art = DIAGRAMS[slot];
  if (!art) return null;
  return (
    <svg
      className={className}
      viewBox="0 0 80 52"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      {art}
    </svg>
  );
}
