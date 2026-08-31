"""Doctor-facing order endpoints.

Every handler resolves the order through ``owned_order``, which filters on the
calling doctor. Status changes go through ``transitions.transition``.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import current_user, owned_order, verified_doctor
from ..enums import (
    CATEGORY_FOLDER,
    STATUS_LABELS,
    DOCTOR_ACTION_STATUSES,
    FILE_GROUP,
    MIN_STEPS_PER_PHASE,
    SLOT_LABELS,
    DispatchMode,
    FileCategory,
    AWAITING_LAB,
    Arch,
    PaymentKind,
    PaymentStatus,
    PhaseIssueResolution,
    PhaseStatus,
    Slot,
    PhaseDecision,
    ShipmentStatus,
    ShipmentType,
    OrderKind,
    OrderStatus,
    PlanStatus,
    QuoteStatus,
    ScanRoute,
    UserRole,
)
from ..models import (
    Address,
    Doctor,
    FitReview,
    Notification,
    Order,
    OrderFile,
    PhaseFitIssue,
    PhaseIssueMessage,
    Patient,
    Product,
    User,
    utcnow,
)
from ..serializers import missing_categories, order_detail, order_summary
from ..transitions import transition
from ..services.numbering import next_enquiry_number
from ..services import catalogue
from ..services import scans as scan_service
from ..services import shipments
from ..services.storage import get_storage
from ..services import payments as payment_service
from ..services import phases as phase_service
from .files import guess_mime
from ..transitions import assert_status, transition

router = APIRouter(prefix="/orders", tags=["orders"])


@router.get("", response_model=list[schemas.OrderSummary])
def list_orders(
    needs_action: bool = Query(default=False),
    series: Optional[str] = Query(
        default=None, pattern="^(enquiry|aligner|product|accessory)$"
    ),
    search: Optional[str] = Query(default=None),
    patient_id: Optional[str] = Query(default=None),
    address_id: Optional[str] = Query(default=None),
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    doctor: Doctor = Depends(verified_doctor),
    db: Session = Depends(get_db),
):
    """A page of the clinic's cases, newest first. A busy practice accumulates
    hundreds, and none of them need to arrive at once.

    Searching runs in the database so a case on page nine is still findable.

    A practice running several branches reads one list of everything by default
    and narrows to a branch with address_id — the branch being the delivery
    address the case ships to, which is the only thing that distinguishes one
    from another on an order.
    """
    query = db.query(Order).filter(Order.doctor_id == doctor.id)
    if needs_action:
        query = query.filter(Order.status.in_(list(DOCTOR_ACTION_STATUSES)))
    # An enquiry has no number yet; a case in the aligner series does. A product
    # order carries a number too, from its own product's series, so the kind is
    # what separates the two.
    if series == "enquiry":
        query = query.filter(Order.order_number.is_(None))
    elif series == "aligner":
        query = query.filter(
            Order.order_number.isnot(None), Order.kind == OrderKind.ALIGNER
        )
    elif series == "product":
        query = query.filter(Order.kind == OrderKind.PRODUCT)
    elif series == "accessory":
        query = query.filter(Order.kind == OrderKind.ACCESSORY)
    if patient_id:
        query = query.filter(Order.patient_id == patient_id)
    if address_id:
        # Confirm it is this doctor's before filtering on it, so a stray id
        # returns nothing rather than quietly listing every case.
        owned = (
            db.query(Address.id)
            .filter(Address.id == address_id, Address.doctor_id == doctor.id)
            .first()
        )
        if owned is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Address not found.")
        query = query.filter(Order.shipping_address_id == address_id)
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
    return [order_summary(o, UserRole.DOCTOR) for o in orders]


@router.post("", response_model=schemas.OrderDetail, status_code=status.HTTP_201_CREATED)
def create_order(
    payload: schemas.OrderCreateIn,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    patient = _resolve_patient(db, doctor, payload)
    address = _resolve_address(db, doctor, payload.shipping_address_id)

    # A by-product ships before it is paid for, so the brake is here: one
    # unsettled appliance at a time. Checked before anything is created, so a
    # blocked clinic never ends up with a half-built draft it cannot use.
    if payload.product_id:
        outstanding = payment_service.unsettled_product_order(db, doctor.id)
        if outstanding is not None:
            row = next(
                (p for p in outstanding.payments if p.kind == PaymentKind.PRODUCT_ORDER),
                None,
            )
            waiting = (
                "the receipt is with 3D Align for checking"
                if row is not None and row.status == PaymentStatus.SUBMITTED
                else "it has not been paid for yet"
            )
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"{outstanding.reference} is still open — {waiting}. "
                "Settle that order before starting another appliance.",
            )

    product = size = None
    if payload.product_id:
        product = db.get(Product, payload.product_id)
        if product is None or not product.is_active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "That product is not available.")
        size = catalogue.size_of(product, payload.product_size_id)
        if size is None:
            # A product with one form needs no choice; one with several does,
            # and picking for the clinic would be guessing at a clinical call.
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Choose a size for the {product.name}.",
            )
        if payload.extra_teeth and not product.per_tooth_price:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"The {product.name} is not priced per tooth.",
            )

    # An order with shelf items and no appliance is an accessory order; one
    # with both is a product order carrying extras. Nothing at all is an
    # aligner case, which is unchanged by any of this.
    if product is not None:
        kind = OrderKind.PRODUCT
    elif payload.accessories:
        kind = OrderKind.ACCESSORY
    else:
        kind = OrderKind.ALIGNER

    order = Order(
        enquiry_number=next_enquiry_number(db),
        doctor_id=doctor.id,
        patient_id=patient.id,
        kind=kind,
        product_id=product.id if product else None,
        product_size_id=size.id if size else None,
        quantity=payload.quantity,
        extra_teeth=payload.extra_teeth,
        arch=payload.arch,
        priority=payload.priority,
        chief_complaint=payload.chief_complaint,
        clinical_notes=payload.clinical_notes,
        shipping_address_id=address.id if address else None,
        status=OrderStatus.DRAFT,
    )
    db.add(order)
    if payload.accessories:
        _set_accessories(db, order, payload.accessories)

    # A fixed-price order has nothing left to fill in, so it does not sit as a
    # draft waiting to be submitted — placing it is what starts it. An aligner
    # case still opens as a draft, because its records are gathered there.
    if kind in (OrderKind.PRODUCT, OrderKind.ACCESSORY) and order.shipping_address_id:
        db.flush()
        if not order.storage_folder_ref:
            order.storage_folder_ref = get_storage().ensure_order_folder(order.reference)
        _begin(db, order, user)

    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


def _set_accessories(db: Session, order: Order, lines) -> None:
    """Replace the order's shelf items, refusing anything not on the shelf."""
    from ..services import accessories as accessory_service

    try:
        accessory_service.set_lines(db, order, lines)
    except KeyError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "One of those accessories is not available."
        )


