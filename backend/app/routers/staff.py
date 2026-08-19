"""Staff-facing endpoints.

The portal is built for a single lab account, so there is no assignment or claim
step — any STAFF user acts on any order.
"""

from __future__ import annotations

from typing import Optional

from decimal import ROUND_HALF_UP, Decimal
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import any_order, current_admin
from ..enums import (
    FileCategory,
    ALIGNER_CATEGORIES,
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
    category_for_count,
    category_label,
)
from ..models import (
    AlignerPrice,
    Doctor,
    Invoice,
    Notification,
    Order,
    Patient,
    Quote,
    QuoteLineItem,
    Shipment,
    TreatmentPlan,
    User,
    utcnow,
)
from ..serializers import order_detail, order_summary
from ..services import billing, pricing, shipments
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
def queue(staff: User = Depends(current_admin), db: Session = Depends(get_db)):
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
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    staff: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    """A page of cases, newest first.

    The search runs in the database rather than over an already-truncated page:
    filtering in Python after a cap means a lab with 500 cases can search for a
    case and be told it does not exist.
    """
    query = db.query(Order)
    if order_status:
        query = query.filter(Order.status == order_status)

    if search and search.strip():
        needle = f"%{search.strip().lower()}%"
        query = (
            query.join(Order.patient)
            .join(Order.doctor)
            .filter(
                or_(
                    func.lower(Order.enquiry_number).like(needle),
                    func.lower(func.coalesce(Order.order_number, "")).like(needle),
                    func.lower(Patient.full_name).like(needle),
                    func.lower(Doctor.full_name).like(needle),
                    func.lower(func.coalesce(Doctor.clinic_name, "")).like(needle),
                )
            )
        )

    orders = (
        query.order_by(Order.created_at.desc()).offset(offset).limit(limit).all()
    )
    return [order_summary(o) for o in orders]


@router.get("/orders/{order_id}", response_model=schemas.OrderDetail)
def get_order(order_id: str, staff: User = Depends(current_admin), db: Session = Depends(get_db)):
    return order_detail(any_order(order_id, db), UserRole.ADMIN)


# --------------------------------------------------------------------------
# Review and quoting
# --------------------------------------------------------------------------


@router.post("/orders/{order_id}/start-review", response_model=schemas.OrderDetail)
def start_review(order_id: str, staff: User = Depends(current_admin), db: Session = Depends(get_db)):
    order = any_order(order_id, db)
    assert_status(order, OrderStatus.SUBMITTED)
    transition(db, order, OrderStatus.UNDER_REVIEW, staff)
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.ADMIN)


