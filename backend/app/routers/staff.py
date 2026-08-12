"""Staff-facing endpoints.

The portal is built for a single lab account, so there is no assignment or claim
step — any STAFF user acts on any order.
"""

from __future__ import annotations

from typing import Optional

from decimal import ROUND_HALF_UP, Decimal
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import any_order, current_staff
from ..enums import (
    AppointmentStatus,
    FileGroup,
    InvoiceStatus,
    OrderStatus,
    PlanStatus,
    QuoteStatus,
    ShipmentStatus,
    ShipmentType,
    UserRole,
    VerificationStatus,
)
from ..models import (
    Doctor,
    Invoice,
    Notification,
    Order,
    Quote,
    QuoteLineItem,
    Shipment,
    TreatmentPlan,
    User,
    utcnow,
)
from ..serializers import order_detail, order_summary
from ..services import billing
from ..transitions import assert_status, transition

CENTS = Decimal("0.01")


def money(value) -> Decimal:
    """Quantize to 2dp so totals are identical on SQLite and Postgres."""
    return Decimal(value or 0).quantize(CENTS, rounding=ROUND_HALF_UP)


router = APIRouter(prefix="/staff", tags=["staff"])

READY_TO_INVOICE_STATUSES = (OrderStatus.DISPATCHING, OrderStatus.COMPLETED)


# --------------------------------------------------------------------------
# Queue and lists
# --------------------------------------------------------------------------


@router.get("/queue", response_model=schemas.QueueOut)
def queue(staff: User = Depends(current_staff), db: Session = Depends(get_db)):
    def count(*statuses: OrderStatus) -> int:
        return db.query(Order).filter(Order.status.in_(statuses)).count()

    ready_to_invoice = sum(
        1
        for order in db.query(Order).filter(Order.status.in_(READY_TO_INVOICE_STATUSES)).all()
        if order.invoice is None and _all_delivered(order)
    )

    return schemas.QueueOut(
        new_submissions=count(OrderStatus.SUBMITTED),
        awaiting_quote=count(OrderStatus.UNDER_REVIEW),
        awaiting_scan_review=count(OrderStatus.SCAN_SUBMITTED),
        in_planning=count(OrderStatus.IN_PLANNING, OrderStatus.FIT_ISSUE),
        in_production=count(
            OrderStatus.TRAINING_ALIGNER_PRODUCTION, OrderStatus.ALIGNER_PRODUCTION
        ),
        ready_to_ship=count(
            OrderStatus.TRAINING_ALIGNER_PRODUCTION, OrderStatus.ALIGNER_PRODUCTION
        ),
        dispatching=count(OrderStatus.DISPATCHING),
        ready_to_invoice=ready_to_invoice,
        pending_doctors=db.query(Doctor)
        .filter(Doctor.verification_status == VerificationStatus.PENDING)
        .count(),
    )


@router.get("/orders", response_model=list[schemas.OrderSummary])
def list_orders(
    order_status: Optional[OrderStatus] = Query(default=None, alias="status"),
    search: Optional[str] = Query(default=None),
    staff: User = Depends(current_staff),
    db: Session = Depends(get_db),
):
    query = db.query(Order)
    if order_status:
        query = query.filter(Order.status == order_status)
    orders = query.order_by(Order.created_at.desc()).limit(400).all()

    if search:
        needle = search.strip().lower()
        orders = [
            o
            for o in orders
            if needle in o.order_number.lower()
            or needle in o.patient.full_name.lower()
            or needle in o.doctor.full_name.lower()
            or needle in (o.doctor.clinic_name or "").lower()
        ]
    return [order_summary(o) for o in orders]


@router.get("/orders/{order_id}", response_model=schemas.OrderDetail)
def get_order(order_id: str, staff: User = Depends(current_staff), db: Session = Depends(get_db)):
    return order_detail(any_order(order_id, db))


# --------------------------------------------------------------------------
# Review and quoting
# --------------------------------------------------------------------------


@router.post("/orders/{order_id}/start-review", response_model=schemas.OrderDetail)
def start_review(order_id: str, staff: User = Depends(current_staff), db: Session = Depends(get_db)):
    order = any_order(order_id, db)
    assert_status(order, OrderStatus.SUBMITTED)
    transition(db, order, OrderStatus.UNDER_REVIEW, staff)
    db.commit()
    db.refresh(order)
    return order_detail(order)


