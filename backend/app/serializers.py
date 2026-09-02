from __future__ import annotations

from . import schemas
from datetime import timedelta, timezone

from .config import settings
from .enums import (
    APPOINTMENT_LABELS,
    LAB_ROLES,
    OrderKind,
    OrderStatus,
    DOCTOR_HIDDEN_CATEGORIES,
    PLAN_GATED_CATEGORIES,
    STAFF_ONLY_CATEGORIES,
    STAFF_UPLOAD_WINDOWS,
    UserRole,
    CATEGORY_FOLDER,
    DOCTOR_ACTION_STATUSES,
    FILE_GROUP,
    PAYMENT_KIND_LABELS,
    PAYMENT_STATUS_LABELS,
    PaymentKind,
    PaymentStatus,
    PhaseStatus,
    REQUIRED_SUBMIT_CATEGORIES,
    category_applies,
    required_categories,
    required_submit_categories,
    SLOT_LABELS,
    STATUS_LABELS,
    FileCategory,
    category_label,
    slots_for,
)
from decimal import Decimal

from sqlalchemy.orm import Session

from .models import Appointment, Order, Technician
from .services import payments, scheduling


def missing_categories(order: Order) -> list[FileCategory]:
    """Only the current revision counts. Photos from a superseded round do not
    satisfy a fresh request for records."""
    present = {
        f.category
        for f in order.files
        if not f.is_deleted and f.revision == order.revision_for(FILE_GROUP[f.category])
    }
    return [c for c in required_submit_categories(order.kind) if c not in present]


from .enums import CATEGORY_TITLES

CATEGORY_LABELS = {
    FileCategory.RECORD_PHOTO: "Clinical photographs",
    FileCategory.OPG: "OPG",
    FileCategory.LATERAL_CEPH: "Lateral cephalogram",
    FileCategory.CBCT: "CBCT",
    FileCategory.INTRAORAL_SCAN: "Intraoral scan",
    FileCategory.TREATMENT_PLAN: "Treatment plan",
    FileCategory.SIMULATION_MODEL: "Simulation files",
    FileCategory.FIT_ISSUE_PHOTO: "Fit issue photographs",
    FileCategory.PROGRESS_PHOTO: "Progress photographs",
    FileCategory.PAYMENT_PROOF: "Payment receipts",
    FileCategory.PHASE_FIT_PHOTO: "Phase fit issue photographs",
    FileCategory.OTHER: "Other",
}


def _uploader(f) -> str:
    user = f.uploaded_by
    if user is None:
        return ""
    if user.doctor is not None:
        return user.doctor.full_name
    return "3D Align"


def file_out(order: Order, f) -> schemas.FileOut:
    out = schemas.FileOut.model_validate(f)
    out.is_current = f.revision == order.revision_for(FILE_GROUP[f.category])
    out.slot_label = SLOT_LABELS.get(f.slot, "")
    out.is_image = f.is_image
    out.uploaded_by = _uploader(f)
    return out


def binned_file_out(f) -> schemas.BinnedFileOut:
    out = schemas.BinnedFileOut.model_validate(f)
    out.slot_label = SLOT_LABELS.get(f.slot, "")
    out.is_image = f.is_image
    out.is_current = False
    out.uploaded_by = _uploader(f)
    deleted_at = f.deleted_at
    if deleted_at:
        if deleted_at.tzinfo is None:
            deleted_at = deleted_at.replace(tzinfo=timezone.utc)
        from .models import utcnow

        gone = deleted_at + timedelta(days=settings.trash_retention_days)
        out.purges_in_days = max(0, (gone - utcnow()).days)
    return out


# Categories that belong to a case from the start, even before anything is
# uploaded — otherwise there is nowhere to put the first OPG.
CORE_CATEGORIES = {
    FileCategory.RECORD_PHOTO,
    FileCategory.OPG,
    FileCategory.INTRAORAL_SCAN,
    FileCategory.LATERAL_CEPH,
    FileCategory.CBCT,
    # Miscellaneous uploads need a home too, now that there is no separate
    # "add a file" box beside the explorer.
    FileCategory.OTHER,
}

