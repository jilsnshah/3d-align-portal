"""The things the lab keeps on a shelf.

Not made, not fitted, not scanned — picked and packed. An accessory has a
price and nothing else, which is why it lives apart from the product catalogue
rather than as a product with one size and no bench work.

They ride on a product order or stand as an order of their own. Either way an
order carries a list of them, because a clinic restocking asks for two strips,
a cleanser and five cases in one breath.
"""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from typing import Optional

from sqlalchemy.orm import Session

from ..models import Accessory, Order, OrderAccessory

CENTS = Decimal("0.01")

# (code, name, price, blurb)
SEED: list = [
    ("OUT", "Outie", 100, "Aligner removal hook."),
    ("BOL", "Bolster", 100, "Seating bolster for a snug fit."),
    ("IPRS", "IPR Strip", 100, "Single interproximal reduction strip."),
    ("CLN", "Cleanser", 100, "Cleaning tablets for aligners and retainers."),
    ("RCASE", "Retainer Case", 100, "Hard case for aligners or a retainer."),
    ("IPRK", "IPR Kit", 25000, "The full interproximal reduction kit."),
]


def money(value) -> Decimal:
    return Decimal(value or 0).quantize(CENTS, rounding=ROUND_HALF_UP)


def ensure_accessories(db: Session) -> list:
    """Put the shelf in place on first boot, and top it up on later ones.

    Prices already in the table are never rewritten: a lab that has repriced
    keeps its own numbers. Only codes that are missing are added, so a new
    accessory reaches a lab that is already running.
    """
    existing = {row.code for row in db.query(Accessory).all()}
    for order, (code, name, price, blurb) in enumerate(SEED):
        if code in existing:
            continue
        db.add(
            Accessory(
                code=code,
                name=name,
                description=blurb,
                price=money(price),
                sort_order=order,
            )
        )
    db.commit()
    return catalogue(db)


def catalogue(db: Session) -> list:
    return (
        db.query(Accessory)
        .filter(Accessory.is_active.is_(True))
        .order_by(Accessory.sort_order, Accessory.name)
        .all()
    )


def set_lines(db: Session, order: Order, wanted: list) -> None:
    """Make the order's accessory lines match what was asked for.

    Called on creation and whenever a draft is edited, so the same rules apply
    both times: an unknown or retired accessory is refused rather than silently
    dropped, a quantity of nothing removes the line, and the price is written
    down at this moment rather than read back later.
    """
    available = {row.id: row for row in catalogue(db)}
    held = {line.accessory_id: line for line in order.accessories}

    seen = set()
    for entry in wanted or []:
        accessory_id = entry.get("accessory_id") if isinstance(entry, dict) else entry.accessory_id
        quantity = entry.get("quantity") if isinstance(entry, dict) else entry.quantity
        quantity = max(int(quantity or 0), 0)
        accessory = available.get(accessory_id)
        if accessory is None:
            raise KeyError(accessory_id)
        if quantity == 0:
            continue
        seen.add(accessory_id)
        line = held.get(accessory_id)
        if line is None:
            order.accessories.append(
                OrderAccessory(
                    accessory_id=accessory_id,
                    quantity=quantity,
                    unit_price=money(accessory.price),
                )
            )
        else:
            line.quantity = quantity
            # A line still on an unplaced draft is repriced; one already
            # ordered keeps what it was quoted at.
            line.unit_price = money(accessory.price)

    for accessory_id, line in held.items():
        if accessory_id not in seen:
            order.accessories.remove(line)


def total(order: Order) -> Decimal:
    """What the accessories on this order come to."""
    return money(sum((line.line_total for line in order.accessories), Decimal("0")))


def describe(order: Order) -> str:
    """One line for a board: what is in the box."""
    parts = [
        f"{line.accessory.name}" + (f" ×{line.quantity}" if (line.quantity or 1) > 1 else "")
        for line in sorted(order.accessories, key=lambda l: l.accessory.sort_order)
        if line.accessory is not None
    ]
    return " · ".join(parts)