@router.get("/{order_id}", response_model=schemas.OrderDetail)
def get_order(
    order_id: str,
    doctor: Doctor = Depends(verified_doctor),
    db: Session = Depends(get_db),
):
    return _with_payments(owned_order(order_id, db, doctor), db, UserRole.DOCTOR)


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
    # Accessories are rows, not a column: setattr would put Pydantic models
    # into the relationship. Pulled out before the generic pass below.
    if "accessories" in data:
        lines = data.pop("accessories") or []
        if order.kind == OrderKind.ALIGNER:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Accessories go on a product order or an order of their own.",
            )
        _set_accessories(db, order, lines)
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


def _begin(db: Session, order: Order, user: User) -> None:
    """Start the order on whatever its first real stage is.

    An aligner case is submitted for the lab to read: it needs photographs
    looked at and a band picked before anyone knows what it costs, so it waits
    at SUBMITTED.

    A by-product and an accessory are sold at a catalogue price that was fixed
    long before the order existed. There is nothing to estimate and nothing to
    accept, so placing the order is the whole of the decision — the by-product
    goes to the scan it is made from, and the accessory to the shelf.
    """
    if order.kind == OrderKind.PRODUCT:
        transition(
            db,
            order,
            OrderStatus.AWAITING_SCAN,
            user,
            note="Ordered at the catalogue price — waiting on the scan.",
        )
    elif order.kind == OrderKind.ACCESSORY:
        transition(
            db,
            order,
            OrderStatus.PRODUCT_FABRICATION,
            user,
            note="Accessories only — nothing to make, straight to packing.",
        )
    else:
        transition(db, order, OrderStatus.SUBMITTED, user)


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

    _begin(db, order, user)
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


