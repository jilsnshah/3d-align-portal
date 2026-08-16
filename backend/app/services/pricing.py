"""Aligner category pricing.

3D Align prices by total aligner count. The lab picks a band from the clinical
photographs for the expected quote, then confirms the real band once the
treatment plan gives an exact count — that confirmed price is what gets
invoiced.

Prices live in the database so they can be changed from the admin panel.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from sqlalchemy.orm import Session

from ..enums import ALIGNER_CATEGORIES, DEFAULT_CATEGORY_PRICES, category_label
from ..models import AlignerPrice

CENTS = Decimal("0.01")


def money(value) -> Decimal:
    return Decimal(value or 0).quantize(CENTS, rounding=ROUND_HALF_UP)


def ensure_prices(db: Session) -> list[AlignerPrice]:
    """Seeds the placeholder list on first use so the quote builder is never
    empty. Existing rows are left alone — the lab owns them after that."""
    existing = {row.category for row in db.query(AlignerPrice).all()}
    added = False
    for category in ALIGNER_CATEGORIES:
        if category not in existing:
            low, high = DEFAULT_CATEGORY_PRICES[category]
            db.add(AlignerPrice(category=category, price_min=money(low), price_max=money(high)))
            added = True
    if added:
        db.commit()
    return price_list(db)


def price_list(db: Session) -> list[AlignerPrice]:
    rows = {r.category: r for r in db.query(AlignerPrice).all()}
    return [rows[c] for c in ALIGNER_CATEGORIES if c in rows]


def range_for(db: Session, category: str) -> Optional[tuple]:
    """The band's (low, high). None when the band is switched off."""
    row = db.get(AlignerPrice, category)
    if row is None or not row.is_active:
        return None
    return money(row.price_min), money(row.price_max)


def describe(category: Optional[str]) -> str:
    return category_label(category) if category else ""