# Categories that only make sense once the case reaches a certain point.
STAGE_CATEGORIES = {
    FileCategory.TREATMENT_PLAN: {OrderStatus.IN_PLANNING, OrderStatus.PLAN_SHARED},
    # The lab needs somewhere to drop the staged export the moment planning
    # opens; a section that only appears once files exist has nowhere to
    # receive the first one.
    FileCategory.SIMULATION_MODEL: {OrderStatus.IN_PLANNING, OrderStatus.PLAN_SHARED},
    FileCategory.FIT_ISSUE_PHOTO: {OrderStatus.FIT_REVIEW, OrderStatus.FIT_ISSUE},
    # The clinic needs somewhere to put them the moment a phase lands.
    FileCategory.PROGRESS_PHOTO: {OrderStatus.DISPATCHING, OrderStatus.PHASE_REVIEW},
    FileCategory.PHASE_FIT_PHOTO: {
        OrderStatus.DISPATCHING,
        OrderStatus.PHASE_REVIEW,
        OrderStatus.FIT_ISSUE,
    },
}


def _shows_category(order: Order, category, live) -> bool:
    """A category appears if it holds files, is core to every case, or the case
    has reached the stage it belongs to — and if this kind of order has any use
    for it in the first place."""
    if not category_applies(order.kind, category):
        return False
    if live:
        return True
    if category in CORE_CATEGORIES:
        return True
    window = STAGE_CATEGORIES.get(category)
    return bool(window and order.status in window)


def _editability(order: Order, category, viewer_role) -> tuple:
    """Mirrors the checks in routers/files.upload_file. One source of truth for
    'can this person put a file here right now'."""
    from .routers.files import DOCTOR_UPLOAD_WINDOWS

    if viewer_role in LAB_ROLES:
        window = STAFF_UPLOAD_WINDOWS.get(category)
        if window is not None and order.status not in window:
            return False, "Only while the case is in planning."
        return True, ""

    if category in STAFF_ONLY_CATEGORIES:
        return False, "Added by 3D Align."
    allowed = DOCTOR_UPLOAD_WINDOWS.get(category, set())
    if order.status not in allowed:
        return False, f"Locked while the case is {STATUS_LABELS[order.status].lower()}."
    return True, ""


def record_sets(order: Order, viewer_role=None, plan_locked=False) -> list[schemas.RecordSet]:
    """Every category the case has, rendered as its slots. This is what turns a
    flat file list into 'upper arch present, bite still missing'."""
    sets: list[schemas.RecordSet] = []

    lab_side = viewer_role in LAB_ROLES
    for category in CATEGORY_LABELS:
        # The clinic sees the simulation, not the files behind it.
        if not lab_side and category in DOCTOR_HIDDEN_CATEGORIES:
            continue
        # And sees nothing of the plan at all until it is paid for.
        if plan_locked and category in PLAN_GATED_CATEGORIES:
            continue
        live = [f for f in order.files if f.category == category and not f.is_deleted]
        if not _shows_category(order, category, live):
            continue
        spec = slots_for(category)
        # A slot is only required when the set it belongs to is. The photo
        # series marks five of its views mandatory, which is right for an
        # aligner case and wrong for a by-product that is never asked for
        # photographs at all — the tiles said REQUIRED and the panel counted
        # "5 missing" for a set nothing was waiting on.
        category_required = category in required_categories(order.kind)
        if not category_required:
            spec = [(name, False) for name, _ in spec]

        revision = order.revision_for(FILE_GROUP[category])
        current = [f for f in live if f.revision == revision]
        by_slot = {f.slot: f for f in current if f.slot}

        slots = [
            schemas.SlotState(
                slot=name,
                label=SLOT_LABELS[name],
                required=required,
                file=file_out(order, by_slot[name]) if name in by_slot else None,
            )
            for name, required in spec
        ]
        # Anything live that is not occupying a current slot tile — earlier
        # revisions of a view included. Filtering on slot name alone hid whole
        # superseded rounds from the explorer even though the files were there.
        tiled = {f.id for f in by_slot.values()}
        extras = sorted(
            (file_out(order, f) for f in live if f.id not in tiled),
            key=lambda f: (-f.revision, f.slot_label or f.filename),
        )

        editable, locked_reason = _editability(order, category, viewer_role)
        sets.append(
            schemas.RecordSet(
                editable=editable,
                locked_reason=locked_reason,
                category=category,
                label=CATEGORY_LABELS[category],
                revision=revision,
                required=category_required,
                complete=(not order.missing_slots(category))
                if (spec and category_required)
                else bool([f for f in live if f.revision == revision]),
                slots=slots,
                extras=extras,
                missing=(
                    [SLOT_LABELS[s] for s in order.missing_slots(category)]
                    if category_required
                    else []
                ),
            )
        )
    return sets


