from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlalchemy import or_
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


def next_enquiry_number(
    db: Session,
    kind: object = None,
    product_code: str = "",
    size_label: str = "",
) -> str:
    """The reference an order carries from the moment it is placed.

    Handed out at creation, so every order has something a doctor can quote on
    the phone, and cheap: an enquiry that dies costs nothing. It used to be one
    series for everything, EN-2026-0001, which meant a list of enquiries could
    not say which were aligner cases and which were a bleaching tray waiting
    for its scan. It now carries what the order is, shaped like the number it
    will be given later:

        aligner case    EN-AL-2026-0001   (becomes AL-2026-0001)
        appliance       EN-ER(1.0)-001    (becomes 3DAER(1.0)001)
        accessories     EN-ACC-001        (becomes 3DAACC001)

    Each has its own count, so no kind of order spends another's numbers, and
    each follows its final series: the aligner count restarts every year, the
    appliance count runs per product across its thicknesses, and neither
    appliances nor accessories carry a year.

    Called without a kind it numbers an aligner case, which is what every
    caller meant before orders had kinds.
    """
    k = str(getattr(kind, "value", kind) or "ALIGNER").upper()
    if k == "PRODUCT" and product_code:
        code = product_code.upper()
        n = _next(db, f"enquiry:product:{code}")
        return f"EN-{code}{size_token(size_label)}-{n:03d}"
    if k == "ACCESSORY":
        return f"EN-ACC-{_next(db, 'enquiry:accessory'):03d}"
    year = datetime.now(timezone.utc).year
    return f"EN-AL-{year}-{_next(db, f'enquiry:AL:{year}'):04d}"


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


PATIENT_COUNTER = "patient"


def patient_number(sequence: int) -> str:
    """PT-00001. Five digits to start with; it simply grows past 99999."""
    return f"PT-{sequence:05d}"


def next_patient_number(db: Session) -> str:
    """The next patient reference. Handed out once, when a patient is first
    recorded, and never reused — two patients can share a name, never a number.
    No year in it: a patient outlives the year they were registered in."""
    return patient_number(_next(db, PATIENT_COUNTER))


def _wind_patient_counter(db: Session) -> None:
    """Make sure the counter stands at or past every number already issued.

    A restored backup, or numbers written by hand, can leave the counter behind
    the patients table; the next patient would then be handed a number someone
    already has and the unique index would refuse the insert.
    """
    from ..models import Patient

    issued = [
        int(n[3:])
        for (n,) in db.query(Patient.patient_number).filter(Patient.patient_number.like("PT-%"))
        if n[3:].isdigit()
    ]
    if not issued:
        return
    counter = db.get(Counter, PATIENT_COUNTER)
    if counter is None:
        db.add(Counter(key=PATIENT_COUNTER, value=max(issued)))
    elif counter.value < max(issued):
        counter.value = max(issued)
    db.flush()


def backfill_patient_numbers(db: Session) -> int:
    """Number every patient recorded before numbers existed, in the order they
    were added, carrying on from the counter so nobody collides. Returns how
    many were numbered; a no-op once everyone has one."""
    from ..models import Patient

    _wind_patient_counter(db)
    blank = (
        db.query(Patient)
        .filter(or_(Patient.patient_number.is_(None), Patient.patient_number == ""))
        .order_by(Patient.created_at, Patient.id)
        .all()
    )
    for patient in blank:
        patient.patient_number = next_patient_number(db)
    db.flush()
    return len(blank)
