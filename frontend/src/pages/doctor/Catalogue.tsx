/* The 3D Align store.
 *
 * What the lab makes besides aligners, and the stock a practice keeps on the
 * shelf. It used to be laid out like a marketplace listing — a grid of white
 * boxes, each with a price table and a buy button — which is the wrong model
 * for ten appliances a doctor already half-knows. This is a store front: the
 * lab's own catalogue cards carry the page, the words under them are few, and
 * ordering happens in a sheet that opens beside the product rather than in a
 * form bolted under a grid.
 *
 * The rules underneath are unchanged — how an appliance is counted, what a
 * paired appliance asks, the extra bite scan, the payment hold, the delivery
 * charge, accessories as practice stock with no patient.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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

/** "₹700" when every thickness costs the same; "from ₹500" only when they do not. */
function priced(product: Product): string {
  const prices = new Set(product.sizes.map((s) => Number(s.price)));
  return prices.size > 1 ? `from ${rupees(from(product))}` : rupees(from(product));
}

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
  JA: "Appliance for mandibular advancement.",
};

/* What a doctor is reaching for, rather than what the lab calls it. A clinic
   finishing a case wants retention; one with a grinding patient wants a guard.
   Grouping by need lets ten products be browsed as four questions. */
type Need = "retention" | "protection" | "joint" | "whitening";

const NEEDS: { key: Need; label: string; codes: string[] }[] = [
  { key: "retention", label: "Retention", codes: ["ER", "GER", "PR"] },
  { key: "protection", label: "Protection", codes: ["NG", "SG"] },
  { key: "joint", label: "Joint & bite", codes: ["TMJ", "JA", "ABP", "PBP"] },
  { key: "whitening", label: "Whitening", codes: ["LEACH"] },
];

function needOf(code: string) {
  return NEEDS.find((n) => n.codes.includes(code));
}

