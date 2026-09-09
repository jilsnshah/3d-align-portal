"""Every charge this practice has, in one place.

Money was only ever visible from inside a case: open the case, scroll to the
payments card. That answers "what does this case owe" and nothing else. A
practice running twenty cases had no way to see what it owed in total, no way
to find the one charge holding a plan up, and no record of what it had already
paid without opening every case in turn.

This is a read of the same rows the case panel reads — there is no second
ledger, and nothing here raises, alters or settles a charge. Paying still
happens through the case's own endpoint, so the one path that writes to a
payment stays the one path.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import verified_doctor
from ..enums import STATUS_LABELS, TERMINAL_STATUSES, PaymentStatus
from ..models import Doctor, Order
from ..serializers import _payment_out
from ..services import catalogue
from ..services import payments as payment_service
from ..services import scheduling

router = APIRouter(prefix="/payments", tags=["payments"])

# What the clinic still has to act on, and in what order it wants to see it.
# A rejected receipt is the most urgent thing on the page — the money left the
# account and the charge is still open — so it sorts above a charge that has
# simply not been paid yet.
PENDING_RANK = {
    PaymentStatus.REJECTED: 0,
    PaymentStatus.DUE: 1,
    PaymentStatus.SUBMITTED: 2,
}


def financial_year(now: datetime) -> tuple:
    """The Indian financial year containing ``now``: 1 April to 31 March.

    A practice reconciles against this window, not the calendar year, so a
    total labelled "this year" that ran January to December would be a number
    they could not use.
    """
    start_year = now.year if now.month >= 4 else now.year - 1
    start = datetime(start_year, 4, 1, tzinfo=timezone.utc)
    return start, f"FY {start_year}–{str(start_year + 1)[-2:]}"


def _subject(order: Order) -> str:
    """What the charge is against, in the clinic's own terms.

    A case is its patient. A product order has no patient, so it is what was
    made — the same line the boards show.
    """
    if order.patient is not None:
        return order.patient.full_name
    return catalogue.describe(order) or "Practice stock"


@router.get("", response_model=schemas.PaymentLedgerOut)
def ledger(
    doctor: Doctor = Depends(verified_doctor),
    db: Session = Depends(get_db),
):
    """Everything this practice owes and everything it has paid.

    Scoped to the signed-in doctor by the query itself — there is no parameter
    that can widen it.
    """
    settings = scheduling.get_settings(db)
    orders = (
        db.query(Order)
        .filter(Order.doctor_id == doctor.id)
        .order_by(Order.created_at.desc())
        .all()
    )

    # A live case's charges follow where it has got to, so they are brought up
    # to date the same way the case page does it. A finished or cancelled case
    # cannot raise a new charge, and re-syncing one would only cost a write for
    # a row that is already final.
    #
    # Every case is brought up to date and committed before any of it is read.
    # A row that sync has only just created has no status until it is written —
    # the column's default is applied on the way to the database — so reading
    # mid-loop hands the serialiser a half-built charge.
    for order in orders:
        if order.status not in TERMINAL_STATUSES:
            payment_service.sync(db, order)
    db.commit()

    pending: list = []
    history: list = []
    outstanding = in_review = paid_total = paid_year = Decimal("0")

    now = datetime.now(timezone.utc)
    year_start, year_label = financial_year(now)

    for order in orders:
        for row in order.payments:
            entry = schemas.LedgerEntry(
                **_payment_out(order, row, settings).model_dump(),
                order_id=order.id,
                order_reference=order.reference,
                order_kind=order.kind,
                subject=_subject(order),
                order_status_label=STATUS_LABELS.get(order.status, order.status),
            )
            if row.status == PaymentStatus.VERIFIED:
                history.append(entry)
                paid_total += row.total
                if row.verified_at is not None and row.verified_at >= year_start:
                    paid_year += row.total
            else:
                pending.append(entry)
                if row.status == PaymentStatus.SUBMITTED:
                    in_review += row.total
                else:
                    outstanding += row.total

    pending.sort(key=lambda e: (PENDING_RANK.get(e.status, 9), e.order_reference))
    # Newest receipt first: the thing a clinic looks for in a paid list is
    # almost always the one they sent most recently.
    history.sort(key=lambda e: (e.verified_at is None, e.verified_at), reverse=True)

    # Quantised on the way out so every figure on the page has two decimal
    # places, including the ones that are still zero. A column reading
    # "0" beside "1,250.00" looks like a different kind of number.
    return schemas.PaymentLedgerOut(
        outstanding=payment_service.money(outstanding),
        in_review=payment_service.money(in_review),
        paid_total=payment_service.money(paid_total),
        paid_this_year=payment_service.money(paid_year),
        financial_year=year_label,
        pending=pending,
        history=history,
    )