@router.post("/orders/{order_id}/request-records", response_model=schemas.OrderDetail)
def request_records(
    order_id: str,
    payload: schemas.RecordsRequestIn,
    staff: User = Depends(current_staff),
    db: Session = Depends(get_db),
):
    order = any_order(order_id, db)
    assert_status(order, OrderStatus.UNDER_REVIEW)
    order.records_request_note = payload.note
    revision = order.bump_revision(FileGroup.RECORDS)
    transition(
        db,
        order,
        OrderStatus.RECORDS_REQUESTED,
        staff,
        note=payload.note,
        metadata={"records_revision": revision},
    )
    db.commit()
    db.refresh(order)
    return order_detail(order)


@router.post("/orders/{order_id}/quotes", response_model=schemas.OrderDetail)
def send_quote(
    order_id: str,
    payload: schemas.QuoteIn,
    staff: User = Depends(current_staff),
    db: Session = Depends(get_db),
):
    order = any_order(order_id, db)
    assert_status(order, OrderStatus.UNDER_REVIEW, OrderStatus.QUOTED)

    for existing in order.quotes:
        if existing.status == QuoteStatus.SENT:
            existing.status = QuoteStatus.SUPERSEDED

    subtotal = money(
        sum((Decimal(item.unit_price) * item.quantity for item in payload.line_items), Decimal("0"))
    )
    tax = money(payload.tax)
    total = money(subtotal + tax)

    quote = Quote(
        order_id=order.id,
        version=len(order.quotes) + 1,
        estimated_aligners_upper=payload.estimated_aligners_upper,
        estimated_aligners_lower=payload.estimated_aligners_lower,
        subtotal=subtotal,
        tax=tax,
        total=total,
        currency=payload.currency,
        notes=payload.notes,
        status=QuoteStatus.SENT,
        created_by_id=staff.id,
        sent_at=utcnow(),
    )
    db.add(quote)
    db.flush()

    for item in payload.line_items:
        db.add(
            QuoteLineItem(
                quote_id=quote.id,
                description=item.description,
                unit_price=money(item.unit_price),
                quantity=item.quantity,
                amount=money(Decimal(item.unit_price) * item.quantity),
            )
        )

    transition(
        db,
        order,
        OrderStatus.QUOTED,
        staff,
        note=f"Quote v{quote.version} sent — {quote.currency} {total}.",
    )
    db.commit()
    db.refresh(order)
    return order_detail(order)


# --------------------------------------------------------------------------
# Scan and planning
# --------------------------------------------------------------------------


@router.post("/orders/{order_id}/scan/accept", response_model=schemas.OrderDetail)
def accept_scan(
    order_id: str,
    payload: schemas.NoteIn,
    staff: User = Depends(current_staff),
    db: Session = Depends(get_db),
):
    order = any_order(order_id, db)
    assert_status(order, OrderStatus.SCAN_SUBMITTED)
    if not order.has_intraoral_scan:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "There is no intraoral scan on this case. Upload the STL before accepting it.",
        )
    if order.appointment and order.appointment.status == AppointmentStatus.BOOKED:
        order.appointment.status = AppointmentStatus.COMPLETED
    order.records_request_note = ""
    transition(db, order, OrderStatus.IN_PLANNING, staff, note=payload.note or "Scan accepted.")
    db.commit()
    db.refresh(order)
    return order_detail(order)


@router.post("/orders/{order_id}/scan/reject", response_model=schemas.OrderDetail)
def reject_scan(
    order_id: str,
    payload: schemas.RecordsRequestIn,
    staff: User = Depends(current_staff),
    db: Session = Depends(get_db),
):
    """Sends the case back for another scan attempt."""
    order = any_order(order_id, db)
    assert_status(order, OrderStatus.SCAN_SUBMITTED)
    order.records_request_note = payload.note
    order.scan_route = None
    revision = order.bump_revision(FileGroup.SCAN)
    transition(
        db,
        order,
        OrderStatus.AWAITING_SCAN,
        staff,
        note=f"{payload.note} (scan v{revision} requested)",
        metadata={"scan_revision": revision},
    )
    db.commit()
    db.refresh(order)
    return order_detail(order)


@router.post("/orders/{order_id}/plans", response_model=schemas.OrderDetail)
def share_plan(
    order_id: str,
    payload: schemas.PlanIn,
    staff: User = Depends(current_staff),
    db: Session = Depends(get_db),
):
    order = any_order(order_id, db)
    assert_status(order, OrderStatus.IN_PLANNING)

    for existing in order.plans:
        if existing.status != PlanStatus.APPROVED:
            existing.status = PlanStatus.SUPERSEDED

    plan = TreatmentPlan(
        order_id=order.id,
        version=len(order.plans) + 1,
        aligners_upper=payload.aligners_upper,
        aligners_lower=payload.aligners_lower,
        ipr_required=payload.ipr_required,
        attachments_required=payload.attachments_required,
        summary=payload.summary,
        status=PlanStatus.SHARED,
        created_by_id=staff.id,
        shared_at=utcnow(),
    )
    db.add(plan)
    transition(db, order, OrderStatus.PLAN_SHARED, staff, note=f"Treatment plan v{plan.version} shared.")
    db.commit()
    db.refresh(order)
    return order_detail(order)


