from __future__ import annotations

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

def next_product_number(db: Session, code: str) -> str:
    """PR-2026-0001, keyed on the product's own code.

    A separate series per product, so the lab reads what a reference is for at a
    glance and the aligner sequence is not spent on a bleaching tray. The old
    system did the same thing with 3DAER(1.0)001, but folded the size into the
    reference — which meant repricing a size changed how orders were numbered.
    """
    year = datetime.now(timezone.utc).year
    key = code.upper()
    return f"{key}-{year}-{_next(db, f'product:{key}:{year}'):04d}"
