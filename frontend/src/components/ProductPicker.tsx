/* What the clinic wants made, when it is not a staged aligner series.

   A product is priced per size, so the size is a price decision as much as a
   clinical one and both are shown together. Products with one form are not
   asked about — a choice of one is not a choice. */

import type { Product, ProductSize } from "../api";
import { Field } from "./ui";

function rupees(value: string | number): string {
  return `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export interface ProductChoice {
  productId: string;
  sizeId: string;
  quantity: number;
  extraTeeth: number;
}

export function totalFor(
  products: Product[],
  choice: ProductChoice,
): { product: Product | null; size: ProductSize | null; total: number } {
  const product = products.find((p) => p.id === choice.productId) ?? null;
  const size = product?.sizes.find((s) => s.id === choice.sizeId) ?? null;
  if (!product || !size) return { product, size, total: 0 };
  const each = Number(size.price) + Number(product.per_tooth_price) * choice.extraTeeth;
  return { product, size, total: each * Math.max(choice.quantity, 1) };
}

export default function ProductPicker({
  products,
  value,
  onChange,
}: {
  products: Product[];
  value: ProductChoice;
  onChange: (next: ProductChoice) => void;
}) {
  const { product, size, total } = totalFor(products, value);

  function pickProduct(productId: string) {
    const next = products.find((p) => p.id === productId);
    onChange({
      productId,
      // A single-size product is settled the moment it is picked.
      sizeId: next && !next.has_choice_of_size ? next.sizes[0]?.id ?? "" : "",
      quantity: value.quantity,
      extraTeeth: 0,
    });
  }

  return (
    <div className="stack-sm">
      <Field label="What should the lab make?">
        <select value={value.productId} onChange={(e) => pickProduct(e.target.value)}>
          <option value="">A staged aligner series</option>
          <optgroup label="Other products">
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        </select>
      </Field>

      {product && (
        <div className="grid-2">
          {product.has_choice_of_size ? (
            <Field label="Thickness">
              <select
                value={value.sizeId}
                onChange={(e) => onChange({ ...value, sizeId: e.target.value })}
              >
                <option value="">Choose…</option>
                {product.sizes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label} — {rupees(s.price)}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Price">
              <p className="muted">{rupees(product.sizes[0]?.price ?? 0)} per set</p>
            </Field>
          )}

          <Field label="How many sets?">
            <input
              type="number"
              min={1}
              max={50}
              value={value.quantity}
              onChange={(e) =>
                onChange({ ...value, quantity: Math.max(1, Number(e.target.value) || 1) })
              }
            />
          </Field>

          {Number(product.per_tooth_price) > 0 && (
            <Field
              label={`Teeth beyond the first ${product.included_teeth}`}
              hint={`${rupees(product.per_tooth_price)} each. The base price covers ${product.included_teeth}.`}
            >
              <input
                type="number"
                min={0}
                max={32}
                value={value.extraTeeth}
                onChange={(e) =>
                  onChange({ ...value, extraTeeth: Math.max(0, Number(e.target.value) || 0) })
                }
              />
            </Field>
          )}
        </div>
      )}

      {product && size && (
        <p className="muted">
          {product.name}
          {product.has_choice_of_size ? ` · ${size.label}` : ""}
          {value.quantity > 1 ? ` · ${value.quantity} sets` : ""} — <strong>{rupees(total)}</strong>
        </p>
      )}
    </div>
  );
}
