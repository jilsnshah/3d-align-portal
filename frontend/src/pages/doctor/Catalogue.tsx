/* What 3D Align makes besides aligners.

   A doctor finishing a case wants a retainer, and until now the only way to ask
   for one was a dropdown buried in step two of the aligner intake — which is to
   say, no way at all. This is the shop front: what exists, what it costs, and
   one button to order it for a patient the clinic already has on file. */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { api } from "../../api";
import type { Product } from "../../api";
import { Banner, ErrorText, Field, Loading } from "../../components/ui";

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

  const [params, setParams] = useSearchParams();
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
  const total = ordering && size
    ? (Number(size.price) + Number(ordering.per_tooth_price) * extraTeeth) * quantity
    : 0;

  const create = useMutation({
    mutationFn: () =>
      api.createOrder({
        patient_id: patientId || null,
        new_patient: patientId ? null : { full_name: newPatientName },
        product_id: ordering!.id,
        product_size_id: sizeId,
        quantity,
        extra_teeth: extraTeeth,
      }),
    // Straight into the case, which is where the records and the scan are asked
    // for — the same path every other order takes.
    onSuccess: (order) => navigate(`/orders/${order.id}`),
  });

  const blocker = !sizeId
    ? "Choose a thickness."
    : !patientId && newPatientName.trim().length < 2
      ? "Name the patient."
      : "";

  // Arriving from the home page with ?order=<id> opens that product straight
  // away, so the strip there is a real shortcut and not just a link to a list.
  const wanted = params.get("order");
  useEffect(() => {
    if (!wanted || ordering || !products.data) return;
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

  if (products.isLoading) return <Loading what="the catalogue" />;

  return (
    <main className="page stack">
      <div>
        <h1>Retainers &amp; appliances</h1>
        <p className="muted">
          Made from an intraoral scan — no treatment plan or simulation stage, so they are
          quick. If we already hold a scan for the patient, you can reuse it rather than
          taking another.
        </p>
      </div>

      <div className="catalogue-grid">
        {products.data?.map((product) => (
          <article key={product.id} className="product-card">
            <header>
              <span className="product-code">{product.code}</span>
              <h3>{product.name}</h3>
            </header>
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

            <footer>
              <span className="product-from">from {rupees(from(product))}</span>
              <button type="button" className="btn-primary" onClick={() => open(product)}>
                Order this
              </button>
            </footer>
          </article>
        ))}
      </div>

      {ordering && (
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

          {total > 0 && (
            <Banner tone="ok">
              <div>
                <b>{rupees(total)}</b> for {quantity} set{quantity === 1 ? "" : "s"}. Delivery is
                added once we know where it is going. You will be asked for photographs and a
                scan next.
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
        </div>
      )}
    </main>
  );
}
