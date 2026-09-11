/* The 3D Align shop.
 *
 * A doctor comes here to buy the things that finish a case — a retainer, a
 * guard, a splint — and the page's job is to make that feel like choosing from
 * a range rather than reading a price list. The catalogue PDF was the only
 * imagery, and printing its pages whole made the shop a wall of flyers. Inside
 * those pages are the real assets: the lab's own boxed product shots on clear
 * backgrounds, photographs of the appliances in use, and before-and-after
 * cases. The page is built from those.
 *
 * It reads top to bottom as a store does:
 *   a spotlight that turns through the range, one product at a time;
 *   shop by need, as four photographs;
 *   the range itself, each appliance lit on its own stage;
 *   why clinics order here;
 *   the shelf — stock that travels in the same box;
 *   and what happens after the button.
 *
 * Ordering happens in a sheet beside the product, with a gallery of it. The
 * rules underneath are unchanged — how an appliance is counted, the paired
 * appliances, the extra bite scan, the payment hold, the delivery charge, and
 * accessories as practice stock with no patient.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { api } from "../../api";
import type { Accessory as AccessoryType, Product } from "../../api";
import { Banner, ErrorText, Field, Skeleton } from "../../components/ui";
import ProductImage from "../../components/ProductImage";

/** "an Essix Retainer", not "a Essix Retainer". */
function article(name: string): string {
  return /^[aeiou]/i.test(name) ? "an" : "a";
}

