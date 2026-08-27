"""Scans a patient has already given, offered back instead of asked for again.

A clinic that finished an aligner case and now wants a retainer for the same
patient should not have to take the impression twice — the lab already holds
their arches, and for a retainer the *final* staged arch is the better record
anyway, because that is where the teeth actually ended up.

The old system had no notion of this: every product order went through the same
four scan routes as a fresh case, so a retainer ordered the week a case
completed still meant another appointment.

Nothing is copied by value. A reused scan points at the same stored object as
the order it came from, so the file is never uploaded or stored twice.
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from ..enums import FileCategory, OrderStatus, Slot
from ..models import Order, OrderFile, utcnow

# The three files that make a scan set. A source is only offerable if it has all
# three: half a scan is not something the bench can work from.
SCAN_SLOTS = (Slot.UPPER_ARCH, Slot.LOWER_ARCH, Slot.BITE)


def _live_scan_files(order: Order) -> dict:
    """The current scan set on an order, newest revision per slot."""
    best: dict = {}
    for f in order.files:
        if f.is_deleted or f.category != FileCategory.INTRAORAL_SCAN:
            continue
        if f.slot not in SCAN_SLOTS:
            continue
        current = best.get(f.slot)
        if current is None or f.revision >= current.revision:
            best[f.slot] = f
    return best


def sources_for(db: Session, patient_id: str, exclude_order_id: Optional[str] = None) -> list:
    """Every earlier order of this patient's that holds a complete scan set.

    Newest first, because the most recent record of a mouth is usually the one
    worth reusing.
    """
    query = (
        db.query(Order)
        .filter(Order.patient_id == patient_id)
        .order_by(Order.created_at.desc())
    )
    out = []
    for order in query:
        if exclude_order_id and order.id == exclude_order_id:
            continue
        files = _live_scan_files(order)
        if len(files) != len(SCAN_SLOTS):
            continue
        out.append(
            {
                "order_id": order.id,
                "reference": order.reference,
                "kind": order.kind,
                "status": order.status,
                "taken_at": max(f.created_at for f in files.values()),
                "files": files,
            }
        )
    return out


def copy_into(db: Session, source: Order, target: Order, actor_id: str) -> list:
    """Attach the source order's scan set to the target order.

    The rows are new — each order owns its own file list — but they point at the
    same objects in storage. Nothing is re-uploaded, and deleting one order's
    copy cannot take the other's file with it, because the bin only ever marks
    a row deleted.
    """
    files = _live_scan_files(source)
    if len(files) != len(SCAN_SLOTS):
        raise ValueError("That case does not have a complete scan set.")

    made = []
    for slot, original in files.items():
        row = OrderFile(
            order_id=target.id,
            category=FileCategory.INTRAORAL_SCAN,
            filename=original.filename,
            mime_type=original.mime_type,
            size_bytes=original.size_bytes,
            storage_ref=original.storage_ref,
            external_link=original.external_link,
            slot=slot,
            uploaded_by_id=actor_id,
            revision=1,
        )
        db.add(row)
        target.files.append(row)
        made.append(row)
    target.scan_reused_from_id = source.id
    target.scan_received_at = utcnow()
    return made


def has_complete_scan(order: Order) -> bool:
    return len(_live_scan_files(order)) == len(SCAN_SLOTS)