def _file_out(order: Order, f) -> schemas.FileOut:
    return file_out(order, f)


def _branch_label(address) -> str:
    """What to call a branch in a list.

    The label is what the clinic typed — "Clinic", "Satellite", "Bopal" — and
    two branches can carry the same one, so the city follows when it adds
    something. A practice with a single address never sees either.
    """
    if address is None:
        return ""
    label = (address.label or "").strip()
    city = (address.city or "").strip()
    if label and city and city.casefold() not in label.casefold():
        return f"{label} · {city}"
    return label or city


def _status_label(order: Order) -> str:
    """What the stage is called, in the words that fit what is being done.

    An accessory order shares the product statuses because the shape of the
    journey is the same, but "In fabrication" is the wrong thing to say about
    picking five retainer cases off a shelf.
    """
    if order.kind == OrderKind.ACCESSORY:
        if order.status == OrderStatus.PRODUCT_FABRICATION:
            return "Being packed"
        if order.status == OrderStatus.SUBMITTED:
            return "Ordered"
    return STATUS_LABELS[order.status]


def order_summary(order: Order, viewer_role=None) -> schemas.OrderSummary:
    # The aligner count and the confirmed band are plan findings. Before the
    # plan is paid for, the clinic sees the estimate it already had.
    locked = (
        viewer_role is not None
        and viewer_role not in LAB_ROLES
        and bool(order.plans)
        and not payments.plan_unlocked(order)
    )
    category = order.quoted_category if locked else order.aligner_category
    from .services import catalogue

    return schemas.OrderSummary(
        id=order.id,
        order_number=order.reference,
        kind=order.kind,
        product_label=catalogue.describe(order),
        status=order.status,
        status_label=_status_label(order),
        category=category,
        category_label=category_label(category) if category else "",
        category_confirmed=False if locked else order.aligner_category_confirmed,
        # The clinic is shown their orthodontist by name so they know who to
        # ask about the case. The id is lab-side plumbing and stays there.
        phases_total=len(order.phases),
        phases_done=sum(1 for p in order.phases if p.status == PhaseStatus.COMPLETED),
        assigned_to_id=order.assigned_to_id if viewer_role in LAB_ROLES else None,
        assigned_to_name=(
            (order.assigned_to.full_name or order.assigned_to.email)
            if order.assigned_to is not None
            else ""
        ),
        # An accessory order names no one. "Practice stock" is what it is,
        # and reads better on a board than a blank cell.
        patient_name=(
            order.patient.full_name if order.patient is not None else "Practice stock"
        ),
        doctor_name=order.doctor.full_name,
        clinic_name=order.doctor.clinic_name,
        branch_id=order.shipping_address_id or "",
        branch_label=_branch_label(order.shipping_address),
        arch=order.arch,
        priority=order.priority,
        needs_doctor_action=order.status in DOCTOR_ACTION_STATUSES,
        created_at=order.created_at,
        updated_at=order.updated_at,
    )


def _issue_out(issue) -> schemas.PhaseFitIssueOut:
    out = schemas.PhaseFitIssueOut.model_validate(issue)
    out.messages = [
        schemas.PhaseIssueMessageOut(
            id=m.id, from_lab=m.from_lab, body=m.body, created_at=m.created_at
        )
        for m in issue.messages
    ]
    return out


