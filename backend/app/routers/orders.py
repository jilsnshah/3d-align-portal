"""Doctor-facing order endpoints.

Every handler resolves the order through ``owned_order``, which filters on the
calling doctor. Status changes go through ``transitions.transition``.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import current_user, owned_order, verified_doctor
from ..enums import (
    DOCTOR_ACTION_STATUSES,
    PhaseDecision,
    ShipmentStatus,
    ShipmentType,
    OrderStatus,
    PlanStatus,
    QuoteStatus,
    ScanRoute,
    UserRole,
)
from ..models import Address, Doctor, FitReview, Notification, Order, Patient, User, utcnow
from ..serializers import missing_categories, order_detail, order_summary
from ..services.numbering import next_enquiry_number
from ..services import shipments
from ..services.storage import get_storage
from ..transitions import assert_status, transition

router = APIRouter(prefix="/orders", tags=["orders"])


@router.get("", response_model=list[schemas.OrderSummary])
def list_orders(
    needs_action: bool = Query(default=False),
    search: Optional[str] = Query(default=None),
    patient_id: Optional[str] = Query(default=None),
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    doctor: Doctor = Depends(verified_doctor),
    db: Session = Depends(get_db),
):
    """A page of the clinic's cases, newest first. A busy practice accumulates
    hundreds, and none of them need to arrive at once.

    Searching runs in the database so a case on page nine is still findable.
    """
    query = db.query(Order).filter(Order.doctor_id == doctor.id)
    if needs_action:
        query = query.filter(Order.status.in_(list(DOCTOR_ACTION_STATUSES)))
    if patient_id:
        query = query.filter(Order.patient_id == patient_id)
    if search and search.strip():
        needle = f"%{search.strip().lower()}%"
        query = query.join(Order.patient).filter(
            or_(
                func.lower(Order.enquiry_number).like(needle),
                func.lower(func.coalesce(Order.order_number, "")).like(needle),
                func.lower(Patient.full_name).like(needle),
                func.lower(func.coalesce(Patient.external_ref, "")).like(needle),
            )
        )
    orders = query.order_by(Order.created_at.desc()).offset(offset).limit(limit).all()
    return [order_summary(o) for o in orders]


@router.post("", response_model=schemas.OrderDetail, status_code=status.HTTP_201_CREATED)
def create_order(
    payload: schemas.OrderCreateIn,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    patient = _resolve_patient(db, doctor, payload)
    address = _resolve_address(db, doctor, payload.shipping_address_id)

    order = Order(
        enquiry_number=next_enquiry_number(db),
        doctor_id=doctor.id,
        patient_id=patient.id,
        arch=payload.arch,
        priority=payload.priority,
        chief_complaint=payload.chief_complaint,
        clinical_notes=payload.clinical_notes,
        shipping_address_id=address.id if address else None,
        status=OrderStatus.DRAFT,
    )
    db.add(order)
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


@router.get("/{order_id}", response_model=schemas.OrderDetail)
def get_order(
    order_id: str,
    doctor: Doctor = Depends(verified_doctor),
    db: Session = Depends(get_db),
):
    return order_detail(owned_order(order_id, db, doctor))


@router.patch("/{order_id}", response_model=schemas.OrderDetail)
def update_order(
    order_id: str,
    payload: schemas.OrderUpdateIn,
    doctor: Doctor = Depends(verified_doctor),
    db: Session = Depends(get_db),
):
    order = owned_order(order_id, db, doctor)
    if order.status != OrderStatus.DRAFT:
        raise HTTPException(status.HTTP_409_CONFLICT, "Only draft orders can be edited.")

    data = payload.model_dump(exclude_unset=True)
    if "shipping_address_id" in data:
        address = _resolve_address(db, doctor, data.pop("shipping_address_id"))
        order.shipping_address_id = address.id if address else None
    for key, value in data.items():
        setattr(order, key, value)

    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


def _set_delivery_address(db, order, doctor, address_id) -> None:
    """Confirms where the next parcel goes.

    A practice can run several clinics, so the address is chosen at the moment
    of dispatch rather than inherited from whenever the case was opened. Silently
    ignoring an unknown id would ship to the wrong building, so it is rejected.
    """
    if not address_id:
        return
    address = (
        db.query(Address)
        .filter(Address.id == address_id, Address.doctor_id == doctor.id)
        .one_or_none()
    )
    if address is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That delivery address is not yours.")
    order.shipping_address_id = address.id


@router.post("/{order_id}/submit", response_model=schemas.OrderDetail)
def submit_order(
    order_id: str,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    order = owned_order(order_id, db, doctor)
    assert_status(order, OrderStatus.DRAFT)

    blockers = order.submit_blockers
    if blockers:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Still needed before this can be submitted — " + "; ".join(blockers) + ".",
        )
    if not order.shipping_address_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Choose a shipping address before submitting.")

    if not order.storage_folder_ref:
        order.storage_folder_ref = get_storage().ensure_order_folder(order.reference)

    transition(db, order, OrderStatus.SUBMITTED, user)
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


@router.post("/{order_id}/resubmit", response_model=schemas.OrderDetail)
def resubmit_records(
    order_id: str,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    order = owned_order(order_id, db, doctor)
    assert_status(order, OrderStatus.RECORDS_REQUESTED)
    transition(db, order, OrderStatus.UNDER_REVIEW, user, note="Additional records supplied.")
    order.records_request_note = ""
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


@router.post("/{order_id}/quote/accept", response_model=schemas.OrderDetail)
def accept_quote(
    order_id: str,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    order = owned_order(order_id, db, doctor)
    assert_status(order, OrderStatus.QUOTED)

    quote = order.current_quote
    if quote is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "There is no quote on this order.")

    quote.status = QuoteStatus.ACCEPTED
    quote.responded_at = utcnow()
    transition(
        db,
        order,
        OrderStatus.AWAITING_SCAN,
        user,
        note=f"Quote v{quote.version} accepted — {quote.currency} {quote.total}.",
    )
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


@router.post("/{order_id}/scan-route", response_model=schemas.OrderDetail)
def choose_scan_route(
    order_id: str,
    payload: schemas.ScanRouteIn,
    doctor: Doctor = Depends(verified_doctor),
    db: Session = Depends(get_db),
):
    """Records how the scan will arrive. Booking a technician visit goes through
    POST /orders/{id}/appointment instead, because it has to allocate a person."""
    order = owned_order(order_id, db, doctor)
    assert_status(order, OrderStatus.AWAITING_SCAN)

    if payload.route == ScanRoute.APPOINTMENT:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Pick a slot from the calendar to book a technician visit.",
        )

    order.scan_route = payload.route
    if payload.route == ScanRoute.COURIER:
        order.scan_courier_tracking = payload.courier_tracking

    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


@router.post("/{order_id}/plan/respond", response_model=schemas.OrderDetail)
def respond_to_plan(
    order_id: str,
    payload: schemas.PlanRespondIn,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    order = owned_order(order_id, db, doctor)
    assert_status(order, OrderStatus.PLAN_SHARED)
    _set_delivery_address(db, order, doctor, payload.shipping_address_id)

    plan = order.current_plan
    if plan is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "There is no treatment plan on this order.")

    plan.responded_at = utcnow()
    if payload.approve:
        plan.status = PlanStatus.APPROVED
        transition(
            db,
            order,
            OrderStatus.TRAINING_ALIGNER_PRODUCTION,
            user,
            note=f"Treatment plan v{plan.version} approved.",
        )
    else:
        if not payload.revision_notes.strip():
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Say what needs changing so the lab can revise the plan."
            )
        plan.status = PlanStatus.REVISION_REQUESTED
        plan.revision_notes = payload.revision_notes
        transition(db, order, OrderStatus.IN_PLANNING, user, note=payload.revision_notes)

    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


@router.post(
    "/{order_id}/shipments/{shipment_id}/delivered", response_model=schemas.OrderDetail
)
def confirm_delivery(
    order_id: str,
    shipment_id: str,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """The clinic confirms a parcel arrived. It cannot edit carrier or tracking —
    only say that what the lab sent has landed."""
    order = owned_order(order_id, db, doctor)
    shipment = next((s for s in order.shipments if s.id == shipment_id), None)
    if shipment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Shipment not found.")

    shipments.mark_delivered(db, shipment, user)
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


def _is_final_phase(order, shipment) -> bool:
    total = order.total_aligners
    return bool(total and shipment.aligner_range_to and shipment.aligner_range_to >= total)


@router.post(
    "/{order_id}/shipments/{shipment_id}/phase-decision", response_model=schemas.OrderDetail
)
def decide_phase(
    order_id: str,
    shipment_id: str,
    payload: schemas.PhaseDecisionIn,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """After receiving a phase the clinic either moves on or asks for it again —
    the same choice as the training aligner, one step down. Until this is
    answered the lab cannot ship the next batch."""
    order = owned_order(order_id, db, doctor)
    shipment = next((s for s in order.shipments if s.id == shipment_id), None)
    if shipment is None or shipment.shipment_type != ShipmentType.ALIGNER_PHASE:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Phase not found.")
    if shipment.status != ShipmentStatus.DELIVERED:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Confirm you have received this phase first."
        )
    if shipment.phase_decision is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "You have already answered for this phase.")

    _set_delivery_address(db, order, doctor, payload.shipping_address_id)
    shipment.phase_decision = payload.decision
    shipment.decision_notes = payload.notes

    if payload.decision == PhaseDecision.REPEAT:
        # Same shape as a fit issue: the batch goes back to the bench, and the
        # replacement ships as the next round of the same phase.
        number, next_round = order.next_phase_label
        transition(
            db,
            order,
            OrderStatus.ALIGNER_PRODUCTION,
            user,
            note=f"Phase {shipment.phase_number} to be remade as round {next_round}. "
            + (payload.notes or ""),
        )
    elif _is_final_phase(order, shipment):
        # Accepting the batch that carries the last aligner is what finishes the
        # case — the clinic confirms the fit rather than it completing silently.
        transition(
            db,
            order,
            OrderStatus.COMPLETED,
            user,
            note=f"Final phase accepted — all {order.total_aligners} aligners delivered and fitting.",
        )
    else:
        start, _ = order.next_phase_range
        for member in db.query(User).filter(User.role == UserRole.ADMIN, User.is_active.is_(True)):
            db.add(
                Notification(
                    user_id=member.id,
                    order_id=order.id,
                    title="Ready for the next phase",
                    body=f"{order.reference} — continue from aligner {start}.",
                )
            )

    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


@router.post("/{order_id}/fit-review", response_model=schemas.OrderDetail)
def submit_fit_review(
    order_id: str,
    payload: schemas.FitReviewIn,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Fit verdict and dispatch preference in one submission."""
    order = owned_order(order_id, db, doctor)
    assert_status(order, OrderStatus.FIT_REVIEW)
    _set_delivery_address(db, order, doctor, payload.shipping_address_id)

    training = next(
        (
            s
            for s in reversed(order.shipments)
            if s.shipment_type == "TRAINING_ALIGNER" and s.fit_round == order.fit_round
        ),
        None,
    )

    if payload.fits:
        if payload.dispatch_mode is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Choose whether the remaining aligners ship in full or in phases.",
            )
        db.add(
            FitReview(
                order_id=order.id,
                shipment_id=training.id if training else None,
                fit_round=order.fit_round,
                outcome="FITS",
                reported_by_id=user.id,
            )
        )
        order.dispatch_mode = payload.dispatch_mode
        transition(
            db,
            order,
            OrderStatus.ALIGNER_PRODUCTION,
            user,
            note=f"Fit confirmed. Dispatch mode: {payload.dispatch_mode.lower()}.",
        )
    else:
        if not payload.issue_notes.strip():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Describe the fit issue.")
        db.add(
            FitReview(
                order_id=order.id,
                shipment_id=training.id if training else None,
                fit_round=order.fit_round,
                outcome="ISSUE_REPORTED",
                issue_notes=payload.issue_notes,
                reported_by_id=user.id,
            )
        )
        transition(db, order, OrderStatus.FIT_ISSUE, user, note=payload.issue_notes)

    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


