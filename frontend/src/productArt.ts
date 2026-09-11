/* The lab's own imagery, lifted out of its product catalogue.
 *
 * The catalogue PDF prints each appliance as a flyer, and showing those whole
 * made every product surface a wall of flyers. Inside them are the real
 * assets — boxed product shots on clear backgrounds, photographs of the
 * appliances in use, and before-and-after cases — and those are what the shop
 * and the home page are built from. Keyed by product code; a product with none
 * of these falls back to its catalogue card or its lettered mark.
 *
 * Shared, so the home page and the shop can never show the same product two
 * different ways.
 */

/** Boxed product shots, trimmed, on clear backgrounds. */
export const SHOT: Record<string, string> = {
  ER: "/products/shots/ER.webp",
  GER: "/products/shots/GER.webp",
  PR: "/products/shots/PR.webp",
  NG: "/products/shots/NG.webp",
  TMJ: "/products/shots/TMJ.webp",
  LEACH: "/products/shots/LEACH.webp",
  JA: "/products/shots/JA.webp",
};

/** The appliance in use, or the problem it answers. */
export const LIFE: Record<string, string> = {
  ER: "/products/life/ER.webp",
  NG: "/products/life/NG.webp",
  TMJ: "/products/life/TMJ.webp",
  LEACH: "/products/life/LEACH.webp",
  SG: "/products/life/SG.webp",
};

/** Cases from the catalogue, before and after. Shown as the lab printed them. */
export const RESULTS: Record<string, [string, string]> = {
  PR: ["/products/ba/PR-before.webp", "/products/ba/PR-after.webp"],
  GER: ["/products/ba/GER-before.webp", "/products/ba/GER-after.webp"],
  JA: ["/products/ba/JA-before.webp", "/products/ba/JA-after.webp"],
};

/** The order the range is shown in: what a clinic buys most, first. */
export const FEATURED = ["ER", "NG", "TMJ", "LEACH", "GER", "PR", "JA", "SG"];

/** What each appliance does for the patient, in a line the doctor could say
    to them. */
export const TAGLINE: Record<string, string> = {
  ER: "Hold the result you worked for.",
  GER: "Retention that keeps the gap.",
  PR: "Small smiles, kept in place.",
  NG: "Nights without the grind.",
  TMJ: "Relief, built to prescription.",
  LEACH: "Whiter, at home.",
  SG: "Play hard. Keep the smile.",
  JA: "Bring the jaw forward.",
};

/** A line of plain English about what the thing is for. The lab's own shorthand
    is not something a doctor should have to decode from a product code. */
export const BLURB: Record<string, string> = {
  ER: "Clear retention after treatment. Two thicknesses — 0.8 mm holds harder and lasts longer.",
  GER: "Retention with a pontic built in, for a space you want held open.",
  PR: "Retention sized for a child, with a pontic included.",
  NG: "Night guard for grinding. Thicker for heavier wear.",
  TMJ: "Occlusal splint for joint pain, built to a prescribed thickness.",
  LEACH: "Trays for home bleaching, reservoirs included.",
  SG: "Mouthguard for contact sport. Thicker for higher impact.",
  ABP: "Anterior bite plate for deprogramming.",
  PBP: "Posterior bite plate for posterior disclusion.",
  JA: "Twin-block appliance for mandibular advancement.",
};