def _payment_out(order: Order, row, settings) -> schemas.PaymentOut:
    if row.kind == PaymentKind.PRODUCTION_PHASE:
        label = f"Phase {row.phase_number} — production aligners"
    else:
        label = PAYMENT_KIND_LABELS[row.kind]
    return schemas.PaymentOut(
        id=row.id,
        kind=row.kind,
        kind_label=PAYMENT_KIND_LABELS[row.kind],
        phase_number=row.phase_number or 0,
        amount=row.amount,
        shipping_amount=row.shipping_amount,
        total=row.total,
        status=row.status,
        status_label=PAYMENT_STATUS_LABELS[row.status],
        reference=row.reference,
        proof_file_id=row.proof_file_id,
        rejected_reason=row.rejected_reason,
        submitted_at=row.submitted_at,
        verified_at=row.verified_at,
        label=label,
        upi_link=(
            ""
            if row.status == PaymentStatus.VERIFIED
            else payments.upi_link(
                settings, row.total, f"{order.reference} {label}", row.id[:12]
            )
        ),
    )


def _product_charge_lines(order: Order, settings) -> list:
    """The money on a product order.

    A product is one charge: what was made, times how many, plus delivery.
    There is no plan to unlock and no training fit to make, so neither fixed
    fee is ever raised against it — and printing them here as deductions said
    ₹3,500 was coming off a bill that never carried it.
    """
    from .services import catalogue

    product = order.product
    size = order.product_size
    quantity = max(order.quantity or 1, 1)
    teeth = max(order.extra_teeth or 0, 0)
    each = Decimal(size.price) if size is not None else Decimal("0")
    per_tooth = Decimal(product.per_tooth_price or 0) if product is not None else Decimal("0")

    lines = []
    if product is not None:
        lines.append(
            schemas.ChargeLine(
                label=product.name,
                amount=each,
                note=(
                    f"{size.label} · each"
                    if size is not None and product.has_choice_of_size
                    else "Each"
                ),
            )
        )
    if teeth and per_tooth:
        lines.append(
            schemas.ChargeLine(
                label=f"{teeth} tooth beyond the base" if teeth == 1
                else f"{teeth} teeth beyond the base",
                amount=per_tooth * teeth,
                note=f"{per_tooth:,.2f} per tooth · each",
            )
        )
    # line_total covers the whole order, accessories included. The subtotal
    # line above the accessories must be the appliance alone, or the reader
    # sees the shelf items counted once in the subtotal and again below it.
    goods = catalogue.line_total(order)
    appliance = (each + per_tooth * teeth) * quantity
    if product is not None and quantity > 1:
        lines.append(
            schemas.ChargeLine(
                label=f"{quantity} sets",
                amount=appliance,
                note="Price of one, times how many",
            )
        )

    for line in sorted(order.accessories, key=lambda l: l.accessory.sort_order):
        lines.append(
            schemas.ChargeLine(
                label=line.accessory.name,
                amount=Decimal(line.line_total),
                note=(
                    f"{Decimal(line.unit_price):,.2f} each · {line.quantity}"
                    if (line.quantity or 1) > 1
                    else "One"
                ),
            )
        )

    row = next((p for p in order.payments if p.kind == PaymentKind.PRODUCT_ORDER), None)
    shipping = Decimal(row.shipping_amount or 0) if row is not None else Decimal("0")
    city = payments.delivery_city(order)
    lines.append(
        schemas.ChargeLine(
            label="Delivery",
            amount=shipping,
            note=(f"To {city}" if city else "Default rate") if shipping else "Not charged",
        )
    )
    lines.append(
        schemas.ChargeLine(
            label="Total for this order",
            amount=goods + shipping,
            note=(
                "Due before it ships"
                if order.kind == OrderKind.ACCESSORY
                else "Due once it has shipped — and before the next appliance is started"
            ),
        )
    )
    return lines