/* Small line icons for the promises in the hero. Drawn inline: four paths do
   not justify an icon library. */
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
  box: (
    <>
      <path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5z" />
      <path d="M4 7.5 12 11l8-3.5M12 11v9" />
    </>
  ),
  clinic: (
    <>
      <path d="M4 20V9l8-5 8 5v11" />
      <path d="M10 20v-5h4v5M12 8v4M10 10h4" />
    </>
  ),
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON[name]}
    </svg>
  );
}

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
     next. Told here rather than only when the button is pressed — a form that
     fills in and then refuses has wasted the clinic's time. Accessories are
     never held: they are paid before they leave the building. */
  const hold = useQuery({ queryKey: ["ordering-hold"], queryFn: api.orderingHold });
  const heldBy = hold.data && !hold.data.can_order_products ? hold.data : null;

  /* Accessories are counted, not chosen once: a clinic restocking asks for two
     strips, a cleanser and five cases in one breath. Held as code -> count so
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
  /* Two rooms, and the accessory one is addressable — so Home can point
     straight at it rather than at the top of a page they then have to scroll. */
  const tab = params.get("tab") === "accessories" ? "accessories" : "appliances";
  function showTab(next: string) {
    const query = new URLSearchParams(params);
    if (next === "accessories") query.set("tab", "accessories");
    else query.delete("tab");
    setParams(query, { replace: true });
  }
  const [ordering, setOrdering] = useState<Product | null>(null);
  const [patientId, setPatientId] = useState("");
  // Two fields, as everywhere else. This form was still sending one after the
  // split and every order for a new patient was refused.
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
    // Straight into the case, which is where the records and the scan are asked
    // for — the same path every other order takes.
    onSuccess: (order) => navigate(`/orders/${order.id}`),
  });

  /* Shelf items name nobody. Restocking IPR strips is the practice buying
     supplies, not clinical work on a person — asking which patient a box of
     retainer cases is for made the clinic invent one. */
  const createAccessoryOrder = useMutation({
    mutationFn: () =>
      api.createOrder({
        accessories: asPayload,
      }),
    onSuccess: (order) => navigate(`/orders/${order.id}`),
  });

  /* Restocking is the practice buying supplies. Nothing else is asked. */
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
    // The query is consumed: a refresh should not reopen a sheet the clinic
    // has already closed.
    setParams({}, { replace: true });
  }, [wanted, ordering, products.data, setParams]);

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

  if (products.isLoading) {
    return (
      <main className="page page-wide stack">
        <Skeleton rows={4} variant="card" />
      </main>
    );
  }

  const range = products.data ?? [];
  // Only the needs something in the range answers, so no chip leads nowhere.
  const needs = NEEDS.filter((n) => range.some((p) => n.codes.includes(p.code)));
  const shown = need === "all" ? range : range.filter((p) => needOf(p.code)?.key === need);

  const deliveryPromise =
    delivery.data && delivery.data.amount !== "0.00"
      ? {
          b: `${rupees(delivery.data.amount)} delivery`,
          s: `Courier to ${
            delivery.data.is_city_rate && delivery.data.city ? delivery.data.city : "your clinic"
          }, per order`,
        }
      : delivery.data
        ? { b: "No delivery charge", s: "To your clinic's address" }
        : { b: "Couriered", s: "To your clinic" };

  const promises =
    tab === "appliances"
      ? [
          { icon: "scan", b: "Scan only", s: "No planning or simulation stage" },
          { icon: "reuse", b: "Reuse a scan", s: "If we already hold one for the patient" },
          { icon: "truck", ...deliveryPromise },
        ]
      : [
          { icon: "box", b: "Nothing made", s: "No scan, no photographs" },
          { icon: "truck", b: "Packed and sent", s: "As soon as it is ordered" },
          { icon: "clinic", b: "Practice stock", s: "No patient to name" },
        ];

  const orderingNeed = ordering ? needOf(ordering.code) : undefined;

  return (
    <main className="page page-wide store">
      {/* The door. Compact on purpose — the products are the show, and a hero
          that pushes them below the fold is a hero in the way. */}
      <header className="store-hero">
        <div className="store-hero-say">
          <span className="store-eyebrow">3D Align · The range</span>
          {tab === "appliances" ? (
            <h1>
              Made from <em>one scan.</em>
            </h1>
          ) : (
            <h1>
              The practice <em>shelf.</em>
            </h1>
          )}
          <p>
            {tab === "appliances"
              ? "Retainers, splints, guards and trays, built from an intraoral scan. No treatment plan and no simulation, so they are quick."
              : "Stock for the clinic. Order it on its own, or add it to an appliance and it travels in the same box."}
          </p>
        </div>
        <ul className="store-promise">
          {promises.map((p) => (
            <li key={p.b}>
              <Icon name={p.icon} />
              <b>{p.b}</b>
              <span>{p.s}</span>
            </li>
          ))}
        </ul>
      </header>

      <nav className="store-bar" aria-label="Browse">
        <div className="store-switch" role="tablist" aria-label="What to order">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "appliances"}
            className={tab === "appliances" ? "on" : ""}
            onClick={() => showTab("appliances")}
          >
            Appliances <small>{range.length}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "accessories"}
            className={tab === "accessories" ? "on" : ""}
            onClick={() => showTab("accessories")}
          >
            Accessories
            {basketLines.length > 0 ? (
              <small className="lit" title="In your basket">{basketLines.length}</small>
            ) : (
              <small>{shelf.data?.length ?? 0}</small>
            )}
          </button>
        </div>

        {tab === "appliances" && needs.length > 1 && (
          <div className="store-needs" role="group" aria-label="Shop by need">
            <button type="button" className={need === "all" ? "on" : ""} aria-pressed={need === "all"} onClick={() => setNeed("all")}>
              Everything
            </button>
            {needs.map((n) => (
              <button
                key={n.key}
                type="button"
                className={need === n.key ? "on" : ""}
                aria-pressed={need === n.key}
                onClick={() => setNeed(n.key)}
              >
                {n.label}
              </button>
            ))}
          </div>
        )}
      </nav>

      {tab === "appliances" && heldBy && (
        <Banner tone="warn">
          <div>
            <b>{heldBy.reference} has been delivered</b> and {heldBy.reason}. Appliances are
            made and shipped before they are paid for, so we ask that one is settled before
            the next is started.{" "}
            <Link to={`/orders?series=product`}>See that order</Link>. Accessories can
            still be ordered.
          </div>
        </Banner>
      )}

      {tab === "appliances" && (
        <>
          <div className="store-grid">
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

          {/* The whole journey in three lines, because the first question a
              doctor has about a product order is what happens after the button.
              Numbered because it is a sequence. */}
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
        </>
      )}

      {tab === "accessories" && (shelf.data?.length ?? 0) > 0 && (
        <section className="stack-sm">
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

      {ordering && createPortal(
        /* Into the body, not into the page. `.page` carries an entrance
           animation on transform with fill-mode "both", which keeps it filling
           for good — and an element with a filling transform animation becomes
           the containing block for position:fixed inside it. */
        <div
          className="sheet-backdrop"
          role="presentation"
          onClick={(e) => {
            // Only a click on the backdrop itself, not one that bubbled up
            // out of the sheet.
            if (e.target === e.currentTarget) setOrdering(null);
          }}
        >
          <div
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={`Order ${article(ordering.name)} ${ordering.name}`}
          >
            {/* The card, large, beside the form — the thing being ordered stays
                in view the whole time it is being configured. */}
            <div className="sheet-media">
              <ProductImage
                src={ordering.image_url}
                code={ordering.code}
                name={ordering.name}
                ratio="1 / 1.414"
              />
            </div>

            <div className="sheet-body">
              <div className="sheet-scroll">
                <header className="sheet-head">
                  <span className="sheet-thumb">
                    <ProductImage
                      src={ordering.image_url}
                      code={ordering.code}
                      name={ordering.name}
                      ratio="1 / 1.414"
                    />
                  </span>
                  <div className="sheet-title">
                    {orderingNeed && <span className="store-need">{orderingNeed.label}</span>}
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

                {ordering.has_choice_of_size && (
                  /* Chips rather than a menu: three thicknesses are a choice to
                     see all at once, with what each costs, not to open and read. */
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
                       arch to choose — saying so is more use than a control that
                       offers a choice the appliance does not have. */
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
                     stage: this appliance is built to a jaw position, and the lab
                     cannot make it from the ordinary three scans. */
                  <p className="sheet-alert">
                    <Icon name="scan" />
                    <span>
                      {article(ordering.name) === "an" ? "An" : "A"} {ordering.name} also
                      needs {/^[aeiou]/i.test(ordering.extra_scan_label) ? "an" : "a"}{" "}
                      <b>{ordering.extra_scan_label.toLowerCase()}</b> scan — a second bite taken
                      where the appliance will hold the jaw. You will be asked for it with the
                      other three.
                    </span>
                  </p>
                )}

                {/* Asked here rather than left to be discovered on the shelf:
                    the moment a clinic is ordering a retainer is the moment it
                    remembers it is low on cases and cleanser, and a second order
                    means a second delivery charge. */}
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

              {/* The bill and the button never scroll away: whatever is being
                  changed above, the total it comes to is always in sight. */}
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

/** One product in the window: the catalogue card, then a name, a line and a
    price. The whole card is the button — there is one thing to do with it. */
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
  return (
    <article className="store-card" style={{ "--i": index } as CSSProperties}>
      <button type="button" className="store-card-hit" onClick={onOpen}>
        <span className="store-media">
          <ProductImage src={product.image_url} code={product.code} name={product.name} ratio="1 / 1.414" />
          {(product.both_arches || product.extra_scan_label) && (
            /* The two things that make an appliance order differently, said on
               the card rather than met halfway through the form. */
            <span className="store-flags">
              {product.both_arches && <span className="store-flag">Upper + lower pair</span>}
              {product.extra_scan_label && (
                <span className="store-flag">+ {product.extra_scan_label.toLowerCase()} scan</span>
              )}
            </span>
          )}
          <span className="store-quick" aria-hidden="true">
            {held ? "See details" : "Order this"}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </span>
        </span>
        <span className="store-info">
          {need && <span className="store-need">{need.label}</span>}
          <span className="store-name">{product.name}</span>
          <span className="store-blurb">{BLURB[product.code] ?? product.description}</span>
          <span className="store-foot">
            <span className="store-price">{priced(product)}</span>
            <span className="store-sizes">
              {product.has_choice_of_size ? product.sizes.map((s) => s.label).join(" · ") : "One size"}
            </span>
          </span>
        </span>
      </button>
    </article>
  );
}

/** A shelf item: mark, name, price, and the control that orders it. Nothing
    opens — a clinic ordering five cases should not have to open anything. */
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

/** One shelf item as a compact row, for the add-on step inside the sheet where
    there is no room for pictures. */
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

/** A labelled counter for the order sheet — how many of an arch, how many
    sets, how many extra teeth. Clamped at both ends so a typed value cannot
    leave the range the server accepts. */
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