@router.post("/{order_id}/cancel", response_model=schemas.OrderDetail)
def cancel_draft(
    order_id: str,
    payload: schemas.CancelIn,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Doctors may cancel only before the case reaches the lab."""
    order = owned_order(order_id, db, doctor)
    assert_status(order, OrderStatus.DRAFT)
    order.cancel_reason = payload.reason
    transition(db, order, OrderStatus.CANCELLED, user, note=payload.reason)
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


# --------------------------------------------------------------------------


def _resolve_patient(db: Session, doctor: Doctor, payload: schemas.OrderCreateIn) -> Patient:
    if payload.patient_id:
        patient = db.get(Patient, payload.patient_id)
        if not patient or patient.doctor_id != doctor.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Patient not found.")
        return patient
    if payload.new_patient:
        patient = Patient(doctor_id=doctor.id, **payload.new_patient.model_dump())
        db.add(patient)
        db.flush()
        return patient
    raise HTTPException(status.HTTP_400_BAD_REQUEST, "Choose an existing patient or add a new one.")


def _resolve_address(db: Session, doctor: Doctor, address_id: Optional[str]) -> Optional[Address]:
    if address_id:
        address = db.get(Address, address_id)
        if not address or address.doctor_id != doctor.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Address not found.")
        return address
    return (
        db.query(Address)
        .filter(Address.doctor_id == doctor.id, Address.is_default_shipping.is_(True))
        .first()
    )