def _with_payments(order, db, role):
    """Bring the case's charges up to date, then render it.

    Amounts follow the plan and the phase split, both of which can change before
    anything is paid, so they are recomputed on read rather than frozen at the
    moment a charge happens to be raised. A settled payment is never re-priced.
    """
    payment_service.sync(db, order)
    db.commit()
    db.refresh(order)
    return order_detail(order, role)


@router.post("/{order_id}/payments/{payment_id}/proof", response_model=schemas.OrderDetail)
async def upload_payment_proof(
    order_id: str,
    payment_id: str,
    reference: str = Form(default=""),
    note: str = Form(default=""),
    upload: UploadFile = File(...),
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """The clinic sends the screenshot of a completed UPI transfer.

    Nothing is charged through the portal, so the receipt is the only record the
    lab has that the money moved. It stays with the case as a file like any
    other, and the charge waits on a person checking it.
    """
    order = owned_order(order_id, db, doctor)
    payment = next((p for p in order.payments if p.id == payment_id), None)
    if payment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Payment not found.")
    if payment.status == PaymentStatus.VERIFIED:
        raise HTTPException(status.HTTP_409_CONFLICT, "This is already paid.")

    filename = (upload.filename or "receipt.jpg").strip()
    mime_type = guess_mime(filename, upload.content_type)
    if not order.storage_folder_ref:
        order.storage_folder_ref = get_storage().ensure_order_folder(order.reference)
    stored = get_storage().save(
        order.reference, CATEGORY_FOLDER[FileCategory.PAYMENT_PROOF], filename, upload.file, mime_type
    )

    record = OrderFile(
        order_id=order.id,
        category=FileCategory.PAYMENT_PROOF,
        filename=filename,
        mime_type=mime_type,
        size_bytes=stored.size_bytes,
        storage_ref=stored.ref,
        external_link=stored.external_link,
        uploaded_by_id=user.id,
        revision=order.revision_for(FILE_GROUP[FileCategory.PAYMENT_PROOF]),
        slot=Slot.OTHER,
    )
    db.add(record)
    db.flush()

    payment.proof_file_id = record.id
    payment.reference = reference.strip()[:80]
    payment.note = note.strip()
    payment.status = PaymentStatus.SUBMITTED
    payment.submitted_at = utcnow()
    payment.rejected_reason = ""

    for member in db.query(User).filter(User.role == UserRole.ADMIN, User.is_active.is_(True)):
        db.add(
            Notification(
                user_id=member.id,
                order_id=order.id,
                title="Payment receipt to check",
                body=f"{order.reference} — {order.doctor.full_name} sent a receipt for "
                f"{payment.total}.",
            )
        )

    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


@router.post("/{order_id}/phase-fit-issue", response_model=schemas.OrderDetail)
def report_phase_fit_issue(
    order_id: str,
    payload: schemas.PhaseFitIssueIn,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """An aligner inside the delivered phase does not fit.

    This is not the training-aligner fit review — that one asks whether the case
    can start at all. This interrupts a phase the patient is already wearing,
    and the lab has to answer it before any further batch is made.

    Whether it also unfinishes the phase depends on which aligner it was. One
    part-way through leaves the rest of the batch unworn, so the phase is
    incomplete again. The last one means the patient has been through the batch,
    which finishes the phase just as sending the progress photographs would — so
    a rescan from there resumes at the phase after this one.
    """
    order = owned_order(order_id, db, doctor)
    assert_status(order, OrderStatus.DISPATCHING, OrderStatus.PHASE_REVIEW)

    if not order.phases:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This case has not been divided into phases."
        )
    if order.open_phase_issue is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "There is already a fit issue open on this case, with 3D Align.",
        )

    phase = order.active_phase
    if phase is None or phase.status != PhaseStatus.ACTIVE:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "There is no phase with the clinic to report against.",
        )

    # The aligner has to be one the phase actually carries, on the arch named.
    if payload.arch == Arch.UPPER:
        low, high = phase.upper_from, phase.upper_to
    else:
        low, high = phase.lower_from, phase.lower_to
    if low is None or high is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Phase {phase.phase_number} has no {payload.arch.lower()} aligners.",
        )
    if not low <= payload.aligner_number <= high:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Phase {phase.phase_number} covers {payload.arch.lower()} aligners "
            f"{low}–{high}.",
        )
    missing = order.missing_slots(FileCategory.PHASE_FIT_PHOTO)
    if missing:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Send the six photographs with the report — still needed: "
            + ", ".join(SLOT_LABELS[m] for m in missing)
            + ".",
        )

    issue = PhaseFitIssue(
        order_id=order.id,
        phase_number=phase.phase_number,
        phase_round=phase.round,
        arch=payload.arch,
        aligner_number=payload.aligner_number,
        notes=payload.notes.strip(),
        photo_revision=order.revision_for(FILE_GROUP[FileCategory.PHASE_FIT_PHOTO]),
        status="OPEN",
        reported_by_id=user.id,
    )
    db.add(issue)
    order.phase_issues.append(issue)
    # An aligner part-way through the phase leaves the rest of it unworn, so the
    # phase is unfinished again. The last aligner is different: the patient has
    # worn the batch through, so it counts as finished exactly as sending the
    # progress photographs would, and only the issue itself is outstanding.
    if payload.aligner_number == high:
        phase_service.mark_completed(order, phase.phase_number)
    else:
        phase_service.reopen(order, phase.phase_number)
    # The next report gets its own photograph set.
    order.bump_revision(FILE_GROUP[FileCategory.PHASE_FIT_PHOTO])

    transition(
        db,
        order,
        OrderStatus.FIT_ISSUE,
        user,
        note=f"Fit issue on phase {phase.phase_number} — {payload.arch.lower()} aligner "
        f"{payload.aligner_number}. {payload.notes.strip()}",
    )
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


