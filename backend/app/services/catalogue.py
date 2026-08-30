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
    ("LEACH", "Bleaching Tray", 0, 0,
     [("0.6 mm", 700), ("0.8 mm", 700), ("1.0 mm", 700)]),
    ("SG", "Sports Guard", 0, 0,
     [("2 mm", 3500), ("3 mm", 3500), ("4 mm", 4000), ("5 mm", 4000)]),
    ("ABP", "Anterior Bite Plate", 0, 0, [("standard", 2500)]),
    ("PBP", "Posterior Bite Plate", 0, 0, [("standard", 2500)]),
    ("JA", "Mandibular Jaw Correction", 0, 0, [("standard", 4000)]),
]


def money(value) -> Decimal:
    return Decimal(value or 0).quantize(CENTS, rounding=ROUND_HALF_UP)


def ensure_products(db: Session) -> list:
    """Put the catalogue in place on first boot, and top it up on later ones.

    Prices are never rewritten: a lab that has repriced must not lose that to a
    restart. But a size added to the seed has to reach the labs that are already
    running, or the catalogue is only ever correct on a database created after
    the change — so a product that exists gains the labels it is missing.

    A size the lab has retired keeps its row with ``is_active`` false, so this
    finds it and leaves it retired rather than resurrecting it on every boot.
    """
    existing = {p.code: p for p in db.query(Product).all()}
    for order, (code, name, per_tooth, included, sizes) in enumerate(SEED):
        product = existing.get(code)
        if product is None:
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
            continue

        held = {size.label for size in product.sizes}
        added = [(label, price) for label, price in sizes if label not in held]
        if not added:
            continue
        for label, price in added:
            product.sizes.append(ProductSize(label=label, price=money(price)))
        _resequence(product, [label for label, _ in sizes])
    db.commit()
    return catalogue(db)


def _resequence(product: Product, seed_labels: list) -> None:
    """Order this product's sizes the way the seed lists them.

    A new thickness belongs between its neighbours, not after them — 0.8 mm
    reading below 1.0 mm looks like a mistake on the shelf. Sizes the lab added
    itself are not in the seed, so they keep their relative order and follow.

    Only called for a product that just gained a size, so a lab that has ordered
    its own list and needs nothing new is never renumbered underneath it.
    """
    rank = {label: index for index, label in enumerate(seed_labels)}
    # A size appended a moment ago has no sort_order until it is flushed, so the
    # extras are ordered on a real number rather than on None.
    extras = sorted(
        (size for size in product.sizes if size.label not in rank),
        key=lambda size: size.sort_order or 0,
    )
    for size in product.sizes:
        if size.label in rank:
            size.sort_order = rank[size.label]
    for offset, size in enumerate(extras):
        size.sort_order = len(rank) + offset


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
