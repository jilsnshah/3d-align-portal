/* The picture on a shelf tile.
 *
 * The lab does not have photographs of its own stock yet, so most of these are
 * an empty slot. An empty slot is not nothing: a card with a hole where the
 * picture goes reads as broken, and a stand-in drawing of a retainer would be
 * a picture of something the lab does not actually sell.
 *
 * So the placeholder says what it is instead of pretending to show it — the
 * lab's own code, set on a quiet ground, the way a specimen tray is labelled.
 * The moment image_url is filled in, the photograph takes its place and
 * nothing else about the tile changes.
 */

import { useState } from "react";

export default function ProductImage({
  src,
  code,
  name,
  ratio = "16 / 10",
}: {
  src?: string;
  code: string;
  name: string;
  ratio?: string;
}) {
  // A URL that 404s would otherwise leave the alt text sitting in a grey box,
  // which looks worse than the placeholder we already have.
  const [broken, setBroken] = useState(false);
  const usable = src && src.trim().length > 0 && !broken;

  return (
    <div className="tile-media" style={{ aspectRatio: ratio }}>
      {usable ? (
        <img src={src} alt={name} loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <span className="tile-mark" aria-hidden="true">
          <span className="tile-code">{code}</span>
        </span>
      )}
    </div>
  );
}