@router.post("/orders/{order_id}/request-records", response_model=schemas.OrderDetail)
def request_records(
    order_id: str,
    payload: schemas.RecordsRequestIn,
    staff: User = Depends(current_admin),
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
    return order_detail(order, UserRole.ADMIN)


@router.get("/pricing", response_model=list[schemas.AlignerPriceOut])
def read_pricing(staff: User = Depends(current_admin), db: Session = Depends(get_db)):
    return [_price_out(row) for row in pricing.ensure_prices(db)]


@router.put("/pricing", response_model=list[schemas.AlignerPriceOut])
def update_pricing(
    payload: schemas.PricingIn,
    staff: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    pricing.ensure_prices(db)
    for entry in payload.prices:
        row = db.get(AlignerPrice, entry.category)
        if row is None:
            row = AlignerPrice(category=entry.category)
            db.add(row)
        if entry.price_max < entry.price_min:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"{category_label(entry.category)}: the upper price cannot be below the lower one.",
            )
        row.price_min = pricing.money(entry.price_min)
        row.price_max = pricing.money(entry.price_max)
        row.is_active = entry.is_active
    db.commit()
    return [_price_out(row) for row in pricing.price_list(db)]


def _price_out(row) -> schemas.AlignerPriceOut:
    label, low, high = ALIGNER_CATEGORIES[row.category]
    out = schemas.AlignerPriceOut.model_validate(row)
    out.label, out.range_from, out.range_to = label, low, high
    return out


@router.post("/orders/{order_id}/quotes", response_model=schemas.OrderDetail)
def send_quote(
    order_id: str,
    payload: schemas.QuoteIn,
    staff: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    """The expected quote. The lab reads the clinical photographs, picks the
    aligner band it thinks the case falls into, and that band's fixed price is
    the estimate the clinic approves before any scan happens."""
    order = any_order(order_id, db)
    assert_status(order, OrderStatus.UNDER_REVIEW, OrderStatus.QUOTED)

    pricing.ensure_prices(db)
    band = pricing.range_for(db, payload.category)
    if band is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{category_label(payload.category)} is not currently offered. Enable it in Settings.",
        )
    price_low, price_high = band

    for existing in order.quotes:
        if existing.status == QuoteStatus.SENT:
            existing.status = QuoteStatus.SUPERSEDED

    extras_total = money(
        sum((Decimal(i.unit_price) * i.quantity for i in payload.extras), Decimal("0"))
    )
    subtotal = money(price_low + extras_total)
    subtotal_max = money(price_high + extras_total)
    tax = money(payload.tax)
    total = money(subtotal + tax)
    total_max = money(subtotal_max + tax)

    quote = Quote(
        order_id=order.id,
        version=len(order.quotes) + 1,
        category=payload.category,
        category_price=price_low,
        category_price_max=price_high,
        subtotal=subtotal,
        subtotal_max=subtotal_max,
        tax=tax,
        total=total,
        total_max=total_max,
        currency=payload.currency,
        notes=payload.notes,
        status=QuoteStatus.SENT,
        created_by_id=staff.id,
        sent_at=utcnow(),
    )
    db.add(quote)
    db.flush()

    # The band itself is the first line; anything else the lab adds sits under it.
    db.add(
        QuoteLineItem(
            quote_id=quote.id,
            description=f"{category_label(payload.category)} — clear aligner treatment",
            unit_price=price_low,
            quantity=1,
            amount=price_low,
        )
    )
    for item in payload.extras:
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
        note=f"Expected quote v{quote.version} — {category_label(payload.category)}, "
        f"{quote.currency} {total}–{total_max}.",
    )
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.ADMIN)


# --------------------------------------------------------------------------
# Scan and planning
# --------------------------------------------------------------------------


@router.post("/orders/{order_id}/scan/accept", response_model=schemas.OrderDetail)
def accept_scan(
    order_id: str,
    payload: schemas.NoteIn,
    staff: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    order = any_order(order_id, db)
    assert_status(order, OrderStatus.SCAN_SUBMITTED)
    if not order.has_intraoral_scan:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "There is no intraoral scan on this case. Upload the STL before accepting it.",
        )
    # A visit is normally closed by the scan upload, but a scan can also arrive
    # by another route while a booking is still open — close it either way.
    booking = order.appointment
    if booking is not None and booking.is_live:
        booking.status = AppointmentStatus.COMPLETED
        booking.completed_at = utcnow()
    order.records_request_note = ""
    transition(db, order, OrderStatus.IN_PLANNING, staff, note=payload.note or "Scan accepted.")
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.ADMIN)


