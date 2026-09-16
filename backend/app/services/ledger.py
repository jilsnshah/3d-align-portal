"""Charges gathered across many cases, for the two pages that read them that way.

The clinic asks "what do I owe"; the lab asks "what is waiting for me to check,
and what is owed to us". Those are different questions over the same rows, and
the part that is genuinely shared — bringing a live case's charges up to date,
turning a row into something readable on its own, and adding the totals — lives
here so the two pages cannot drift apart on what a charge means.

Nothing here writes to a payment. Raising a charge is sync()'s job and settling
one is the verify endpoint's; this only reads.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session

from .. import schemas
from ..enums import STATUS_LABELS, TERMINAL_STATUSES, PaymentStatus
from ..models import Order
from . import catalogue
from . import payments as payment_service

# What is still open, and the order the reader wants it in. A rejected receipt
# is the most urgent thing on either page — the money left the clinic's account
# and the charge is still open — so it sorts above one merely unpaid.
PENDING_RANK = {
    PaymentStatus.REJECTED: 0,
    PaymentStatus.DUE: 1,
    PaymentStatus.SUBMITTED: 2,
}


def financial_year(now: datetime) -> tuple:
    """The Indian financial year containing ``now``: 1 April to 31 March.

    A practice and a lab both reconcile against this window rather than the
    calendar year, so a total labelled "this year" running January to December
    would be a number neither could use.
    """
    start_year = now.year if now.month >= 4 else now.year - 1
    start = datetime(start_year, 4, 1, tzinfo=timezone.utc)
    return start, f"FY {start_year}–{str(start_year + 1)[-2:]}"


def subject(order: Order) -> str:
    """What the charge is against, in the reader's own terms.

    A case is its patient. A shelf order names nobody, so it is what is in the
    box — the same line the boards show.
    """
    if order.patient is not None:
        return order.patient.full_name
    return catalogue.describe(order) or "Aligner accessories"


def refresh(db: Session, orders) -> None:
    """Bring every live case's charges up to date, then commit.

    Committed before anything is read, and deliberately: a row sync has only
    just created has no status until it is written — the column default is
    applied on the way to the database — so reading mid-loop hands the
    serialiser a half-built charge.

    A finished or cancelled case cannot raise a new charge, so re-syncing one
    would only cost a write for a row that is already final.
    """
    for order in orders:
        if order.status not in TERMINAL_STATUSES:
            payment_service.sync(db, order)
    db.commit()


def entry(order: Order, row, settings, with_doctor: bool = False) -> schemas.LedgerEntry:
    """One charge, carried with enough of its case to be read on its own."""
    from ..serializers import _payment_out

    return schemas.LedgerEntry(
        **_payment_out(order, row, settings).model_dump(),
        order_id=order.id,
        order_reference=order.reference,
        order_kind=order.kind,
        subject=subject(order),
        order_status_label=STATUS_LABELS.get(order.status, order.status),
        # The clinic knows whose money it is. The lab is looking across all of
        # them and cannot read a column of amounts without it.
        doctor_name=order.doctor.full_name if with_doctor else "",
        clinic_name=order.doctor.clinic_name if with_doctor else "",
        doctor_id=order.doctor_id if with_doctor else "",
    )


def collect(db: Session, orders, settings, with_doctor: bool = False) -> dict:
    """Every charge on these orders, split by what is still to be done with it,
    with the totals each page puts across the top."""
    refresh(db, orders)

    pending: list = []
    history: list = []
    to_verify: list = []
    outstanding = in_review = paid_total = paid_year = Decimal("0")

    year_start, year_label = financial_year(datetime.now(timezone.utc))

    for order in orders:
        for row in order.payments:
            item = entry(order, row, settings, with_doctor)
            if row.status == PaymentStatus.VERIFIED:
                history.append(item)
                paid_total += row.total
                if row.verified_at is not None and row.verified_at >= year_start:
                    paid_year += row.total
            else:
                pending.append(item)
                if row.status == PaymentStatus.SUBMITTED:
                    in_review += row.total
                    to_verify.append(item)
                else:
                    outstanding += row.total

    pending.sort(key=lambda e: (PENDING_RANK.get(e.status, 9), e.order_reference))
    # Oldest receipt first: a clinic waiting on a decision has been waiting
    # longest on the one at the top, and that is the one to check next.
    to_verify.sort(key=lambda e: (e.submitted_at is None, e.submitted_at))
    # Newest confirmation first: what someone looks for in a settled list is
    # almost always the most recent one.
    history.sort(key=lambda e: (e.verified_at is None, e.verified_at), reverse=True)

    money = payment_service.money
    return {
        # Quantised on the way out so every figure has two decimal places,
        # including the ones still at zero. "0" beside "1,250.00" reads as a
        # different kind of number.
        "outstanding": money(outstanding),
        "in_review": money(in_review),
        "paid_total": money(paid_total),
        "paid_this_year": money(paid_year),
        "financial_year": year_label,
        "pending": pending,
        "history": history,
        "to_verify": to_verify,
    }


def owed_by_doctor(pending) -> list:
    """Which clinic owes what, largest first.

    Only what is actually owed — a receipt already sent is not a debt, it is a
    job on the lab's own desk, and mixing the two would chase a clinic that has
    already paid.
    """
    totals: dict = {}
    for item in pending:
        if item.status == PaymentStatus.SUBMITTED:
            continue
        key = item.doctor_id or item.doctor_name
        row = totals.setdefault(
            key,
            {
                "doctor_id": item.doctor_id,
                "doctor_name": item.doctor_name,
                "clinic_name": item.clinic_name,
                "amount": Decimal("0"),
                "charges": 0,
            },
        )
        row["amount"] += Decimal(item.total)
        row["charges"] += 1
    rows = sorted(totals.values(), key=lambda r: r["amount"], reverse=True)
    for row in rows:
        row["amount"] = payment_service.money(row["amount"])
    return [schemas.DoctorOwing(**row) for row in rows]
