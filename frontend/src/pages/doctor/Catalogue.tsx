/* What 3D Align makes besides aligners.

   A doctor finishing a case wants a retainer, and until now the only way to ask
   for one was a dropdown buried in step two of the aligner intake — which is to
   say, no way at all. This is the shop front: what exists, what it costs, and
   one button to order it for a patient the clinic already has on file. */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
     the same basket serves the shelf below and the add-on step in the order
     dialog above it. */
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [orderingAccessories, setOrderingAccessories] = useState(false);


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
  /* Accessories used to live below ten appliance cards, which meant a clinic
     restocking IPR strips scrolled past the entire range to reach them. Two
     tabs instead, and the accessory one is addressable — so Home can point
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
  const [newPatientName, setNewPatientName] = useState("");
  const [sizeId, setSizeId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [extraTeeth, setExtraTeeth] = useState(0);

  function open(product: Product) {
    setOrdering(product);
    // A product with one form is settled the moment it is chosen.
    setSizeId(product.has_choice_of_size ? "" : product.sizes[0]?.id ?? "");
    setQuantity(1);
    setExtraTeeth(0);
  }

  const size = ordering?.sizes.find((s) => s.id === sizeId) ?? null;
  const goods = ordering && size
    ? (Number(size.price) + Number(ordering.per_tooth_price) * extraTeeth) * quantity
    : 0;
  const shipping = Number(delivery.data?.amount ?? 0);
  const total = goods + basketTotal + shipping;

  const create = useMutation({
    mutationFn: () =>
      api.createOrder({
        patient_id: patientId || null,
        new_patient: patientId ? null : { full_name: newPatientName },
        product_id: ordering!.id,
        product_size_id: sizeId,
        quantity,
        extra_teeth: extraTeeth,
        accessories: asPayload,
      }),
    // Straight into the case, which is where the records and the scan are asked
    // for — the same path every other order takes.
    onSuccess: (order) => navigate(`/orders/${order.id}`),
  });

  /* An accessory order names a patient the same way every other order does —
     the lab ships to a clinic, but the case still belongs to someone. */
  const createAccessoryOrder = useMutation({
    mutationFn: () =>
      api.createOrder({
        patient_id: patientId || null,
        new_patient:
          !patientId && newPatientName.trim().length >= 2
            ? { full_name: newPatientName }
            : null,
        accessories: asPayload,
      }),
    onSuccess: (order) => navigate(`/orders/${order.id}`),
  });

  /* Restocking is the practice buying supplies, so nobody has to be named.
     A clinic that wants the order filed against a case still can. */
  const accessoryBlocker = asPayload.length === 0 ? "Add something first." : "";

  const blocker = !sizeId
    ? "Choose a thickness."
    : !patientId && newPatientName.trim().length < 2
      ? "Name the patient."
      : "";

  // Arriving from the home page with ?order=<id> opens that product straight
  // away, so the strip there is a real shortcut and not just a link to a list.
  const wanted = params.get("order");
  useEffect(() => {
    if (!wanted || ordering || !products.data || heldBy) return;
    const match = products.data.find((p) => p.id === wanted);
    if (match) open(match);
    // The query is consumed: a refresh should not reopen a dialog the clinic
    // has already closed.
    setParams({}, { replace: true });
  }, [wanted, ordering, products.data, setParams]);

  // Escape closes it, and the page behind must not scroll while it is open.
  useEffect(() => {
    if (!ordering) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOrdering(null);
    }
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [ordering]);

  if (products.isLoading) {
    return (
      <main className="page stack">
        <Skeleton rows={4} variant="card" />
      </main>
    );
  }

  return (
    <main className="page stack">
      <div>
        <h1>{tab === "accessories" ? "Accessories" : "Orthodontic Aligner Integrated Appliances"}</h1>
        <p className="muted">
          {tab === "accessories"
            ? "Stock items — nothing is made and no scan is needed, so these ship as soon as they are packed. Order them on their own, or add them to an appliance."
            : "Made from an intraoral scan — no treatment plan or simulation stage, so they are quick. If we already hold a scan for the patient, you can reuse it rather than taking another."}
        </p>
        {/* Said once at the top and again on the order itself. An aligner case
            can be started without meeting a delivery cost; this cannot. */}
        {tab === "appliances" && delivery.data && delivery.data.amount !== "0.00" && (
          <p className="muted">
            Prices exclude delivery. Courier to{" "}
            {delivery.data.is_city_rate && delivery.data.city ? delivery.data.city : "your address"}{" "}
            is <b>{rupees(delivery.data.amount)}</b> per order, charged with the product.
          </p>
        )}
      </div>

      <div className="seg" role="tablist" aria-label="What to order">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "appliances"}
          className={tab === "appliances" ? "active" : ""}
          onClick={() => showTab("appliances")}
        >
          Appliances
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "accessories"}
          className={tab === "accessories" ? "active" : ""}
          onClick={() => showTab("accessories")}
        >
          Accessories
          {basketLines.length > 0 && <span className="seg-count">{basketLines.length}</span>}
        </button>
      </div>

      {tab === "appliances" && heldBy && (
        <Banner tone="warn">
          <div>
            <b>{heldBy.reference} has been delivered</b> and {heldBy.reason}. Appliances are
            made and shipped before they are paid for, so we ask that one is settled before
            the next is started.{" "}
            <Link to={`/orders?series=product`}>See that order</Link>. Accessories below can
            still be ordered.
          </div>
        </Banner>
      )}

      {tab === "appliances" && (
      <div className="catalogue-grid">
        {products.data?.map((product) => (
          <article key={product.id} className="product-card">
            <ProductImage src={product.image_url} code={product.code} name={product.name} />

            <div className="product-body">
              <h3>{product.name}</h3>
              <p className="muted">{BLURB[product.code] ?? product.description}</p>

              <ul className="product-sizes">
                {product.sizes.map((s) => (
                  <li key={s.id}>
                    <span>{product.has_choice_of_size ? s.label : "One size"}</span>
                    <b>{rupees(s.price)}</b>
                  </li>
                ))}
              </ul>

              {Number(product.per_tooth_price) > 0 && (
                <p className="dim">
                  Includes {product.included_teeth} pontic
                  {product.included_teeth === 1 ? "" : "s"} — {rupees(product.per_tooth_price)} per
                  extra tooth.
                </p>
              )}
            </div>

            <footer>
              <span className="product-from">
                <small>from</small>
                {rupees(from(product))}
              </span>
              <button
                type="button"
                className="btn-primary"
                disabled={Boolean(heldBy)}
                title={heldBy ? `${heldBy.reference} is still open — ${heldBy.reason}.` : undefined}
                onClick={() => open(product)}
              >
                {heldBy ? "Settle first" : "Order this"}
              </button>
            </footer>
          </article>
        ))}
      </div>
      )}

      {tab === "accessories" && (shelf.data?.length ?? 0) > 0 && (
        <section className="stack-sm">
          <div className="catalogue-grid">
            {shelf.data?.map((item) => (
              <AccessoryCard
                key={item.id}
                item={item}
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
           the containing block for position:fixed inside it. The backdrop was
           therefore sizing to the page rather than the viewport, and centring
           the dialog in a very tall box put it near the bottom. */
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            // Only a click on the backdrop itself, not one that bubbled up
            // out of the dialog.
            if (e.target === e.currentTarget) setOrdering(null);
          }}
        >
        <div
          className="modal stack-sm"
          role="dialog"
          aria-modal="true"
          aria-label={`Order ${article(ordering.name)} ${ordering.name}`}
        >
          <div className="row-between">
            <h2 style={{ margin: 0 }}>Order {article(ordering.name)} {ordering.name}</h2>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setOrdering(null)}>
              Cancel
            </button>
          </div>

          <div className="grid-2">
            <Field label="Patient">
              <select
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
              >
                <option value="">A patient not on file yet</option>
                {patients.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name}
                  </option>
                ))}
              </select>
            </Field>

            {!patientId && (
              <Field label="Patient's full name">
                <input
                  value={newPatientName}
                  onChange={(e) => setNewPatientName(e.target.value)}
                  placeholder="As it should appear on the case"
                />
              </Field>
            )}

            {ordering.has_choice_of_size && (
              <Field label="Thickness">
                <select value={sizeId} onChange={(e) => setSizeId(e.target.value)}>
                  <option value="">Choose…</option>
                  {ordering.sizes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} — {rupees(s.price)}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field label="How many sets?">
              <input
                type="number"
                min={1}
                max={50}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
              />
            </Field>

            {Number(ordering.per_tooth_price) > 0 && (
              <Field
                label={`Teeth beyond the first ${ordering.included_teeth}`}
                hint={`${rupees(ordering.per_tooth_price)} each.`}
              >
                <input
                  type="number"
                  min={0}
                  max={32}
                  value={extraTeeth}
                  onChange={(e) => setExtraTeeth(Math.max(0, Number(e.target.value) || 0))}
                />
              </Field>
            )}
          </div>

          {/* Asked here rather than left to be discovered on the shelf below:
              the moment a clinic is ordering a retainer is the moment it
              remembers it is low on cases and cleanser, and a second order
              means a second delivery charge. */}
          {(shelf.data?.length ?? 0) > 0 && (
            <details className="addons" open={basketLines.length > 0}>
              <summary>
                Anything else with it?
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

          {goods > 0 && (
            <Banner tone="ok">
              <div className="order-total">
                <div className="order-total-line">
                  <span>
                    {quantity} set{quantity === 1 ? "" : "s"}
                  </span>
                  <span>{rupees(goods)}</span>
                </div>
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
                  <span>{delivery.isLoading ? "…" : rupees(shipping)}</span>
                </div>
                <div className="order-total-line grand">
                  <span>Total</span>
                  <b>{delivery.isLoading ? "…" : rupees(total)}</b>
                </div>
                <p className="muted" style={{ margin: 0 }}>
                  {shipping > 0
                    ? "Payable in one charge. The scan is the only thing we need — no photographs, no planning stage."
                    : "Delivery is not charged to your address. The scan is the only thing we need."}
                </p>
              </div>
            </Banner>
          )}

          <ErrorText error={create.error} />
          <div className="row-between">
            {/* A grey button that will not say why is the thing that makes a
                form feel broken. */}
            <span className="dim">{blocker}</span>
            <button
              type="button"
              className="btn-primary"
              disabled={Boolean(blocker) || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Creating…" : "Start this order"}
            </button>
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

            <Field
              label="For a patient?"
              hint="Optional — leave it as practice stock if these are for the shelf."
            >
              <select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
                <option value="">Practice stock — no patient</option>
                {patients.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name}
                  </option>
                ))}
              </select>
            </Field>

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

/** A shelf tile: picture, name, price, and the stepper that orders it. The
    stepper is the whole control — a clinic ordering five cases should not have
    to open anything to do it. */
function AccessoryCard({
  item,
  count,
  onChange,
}: {
  item: AccessoryType;
  count: number;
  onChange: (count: number) => void;
}) {
  return (
    <article className={`product-card shelf-card${count > 0 ? " picked" : ""}`}>
      <ProductImage src={item.image_url} code={item.code} name={item.name} ratio="16 / 10" />
      <div className="product-body">
        <h3>{item.name}</h3>
        <p className="muted">{item.description}</p>
      </div>
      <footer>
        <span className="product-from">{rupees(item.price)}</span>
        <Stepper item={item} count={count} onChange={onChange} />
      </footer>
    </article>
  );
}

/** One shelf item as a compact row, for the add-on step inside a dialog where
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