function rupees(value: string | number): string {
  return `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/** The cheapest way to buy one, which is what a price list should lead with. */
function from(product: Product): number {
  return Math.min(...product.sizes.map((s) => Number(s.price)));
}

function variesInPrice(product: Product): boolean {
  return new Set(product.sizes.map((s) => Number(s.price))).size > 1;
}

/** "₹700" when every thickness costs the same; "from ₹500" only when they do not. */
function priced(product: Product): string {
  return variesInPrice(product) ? `from ${rupees(from(product))}` : rupees(from(product));
}

function scrollToId(id: string, smooth = true) {
  document.getElementById(id)?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
}

/* --- the lab's own imagery, lifted out of its catalogue --------------------
   Keyed by product code. The boxed shots are on clear backgrounds, so they sit
   on whatever stage the page gives them; the photographs are used whole. */

const SHOT: Record<string, string> = {
  ER: "/products/shots/ER.webp",
  GER: "/products/shots/GER.webp",
  PR: "/products/shots/PR.webp",
  NG: "/products/shots/NG.webp",
  TMJ: "/products/shots/TMJ.webp",
  LEACH: "/products/shots/LEACH.webp",
  JA: "/products/shots/JA.webp",
};

const LIFE: Record<string, string> = {
  ER: "/products/life/ER.webp",
  NG: "/products/life/NG.webp",
  TMJ: "/products/life/TMJ.webp",
  LEACH: "/products/life/LEACH.webp",
  SG: "/products/life/SG.webp",
};

/** Cases from the catalogue, before and after. Shown as the lab printed them. */
const RESULTS: Record<string, [string, string]> = {
  PR: ["/products/ba/PR-before.webp", "/products/ba/PR-after.webp"],
  GER: ["/products/ba/GER-before.webp", "/products/ba/GER-after.webp"],
  JA: ["/products/ba/JA-before.webp", "/products/ba/JA-after.webp"],
};

/** The order the spotlight turns in: what a clinic buys most first. */
const FEATURED = ["ER", "NG", "TMJ", "LEACH", "GER", "PR", "JA"];

/** What each appliance does for the patient, in a line the doctor could say
    to them. The spotlight leads with this, and names the product under it. */
const TAGLINE: Record<string, string> = {
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
const BLURB: Record<string, string> = {
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

/* What a doctor is reaching for, rather than what the lab calls it. A clinic
   finishing a case wants retention; one with a grinding patient wants a guard.
   Grouping by need lets ten products be browsed as four questions. */
type Need = "retention" | "protection" | "joint" | "whitening";

const NEEDS: { key: Need; label: string; codes: string[]; photo: string }[] = [
  { key: "retention", label: "Retention", codes: ["ER", "GER", "PR"], photo: "/products/life/ER.webp" },
  { key: "protection", label: "Protection", codes: ["NG", "SG"], photo: "/products/life/NG.webp" },
  { key: "joint", label: "Joint & bite", codes: ["TMJ", "JA", "ABP", "PBP"], photo: "/products/life/TMJ.webp" },
  { key: "whitening", label: "Whitening", codes: ["LEACH"], photo: "/products/life/LEACH.webp" },
];

function needOf(code: string) {
  return NEEDS.find((n) => n.codes.includes(code));
}

const ICON: Record<string, ReactNode> = {
  scan: (
    <>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h10" />
    </>
  ),
  reuse: (
    <>
      <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.7" />
      <path d="M20 4v4.7h-4.7" />
      <path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.3" />
      <path d="M4 20v-4.7h4.7" />
    </>
  ),
  truck: (
    <>
      <path d="M3 6h11v10H3zM14 10h4l3 3v3h-7" />
      <circle cx="7" cy="17.5" r="1.8" />
      <circle cx="17" cy="17.5" r="1.8" />
    </>
  ),
  lab: (
    <>
      <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9V3" />
      <path d="M7.5 14h9" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON[name]}
    </svg>
  );
}

type Hold = { reference: string; reason: string };

export default function Catalogue() {
  const navigate = useNavigate();
  const products = useQuery({ queryKey: ["products"], queryFn: api.products });
  const patients = useQuery({
    queryKey: ["patients", "picker"],
    queryFn: () => api.patients({ limit: 200 }),
  });
  /* A product is one charge, raised the moment the order exists — so the
     delivery on top has to be a number the clinic saw before it committed,
     not a line it meets for the first time on the payment screen. */
  const delivery = useQuery({ queryKey: ["delivery-charge"], queryFn: api.deliveryCharge });
  const shelf = useQuery({ queryKey: ["accessories"], queryFn: api.accessories });
  /* An appliance ships before it is paid for, so an unsettled one holds the
     next. Accessories are never held: they are paid before they leave. */
  const hold = useQuery({ queryKey: ["ordering-hold"], queryFn: api.orderingHold });
  const heldBy: Hold | null = hold.data && !hold.data.can_order_products ? hold.data : null;

  /* Accessories are counted, not chosen once: a clinic restocking asks for two
     strips, a cleanser and five cases in one breath. Held as id -> count so
     the same basket serves the shelf and the add-on step in the order sheet. */
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [orderingAccessories, setOrderingAccessories] = useState(false);
  const [need, setNeed] = useState<Need | "all">("all");

  function setCount(id: string, count: number) {
    setBasket((was) => {
      const next = { ...was };
      if (count <= 0) delete next[id];
      else next[id] = Math.min(count, 200);
      return next;
    });
  }

  const basketLines = (shelf.data ?? [])
    .filter((item) => basket[item.id])
    .map((item) => ({ item, quantity: basket[item.id] }));
  const basketTotal = basketLines.reduce(
    (sum, line) => sum + Number(line.item.price) * line.quantity,
    0,
  );
  const asPayload = basketLines.map((line) => ({
    accessory_id: line.item.id,
    quantity: line.quantity,
  }));

  const [params, setParams] = useSearchParams();
  const [ordering, setOrdering] = useState<Product | null>(null);
  const [mediaAt, setMediaAt] = useState(0);
  const [patientId, setPatientId] = useState("");
  // Two fields, as everywhere else.
  const [newFirst, setNewFirst] = useState("");
  const [newLast, setNewLast] = useState("");
  const newPatient = { first_name: newFirst.trim(), last_name: newLast.trim() };
  const [sizeId, setSizeId] = useState("");
  // Most appliances are a tray per arch, so the clinic says how many of each.
  // A TMJ splint and a jaw-correction appliance are only ever made as a pair,
  // and for those one number is the whole question.
  const [quantity, setQuantity] = useState(1);
  const [upper, setUpper] = useState(1);
  const [lower, setLower] = useState(1);
  const [extraTeeth, setExtraTeeth] = useState(0);

  function open(product: Product) {
    setOrdering(product);
    setMediaAt(0);
    // A product with one form is settled the moment it is chosen.
    setSizeId(product.has_choice_of_size ? "" : product.sizes[0]?.id ?? "");
    setQuantity(1);
    setUpper(1);
    setLower(1);
    setExtraTeeth(0);
  }

  const paired = ordering?.both_arches ?? false;
  // What the order actually comes to, and the one number the price is worked
  // from — the same number "how many sets" always meant, so nothing repriced.
  const count = paired ? quantity : upper + lower;

  const size = ordering?.sizes.find((s) => s.id === sizeId) ?? null;
  const goods = ordering && size
    ? (Number(size.price) + Number(ordering.per_tooth_price) * extraTeeth) * count
    : 0;
  const shipping = Number(delivery.data?.amount ?? 0);
  const total = goods + basketTotal + shipping;

  const create = useMutation({
    mutationFn: () =>
      api.createOrder({
        patient_id: patientId || null,
        new_patient: patientId ? null : newPatient,
        product_id: ordering!.id,
        product_size_id: sizeId,
        // A paired appliance is counted in sets; everything else per arch, and
        // the server adds them up rather than trusting a total sent alongside.
        ...(paired
          ? { quantity }
          : { quantity_upper: upper, quantity_lower: lower }),
        extra_teeth: extraTeeth,
        accessories: asPayload,
      }),
    // Straight into the case, which is where the scan is asked for.
    onSuccess: (order) => navigate(`/orders/${order.id}`),
  });

  /* Shelf items name nobody. Restocking IPR strips is the practice buying
     supplies, not clinical work on a person. */
  const createAccessoryOrder = useMutation({
    mutationFn: () =>
      api.createOrder({
        accessories: asPayload,
      }),
    onSuccess: (order) => navigate(`/orders/${order.id}`),
  });

  const accessoryBlocker = asPayload.length === 0 ? "Add something first." : "";

  const blocker = heldBy
    ? `Settle ${heldBy.reference} first.`
    : !sizeId
      ? "Choose a thickness."
      : !patientId && newFirst.trim().length < 2
        ? "Name the patient."
        : count < 1
          ? "Say how many you need."
          : "";

  // Arriving from the home page with ?order=<id> opens that product straight
  // away, so the strip there is a real shortcut and not just a link to a list.
  const wanted = params.get("order");
  useEffect(() => {
    if (!wanted || ordering || !products.data || heldBy) return;
    const match = products.data.find((p) => p.id === wanted);
    if (match) open(match);
    setParams({}, { replace: true });
  }, [wanted, ordering, products.data, setParams]);

  // ?tab=accessories used to open a second tab; the shelf is on this page now,
  // so the same link lands on it.
  const wantsShelf = params.get("tab") === "accessories";
  useEffect(() => {
    if (!wantsShelf || !shelf.data) return;
    // Landing, not browsing: jump there rather than glide past the range.
    requestAnimationFrame(() => scrollToId("shelf", false));
    const query = new URLSearchParams(params);
    query.delete("tab");
    setParams(query, { replace: true });
  }, [wantsShelf, shelf.data]);

  // Escape closes it, and the page behind must not scroll while it is open.
  useEffect(() => {
    if (!ordering && !orderingAccessories) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOrdering(null);
      setOrderingAccessories(false);
    }
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [ordering, orderingAccessories]);

  const range = products.data ?? [];
  const featured = useMemo(
    () =>
      FEATURED.map((code) => range.find((p) => p.code === code)).filter(
        (p): p is Product => Boolean(p),
      ),
    [range],
  );

  if (products.isLoading) {
    return (
      <main className="page page-wide stack">
        <Skeleton rows={4} variant="card" />
      </main>
    );
  }

  // Only the needs something in the range answers, so no tile leads nowhere.
  const needs = NEEDS.filter((n) => range.some((p) => n.codes.includes(p.code)));
  const shown = need === "all" ? range : range.filter((p) => needOf(p.code)?.key === need);
  const activeNeed = NEEDS.find((n) => n.key === need);

  const deliveryFact =
    delivery.data && delivery.data.amount !== "0.00"
      ? {
          b: `${rupees(delivery.data.amount)} delivery`,
          s: `Couriered to ${
            delivery.data.is_city_rate && delivery.data.city ? delivery.data.city : "your clinic"
          }, once per order`,
        }
      : { b: "Couriered to you", s: "Straight to your clinic's address" };

  const media = ordering ? galleryFor(ordering) : [];
  const shownMedia = media[Math.min(mediaAt, media.length - 1)];
  const orderingNeed = ordering ? needOf(ordering.code) : undefined;

  return (
    <main className="page page-wide shop">
      {featured.length > 0 && (
        <Spotlight
          items={featured}
          held={heldBy}
          onOpen={open}
          onBrowse={() => scrollToId("range")}
        />
      )}

      {/* Shop by need: four photographs, each a question a clinic arrives
          with. Choosing one narrows the range below and takes you to it. */}
      {needs.length > 1 && (
        <section className="shop-needs" aria-label="Shop by need">
          {needs.map((n) => {
            const names = range.filter((p) => n.codes.includes(p.code)).map((p) => p.name);
            return (
              <button
                key={n.key}
                type="button"
                className={need === n.key ? "need-tile on" : "need-tile"}
                aria-pressed={need === n.key}
                onClick={() => {
                  setNeed(need === n.key ? "all" : n.key);
                  scrollToId("range");
                }}
              >
                <img src={n.photo} alt="" loading="lazy" />
                <span className="need-go">
                  {names.length} {names.length === 1 ? "appliance" : "appliances"}
                </span>
                <b>{n.label}</b>
                <small>{names.join(" · ")}</small>
              </button>
            );
          })}
        </section>
      )}

      <section id="range" className="shop-section" aria-labelledby="range-title">
        <header className="shop-head">
          <div>
            <span className="shop-eyebrow">The range</span>
            <h2 id="range-title">{activeNeed ? activeNeed.label : "Every appliance"}</h2>
            <p>Made in our lab from an intraoral scan. No planning stage, so they are quick.</p>
          </div>
          <div className="shop-chips" role="group" aria-label="Filter by need">
            <button type="button" className={need === "all" ? "on" : ""} aria-pressed={need === "all"} onClick={() => setNeed("all")}>
              Everything <small>{range.length}</small>
            </button>
            {needs.map((n) => (
              <button
                key={n.key}
                type="button"
                className={need === n.key ? "on" : ""}
                aria-pressed={need === n.key}
                onClick={() => setNeed(n.key)}
              >
                {n.label} <small>{range.filter((p) => n.codes.includes(p.code)).length}</small>
              </button>
            ))}
          </div>
        </header>

        <div className="shop-grid">
          {shown.map((product, i) => (
            <ProductCard
              key={product.id}
              product={product}
              index={i}
              held={Boolean(heldBy)}
              onOpen={() => open(product)}
            />
          ))}
        </div>
      </section>

      <section className="shop-band" aria-labelledby="band-title">
        <figure className="band-photo">
          <img src="/products/life/ER.webp" alt="An Essix retainer being seated" loading="lazy" />
        </figure>
        <div className="band-say">
          <span className="shop-eyebrow">Why clinics order here</span>
          <h2 id="band-title">
            One scan. <em>Everything after it.</em>
          </h2>
          <ul className="band-facts">
            <li>
              <Icon name="scan" />
              <b>Made from your scan</b>
              <span>Three intraoral scans, and a bite scan where the appliance needs one.</span>
            </li>
            <li>
              <Icon name="reuse" />
              <b>Reuse a scan we hold</b>
              <span>If the patient was scanned for an earlier case, there is nothing to send.</span>
            </li>
            <li>
              <Icon name="lab" />
              <b>No planning stage</b>
              <span>No treatment plan and no simulation — straight into fabrication.</span>
            </li>
            <li>
              <Icon name="truck" />
              <b>{deliveryFact.b}</b>
              <span>{deliveryFact.s}.</span>
            </li>
          </ul>
        </div>
      </section>

      {(shelf.data?.length ?? 0) > 0 && (
        <section id="shelf" className="shop-section" aria-labelledby="shelf-title">
          <header className="shop-head">
            <div>
              <span className="shop-eyebrow">Practice stock</span>
              <h2 id="shelf-title">Add to the box</h2>
              <p>
                Nothing to make and nothing to scan. Order on their own, or with an appliance and
                they travel together for one delivery charge.
              </p>
            </div>
          </header>
          <div className="shelf">
            {shelf.data?.map((item, i) => (
              <ShelfItem
                key={item.id}
                item={item}
                index={i}
                count={basket[item.id] ?? 0}
                onChange={(n) => setCount(item.id, n)}
              />
            ))}
          </div>

          {basketLines.length > 0 && !ordering && (
            /* Only while something is in it. A permanent empty bar at the foot
               of the page is furniture. */
            <div className="basket-bar">
              <div className="basket-lines">
                {basketLines.map((line) => (
                  <span key={line.item.id}>
                    {line.item.name}
                    {line.quantity > 1 ? ` ×${line.quantity}` : ""}
                  </span>
                ))}
              </div>
              <div className="basket-right">
                <span className="basket-total">
                  {rupees(basketTotal)}
                  {shipping > 0 && <small> + {rupees(shipping)} delivery</small>}
                </span>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setBasket({})}>
                  Clear
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => setOrderingAccessories(true)}
                >
                  Order these
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* What happens after the button — the first question a doctor has
          about a product order. Numbered because it is a sequence. */}
      <section className="store-how" aria-labelledby="store-how-title">
        <h2 id="store-how-title">From scan to your clinic</h2>
        <ol>
          <li>
            <span className="store-how-n">Step 1</span>
            <h3>Order here</h3>
            <p>Choose the appliance, the patient and how many. One charge, with delivery.</p>
          </li>
          <li>
            <span className="store-how-n">Step 2</span>
            <h3>Send the scan</h3>
            <p>
              Three intraoral scans — or none, if we already hold one. A TMJ splint or
              jaw-correction appliance also needs its bite scan.
            </p>
          </li>
          <li>
            <span className="store-how-n">Step 3</span>
            <h3>Made and sent</h3>
            <p>No planning stage. We make it from the scan and courier it to you.</p>
          </li>
        </ol>
      </section>

      {ordering && createPortal(
        /* Into the body, not into the page. `.page` carries an entrance
           animation on transform with fill-mode "both", which makes it the
           containing block for position:fixed inside it. */
        <div
          className="sheet-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOrdering(null);
          }}
        >
          <div
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={`Order ${article(ordering.name)} ${ordering.name}`}
          >
            {/* A gallery of the thing being ordered, kept in view the whole time
                it is configured: the boxed shot, the appliance in use, a case
                it was used on, and the lab's catalogue card. */}
            <div className="sheet-media">
              <div className="g-main" key={shownMedia?.key}>
                {shownMedia?.node}
              </div>
              {media.length > 1 && (
                <div className="g-thumbs" role="tablist" aria-label="Pictures">
                  {media.map((m, i) => (
                    <button
                      key={m.key}
                      type="button"
                      role="tab"
                      aria-selected={i === mediaAt}
                      className={i === mediaAt ? "on" : ""}
                      onClick={() => setMediaAt(i)}
                    >
                      <img src={m.thumb} alt="" />
                      <span>{m.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="sheet-body">
              <div className="sheet-scroll">
                <header className="sheet-head">
                  <span className="sheet-thumb">
                    {SHOT[ordering.code] ? (
                      <img src={SHOT[ordering.code]} alt="" />
                    ) : (
                      <ProductImage src={ordering.image_url} code={ordering.code} name={ordering.name} ratio="1 / 1.414" />
                    )}
                  </span>
                  <div className="sheet-title">
                    {orderingNeed && <span className="shop-eyebrow">{orderingNeed.label}</span>}
                    <h2>{ordering.name}</h2>
                    <p>{BLURB[ordering.code] ?? ordering.description}</p>
                  </div>
                  <button
                    type="button"
                    className="sheet-close"
                    onClick={() => setOrdering(null)}
                    aria-label="Close"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6 6 18" />
                    </svg>
                  </button>
                </header>

                {heldBy && (
                  <p className="sheet-held">
                    <i aria-hidden="true" />
                    <span>
                      New appliance orders wait until <b>{heldBy.reference}</b> is settled —{" "}
                      {heldBy.reason}. <Link to="/orders?series=product">View it</Link>
                    </span>
                  </p>
                )}

                {ordering.has_choice_of_size && (
                  /* Chips rather than a menu: three thicknesses are a choice to
                     see all at once, with what each costs. */
                  <fieldset className="opt">
                    <legend>Thickness</legend>
                    <div className="opt-chips" role="radiogroup" aria-label="Thickness">
                      {ordering.sizes.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          role="radio"
                          aria-checked={sizeId === s.id}
                          className={sizeId === s.id ? "on" : ""}
                          onClick={() => setSizeId(s.id)}
                        >
                          <b>{s.label}</b>
                          <small>{rupees(s.price)}</small>
                        </button>
                      ))}
                    </div>
                  </fieldset>
                )}

                <fieldset className="opt">
                  <legend>Patient</legend>
                  <select
                    className="opt-select"
                    value={patientId}
                    onChange={(e) => setPatientId(e.target.value)}
                    aria-label="Patient"
                  >
                    <option value="">A patient not on file yet</option>
                    {patients.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.full_name}
                      </option>
                    ))}
                  </select>
                  {!patientId && (
                    <div className="opt-row">
                      <Field label="First name">
                        <input value={newFirst} onChange={(e) => setNewFirst(e.target.value)} />
                      </Field>
                      <Field label="Last name">
                        <input value={newLast} onChange={(e) => setNewLast(e.target.value)} />
                      </Field>
                    </div>
                  )}
                </fieldset>

                <fieldset className="opt">
                  <legend>How many</legend>
                  {paired ? (
                    /* Only ever made as an upper-and-lower pair, so there is no
                       arch to choose. */
                    <Count
                      label="Sets"
                      hint="Made as an upper and lower pair"
                      value={quantity}
                      min={1}
                      max={50}
                      onChange={setQuantity}
                    />
                  ) : (
                    <>
                      <div className="opt-row">
                        <Count label="Upper arch" value={upper} min={0} max={50} onChange={setUpper} />
                        <Count label="Lower arch" value={lower} min={0} max={50} onChange={setLower} />
                      </div>
                      <p className="opt-note">
                        {count > 0
                          ? `${count} tray${count === 1 ? "" : "s"} in total.`
                          : "Set a count against at least one arch."}
                      </p>
                    </>
                  )}
                  {Number(ordering.per_tooth_price) > 0 && (
                    <Count
                      label={`Teeth beyond the first ${ordering.included_teeth}`}
                      hint={`${rupees(ordering.per_tooth_price)} each`}
                      value={extraTeeth}
                      min={0}
                      max={32}
                      onChange={setExtraTeeth}
                    />
                  )}
                </fieldset>

                {ordering.extra_scan_label && (
                  /* Said before the order is placed, not discovered at the scan
                     stage: this appliance is built to a jaw position. */
                  <p className="sheet-alert">
                    <Icon name="scan" />
                    <span>
                      {article(ordering.name) === "an" ? "An" : "A"} {ordering.name} also needs{" "}
                      {/^[aeiou]/i.test(ordering.extra_scan_label) ? "an" : "a"}{" "}
                      <b>{ordering.extra_scan_label.toLowerCase()}</b> scan — a second bite taken
                      where the appliance will hold the jaw. You will be asked for it with the
                      other three.
                    </span>
                  </p>
                )}

                {/* The moment a clinic is ordering a retainer is the moment it
                    remembers it is low on cases and cleanser, and a second
                    order means a second delivery charge. */}
                {(shelf.data?.length ?? 0) > 0 && (
                  <details className="addons" open={basketLines.length > 0}>
                    <summary>
                      Anything else in the same box?
                      {basketLines.length > 0 && (
                        <span className="addons-count">
                          {basketLines.length} added · {rupees(basketTotal)}
                        </span>
                      )}
                    </summary>
                    <div className="addon-list">
                      {shelf.data?.map((item) => (
                        <AccessoryRow
                          key={item.id}
                          item={item}
                          count={basket[item.id] ?? 0}
                          onChange={(n) => setCount(item.id, n)}
                        />
                      ))}
                    </div>
                  </details>
                )}
              </div>

              {/* The bill and the button never scroll away. */}
              <footer className="sheet-foot">
                {goods > 0 && (
                  <div className="sheet-lines">
                    <div>
                      <span>
                        {ordering.name}
                        {size && ordering.has_choice_of_size ? `, ${size.label}` : ""} —{" "}
                        {paired
                          ? `${quantity} set${quantity === 1 ? "" : "s"}`
                          : `${count} tray${count === 1 ? "" : "s"}`}
                      </span>
                      <span>{rupees(goods)}</span>
                    </div>
                    {basketLines.map((line) => (
                      <div key={line.item.id}>
                        <span>
                          {line.item.name}
                          {line.quantity > 1 ? ` ×${line.quantity}` : ""}
                        </span>
                        <span>{rupees(Number(line.item.price) * line.quantity)}</span>
                      </div>
                    ))}
                    <div>
                      <span>
                        Delivery
                        {delivery.data?.is_city_rate && delivery.data.city
                          ? ` to ${delivery.data.city}`
                          : ""}
                      </span>
                      <span>{delivery.isLoading ? "…" : shipping > 0 ? rupees(shipping) : "Free"}</span>
                    </div>
                  </div>
                )}

                <ErrorText error={create.error} />

                <div className="sheet-go">
                  <div className="sheet-total">
                    <small>{goods > 0 ? "Total, one charge" : priced(ordering)}</small>
                    <b>{goods > 0 ? (delivery.isLoading ? "…" : rupees(total)) : "—"}</b>
                    {/* A grey button that will not say why is the thing that
                        makes a form feel broken. */}
                    {blocker && <span className="sheet-why">{blocker}</span>}
                  </div>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={Boolean(blocker) || create.isPending}
                    onClick={() => create.mutate()}
                  >
                    {create.isPending ? "Creating…" : "Start this order"}
                  </button>
                </div>
              </footer>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {orderingAccessories && createPortal(
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOrderingAccessories(false);
          }}
        >
          <div className="modal stack-sm" role="dialog" aria-modal="true" aria-label="Order accessories">
            <div className="row-between">
              <h2 style={{ margin: 0 }}>Order accessories</h2>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => setOrderingAccessories(false)}
              >
                Cancel
              </button>
            </div>

            <Banner tone="ok">
              <div className="order-total">
                {basketLines.map((line) => (
                  <div className="order-total-line" key={line.item.id}>
                    <span>
                      {line.item.name}
                      {line.quantity > 1 ? ` ×${line.quantity}` : ""}
                    </span>
                    <span>{rupees(Number(line.item.price) * line.quantity)}</span>
                  </div>
                ))}
                <div className="order-total-line">
                  <span>
                    Delivery
                    {delivery.data?.is_city_rate && delivery.data.city
                      ? ` to ${delivery.data.city}`
                      : ""}
                  </span>
                  <span>{rupees(shipping)}</span>
                </div>
                <div className="order-total-line grand">
                  <span>Total</span>
                  <b>{rupees(basketTotal + shipping)}</b>
                </div>
                <p className="muted" style={{ margin: 0 }}>
                  Nothing is made for these, so no scan or photographs are asked for — they go
                  straight to packing.
                </p>
              </div>
            </Banner>

            <ErrorText error={createAccessoryOrder.error} />
            <div className="row-between">
              <span className="dim">{accessoryBlocker}</span>
              <button
                type="button"
                className="btn-primary"
                disabled={Boolean(accessoryBlocker) || createAccessoryOrder.isPending}
                onClick={() => createAccessoryOrder.mutate()}
              >
                {createAccessoryOrder.isPending ? "Placing…" : "Place this order"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </main>
  );
}

/** The pictures the order sheet can show for a product, in the order a buyer
    wants them: the thing, the thing in use, what it did, the lab's card. */
function galleryFor(p: Product): { key: string; label: string; thumb: string; node: ReactNode }[] {
  const out: { key: string; label: string; thumb: string; node: ReactNode }[] = [];
  if (SHOT[p.code]) {
    out.push({
      key: "shot",
      label: "The appliance",
      thumb: SHOT[p.code],
      node: <img className="g-shot" src={SHOT[p.code]} alt={p.name} />,
    });
  }
  if (LIFE[p.code]) {
    out.push({
      key: "life",
      label: "In use",
      thumb: LIFE[p.code],
      node: <img className="g-photo" src={LIFE[p.code]} alt={`${p.name} in use`} />,
    });
  }
  if (RESULTS[p.code]) {
    const [before, after] = RESULTS[p.code];
    out.push({
      key: "results",
      label: "Before and after",
      thumb: after,
      node: (
        <div className="g-ba">
          <figure>
            <img src={before} alt="Before" />
            <figcaption>Before</figcaption>
          </figure>
          <figure>
            <img src={after} alt="After" />
            <figcaption>After</figcaption>
          </figure>
        </div>
      ),
    });
  }
  if (p.code === "NG") {
    out.push({
      key: "wear",
      label: "What it prevents",
      thumb: "/products/ba/NG-worn.webp",
      node: <img className="g-photo" src="/products/ba/NG-worn.webp" alt="Teeth worn flat by grinding" />,
    });
  }
  if (p.image_url) {
    out.push({
      key: "card",
      label: "Catalogue card",
      thumb: p.image_url,
      node: <img className="g-card" src={p.image_url} alt={`${p.name} catalogue card`} />,
    });
  }
  if (out.length === 0) {
    out.push({
      key: "mark",
      label: p.name,
      thumb: "",
      node: <ProductImage src="" code={p.code} name={p.name} ratio="4 / 5" />,
    });
  }
  return out;
}

/** The door: the range turning one appliance at a time, each lit on its own
    stage with the line a doctor could say to the patient about it. */
function Spotlight({
  items,
  held,
  onOpen,
  onBrowse,
}: {
  items: Product[];
  held: Hold | null;
  onOpen: (p: Product) => void;
  onBrowse: () => void;
}) {
  const [at, setAt] = useState(0);
  const [paused, setPaused] = useState(false);
  // No turning for anyone who has asked the system for less motion.
  const still = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  useEffect(() => {
    if (paused || still || items.length < 2) return;
    const timer = window.setTimeout(() => setAt((i) => (i + 1) % items.length), 6500);
    return () => window.clearTimeout(timer);
  }, [at, paused, still, items.length]);

  const p = items[at % items.length];
  const need = needOf(p.code);

  return (
    <section
      className={paused ? "spot paused" : "spot"}
      aria-roledescription="carousel"
      aria-label="Featured appliances"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {held && (
        /* Said once, quietly, where the buying starts — not as a banner across
           the whole shop. The sheet repeats it where it matters. */
        <p className="spot-hold">
          <i aria-hidden="true" />
          <span>
            <b>New appliance orders are paused</b> until {held.reference} is settled.
          </span>
          <Link to="/orders?series=product">View it</Link>
        </p>
      )}

      <div className="spot-say" key={`say-${p.id}`}>
        <span className="spot-kicker">
          {need ? need.label : "3D Align"} · {p.name}
        </span>
        <h1>{TAGLINE[p.code] ?? p.name}</h1>
        <p className="spot-blurb">{BLURB[p.code] ?? p.description}</p>
        <div className="spot-buy">
          <span className="spot-price">
            <small>{variesInPrice(p) ? "From" : "Price"}</small>
            <b>{rupees(from(p))}</b>
          </span>
          <button type="button" className="spot-cta" onClick={() => onOpen(p)}>
            {held ? "See details" : "Order now"}
            <Icon name="arrow" />
          </button>
          <button type="button" className="spot-more" onClick={onBrowse}>
            See the whole range
          </button>
        </div>
      </div>

      <div className="spot-stage" key={`stage-${p.id}`} aria-hidden="true">
        <span className="spot-glow" />
        <span className="spot-ring" />
        <img className="spot-shot" src={SHOT[p.code]} alt="" />
        {LIFE[p.code] && (
          <figure className="spot-life">
            <img src={LIFE[p.code]} alt="" />
            <figcaption>In use</figcaption>
          </figure>
        )}
        {(p.both_arches || p.extra_scan_label || p.has_choice_of_size) && (
          <span className="spot-tags">
            {p.has_choice_of_size && (
              <span className="spot-tag">{p.sizes.map((s) => s.label).join(" · ")}</span>
            )}
            {p.both_arches && <span className="spot-tag">Upper + lower pair</span>}
            {p.extra_scan_label && (
              <span className="spot-tag">+ {p.extra_scan_label.toLowerCase()} scan</span>
            )}
          </span>
        )}
      </div>

      <div className="spot-rail" role="tablist" aria-label="Choose an appliance">
        {items.map((q, i) => (
          <button
            key={q.id}
            type="button"
            role="tab"
            aria-selected={i === at}
            className={i === at ? "on" : ""}
            onClick={() => setAt(i)}
          >
            <img src={SHOT[q.code]} alt="" />
            <span>{q.name}</span>
            <i className="spot-bar" aria-hidden="true">
              {i === at && <i key={at} />}
            </i>
          </button>
        ))}
      </div>
    </section>
  );
}

/** One appliance in the range, lit on its own stage. The whole card is the
    button — there is one thing to do with it. */
function ProductCard({
  product,
  index,
  held,
  onOpen,
}: {
  product: Product;
  index: number;
  held: boolean;
  onOpen: () => void;
}) {
  const need = needOf(product.code);
  const shot = SHOT[product.code];
  const photo = !shot ? LIFE[product.code] : undefined;
  return (
    <article className="pc" style={{ "--i": index } as CSSProperties}>
      <button type="button" className="pc-hit" onClick={onOpen}>
        <span className={`pc-stage${photo ? " photo" : ""}${!shot && !photo ? " bare" : ""}`}>
          {shot ? (
            <img className="pc-shot" src={shot} alt="" loading="lazy" />
          ) : photo ? (
            <img className="pc-photo" src={photo} alt="" loading="lazy" />
          ) : (
            <ProductImage src="" code={product.code} name={product.name} ratio="4 / 5" />
          )}
          <span className="pc-flags">
            {need && <span className="pc-flag need">{need.label}</span>}
            {product.both_arches && <span className="pc-flag">Pair</span>}
            {product.extra_scan_label && <span className="pc-flag">+ bite scan</span>}
          </span>
          <span className="pc-quick" aria-hidden="true">
            {held ? "See details" : "Order"}
            <Icon name="arrow" />
          </span>
        </span>
        <span className="pc-info">
          <span className="pc-name">{product.name}</span>
          <span className="pc-blurb">{BLURB[product.code] ?? product.description}</span>
          <span className="pc-foot">
            <span className="pc-price">{priced(product)}</span>
            <span className="pc-sizes">
              {product.has_choice_of_size ? product.sizes.map((s) => s.label).join(" · ") : "One size"}
            </span>
          </span>
        </span>
      </button>
    </article>
  );
}

/** A shelf item: mark, name, price, and the control that orders it. */
function ShelfItem({
  item,
  index,
  count,
  onChange,
}: {
  item: AccessoryType;
  index: number;
  count: number;
  onChange: (count: number) => void;
}) {
  return (
    <article className={`shelf-item${count > 0 ? " picked" : ""}`} style={{ "--i": index } as CSSProperties}>
      <span className="shelf-mark">
        <ProductImage src={item.image_url} code={item.code} name={item.name} ratio="1 / 1" />
      </span>
      <div className="shelf-say">
        <h3>{item.name}</h3>
        <p>{item.description}</p>
        <b className="shelf-price">{rupees(item.price)}</b>
      </div>
      {count === 0 ? (
        <button type="button" className="shelf-add" onClick={() => onChange(1)} aria-label={`Add ${item.name}`}>
          Add
        </button>
      ) : (
        <Stepper item={item} count={count} onChange={onChange} />
      )}
    </article>
  );
}

/** One shelf item as a compact row, for the add-on step inside the sheet. */
function AccessoryRow({
  item,
  count,
  onChange,
}: {
  item: AccessoryType;
  count: number;
  onChange: (count: number) => void;
}) {
  return (
    <div className={`addon-row${count > 0 ? " picked" : ""}`}>
      <div className="addon-name">
        <b>{item.name}</b>
        <small>{item.description}</small>
      </div>
      <span className="addon-price">{rupees(item.price)}</span>
      <Stepper item={item} count={count} onChange={onChange} />
    </div>
  );
}

function Stepper({
  item,
  count,
  onChange,
}: {
  item: AccessoryType;
  count: number;
  onChange: (count: number) => void;
}) {
  return (
    <div className="stepper">
      <button
        type="button"
        onClick={() => onChange(count - 1)}
        disabled={count === 0}
        aria-label={`One fewer ${item.name}`}
      >
        −
      </button>
      <input
        type="number"
        min={0}
        max={200}
        value={count}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        aria-label={`How many ${item.name}`}
      />
      <button
        type="button"
        onClick={() => onChange(count + 1)}
        aria-label={`One more ${item.name}`}
      >
        +
      </button>
    </div>
  );
}

/** A labelled counter for the order sheet, clamped at both ends so a typed
    value cannot leave the range the server accepts. */
function Count({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div className="count">
      <span className="count-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <div className="stepper">
        <button type="button" onClick={() => onChange(clamp(value - 1))} disabled={value <= min} aria-label={`Fewer — ${label}`}>
          −
        </button>
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(clamp(Number(e.target.value) || min))}
          aria-label={label}
        />
        <button type="button" onClick={() => onChange(clamp(value + 1))} disabled={value >= max} aria-label={`More — ${label}`}>
          +
        </button>
      </div>
    </div>
  );
}
