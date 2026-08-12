from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models import Counter


def next_order_number(db: Session) -> str:
    """AL-2026-0001. Sequence resets each calendar year."""
    year = datetime.now(timezone.utc).year
    key = f"order:{year}"

    counter = db.get(Counter, key, with_for_update=True) if db.bind.dialect.name != "sqlite" else db.get(Counter, key)
    if counter is None:
        counter = Counter(key=key, value=0)
        db.add(counter)
        db.flush()

    counter.value += 1
    db.flush()
    return f"AL-{year}-{counter.value:04d}"
