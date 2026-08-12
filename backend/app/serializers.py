from __future__ import annotations

from . import schemas
from .enums import (
    DOCTOR_ACTION_STATUSES,
    FILE_GROUP,
    REQUIRED_SUBMIT_CATEGORIES,
    STATUS_LABELS,
    FileCategory,
)
from .models import Order


def missing_categories(order: Order) -> list[FileCategory]:
    """Only the current revision counts. Photos from a superseded round do not
    satisfy a fresh request for records."""
    present = {
        f.category
        for f in order.files
        if not f.is_deleted and f.revision == order.revision_for(FILE_GROUP[f.category])
    }
    return [c for c in REQUIRED_SUBMIT_CATEGORIES if c not in present]


def _file_out(order: Order, f) -> schemas.FileOut:
    out = schemas.FileOut.model_validate(f)
    out.is_current = f.revision == order.revision_for(FILE_GROUP[f.category])
    return out


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


def order_detail(order: Order) -> schemas.OrderDetail:
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
        quotes=[schemas.QuoteOut.model_validate(q) for q in order.quotes],
        plans=[schemas.PlanOut.model_validate(p) for p in order.plans],
        shipments=[schemas.ShipmentOut.model_validate(s) for s in order.shipments],
        appointment=(
            schemas.AppointmentOut.model_validate(order.appointment) if order.appointment else None
        ),
        invoice=schemas.InvoiceOut.model_validate(order.invoice) if order.invoice else None,
        events=events,
        missing_categories=missing_categories(order),
    )


def _actor_name(event) -> str:
    if event.actor is None:
        return "System"
    if event.actor.doctor is not None:
        return event.actor.doctor.full_name
    return "3D Align"