@router.post("/orders/{order_id}/scan/reject", response_model=schemas.OrderDetail)
def reject_scan(
    order_id: str,
    payload: schemas.RecordsRequestIn,
    staff: User = Depends(current_admin),
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
    return order_detail(order, UserRole.ADMIN)


@router.post("/orders/{order_id}/plans", response_model=schemas.OrderDetail)
def share_plan(
    order_id: str,
    payload: schemas.PlanIn,
    staff: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    order = any_order(order_id, db)
    assert_status(order, OrderStatus.IN_PLANNING)

    for existing in order.plans:
        if existing.status != PlanStatus.APPROVED:
            existing.status = PlanStatus.SUPERSEDED

    # The plan gives an exact aligner count, so this is where the estimate
    # becomes the real price. The lab types the figure; the band is recorded
    # alongside it for reporting but never gates anything.
    total_aligners = payload.aligners_upper + payload.aligners_lower
    final_price = money(payload.final_price)
    final_tax = money(payload.final_tax)
    if final_price <= 0:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Enter the final price for this case before sharing the plan.",
        )
    # The clinic is being asked to approve movement it can only judge by seeing
    # it, so the staged models are a prerequisite rather than a nicety.
    if not any(
        f.category == FileCategory.SIMULATION_MODEL and not f.is_deleted for f in order.files
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Attach the simulation files before sharing the plan — the clinic reviews the "
            "movement in 3D, not the aligner count alone.",
        )
    if not any(
        f.category == FileCategory.TREATMENT_PLAN and not f.is_deleted for f in order.files
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Attach the treatment plan document before sharing the plan.",
        )

    final_category = category_for_count(total_aligners)

    plan = TreatmentPlan(
        order_id=order.id,
        version=len(order.plans) + 1,
        aligners_upper=payload.aligners_upper,
        aligners_lower=payload.aligners_lower,
        final_category=final_category,
        final_price=final_price,
        final_tax=final_tax,
        final_total=money(final_price + final_tax),
        ipr_required=payload.ipr_required,
        attachments_required=payload.attachments_required,
        summary=payload.summary,
        status=PlanStatus.SHARED,
        created_by_id=staff.id,
        shared_at=utcnow(),
    )
    db.add(plan)

    # The expected quote was a placeholder read off the photographs. Now that
    # the plan gives a real figure, that figure *is* the quote — overwrite it
    # rather than leaving two prices on the case. The estimate stays in the
    # timeline for anyone who needs to see what changed.
    live_quote = order.accepted_quote or order.current_quote
    if live_quote is not None:
        previous_total = live_quote.total
        # Both ends of the range collapse onto the one real figure.
        live_quote.category_price = final_price
        live_quote.category_price_max = final_price
        live_quote.subtotal = final_price
        live_quote.subtotal_max = final_price
        live_quote.tax = final_tax
        live_quote.total = plan.final_total
        live_quote.total_max = plan.final_total
        live_quote.is_final = True
        for index, item in enumerate(live_quote.line_items):
            if index == 0:
                item.description = (
                    f"Clear aligner treatment — {total_aligners} aligners"
                )
                item.unit_price = final_price
                item.quantity = 1
                item.amount = final_price
            else:
                db.delete(item)
    else:
        previous_total = None

    transition(
        db,
        order,
        OrderStatus.PLAN_SHARED,
        staff,
        note=f"Treatment plan v{plan.version} shared — {total_aligners} aligners. "
        f"Price set to {plan.final_total}"
        + (f", replacing the estimated range from {previous_total}." if previous_total is not None else "."),
    )
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.ADMIN)


@router.post("/orders/{order_id}/fit-issue/resolve", response_model=schemas.OrderDetail)
def resolve_fit_issue(
    order_id: str,
    resolution: str = Query(..., pattern="^(rescan|replan|refabricate)$"),
    staff: User = Depends(current_admin),
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
    return order_detail(order, UserRole.ADMIN)


# --------------------------------------------------------------------------
# Shipments
# --------------------------------------------------------------------------


@router.post("/orders/{order_id}/shipments", response_model=schemas.OrderDetail)
def create_shipment(
    order_id: str,
    payload: schemas.ShipmentIn,
    staff: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    order = any_order(order_id, db)

    range_from = None
    range_to = payload.aligner_range_to
    phase_number = phase_round = None

    if payload.shipment_type == ShipmentType.TRAINING_ALIGNER:
        assert_status(order, OrderStatus.TRAINING_ALIGNER_PRODUCTION)
        next_status = OrderStatus.TRAINING_ALIGNER_SHIPPED
    else:
        assert_status(order, OrderStatus.ALIGNER_PRODUCTION, OrderStatus.DISPATCHING)
        next_status = OrderStatus.DISPATCHING

        # A phase cannot go out until the clinic has received the previous one
        # and said whether to carry on — same shape as the training aligner.
        blocker = order.phase_blocker
        if blocker:
            raise HTTPException(status.HTTP_409_CONFLICT, blocker)

        if payload.shipment_type == ShipmentType.ALIGNER_PHASE:
            phase_number, phase_round = order.next_phase_label
            range_from, ceiling = order.next_phase_range
            if range_to is None:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"Say which aligner this phase runs to. It starts at {range_from}.",
                )
            if range_to < range_from:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"This phase starts at aligner {range_from}, so it cannot end at {range_to}.",
                )
            if ceiling and range_to > ceiling:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"The plan has {order.total_aligners} aligners; this phase cannot run past that.",
                )
        else:
            # A full-case dispatch covers everything in one go.
            phase_number = phase_round = None
            range_from, range_to = 1, order.total_aligners or None

    shipment = Shipment(
        order_id=order.id,
        shipment_type=payload.shipment_type,
        fit_round=order.fit_round if payload.shipment_type == ShipmentType.TRAINING_ALIGNER else None,
        phase_number=phase_number,
        phase_round=phase_round,
        aligner_range_from=range_from,
        aligner_range_to=range_to,
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
        elif phase_number:
            label = f"phase {phase_number}"
            if phase_round and phase_round > 1:
                label += f" round {phase_round}"
            label += f" (aligners {range_from}–{range_to})"
        elif range_from and range_to:
            label = f"{label} (aligners {range_from}–{range_to})"
        transition(
            db,
            order,
            next_status,
            staff,
            note=f"{label} shipped — {payload.carrier} {payload.tracking_number}".strip(),
        )
    else:
        span = f"aligners {range_from}–{range_to}" if range_from and range_to else ""
        db.add(
            Notification(
                user_id=order.doctor.user_id,
                order_id=order.id,
                title="Another shipment is on its way",
                body=f"{order.reference} — {span} {payload.carrier} {payload.tracking_number}".strip(),
            )
        )

    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.ADMIN)