@router.post("/orders/{order_id}/fit-issue/resolve", response_model=schemas.OrderDetail)
def resolve_fit_issue(
    order_id: str,
    resolution: str = Query(..., pattern="^(rescan|replan|refabricate)$"),
    staff: User = Depends(current_staff),
    db: Session = Depends(get_db),
):
    """Three ways out of a fit issue. All of them produce a fresh training
    aligner, so the fit round advances and the next one is distinguishable from
    the one that did not fit."""
    order = any_order(order_id, db)
    assert_status(order, OrderStatus.FIT_ISSUE)

    fit_round = order.bump_revision(FileGroup.FIT)

    if resolution == "rescan":
        scan_revision = order.bump_revision(FileGroup.SCAN)
        order.scan_route = None
        target = OrderStatus.AWAITING_SCAN
        note = f"Fresh scan requested (scan v{scan_revision}), training aligner round {fit_round}."
    elif resolution == "replan":
        target = OrderStatus.IN_PLANNING
        note = f"Re-planning the case for training aligner round {fit_round}."
    else:
        target = OrderStatus.TRAINING_ALIGNER_PRODUCTION
        note = f"Refabricating the training aligner, round {fit_round}."

    transition(db, order, target, staff, note=note, metadata={"fit_round": fit_round})
    db.commit()
    db.refresh(order)
    return order_detail(order)


# --------------------------------------------------------------------------
# Shipments
# --------------------------------------------------------------------------


@router.post("/orders/{order_id}/shipments", response_model=schemas.OrderDetail)
def create_shipment(
    order_id: str,
    payload: schemas.ShipmentIn,
    staff: User = Depends(current_staff),
    db: Session = Depends(get_db),
):
    order = any_order(order_id, db)

    if payload.shipment_type == ShipmentType.TRAINING_ALIGNER:
        assert_status(order, OrderStatus.TRAINING_ALIGNER_PRODUCTION)
        next_status = OrderStatus.TRAINING_ALIGNER_SHIPPED
    else:
        assert_status(order, OrderStatus.ALIGNER_PRODUCTION, OrderStatus.DISPATCHING)
        next_status = OrderStatus.DISPATCHING

    shipment = Shipment(
        order_id=order.id,
        shipment_type=payload.shipment_type,
        fit_round=order.fit_round if payload.shipment_type == ShipmentType.TRAINING_ALIGNER else None,
        phase_number=payload.phase_number,
        aligner_range_from=payload.aligner_range_from,
        aligner_range_to=payload.aligner_range_to,
        carrier=payload.carrier,
        tracking_number=payload.tracking_number,
        tracking_url=payload.tracking_url,
        status=ShipmentStatus.SHIPPED,
        shipped_at=utcnow(),
    )
    db.add(shipment)

    if order.status != next_status:
        label = payload.shipment_type.replace("_", " ").lower()
        if payload.shipment_type == ShipmentType.TRAINING_ALIGNER and order.fit_round > 1:
            label = f"{label} (round {order.fit_round})"
        transition(
            db,
            order,
            next_status,
            staff,
            note=f"{label} shipped — {payload.carrier} {payload.tracking_number}".strip(),
        )
    else:
        db.add(
            Notification(
                user_id=order.doctor.user_id,
                order_id=order.id,
                title="Another shipment is on its way",
                body=f"{order.order_number} — {payload.carrier} {payload.tracking_number}".strip(),
            )
        )

    db.commit()
    db.refresh(order)
    return order_detail(order)


@router.patch("/shipments/{shipment_id}", response_model=schemas.OrderDetail)
def update_shipment(
    shipment_id: str,
    payload: schemas.ShipmentUpdateIn,
    staff: User = Depends(current_staff),
    db: Session = Depends(get_db),
):
    shipment = db.get(Shipment, shipment_id)
    if not shipment:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Shipment not found.")
    order = shipment.order

    for field in ("carrier", "tracking_number", "tracking_url"):
        value = getattr(payload, field)
        if value is not None:
            setattr(shipment, field, value)

    if payload.mark_delivered and shipment.status != ShipmentStatus.DELIVERED:
        shipment.status = ShipmentStatus.DELIVERED
        shipment.delivered_at = utcnow()

        if (
            shipment.shipment_type == ShipmentType.TRAINING_ALIGNER
            and order.status == OrderStatus.TRAINING_ALIGNER_SHIPPED
        ):
            transition(
                db,
                order,
                OrderStatus.FIT_REVIEW,
                staff,
                note="Training aligner delivered — fit confirmation requested.",
            )

    db.commit()
    db.refresh(order)
    return order_detail(order)


