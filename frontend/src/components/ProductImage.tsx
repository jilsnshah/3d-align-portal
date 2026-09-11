/* The picture on a shelf tile.
 *
 * Most appliances have 3D Align's own catalogue card; a few, and every
 * accessory, have nothing yet. An empty slot is not nothing: a card with a hole
 * where the picture goes reads as broken, and a stand-in drawing of a retainer
 * would be a picture of something the lab does not actually sell.
 *
 * So the placeholder says what it is instead of pretending to show it — the
 * lab's own code set in gold on the same black the catalogue cards are printed
 * on, so a missing picture sits in the row as one of the set rather than a gap.
 * The moment image_url is filled in, the photograph takes its place and
 * nothing else about the tile changes.
 *
 * Spans rather than divs throughout: the store wraps the whole card in a
 * button, and a button may only hold phrasing content.
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
    <span className="tile-media" style={{ aspectRatio: ratio }}>
      {usable ? (
        /* These are 3D Align's own catalogue cards — whole posters with the
           appliance named on them, not cut-out product shots — so each is shown
           entire on a ground its own black disappears into. */
        <img
          className="tile-poster"
          src={src}
          alt={name}
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="tile-mark" aria-hidden="true">
          <span className="tile-code">{code}</span>
          <span className="tile-name">{name}</span>
        </span>
      )}
    </span>
  );
}
