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

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import verified_doctor
from ..models import Doctor, Order
from ..services import ledger, scheduling

router = APIRouter(prefix="/payments", tags=["payments"])


@router.get("", response_model=schemas.PaymentLedgerOut)
def practice_ledger(
    doctor: Doctor = Depends(verified_doctor),
    db: Session = Depends(get_db),
):
    """Everything this practice owes and everything it has paid.

    Scoped to the signed-in doctor by the query itself — there is no parameter
    that can widen it.
    """
    orders = (
        db.query(Order)
        .filter(Order.doctor_id == doctor.id)
        .order_by(Order.created_at.desc())
        .all()
    )
    data = ledger.collect(db, orders, scheduling.get_settings(db))
    return schemas.PaymentLedgerOut(**{
        k: v for k, v in data.items() if k != "to_verify"
    })