def charge_lines(order: Order, settings) -> list:
    """The money on a case, itemised.

    Written out in full rather than as one total, because the clinic is paying
    it in pieces and needs to see that the plan fee and the training-fit fee are
    taken off the quote rather than added on top of it.
    """
    # A product order shares none of that arithmetic — no band, no quote, and
    # neither fixed fee — so it gets its own breakdown rather than an aligner
    # one with every line reading "not set yet".
    if order.kind == OrderKind.PRODUCT:
        return _product_charge_lines(order, settings)
    if order.kind == OrderKind.ACCESSORY:
        return _product_charge_lines(order, settings)

    plan = order.approved_plan or order.current_plan
    lines = [
        schemas.ChargeLine(
            label="Align category",
            amount=Decimal("0"),
            note=category_label(order.aligner_category)
            if order.aligner_category
            else "Not set yet",
        ),
        schemas.ChargeLine(
            label="Quoted price",
            amount=payments.quoted_total(order),
            note="From the treatment plan" if plan and plan.final_total else "Estimated",
        ),
        schemas.ChargeLine(
            label="Treatment plan fee",
            amount=-Decimal(settings.plan_fee or 0),
            note="Paid separately — deducted here, not charged twice",
        ),
        schemas.ChargeLine(
            label="Training fit aligner fee",
            amount=-Decimal(settings.training_fit_fee or 0),
            note="Paid separately — deducted here, not charged twice",
        ),
        schemas.ChargeLine(
            label="Production aligners",
            amount=payments.production_total(order, settings),
            note=_phase_note(order),
        ),
    ]
    # Delivery is per phase, and a phase that has already been paid keeps the
    # rate it was paid at. Reporting one figure taken from the first phase
    # under-reports the case whenever a rate has changed mid-treatment, so the
    # total is summed from the phases themselves.
    phases = [p for p in order.payments if p.kind == PaymentKind.PRODUCTION_PHASE]
    if phases:
        city = payments.delivery_city(order)
        # Phase one's delivery is free, so it is not part of the rate spread.
        charged = [p for p in phases if Decimal(p.shipping_amount or 0) > 0]
        rates = {Decimal(p.shipping_amount or 0) for p in charged}
        where = f"To {city}" if city else "Default rate"
        if not charged:
            note = "First delivery included"
        elif len(rates) == 1:
            note = f"{where} · {len(charged)} of {len(phases)} phases · first delivery free"
        else:
            # Spell out the split rather than hiding it behind an average.
            note = where + " · first delivery free · " + ", ".join(
                f"phase {p.phase_number} {Decimal(p.shipping_amount or 0):,.2f}"
                for p in sorted(charged, key=lambda x: x.phase_number)
            )
        lines.append(
            schemas.ChargeLine(
                label="Delivery",
                amount=sum((Decimal(p.shipping_amount or 0) for p in phases), Decimal("0")),
                note=note,
            )
        )
        lines.append(
            schemas.ChargeLine(
                label="Total for this case",
                amount=sum((Decimal(p.total) for p in order.payments), Decimal("0")),
                note="Every charge, including the two fixed fees",
            )
        )
    return lines


def _phase_note(order: Order) -> str:
    count = payments.phase_count(order)
    if not count:
        return "Split once the clinic chooses how it ships"
    if count == 1:
        return "One delivery"
    return f"Split equally across {count} phases"


