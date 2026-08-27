"""The products the lab makes besides staged aligner series.

Retainers, splints, bleaching trays, bite plates. The previous system held this
list in two places — a ``products`` dictionary and the list its assistant was
told to classify against — and they drifted: sports guards and both bite plates
were orderable but missing from the list, so a doctor asking for one could not
be routed. One table, read by everything.

Prices live per size, because that is how the lab sells: a 0.8 mm Essix is twice
a 1.0 mm one.
"""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from typing import Optional

from sqlalchemy.orm import Session

from ..models import Order, Product, ProductSize

CENTS = Decimal("0.01")

# Carried over from the old catalogue, with the three products its classifier
# never knew about included. (code, name, per-tooth, teeth included, sizes)
SEED: list = [
    ("ER", "Essix Retainer", 0, 0, [("1.0 mm", 500), ("0.8 mm", 1000)]),
    ("GER", "Guided Essix Retainer", 100, 1, [("standard", 750)]),
    ("PR", "Pediatric Retainer", 100, 1, [("standard", 750)]),
    ("NG", "Bruxism Splint", 0, 0, [("0.5 mm", 700), ("1.0 mm", 700), ("1.5 mm", 700)]),
    ("TMJ", "TMJ Splint", 0, 0, [("1.5 mm", 2000), ("2.0 mm", 2000)]),
    ("LEACH", "Bleaching Tray", 0, 0, [("0.6 mm", 700), ("1.0 mm", 700)]),
    ("SG", "Sports Guard", 0, 0,
     [("2 mm", 3500), ("3 mm", 3500), ("4 mm", 4000), ("5 mm", 4000)]),
    ("ABP", "Anterior Bite Plate", 0, 0, [("standard", 2500)]),
    ("PBP", "Posterior Bite Plate", 0, 0, [("standard", 2500)]),
    ("JA", "Mandibular Jaw Correction", 0, 0, [("standard", 4000)]),
]


def money(value) -> Decimal:
    return Decimal(value or 0).quantize(CENTS, rounding=ROUND_HALF_UP)


def ensure_products(db: Session) -> list:
    """Put the catalogue in place on first boot, and leave it alone after.

    Only missing products are added: a lab that has repriced must not have its
    prices overwritten by a restart.
    """
    existing = {p.code for p in db.query(Product).all()}
    for order, (code, name, per_tooth, included, sizes) in enumerate(SEED):
        if code in existing:
            continue
        product = Product(
            code=code,
            name=name,
            per_tooth_price=money(per_tooth),
            included_teeth=included,
            sort_order=order,
        )
        db.add(product)
        for index, (label, price) in enumerate(sizes):
            product.sizes.append(
                ProductSize(label=label, price=money(price), sort_order=index)
            )
    db.commit()
    return catalogue(db)


def catalogue(db: Session) -> list:
    return (
        db.query(Product)
        .filter(Product.is_active.is_(True))
        .order_by(Product.sort_order, Product.name)
        .all()
    )


def size_of(product: Product, size_id: Optional[str]) -> Optional[ProductSize]:
    if size_id:
        return next((s for s in product.sizes if s.id == size_id), None)
    # A product with one size does not need to be asked about.
    sizes = product.priced_sizes
    return sizes[0] if len(sizes) == 1 else None


def line_total(order: Order) -> Decimal:
    """What a product order is worth, before delivery.

    Unit price times quantity, plus any teeth beyond what the base price covers.
    The old system stored the *unit* price as the quote and only multiplied by
    quantity when the invoice was raised, so everything the clinic was shown in
    between was the price of one — order three splints, get quoted for one.
    """
    if order.product is None or order.product_size is None:
        return Decimal("0")
    # Column defaults only land on insert, so an order still being built in
    # memory has None here rather than 0.
    teeth = max(order.extra_teeth or 0, 0)
    count = max(order.quantity or 1, 1)
    each = money(order.product_size.price)
    extra = money(order.product.per_tooth_price) * teeth
    return money((each + extra) * count)


def describe(order: Order) -> str:
    """One line for the board: what was ordered, in how many, at what size."""
    if order.product is None:
        return ""
    parts = [order.product.name]
    if order.product_size is not None and order.product.has_choice_of_size:
        parts.append(order.product_size.label)
    if (order.extra_teeth or 0) > 0:
        # Part of the price, so it belongs in the line the board shows rather
        # than only in the total.
        parts.append(f"+{order.extra_teeth} tooth" if order.extra_teeth == 1
                     else f"+{order.extra_teeth} teeth")
    if (order.quantity or 1) > 1:
        parts.append(f"x{order.quantity}")
    return " · ".join(parts)