@router.post("/{order_id}/phase-fit-issue/reply", response_model=schemas.OrderDetail)
def reply_to_phase_fit_issue(
    order_id: str,
    payload: schemas.PhaseIssueReplyIn,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """The clinic says what happened after trying what the lab suggested.

    Advice rarely settles a misfitting aligner first time, so this hands the
    issue back to the lab with the outcome rather than forcing the clinic to
    either accept it or raise a fresh report.
    """
    order = owned_order(order_id, db, doctor)
    issue = order.open_phase_issue
    if issue is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "There is no open fit issue on this case."
        )

    db.add(
        PhaseIssueMessage(
            issue_id=issue.id,
            author_id=user.id,
            from_lab=False,
            body=payload.message.strip(),
        )
    )
    issue.awaiting = AWAITING_LAB

    for member in db.query(User).filter(User.role == UserRole.ADMIN, User.is_active.is_(True)):
        db.add(
            Notification(
                user_id=member.id,
                order_id=order.id,
                title="Reply on a fit issue",
                body=f"{order.reference} — {payload.message.strip()}",
            )
        )

    if order.status != OrderStatus.FIT_ISSUE:
        transition(
            db,
            order,
            OrderStatus.FIT_ISSUE,
            user,
            note=f"Fit issue on phase {issue.phase_number} — {payload.message.strip()}",
        )
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


