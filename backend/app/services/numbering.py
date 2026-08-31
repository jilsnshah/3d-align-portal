from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models import Counter


def _next(db: Session, key: str) -> int:
    counter = db.get(Counter, key, with_for_update=True) if db.bind.dialect.name != "sqlite" else db.get(Counter, key)
    if counter is None:
        counter = Counter(key=key, value=0)
        db.add(counter)
        db.flush()

    counter.value += 1
    db.flush()
    return counter.value


def next_enquiry_number(db: Session) -> str:
    """EN-2026-0001. Handed out at case creation, so every case has a reference
    a doctor can quote on the phone. Cheap: an enquiry that dies costs nothing."""
    year = datetime.now(timezone.utc).year
    return f"EN-{year}-{_next(db, f'enquiry:{year}'):04d}"


def next_order_number(db: Session) -> str:
    """AL-2026-0001. The lab's production series, spent only when a case reaches
    planning. Sequence resets each calendar year."""
    year = datetime.now(timezone.utc).year
    return f"AL-{year}-{_next(db, f'order:{year}'):04d}"


def size_token(label: str) -> str:
    """The thickness as it reads in a reference: "1.0 mm" becomes "(1.0)".

    A product made in one form is labelled "standard" or "One size", which
    carries no number and would only pad the reference, so it contributes
    nothing and the code stands on its own: 3DAABP001.
    """
    match = re.search(r"\d+(?:\.\d+)?", label or "")
    return f"({match.group()})" if match else ""


def product_number(code: str, size_label: str, sequence: int) -> str:
    """Assemble a product reference from its parts.

    Split out from next_product_number so the backfill that renumbers the
    orders already placed builds its references the same way new ones are
    built, rather than reimplementing the format and drifting from it.
    """
    return f"3DA{code.upper()}{size_token(size_label)}{sequence:03d}"


def product_counter_key(code: str) -> str:
    """One sequence per product, whatever thickness was made.

    The size lives in the parentheses to say what the appliance is, not where
    it sits in the queue — so an Essix Retainer runs 001, 002, 003 across every
    thickness rather than restarting each time a different one is ordered.
    """
    return f"product:{code.upper()}"


def next_accessory_number(db: Session) -> str:
    """3DAACC001 — one series for orders that are only shelf items.

    A product reference names the appliance and its thickness because that is
    what the bench reads off the tray. An accessory order has no appliance and
    can hold several different items, so there is nothing to name: it takes a
    plain running number and the packing list says what is in the box.
    """
    return f"3DAACC{_next(db, 'accessory'):03d}"


def next_product_number(db: Session, code: str, size_label: str = "") -> str:
    """3DAER(1.0)001 — the lab's own bench series.

    No year in it, unlike the aligner and enquiry series: this is the reference
    the lab writes on the tray itself, and it has never carried one.
    """
    return product_number(code, size_label, _next(db, product_counter_key(code)))