@router.post("/orders/{order_id}/complete", response_model=schemas.OrderDetail)
def complete_order(
    order_id: str, staff: User = Depends(current_staff), db: Session = Depends(get_db)
):
    order = any_order(order_id, db)
    assert_status(order, OrderStatus.DISPATCHING)
    if not _all_delivered(order):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Mark every shipment delivered before completing the case."
        )
    transition(db, order, OrderStatus.COMPLETED, staff)
    db.commit()
    db.refresh(order)
    return order_detail(order)


@router.post("/orders/{order_id}/cancel", response_model=schemas.OrderDetail)
def cancel_order(
    order_id: str,
    payload: schemas.CancelIn,
    staff: User = Depends(current_staff),
    db: Session = Depends(get_db),
):
    order = any_order(order_id, db)
    order.cancel_reason = payload.reason
    transition(db, order, OrderStatus.CANCELLED, staff, note=payload.reason)
    db.commit()
    db.refresh(order)
    return order_detail(order)


# --------------------------------------------------------------------------
# Invoicing
# --------------------------------------------------------------------------


@router.post("/orders/{order_id}/invoice", response_model=schemas.OrderDetail)
def generate_invoice(
    order_id: str, staff: User = Depends(current_staff), db: Session = Depends(get_db)
):
    order = any_order(order_id, db)
    if order.invoice is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This order already has an invoice.")
    if order.status not in READY_TO_INVOICE_STATUSES:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Invoice once the aligners have been dispatched."
        )

    quote = order.accepted_quote
    if quote is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "No accepted quote to invoice from.")

    payload = billing.build_invoice_payload(order, quote, order.doctor, order.shipping_address)
    try:
        result = billing.create_invoice(payload)
    except billing.BillingNotConfigured as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    invoice = Invoice(
        order_id=order.id,
        invoice_number=order.order_number,
        provider_invoice_id=result["provider_invoice_id"],
        amount=money(quote.total),
        currency=quote.currency,
        pdf_url=result["pdf_url"],
        share_url=result["share_url"],
        status=InvoiceStatus.ISSUED,
        issued_at=utcnow(),
    )
    db.add(invoice)
    db.add(
        Notification(
            user_id=order.doctor.user_id,
            order_id=order.id,
            title="Invoice available",
            body=f"{order.order_number} — {quote.currency} {quote.total}",
        )
    )
    db.commit()
    db.refresh(order)
    return order_detail(order)


# --------------------------------------------------------------------------
# Doctor verification
# --------------------------------------------------------------------------


@router.get("/doctors", response_model=list[schemas.PendingDoctorOut])
def list_doctors(
    pending_only: bool = Query(default=False),
    staff: User = Depends(current_staff),
    db: Session = Depends(get_db),
):
    query = db.query(Doctor)
    if pending_only:
        query = query.filter(Doctor.verification_status == VerificationStatus.PENDING)

    result = []
    for doctor in query.order_by(Doctor.created_at.desc()).all():
        out = schemas.PendingDoctorOut.model_validate(doctor)
        out.email = doctor.user.email
        result.append(out)
    return result


@router.post("/doctors/{doctor_id}/verify", response_model=schemas.PendingDoctorOut)
def verify_doctor(
    doctor_id: str,
    payload: schemas.VerifyDoctorIn,
    staff: User = Depends(current_staff),
    db: Session = Depends(get_db),
):
    doctor = db.get(Doctor, doctor_id)
    if not doctor:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Doctor not found.")

    if payload.approve:
        doctor.verification_status = VerificationStatus.VERIFIED
        doctor.verified_at = utcnow()
        doctor.verified_by_id = staff.id
        doctor.rejection_reason = ""
        title, body = "Your account is verified", "You can now submit aligner cases."
    else:
        if not payload.reason.strip():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Give a reason for the rejection.")
        doctor.verification_status = VerificationStatus.REJECTED
        doctor.rejection_reason = payload.reason
        title, body = "Verification was not approved", payload.reason

    db.add(Notification(user_id=doctor.user_id, title=title, body=body))
    db.commit()
    db.refresh(doctor)

    out = schemas.PendingDoctorOut.model_validate(doctor)
    out.email = doctor.user.email
    return out


# --------------------------------------------------------------------------


def _all_delivered(order: Order) -> bool:
    aligner_shipments = [
        s for s in order.shipments if s.shipment_type != ShipmentType.TRAINING_ALIGNER
    ]
    return bool(aligner_shipments) and all(
        s.status == ShipmentStatus.DELIVERED for s in aligner_shipments
    )