@router.post("/{order_id}/phase-fit-issue/resolve", response_model=schemas.OrderDetail)
def close_phase_fit_issue(
    order_id: str,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """The clinic says the aligner is wearing properly now.

    Closing the issue is theirs to do — they are the ones who can see whether
    the advice worked. It does not finish the phase: the patient still has to
    wear the rest of the batch, and the progress photographs at the end of it
    are what completes it.
    """
    order = owned_order(order_id, db, doctor)
    issue = order.open_phase_issue
    if issue is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "There is no open fit issue on this case."
        )
    if not issue.messages:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "3D Align has not answered this yet.",
        )

    issue.status = "RESOLVED"
    issue.resolution = PhaseIssueResolution.CLINIC_CONFIRMED
    issue.resolved_at = utcnow()
    issue.resolved_by_id = user.id

    # The phase goes back to being simply unfinished — with the clinic, working
    # through the batch. Completing it is a separate thing entirely.
    phase = phase_service.get(order, issue.phase_number)
    if phase is not None and phase.status == PhaseStatus.ISSUE:
        phase.status = PhaseStatus.ACTIVE

    for member in db.query(User).filter(User.role == UserRole.ADMIN, User.is_active.is_(True)):
        db.add(
            Notification(
                user_id=member.id,
                order_id=order.id,
                title="Fit issue closed by the clinic",
                body=f"{order.reference} — phase {issue.phase_number} is wearing properly now.",
            )
        )

    if order.status != OrderStatus.DISPATCHING:
        transition(
            db,
            order,
            OrderStatus.DISPATCHING,
            user,
            note=f"Fit issue on phase {issue.phase_number} closed by the clinic.",
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


@router.get("/{order_id}/scan-sources", response_model=list[schemas.ScanSourceOut])
def scan_sources(
    order_id: str,
    doctor: Doctor = Depends(verified_doctor),
    db: Session = Depends(get_db),
):
    """Earlier cases of this patient's whose scan could be used again.

    A clinic that finished a case and now wants a retainer for the same patient
    should not be sent to take the impression twice — the lab already holds the
    arches. Only complete sets are offered: half a scan is nothing the bench can
    work from.
    """
    order = owned_order(order_id, db, doctor)
    return [
        schemas.ScanSourceOut(
            order_id=s["order_id"],
            reference=s["reference"],
            kind=s["kind"],
            status=s["status"],
            status_label=STATUS_LABELS[s["status"]],
            taken_at=s["taken_at"],
        )
        for s in scan_service.sources_for(db, order.patient_id, exclude_order_id=order.id)
    ]


@router.post("/{order_id}/scan-reuse", response_model=schemas.OrderDetail)
def reuse_scan(
    order_id: str,
    payload: schemas.ScanReuseIn,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Carry an existing scan onto this order instead of taking a new one.

    The rows are new — each order owns its files — but they point at the same
    stored objects, so nothing is uploaded or stored twice. The case then moves
    on exactly as it would with a fresh scan: the lab still reviews it, because
    a scan old enough to be stale is the lab's call, not the clinic's.
    """
    order = owned_order(order_id, db, doctor)
    assert_status(order, OrderStatus.AWAITING_SCAN)

    source = db.get(Order, payload.source_order_id)
    if source is None or source.patient_id != order.patient_id:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "That case is not on this patient's record."
        )
    if scan_service.has_complete_scan(order):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This case already has a scan."
        )
    try:
        scan_service.copy_into(db, source, order, user.id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    order.scan_route = ScanRoute.UPLOAD
    transition(
        db,
        order,
        OrderStatus.SCAN_SUBMITTED,
        user,
        note=f"Scan carried over from {source.reference}.",
    )
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
    # The plan is released against the plan fee, so it cannot be approved — or
    # even read — before that is settled.
    if not payment_service.plan_unlocked(order):
        raise HTTPException(
            status.HTTP_402_PAYMENT_REQUIRED,
            payment_service.blocker_for(order, PaymentKind.TREATMENT_PLAN)
            or "The treatment plan fee has not been paid yet.",
        )
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

    payment_service.sync(db, order)
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
    return order.is_final_phase(shipment)


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

    # Accepting a phase is not the end of it: the lab has to see how the teeth
    # actually moved before it commits the next batch to production. The
    # photographs are the evidence, so they gate the handover.
    if payload.decision == PhaseDecision.CONTINUE and not _is_final_phase(order, shipment):
        missing = order.missing_slots(FileCategory.PROGRESS_PHOTO)
        if missing:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Send the progress photographs for this phase first — still needed: "
                + ", ".join(SLOT_LABELS[m] for m in missing)
                + ".",
            )

    if payload.decision == PhaseDecision.REPEAT:
        # Asking for the batch again is the same event as an aligner in it not
        # fitting, and that route carries what the lab actually needs to judge
        # it: which arch, which aligner, and the photographs. Historical
        # decisions are still read; new ones go the one way.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Report a fit issue instead — it asks which aligner is wrong and takes the "
            "photographs the lab needs. A remake is one of the answers to it.",
        )

    if _is_final_phase(order, shipment):
        # Accepting the batch that carries the last aligner is what finishes the
        # case — the clinic confirms the fit rather than it completing silently.
        if shipment.phase_number:
            phase_service.mark_completed(order, shipment.phase_number)
        transition(
            db,
            order,
            OrderStatus.COMPLETED,
            user,
            note=f"Final phase accepted — all {order.total_aligners} aligners "
            f"({order.aligner_steps} steps) delivered and fitting.",
        )
    else:
        # Wearing the batch through and sending the photographs is what finishes
        # a phase. The lab still reviews them, but the review decides what comes
        # *next* — carry on, or rescan — not whether this phase happened. A
        # rescan called at that point must therefore resume at the phase after
        # this one, which only works if this one is already complete.
        if shipment.phase_number:
            phase_service.mark_completed(order, shipment.phase_number)
        start, _ = order.next_phase_range
        transition(
            db,
            order,
            OrderStatus.PHASE_REVIEW,
            user,
            note=f"Phase {shipment.phase_number} completed — progress photographs sent "
            f"for review.",
        )
        for member in db.query(User).filter(User.role == UserRole.ADMIN, User.is_active.is_(True)):
            db.add(
                Notification(
                    user_id=member.id,
                    order_id=order.id,
                    title="Progress photographs to review",
                    body=f"{order.reference} — phase {shipment.phase_number} received. "
                    f"Review the photographs before shipping from aligner {start}.",
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
        # A case that has already been divided is not asked again. The phases
        # are fixed, the clinic is part-way through them, and a different answer
        # halfway through would contradict the division the patient is living
        # with. Confirming the fit simply resumes at the earliest unfinished
        # phase.
        resuming = bool(order.phases) and order.dispatch_mode is not None
        if payload.dispatch_mode is None and not resuming:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Choose whether the remaining aligners ship in full or in phases.",
            )
        if not resuming and payload.dispatch_mode == DispatchMode.PHASED:
            allowed = order.max_phases
            if payload.phase_count is None:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "Choose how many phases the remaining aligners should ship in.",
                )
            if not 1 <= payload.phase_count <= allowed:
                # Below five steps a phase is not worth a dispatch, which is what
                # caps the count.
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"This case runs {order.aligner_steps} steps, so it can be split into "
                    f"at most {allowed} phase(s) of at least {MIN_STEPS_PER_PHASE} aligners each.",
                )
            order.phase_count = payload.phase_count
        elif not resuming:
            order.phase_count = None
        db.add(
            FitReview(
                order_id=order.id,
                shipment_id=training.id if training else None,
                fit_round=order.fit_round,
                outcome="FITS",
                reported_by_id=user.id,
            )
        )
        if payload.dispatch_mode is not None:
            order.dispatch_mode = payload.dispatch_mode
        # The case is divided once, here. A refinement passing through this same
        # step later must not redraw boundaries the patient is part-way through,
        # which is why divide() refuses to run twice.
        phase_service.divide(db, order)
        transition(
            db,
            order,
            OrderStatus.ALIGNER_PRODUCTION,
            user,
            note=(
                f"Refinement fit confirmed — phases resume from aligner "
                f"{order.next_phase_range[0]}."
                if resuming
                else f"Fit confirmed. Dispatch mode: {order.dispatch_mode.lower()}"
                + (f", in {order.phase_count} phase(s)." if order.phase_count else ".")
            ),
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
