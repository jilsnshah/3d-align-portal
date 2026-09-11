import type { CSSProperties } from "react";

/* A face for each name, so a long list can be scanned by shape as well as by
   reading. The tone follows the person, never the row it happens to sit on. */
const TONES: [string, string][] = [
  ["#f3ead4", "#8f6f1f"],
  ["#e5efe8", "#2f6f4f"],
  ["#e7ebf3", "#3c4f6e"],
  ["#f3e5e0", "#8a4a3a"],
  ["#ece7f3", "#5b4a7a"],
  ["#e5eef0", "#3d5f66"],
];

export default function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  const parts = name
    .replace(/^dr\.?\s+/i, "")
    .trim()
    .split(/\s+/);
  const initials = ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, ink] = TONES[h % TONES.length];
  return (
    <span
      className={large ? "pt-avatar lg" : "pt-avatar"}
      style={{ "--av-bg": bg, "--av-ink": ink } as CSSProperties}
      aria-hidden="true"
    >
      {initials || "?"}
    </span>
  );
}
