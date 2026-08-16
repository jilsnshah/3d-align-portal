from __future__ import annotations

from . import schemas
from datetime import timedelta, timezone

from .config import settings
from .enums import (
    APPOINTMENT_LABELS,
    LAB_ROLES,
    OrderStatus,
    STAFF_ONLY_CATEGORIES,
    STAFF_UPLOAD_WINDOWS,
    UserRole,
    CATEGORY_FOLDER,
    DOCTOR_ACTION_STATUSES,
    FILE_GROUP,
    REQUIRED_SUBMIT_CATEGORIES,
    SLOT_LABELS,
    STATUS_LABELS,
    FileCategory,
    slots_for,
)
from .models import Appointment, Order, Technician


def missing_categories(order: Order) -> list[FileCategory]:
    """Only the current revision counts. Photos from a superseded round do not
    satisfy a fresh request for records."""
    present = {
        f.category
        for f in order.files
        if not f.is_deleted and f.revision == order.revision_for(FILE_GROUP[f.category])
    }
    return [c for c in REQUIRED_SUBMIT_CATEGORIES if c not in present]


from .enums import CATEGORY_TITLES

CATEGORY_LABELS = {
    FileCategory.RECORD_PHOTO: "Clinical photographs",
    FileCategory.OPG: "OPG",
    FileCategory.LATERAL_CEPH: "Lateral cephalogram",
    FileCategory.CBCT: "CBCT",
    FileCategory.INTRAORAL_SCAN: "Intraoral scan",
    FileCategory.TREATMENT_PLAN: "Treatment plan",
    FileCategory.SIMULATION_VIDEO: "Simulation video",
    FileCategory.FIT_ISSUE_PHOTO: "Fit issue photographs",
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
}

# Categories that only make sense once the case reaches a certain point.
STAGE_CATEGORIES = {
    FileCategory.TREATMENT_PLAN: {OrderStatus.IN_PLANNING, OrderStatus.PLAN_SHARED},
    FileCategory.SIMULATION_VIDEO: {OrderStatus.IN_PLANNING, OrderStatus.PLAN_SHARED},
    FileCategory.FIT_ISSUE_PHOTO: {OrderStatus.FIT_REVIEW, OrderStatus.FIT_ISSUE},
}


def _shows_category(order: Order, category, live) -> bool:
    """A category appears if it holds files, is core to every case, or the case
    has reached the stage it belongs to."""
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


def record_sets(order: Order, viewer_role=None) -> list[schemas.RecordSet]:
    """Every category the case has, rendered as its slots. This is what turns a
    flat file list into 'upper arch present, bite still missing'."""
    sets: list[schemas.RecordSet] = []

    for category in CATEGORY_LABELS:
        live = [f for f in order.files if f.category == category and not f.is_deleted]
        if not _shows_category(order, category, live):
            continue
        spec = slots_for(category)

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
                required=category in REQUIRED_SUBMIT_CATEGORIES,
                complete=(not order.missing_slots(category))
                if spec
                else bool([f for f in live if f.revision == revision]),
                slots=slots,
                extras=extras,
                missing=[SLOT_LABELS[s] for s in order.missing_slots(category)],
            )
        )
    return sets


def _file_out(order: Order, f) -> schemas.FileOut:
    return file_out(order, f)


def order_summary(order: Order) -> schemas.OrderSummary:
    return schemas.OrderSummary(
        id=order.id,
        order_number=order.order_number,
        status=order.status,
        status_label=STATUS_LABELS[order.status],
        patient_name=order.patient.full_name,
        doctor_name=order.doctor.full_name,
        clinic_name=order.doctor.clinic_name,
        arch=order.arch,
        priority=order.priority,
        needs_doctor_action=order.status in DOCTOR_ACTION_STATUSES,
        created_at=order.created_at,
        updated_at=order.updated_at,
    )


def order_detail(order: Order, viewer_role=None) -> schemas.OrderDetail:
    base = order_summary(order).model_dump()
    events = [
        schemas.EventOut(
            id=e.id,
            from_status=e.from_status,
            to_status=e.to_status,
            note=e.note,
            actor_name=_actor_name(e),
            created_at=e.created_at,
        )
        for e in order.events
    ]
    return schemas.OrderDetail(
        **base,
        dispatch_mode=order.dispatch_mode,
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
        plans=[_plan_out(p) for p in order.plans],
        shipments=[_shipment_out(order, s) for s in order.shipments],
        appointment=appointment_out(order.appointment) if order.appointment else None,
        invoice=schemas.InvoiceOut.model_validate(order.invoice) if order.invoice else None,
        events=events,
        missing_categories=missing_categories(order),
        submit_blockers=order.submit_blockers,
        record_sets=record_sets(order, viewer_role),
        total_aligners=order.total_aligners,
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
    total = order.total_aligners
    out.is_final_phase = bool(
        total and shipment.aligner_range_to and shipment.aligner_range_to >= total
    )
    return out


def _awaiting_decision(order: Order):
    """The phase the clinic still has to answer for, if any.

    The last phase is asked about too — a batch that does not fit is a batch
    that does not fit, and completing the case silently would leave no way back.
    """
    last = order.last_phase
    if last is not None and last.status.value == "DELIVERED" and last.phase_decision is None:
        return last.id
    return None