@router.patch("/shipments/{shipment_id}", response_model=schemas.OrderDetail)
def update_shipment(
    shipment_id: str,
    payload: schemas.ShipmentUpdateIn,
    staff: User = Depends(current_admin),
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
        shipments.mark_delivered(db, shipment, staff)

    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.ADMIN)


@router.post("/orders/{order_id}/complete", response_model=schemas.OrderDetail)
def complete_order(
    order_id: str, staff: User = Depends(current_admin), db: Session = Depends(get_db)
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
    return order_detail(order, UserRole.ADMIN)


@router.post("/orders/{order_id}/cancel", response_model=schemas.OrderDetail)
def cancel_order(
    order_id: str,
    payload: schemas.CancelIn,
    staff: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    order = any_order(order_id, db)
    order.cancel_reason = payload.reason
    transition(db, order, OrderStatus.CANCELLED, staff, note=payload.reason)
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.ADMIN)


# --------------------------------------------------------------------------
# Invoicing
# --------------------------------------------------------------------------


@router.post("/orders/{order_id}/invoice", response_model=schemas.OrderDetail)
def generate_invoice(
    order_id: str, staff: User = Depends(current_admin), db: Session = Depends(get_db)
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

    # Bill the treatment plan's confirmed price where there is one — the quote
    # was only ever an estimate from the photographs.
    plan = order.approved_plan
    billed_total = plan.final_total if plan is not None and plan.final_total else quote.total
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
        amount=money(billed_total),
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
            body=f"{order.reference} — {quote.currency} {billed_total}",
        )
    )
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.ADMIN)


# --------------------------------------------------------------------------
# Doctor verification
# --------------------------------------------------------------------------


@router.get("/doctors", response_model=list[schemas.PendingDoctorOut])
def list_doctors(
    pending_only: bool = Query(default=False),
    search: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    staff: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    query = db.query(Doctor)
    if pending_only:
        query = query.filter(Doctor.verification_status == VerificationStatus.PENDING)
    if search and search.strip():
        needle = f"%{search.strip().lower()}%"
        query = query.filter(
            or_(
                func.lower(Doctor.full_name).like(needle),
                func.lower(func.coalesce(Doctor.clinic_name, "")).like(needle),
            )
        )

    result = []
    for doctor in (
        query.order_by(Doctor.created_at.desc()).offset(offset).limit(limit).all()
    ):
        out = schemas.PendingDoctorOut.model_validate(doctor)
        out.email = doctor.user.email
        result.append(out)
    return result


@router.post("/doctors/{doctor_id}/verify", response_model=schemas.PendingDoctorOut)
def verify_doctor(
    doctor_id: str,
    payload: schemas.VerifyDoctorIn,
    staff: User = Depends(current_admin),
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