def order_detail(order: Order, viewer_role=None) -> schemas.OrderDetail:
    base = order_summary(order, viewer_role).model_dump()
    db = Session.object_session(order)
    settings = scheduling.get_settings(db) if db is not None else None
    # The clinic sees the plan once the plan fee is settled. The lab always sees
    # it — they wrote it.
    plan_locked = (
        viewer_role not in LAB_ROLES
        and bool(order.plans)
        and not payments.plan_unlocked(order)
    )
    events = [
        schemas.EventOut(
            id=e.id,
            from_status=e.from_status,
            to_status=e.to_status,
            # The move to PLAN_SHARED spells out the aligner count and the
            # price, which is the plan itself. Withheld with the rest of it.
            note=(
                "Treatment plan ready — unlock it to see the details."
                if plan_locked and e.to_status == OrderStatus.PLAN_SHARED
                else e.note
            ),
            actor_name=_actor_name(e),
            created_at=e.created_at,
        )
        for e in order.events
    ]
    return schemas.OrderDetail(
        **base,
        patient_id=order.patient_id or "",
        has_simulation=any(
            f.category == FileCategory.SIMULATION_MODEL and not f.is_deleted
            for f in order.files
        ),
        enquiry_number=order.enquiry_number,
        dispatch_mode=order.dispatch_mode,
        phase_count=order.phase_count,
        refinement_round=order.refinement_round,
        progress_round=order.progress_round,
        progress_missing=[
            SLOT_LABELS[s] for s in order.missing_slots(FileCategory.PROGRESS_PHOTO)
        ],
        aligner_steps=order.aligner_steps,
        max_phases=order.max_phases,
        phase_plan=order.phase_plan,
        phases_divided=order.phases_divided,
        phase_issues=[_issue_out(i) for i in order.phase_issues],
        open_phase_issue=(
            order.open_phase_issue.id if order.open_phase_issue is not None else None
        ),
        scan_route=order.scan_route,
        scan_courier_tracking=order.scan_courier_tracking,
        chief_complaint=order.chief_complaint,
        clinical_notes=order.clinical_notes,
        records_request_note=order.records_request_note,
        cancel_reason=order.cancel_reason,
        records_revision=order.records_revision,
        scan_revision=order.scan_revision,
        fit_round=order.fit_round,
        submitted_at=order.submitted_at,
        approved_at=order.approved_at,
        completed_at=order.completed_at,
        shipping_address=(
            schemas.AddressOut.model_validate(order.shipping_address)
            if order.shipping_address
            else None
        ),
        files=[_file_out(order, f) for f in order.files if not f.is_deleted],
        quotes=[_quote_out(q) for q in order.quotes],
        plans=[] if plan_locked else [_plan_out(p) for p in order.plans],
        plan_locked=plan_locked,
        payments=[_payment_out(order, p, settings) for p in order.payments],
        charges=charge_lines(order, settings),
        accessories=[
            schemas.AccessoryLineOut(
                accessory_id=line.accessory_id,
                code=line.accessory.code,
                name=line.accessory.name,
                quantity=line.quantity,
                unit_price=line.unit_price,
                line_total=line.line_total,
            )
            for line in sorted(order.accessories, key=lambda l: l.accessory.sort_order)
        ],
        shipments=[_shipment_out(order, s) for s in order.shipments],
        appointment=appointment_out(order.appointment) if order.appointment else None,
        invoice=schemas.InvoiceOut.model_validate(order.invoice) if order.invoice else None,
        events=events,
        missing_categories=missing_categories(order),
        submit_blockers=order.submit_blockers,
        record_sets=record_sets(order, viewer_role, plan_locked),
        # The aligner count is a plan finding, so it is withheld with the plan.
        total_aligners=0 if plan_locked else order.total_aligners,
        next_phase_from=order.next_phase_range[0],
        next_phase_max=order.next_phase_range[1],
        next_phase_number=order.next_phase_label[0],
        next_phase_round=order.next_phase_label[1],
        phase_blocker=order.phase_blocker,
        awaiting_phase_decision=_awaiting_decision(order),
        binned_count=sum(1 for f in order.files if f.is_deleted),
        scan_complete=order.has_intraoral_scan,
    )


def _actor_name(event) -> str:
    if event.actor is None:
        return "System"
    if event.actor.doctor is not None:
        return event.actor.doctor.full_name
    return "3D Align"


def appointment_out(appointment: Appointment) -> schemas.AppointmentOut:
    address = appointment.address
    location = (
        f"{address.line1}, {address.city} {address.pincode}" if address else ""
    )
    technician = appointment.technician
    return schemas.AppointmentOut(
        needs_attention=appointment.needs_attention_at is not None,
        attention_reason=appointment.attention_reason or "",
        is_day_visit=bool(getattr(appointment, "is_day_visit", False)),
        id=appointment.id,
        starts_at=appointment.starts_at,
        ends_at=appointment.ends_at,
        status=appointment.status,
        status_label=APPOINTMENT_LABELS[appointment.status],
        technician_name=technician.full_name if technician else "Not yet assigned",
        technician_phone=technician.phone if technician else "",
        contact_name=appointment.contact_name,
        contact_phone=appointment.contact_phone,
        access_notes=appointment.access_notes,
        assignment_reason=appointment.assignment_reason,
        cancel_reason=appointment.cancel_reason,
        outcome_notes=appointment.outcome_notes,
        location=location,
    )


def technician_out(technician: Technician) -> schemas.TechnicianOut:
    from .enums import LIVE_APPOINTMENT_STATUSES

    return schemas.TechnicianOut(
        id=technician.id,
        full_name=technician.full_name,
        phone=technician.phone,
        employee_code=technician.employee_code,
        max_daily_jobs=technician.max_daily_jobs,
        is_active=technician.is_active,
        email=technician.user.email,
        availability=[
            schemas.AvailabilityRuleOut.model_validate(r)
            for r in sorted(technician.availability, key=lambda r: (r.weekday, r.start_time))
        ],
        time_off=[schemas.TimeOffOut.model_validate(t) for t in technician.time_off],
        upcoming_jobs=sum(
            1 for a in technician.appointments if a.status in LIVE_APPOINTMENT_STATUSES
        ),
    )


def _quote_out(quote) -> schemas.QuoteOut:
    from .enums import category_label

    out = schemas.QuoteOut.model_validate(quote)
    out.category_label = category_label(quote.category) if quote.category else ""
    return out


def _plan_out(plan) -> schemas.PlanOut:
    from .enums import category_label

    out = schemas.PlanOut.model_validate(plan)
    out.total_aligners = plan.aligners_upper + plan.aligners_lower
    out.final_category_label = category_label(plan.final_category) if plan.final_category else ""
    return out


def _shipment_out(order: Order, shipment) -> schemas.ShipmentOut:
    out = schemas.ShipmentOut.model_validate(shipment)
    out.is_final_phase = order.is_final_phase(shipment)
    return out


def _awaiting_decision(order: Order):
    """The phase the clinic still has to answer for, if any.

    The last phase is asked about too — a batch that does not fit is a batch
    that does not fit, and completing the case silently would leave no way back.
    """
    # Only while the case is actually waiting on it. A batch can sit delivered
    # and unanswered for good reasons — a rescan or a remake moves the case on
    # and the question stops applying — and asking anyway leaves the clinic
    # staring at a panel about a phase that is being rebuilt.
    if order.status != OrderStatus.DISPATCHING:
        return None
    last = order.last_phase
    if last is not None and last.status.value == "DELIVERED" and last.phase_decision is None:
        return last.id
    return None


def day_route_out(route, maps_url: str, browser_key: str = "") -> schemas.DayRouteOut:
    return schemas.DayRouteOut(
        technician_id=route.technician_id,
        technician_name=route.technician_name,
        date=route.day,
        stops=[
            schemas.RouteStopOut(
                kind=stop.kind,
                label=stop.label,
                address=stop.address,
                latitude=stop.point[0] if stop.point else None,
                longitude=stop.point[1] if stop.point else None,
                arrives_at=stop.arrives_at,
                departs_at=stop.departs_at,
                leg_minutes=round(stop.leg_minutes, 1),
                leg_km=round(stop.leg_km, 2),
                appointment_id=stop.appointment_id,
                order_reference=stop.order_reference,
                patient_name=stop.patient_name,
                booked_for=stop.booked_for,
                late_by_minutes=round(stop.late_by_minutes, 1),
            )
            for stop in route.stops
        ],
        total_km=round(route.total_km, 2),
        drive_minutes=round(route.drive_minutes, 1),
        onsite_minutes=round(route.onsite_minutes, 1),
        warnings=route.warnings,
        at_risk=route.is_at_risk,
        maps_url=maps_url,
        polyline=route.polyline,
        browser_map_key=browser_key,
    )
