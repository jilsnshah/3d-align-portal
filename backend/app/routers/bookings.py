"""Scan appointment booking.

Three audiences on one model:
  doctor      picks a slot from the calendar and cancels
  technician  works their own schedule
  admin       sees and reassigns everything, and owns the settings
"""

from __future__ import annotations

from datetime import date as date_type, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from .. import schemas
from ..config import settings as app_settings
from ..db import get_db
from ..deps import (
    current_admin,
    current_doctor,
    current_technician,
    current_user,
    owned_order,
    verified_doctor,
)
from ..enums import (
    AttentionAction,
    LEAVE_STATUS_LABELS,
    LeaveStatus,
    ReassignmentStatus,
    LIVE_APPOINTMENT_STATUSES,
    AppointmentStatus,
    OrderStatus,
    ScanRoute,
    UserRole,
)
from ..models import (
    ReassignmentRequest,
    Appointment,
    AvailabilityRule,
    Doctor,
    Notification,
    Order,
    Technician,
    TimeOff,
    User,
    utcnow,
)
from ..security import hash_password
from ..serializers import appointment_out, day_route_out, order_detail, technician_out
from ..services import geo, scheduling
from ..services.routes import build_day_route, google_maps_link
from ..services.travel import TravelService

router = APIRouter(tags=["bookings"])


def _as_utc(value: datetime) -> datetime:
    """Normalise to UTC.

    SQLite stores no offset, so an aware datetime is written as its own wall
    clock and read back naive. A booking sent as 09:30+05:30 would come back as
    09:30 UTC — five and a half hours out. Converting before storing is what
    keeps that from happening.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


# --------------------------------------------------------------------------
# Doctor — availability and booking
# --------------------------------------------------------------------------


def _clinic_address(doctor, address_id):
    """The clinic a visit is going to. Falls back to the doctor's default so a
    doctor who never picked an address still gets travel-aware availability."""
    if address_id:
        for address in doctor.addresses:
            if address.id == address_id:
                return address
    for address in doctor.addresses:
        if address.is_default_shipping:
            return address
    return doctor.addresses[0] if doctor.addresses else None




@router.get("/appointments/availability", response_model=list[schemas.DayAvailability])
def availability(
    from_date: date_type = Query(..., alias="from"),
    to_date: date_type = Query(..., alias="to"),
    address_id: Optional[str] = Query(default=None),
    detail: bool = Query(default=False),
    doctor: Doctor = Depends(verified_doctor),
    db: Session = Depends(get_db),
):
    """Month view: which days are worth clicking.

    Deliberately does not work out exact times. Doing so means asking the
    routing provider how long every leg of every technician's day takes, and a
    doctor flicking through a calendar would bill for weeks of routing they
    never look at. Pass ``detail=true`` for a single day to get real times.
    """
    settings = scheduling.get_settings(db)
    if (to_date - from_date).days > 62:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ask for at most two months at a time.")

    if detail and (to_date - from_date).days > 6:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Detailed availability is limited to a week at a time.",
        )

    clinic = scheduling.address_point(_clinic_address(doctor, address_id))
    travel = TravelService(db, settings)

    days = []
    cursor = from_date
    while cursor <= to_date:
        if detail:
            slots = scheduling.slots_for_day(db, cursor, settings, clinic, travel)
            days.append(
                schemas.DayAvailability(
                    date=cursor,
                    closed=not slots,
                    slots=[
                        schemas.SlotOut(
                            starts_at=s.starts_at,
                            ends_at=s.ends_at,
                            available=s.available,
                            reason=s.reason,
                        )
                        for s in slots
                    ],
                    free_count=sum(1 for s in slots if s.available),
                    technicians_free=0,
                )
            )
        else:
            closed, free = scheduling.day_capacity(db, cursor, settings, clinic)
            days.append(
                schemas.DayAvailability(
                    date=cursor,
                    closed=closed,
                    slots=[],
                    free_count=0,
                    technicians_free=free,
                )
            )
        cursor += timedelta(days=1)
    db.commit()
    return days


@router.post("/orders/{order_id}/appointment", response_model=schemas.OrderDetail)
def book_appointment(
    order_id: str,
    payload: schemas.BookAppointmentIn,
    doctor: Doctor = Depends(verified_doctor),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    order = owned_order(order_id, db, doctor)
    if order.status != OrderStatus.AWAITING_SCAN:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "A scan visit can only be booked while the case is awaiting its scan.",
        )
    if any(a.is_live for a in order.appointments):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This case already has a scan visit booked. Cancel it before booking another.",
        )

    settings = scheduling.get_settings(db)
    starts_at = _as_utc(payload.starts_at)
    address = _clinic_address(doctor, payload.address_id or order.shipping_address_id)
    clinic = scheduling.address_point(address)

    # Outside the service city the technician is out for the day, so the
    # appointment has to occupy the day — otherwise the calendar would happily
    # sell the afternoon to somebody else.
    day_visit = scheduling.requires_day_visit(clinic, settings)
    if day_visit:
        span = scheduling.day_visit_window(starts_at.date(), settings)
        if span is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "The lab is closed that day.")
        starts_at, ends_at = span
    else:
        ends_at = starts_at + scheduling.visit_length(settings)

    # Availability was advisory; this is the check that counts.
    try:
        technician, reason = scheduling.assign_technician(
            db, starts_at, ends_at, settings, clinic
        )
    except scheduling.SlotUnavailable as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

    appointment = Appointment(
        order_id=order.id,
        technician_id=technician.id,
        starts_at=starts_at,
        ends_at=ends_at,
        status=AppointmentStatus.ASSIGNED,
        is_day_visit=day_visit,
        address_id=payload.address_id or order.shipping_address_id,
        contact_name=payload.contact_name or doctor.full_name,
        contact_phone=payload.contact_phone or doctor.phone,
        access_notes=payload.access_notes,
        assignment_reason=reason,
    )
    db.add(appointment)
    order.scan_route = ScanRoute.APPOINTMENT

    db.add(
        Notification(
            user_id=technician.user_id,
            order_id=order.id,
            title="New scan visit assigned",
            body=f"{order.reference} — {order.patient.full_name}\n{starts_at:%d %b %Y, %H:%M}",
        )
    )
    db.commit()
    db.refresh(order)
    return order_detail(order, UserRole.DOCTOR)


@router.post("/appointments/{appointment_id}/cancel", response_model=schemas.OrderDetail)
def cancel_appointment(
    appointment_id: str,
    payload: schemas.CancelIn,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    appointment = db.get(Appointment, appointment_id)
    if not appointment:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Booking not found.")

    settings = scheduling.get_settings(db)
    if user.role == UserRole.DOCTOR:
        doctor = db.query(Doctor).filter(Doctor.user_id == user.id).one_or_none()
        if not doctor or appointment.order.doctor_id != doctor.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Booking not found.")
        cutoff = datetime.now(timezone.utc) + timedelta(hours=settings.min_notice_hours)
        if _as_utc(appointment.starts_at) < cutoff:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"This visit is within {settings.min_notice_hours} hours. "
                "Contact 3D Align to change it.",
            )
    elif user.role not in (UserRole.ADMIN, UserRole.TECHNICIAN):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed.")

    if not appointment.is_live:
        raise HTTPException(status.HTTP_409_CONFLICT, "That booking is already closed.")

    appointment.status = AppointmentStatus.CANCELLED
    appointment.cancelled_at = utcnow()
    appointment.cancel_reason = payload.reason

    order = appointment.order
    recipient = (
        order.doctor.user_id if user.role != UserRole.DOCTOR else appointment.technician.user_id
    )
    db.add(
        Notification(
            user_id=recipient,
            order_id=order.id,
            title="Scan visit cancelled",
            body=f"{order.reference} — {payload.reason}",
        )
    )
    db.commit()
    db.refresh(order)
    return order_detail(order, user.role)


# --------------------------------------------------------------------------
# Technician — their own schedule
# --------------------------------------------------------------------------


@router.get("/tech/route", response_model=schemas.DayRouteOut)
def my_route(
    day: date_type = Query(default=None),
    technician: Technician = Depends(current_technician),
    db: Session = Depends(get_db),
):
    """The technician's own day, re-costed against traffic right now."""
    settings = scheduling.get_settings(db)
    target = day or datetime.now(timezone.utc).date()
    route = build_day_route(db, technician, target, settings)
    db.commit()
    return day_route_out(route, google_maps_link(route))



@router.get("/admin/technicians/{technician_id}/route", response_model=schemas.DayRouteOut)
def technician_route(
    technician_id: str,
    day: date_type = Query(default=None),
    admin: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    """Any technician's day, for the lab's route view."""
    technician = db.get(Technician, technician_id)
    if technician is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Technician not found.")

    settings = scheduling.get_settings(db)
    target = day or datetime.now(timezone.utc).date()
    route = build_day_route(db, technician, target, settings)
    db.commit()
    # The browser key is referrer-restricted and belongs in the page; the server
    # key never leaves the backend.
    return day_route_out(route, google_maps_link(route), app_settings.google_maps_browser_key)


@router.get("/tech/schedule", response_model=list[schemas.JobOut])
def my_schedule(
    scope: str = Query(default="today", pattern="^(today|upcoming|past)$"),
    technician: Technician = Depends(current_technician),
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    day_start = datetime.combine(now.date(), datetime.min.time(), tzinfo=timezone.utc)
    day_end = day_start + timedelta(days=1)

    jobs = []
    for appointment in technician.appointments:
        starts = _as_utc(appointment.starts_at)
        if scope == "today":
            keep = day_start <= starts < day_end and appointment.is_live
        elif scope == "upcoming":
            keep = starts >= day_end and appointment.is_live
        else:
            keep = not appointment.is_live or starts < day_start
        if keep:
            jobs.append(appointment)

    jobs.sort(key=lambda a: _as_utc(a.starts_at), reverse=(scope == "past"))
    return [schemas.JobOut(**appointment_out(a).model_dump(), order=_job_order(a)) for a in jobs]


def _job_order(appointment: Appointment) -> schemas.JobOrderOut:
    order = appointment.order
    return schemas.JobOrderOut(
        id=order.id,
        order_number=order.reference,
        patient_name=order.patient.full_name,
        doctor_name=order.doctor.full_name,
        clinic_name=order.doctor.clinic_name,
        arch=order.arch,
        clinical_notes=order.clinical_notes,
        status=order.status,
    )


def _own_job(appointment_id: str, db: Session, technician: Technician) -> Appointment:
    """Single choke point for technician-scoped access."""
    appointment = db.get(Appointment, appointment_id)
    if not appointment or appointment.technician_id != technician.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found.")
    return appointment


@router.get("/tech/cases/{order_id}", response_model=schemas.OrderDetail)
def technician_case(
    order_id: str,
    technician: Technician = Depends(current_technician),
    db: Session = Depends(get_db),
):
    """A technician reaches a case through their own schedule, never by browsing.
    Scoped to orders they hold an appointment on so they cannot wander into
    somebody else's work by editing the URL."""
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Case not found.")
    if not any(a.technician_id == technician.id for a in order.appointments):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Case not found.")
    return order_detail(order, UserRole.TECHNICIAN)


@router.post("/tech/jobs/{appointment_id}/en-route", response_model=schemas.JobOut)
def mark_en_route(
    appointment_id: str,
    technician: Technician = Depends(current_technician),
    db: Session = Depends(get_db),
):
    appointment = _own_job(appointment_id, db, technician)
    if appointment.status != AppointmentStatus.ASSIGNED:
        raise HTTPException(status.HTTP_409_CONFLICT, "This job is not scheduled.")
    appointment.status = AppointmentStatus.EN_ROUTE
    appointment.started_at = utcnow()
    db.add(
        Notification(
            user_id=appointment.order.doctor.user_id,
            order_id=appointment.order_id,
            title="Technician on the way",
            body=f"{appointment.order.reference} — {technician.full_name} is heading over.",
        )
    )
    db.commit()
    db.refresh(appointment)
    return schemas.JobOut(**appointment_out(appointment).model_dump(), order=_job_order(appointment))


@router.post("/tech/jobs/{appointment_id}/no-show", response_model=schemas.JobOut)
def mark_no_show(
    appointment_id: str,
    payload: schemas.RecordsRequestIn,
    technician: Technician = Depends(current_technician),
    db: Session = Depends(get_db),
):
    appointment = _own_job(appointment_id, db, technician)
    if not appointment.is_live:
        raise HTTPException(status.HTTP_409_CONFLICT, "This job is already closed.")
    appointment.status = AppointmentStatus.NO_SHOW
    appointment.outcome_notes = payload.note
    db.add(
        Notification(
            user_id=appointment.order.doctor.user_id,
            order_id=appointment.order_id,
            title="Scan could not be taken",
            body=f"{appointment.order.reference} — {payload.note}",
        )
    )
    db.commit()
    db.refresh(appointment)
    return schemas.JobOut(**appointment_out(appointment).model_dump(), order=_job_order(appointment))


# --------------------------------------------------------------------------
# Admin — bookings, technicians, settings
# --------------------------------------------------------------------------


@router.get("/admin/bookings", response_model=list[schemas.BookingOut])
def list_bookings(
    from_date: Optional[date_type] = Query(default=None, alias="from"),
    to_date: Optional[date_type] = Query(default=None, alias="to"),
    technician_id: Optional[str] = Query(default=None),
    appointment_status: Optional[AppointmentStatus] = Query(default=None, alias="status"),
    admin: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    query = db.query(Appointment)
    if technician_id:
        query = query.filter(Appointment.technician_id == technician_id)
    if appointment_status:
        query = query.filter(Appointment.status == appointment_status)

    rows = query.order_by(Appointment.starts_at).all()
    if from_date:
        rows = [a for a in rows if _as_utc(a.starts_at).date() >= from_date]
    if to_date:
        rows = [a for a in rows if _as_utc(a.starts_at).date() <= to_date]

    return [
        schemas.BookingOut(
            **appointment_out(a).model_dump(),
            order=_job_order(a),
            address=schemas.AddressOut.model_validate(a.address) if a.address else None,
        )
        for a in rows
    ]


def _hand_over(
    db: Session,
    appointment: Appointment,
    technician: Technician,
    overridden: bool = False,
    note: str = "",
) -> None:
    """Move a live visit to another technician and tell both of them.

    The one place a visit changes hands, so the notifications and the audit
    line cannot drift apart between the lab's own reassignment and a
    technician-initiated handover.
    """
    previous = appointment.technician
    appointment.technician_id = technician.id
    appointment.assignment_reason = (
        f"Reassigned by the lab from {previous.full_name if previous else 'unassigned'}"
        f"{' (availability overridden)' if overridden else ''}."
        + (f" {note}" if note else "")
    )
    db.add(
        Notification(
            user_id=technician.user_id,
            order_id=appointment.order_id,
            title="Scan visit assigned to you",
            body=f"{appointment.order.reference} — {_as_utc(appointment.starts_at):%d %b, %H:%M}",
        )
    )
    if previous and previous.id != technician.id:
        db.add(
            Notification(
                user_id=previous.user_id,
                order_id=appointment.order_id,
                title="Visit handed over",
                body=(
                    f"{appointment.order.reference} — now with {technician.full_name}."
                ),
            )
        )


def _reassignment_out(request) -> schemas.ReassignmentOut:
    appointment = request.appointment
    order = appointment.order if appointment else None
    return schemas.ReassignmentOut(
        id=request.id,
        status=request.status.value,
        reason=request.reason,
        resolution=request.resolution,
        created_at=request.created_at,
        resolved_at=request.resolved_at,
        requested_by=request.technician.full_name if request.technician else "",
        appointment_id=request.appointment_id,
        order_reference=order.reference if order else "",
        patient_name=order.patient.full_name if order and order.patient else "",
        clinic_name=order.doctor.clinic_name if order and order.doctor else "",
        starts_at=_as_utc(appointment.starts_at) if appointment else utcnow(),
        current_technician=appointment.technician.full_name
        if appointment and appointment.technician
        else "",
    )


@router.post("/tech/jobs/{appointment_id}/reassign-request", response_model=schemas.ReassignmentOut)
def request_reassignment(
    appointment_id: str,
    payload: schemas.ReassignRequestIn,
    technician: Technician = Depends(current_technician),
    db: Session = Depends(get_db),
):
    """A technician asking the lab to take a visit off them."""
    appointment = db.get(Appointment, appointment_id)
    if not appointment or appointment.technician_id != technician.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Booking not found.")
    if not appointment.is_live:
        raise HTTPException(status.HTTP_409_CONFLICT, "That booking is already closed.")

    existing = (
        db.query(ReassignmentRequest)
        .filter(
            ReassignmentRequest.appointment_id == appointment.id,
            ReassignmentRequest.status == ReassignmentStatus.PENDING,
        )
        .first()
    )
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "The lab already has a request for this visit.")

    request = ReassignmentRequest(
        appointment_id=appointment.id,
        technician_id=technician.id,
        reason=payload.reason.strip(),
    )
    db.add(request)

    for member in db.query(User).filter(User.role == UserRole.ADMIN, User.is_active.is_(True)).all():
        db.add(
            Notification(
                user_id=member.id,
                order_id=appointment.order_id,
                title="Reassignment requested",
                body=(
                    f"{appointment.order.reference} — {technician.full_name} asked to hand over "
                    f"{_as_utc(appointment.starts_at):%d %b, %H:%M}.\n{payload.reason.strip()}"
                ),
            )
        )
    db.commit()
    db.refresh(request)
    return _reassignment_out(request)


# --------------------------------------------------------------------------
# Leave
# --------------------------------------------------------------------------


def _leave_out(row, affected: int = 0) -> schemas.LeaveOut:
    return schemas.LeaveOut(
        id=row.id,
        technician_id=row.technician_id,
        technician_name=row.technician.full_name if row.technician else "",
        starts_at=row.starts_at,
        ends_at=row.ends_at,
        reason=row.reason,
        status=row.status,
        status_label=LEAVE_STATUS_LABELS.get(row.status, row.status),
        decision_note=row.decision_note,
        decided_at=row.decided_at,
        affected_visits=affected,
    )


def _visits_in_window(technician, starts_at, ends_at) -> list:
    return [
        a
        for a in technician.appointments
        if a.status in LIVE_APPOINTMENT_STATUSES
        and _as_utc(a.starts_at) < _as_utc(ends_at)
        and _as_utc(starts_at) < _as_utc(a.ends_at)
    ]


@router.post("/tech/leave", response_model=schemas.LeaveOut, status_code=status.HTTP_201_CREATED)
def request_leave(
    payload: schemas.LeaveRequestIn,
    technician: Technician = Depends(current_technician),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """A technician asks to be off for a window.

    Asking does not close the diary — the lab has to approve it first, or a
    technician could strand their own bookings simply by requesting a day.
    """
    starts_at, ends_at = _as_utc(payload.starts_at), _as_utc(payload.ends_at)
    if ends_at <= starts_at:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Leave has to end after it starts.")

    row = TimeOff(
        technician_id=technician.id,
        starts_at=starts_at,
        ends_at=ends_at,
        reason=payload.reason.strip()[:200],
        status=LeaveStatus.PENDING,
        requested_by_id=user.id,
    )
    db.add(row)

    affected = len(_visits_in_window(technician, starts_at, ends_at))
    for member in db.query(User).filter(User.role == UserRole.ADMIN, User.is_active.is_(True)):
        db.add(
            Notification(
                user_id=member.id,
                title="Leave requested",
                body=f"{technician.full_name} — {starts_at:%d %b %H:%M} to {ends_at:%d %b %H:%M}"
                + (f", {affected} visit(s) booked in it." if affected else ", no visits booked."),
            )
        )
    db.commit()
    db.refresh(row)
    return _leave_out(row, affected)


@router.get("/tech/leave", response_model=list[schemas.LeaveOut])
def my_leave(
    technician: Technician = Depends(current_technician), db: Session = Depends(get_db)
):
    rows = sorted(technician.time_off, key=lambda r: _as_utc(r.starts_at), reverse=True)
    return [_leave_out(r) for r in rows]


@router.get("/admin/leave", response_model=list[schemas.LeaveOut])
def list_leave(
    pending_only: bool = False,
    admin: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    query = db.query(TimeOff)
    if pending_only:
        query = query.filter(TimeOff.status == LeaveStatus.PENDING)
    rows = query.order_by(TimeOff.starts_at.desc()).limit(200).all()
    return [
        _leave_out(
            r,
            len(_visits_in_window(r.technician, r.starts_at, r.ends_at)) if r.technician else 0,
        )
        for r in rows
    ]


@router.post("/admin/leave/{leave_id}/decide", response_model=schemas.LeaveDecisionOut)
def decide_leave(
    leave_id: str,
    payload: schemas.LeaveDecisionIn,
    admin: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    """Approve or decline a technician's leave.

    Approving is the moment the diary actually closes, so it is also the moment
    every visit inside the window has to find another technician. Whatever
    nobody can cover is handed to the lab rather than left silently double
    booked against someone who will not be there.
    """
    row = db.get(TimeOff, leave_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Leave request not found.")
    if row.status != LeaveStatus.PENDING:
        raise HTTPException(status.HTTP_409_CONFLICT, "That request has already been answered.")

    row.decided_by_id = admin.id
    row.decided_at = utcnow()
    row.decision_note = payload.note.strip()[:300]

    if not payload.approve:
        row.status = LeaveStatus.DECLINED
        db.add(
            Notification(
                user_id=row.technician.user_id,
                title="Leave declined",
                body=payload.note.strip() or "3D Align could not approve that leave.",
            )
        )
        db.commit()
        db.refresh(row)
        return schemas.LeaveDecisionOut(leave=_leave_out(row), covered=[], stranded=[])

    row.status = LeaveStatus.APPROVED
    settings = scheduling.get_settings(db)
    covered, stranded = scheduling.cover_leave(
        db, row.technician, _as_utc(row.starts_at), _as_utc(row.ends_at), settings
    )

    covered_out = []
    for appointment, technician, reason in covered:
        _hand_over(
            db,
            appointment,
            technician,
            note=f"{row.technician.full_name} is on approved leave.",
        )
        appointment.needs_attention_at = None
        appointment.attention_reason = ""
        covered_out.append(
            {
                "appointment_id": appointment.id,
                "order_reference": appointment.order.reference,
                "starts_at": _as_utc(appointment.starts_at).isoformat(),
                "technician_name": technician.full_name,
                "reason": reason,
            }
        )

    stranded_out = []
    for appointment, why in stranded:
        appointment.needs_attention_at = utcnow()
        appointment.attention_reason = why[:300]
        stranded_out.append(
            {
                "appointment_id": appointment.id,
                "order_reference": appointment.order.reference,
                "starts_at": _as_utc(appointment.starts_at).isoformat(),
                "reason": why,
            }
        )

    db.add(
        Notification(
            user_id=row.technician.user_id,
            title="Leave approved",
            body=f"{len(covered_out)} visit(s) moved to someone else"
            + (f", {len(stranded_out)} still with the lab." if stranded_out else "."),
        )
    )
    if stranded_out:
        for member in db.query(User).filter(
            User.role == UserRole.ADMIN, User.is_active.is_(True)
        ):
            db.add(
                Notification(
                    user_id=member.id,
                    title="Visits need a decision",
                    body=f"{len(stranded_out)} visit(s) could not be covered for "
                    f"{row.technician.full_name}'s leave.",
                )
            )

    db.commit()
    db.refresh(row)
    return schemas.LeaveDecisionOut(
        leave=_leave_out(row), covered=covered_out, stranded=stranded_out
    )


@router.get("/admin/bookings/attention", response_model=list[schemas.BookingOut])
def bookings_needing_attention(
    admin: User = Depends(current_admin), db: Session = Depends(get_db)
):
    """Visits approved leave stranded, which only a person can settle."""
    rows = (
        db.query(Appointment)
        .filter(
            Appointment.needs_attention_at.isnot(None),
            Appointment.status.in_(list(LIVE_APPOINTMENT_STATUSES)),
        )
        .order_by(Appointment.starts_at)
        .all()
    )
    return [
        schemas.BookingOut(
            **appointment_out(a).model_dump(),
            order=_job_order(a),
            address=schemas.AddressOut.model_validate(a.address) if a.address else None,
        )
        for a in rows
    ]


@router.post("/admin/bookings/{appointment_id}/attention", response_model=schemas.BookingOut)
def settle_attention(
    appointment_id: str,
    payload: schemas.AttentionIn,
    admin: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    """What the lab does with a visit nobody could cover.

    Either the clinic is asked for another slot — which cancels this one through
    the ordinary path, so the case goes back to awaiting a scan exactly as any
    other cancellation would — or it is left standing, because the lab has
    arranged something the portal cannot see.
    """
    appointment = db.get(Appointment, appointment_id)
    if appointment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Booking not found.")
    if appointment.needs_attention_at is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "That booking is not waiting on a decision.")

    if payload.action == AttentionAction.RESCHEDULE:
        reason = payload.note.strip() or "The technician is on leave and nobody else was free."
        appointment.status = AppointmentStatus.CANCELLED
        appointment.cancelled_at = utcnow()
        appointment.cancel_reason = reason
        appointment.needs_attention_at = None
        appointment.attention_reason = ""
        db.add(
            Notification(
                user_id=appointment.order.doctor.user_id,
                order_id=appointment.order_id,
                title="Scan visit cancelled — please pick another slot",
                body=f"{appointment.order.reference} — {reason}",
            )
        )
    else:
        appointment.needs_attention_at = None
        appointment.attention_reason = ""
        appointment.assignment_reason = (
            (appointment.assignment_reason or "")
            + f" Left standing by the lab despite approved leave."
            + (f" {payload.note.strip()}" if payload.note.strip() else "")
        ).strip()

    db.commit()
    db.refresh(appointment)
    return schemas.BookingOut(
        **appointment_out(appointment).model_dump(),
        order=_job_order(appointment),
        address=schemas.AddressOut.model_validate(appointment.address)
        if appointment.address
        else None,
    )


@router.get("/admin/reassignments", response_model=list[schemas.ReassignmentOut])
def list_reassignments(
    pending_only: bool = Query(default=True),
    admin: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    query = db.query(ReassignmentRequest)
    if pending_only:
        query = query.filter(ReassignmentRequest.status == ReassignmentStatus.PENDING)
    rows = query.order_by(ReassignmentRequest.created_at.desc()).limit(200).all()
    return [_reassignment_out(r) for r in rows]


@router.post("/admin/reassignments/{request_id}/resolve", response_model=schemas.ReassignmentOut)
def resolve_reassignment(
    request_id: str,
    payload: schemas.ResolveReassignmentIn,
    admin: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    """Three ways out: name a technician, let the scheduler choose, or decline.

    The handover itself goes through the same feasibility check and the same
    assignment engine the lab already uses, so a visit moved this way is as
    reachable as one booked normally.
    """
    request = db.get(ReassignmentRequest, request_id)
    if not request:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Request not found.")
    if not request.is_open:
        raise HTTPException(status.HTTP_409_CONFLICT, "That request is already resolved.")

    appointment = request.appointment
    if payload.action == "DECLINE":
        request.status = ReassignmentStatus.DECLINED
        request.resolution = payload.note or "The lab kept the visit where it was."
        request.resolved_at = utcnow()
        db.add(
            Notification(
                user_id=request.technician.user_id,
                order_id=appointment.order_id,
                title="Reassignment declined",
                body=f"{appointment.order.reference} — {request.resolution}",
            )
        )
        db.commit()
        db.refresh(request)
        return _reassignment_out(request)

    if not appointment.is_live:
        raise HTTPException(status.HTTP_409_CONFLICT, "That booking is already closed.")

    settings = scheduling.get_settings(db)
    clinic = scheduling.address_point(appointment.address)
    starts, ends = _as_utc(appointment.starts_at), _as_utc(appointment.ends_at)

    if payload.action == "TECHNICIAN":
        technician = db.get(Technician, payload.technician_id or "")
        if not technician or not technician.is_active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Technician not found.")
        if technician.id == appointment.technician_id:
            raise HTTPException(status.HTTP_409_CONFLICT, "That is the technician asking to hand it over.")
        free = scheduling.technician_is_free(
            db, technician, starts, ends, settings,
            ignore_appointment_id=appointment.id, clinic=clinic,
        )
        if not free and not payload.force:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"{technician.full_name} is not free then. Re-send with force to override.",
            )
        overridden = not free
    else:
        # Let the scheduler pick, excluding whoever is handing it over.
        try:
            technician, _ = scheduling.assign_technician(
                db, starts, ends, settings, clinic,
                exclude_ids={appointment.technician_id},
                ignore_appointment_id=appointment.id,
            )
        except scheduling.SlotUnavailable as exc:
            # The booking-time explanation does not fit here: the visit's time is
            # fixed, so "the nearest time that works is 16:34" is advice the lab
            # cannot act on. Say what is actually true and what the options are.
            holder = (
                appointment.technician.full_name if appointment.technician else "the current technician"
            )
            when = starts.astimezone(scheduling.lab_zone(settings))
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                (
                    f"No other technician can reach this clinic at {when:%H:%M}"
                    f" on {when:%d %b} — {holder} is the only one who fits it in."
                    " Assign someone specific to override, or decline the request."
                ),
            ) from exc
        overridden = False

    _hand_over(db, appointment, technician, overridden=overridden, note=payload.note)
    request.status = ReassignmentStatus.RESOLVED
    request.resolution = (
        f"Handed to {technician.full_name}"
        + (" (availability overridden)" if overridden else "")
        + (f". {payload.note}" if payload.note else ".")
    )
    request.resolved_at = utcnow()
    db.commit()
    db.refresh(request)
    return _reassignment_out(request)


@router.post("/admin/bookings/{appointment_id}/reassign", response_model=schemas.BookingOut)
def reassign_booking(
    appointment_id: str,
    payload: schemas.ReassignIn,
    admin: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    appointment = db.get(Appointment, appointment_id)
    if not appointment:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Booking not found.")
    if not appointment.is_live:
        raise HTTPException(status.HTTP_409_CONFLICT, "That booking is already closed.")

    technician = db.get(Technician, payload.technician_id)
    if not technician or not technician.is_active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Technician not found.")

    settings = scheduling.get_settings(db)
    free = scheduling.technician_is_free(
        db,
        technician,
        _as_utc(appointment.starts_at),
        _as_utc(appointment.ends_at),
        settings,
        ignore_appointment_id=appointment.id,
        clinic=scheduling.address_point(appointment.address),
    )
    if not free and not payload.force:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{technician.full_name} is not free then. Re-send with force to override.",
        )

    _hand_over(db, appointment, technician, overridden=not free)
    db.commit()
    db.refresh(appointment)
    return schemas.BookingOut(
        **appointment_out(appointment).model_dump(),
        order=_job_order(appointment),
        address=schemas.AddressOut.model_validate(appointment.address)
        if appointment.address
        else None,
    )


@router.get("/admin/technicians", response_model=list[schemas.TechnicianOut])
def list_technicians(admin: User = Depends(current_admin), db: Session = Depends(get_db)):
    rows = db.query(Technician).order_by(Technician.full_name).all()
    return [technician_out(t) for t in rows]


@router.post(
    "/admin/technicians",
    response_model=schemas.TechnicianOut,
    status_code=status.HTTP_201_CREATED,
)
def create_technician(
    payload: schemas.TechnicianIn, admin: User = Depends(current_admin), db: Session = Depends(get_db)
):
    email = payload.email.lower().strip()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with that email already exists.")

    user = User(
        email=email, password_hash=hash_password(payload.password), role=UserRole.TECHNICIAN
    )
    db.add(user)
    db.flush()

    technician = Technician(
        user_id=user.id,
        full_name=payload.full_name,
        phone=payload.phone,
        employee_code=payload.employee_code,
        max_daily_jobs=payload.max_daily_jobs,
    )
    db.add(technician)
    db.flush()

    # Seed the roster from the lab's own working hours so a new hire is bookable
    # immediately rather than invisible until someone fills in a form.
    settings = scheduling.get_settings(db)
    for weekday, hours in (settings.working_hours or {}).items():
        if hours:
            db.add(
                AvailabilityRule(
                    technician_id=technician.id,
                    weekday=int(weekday),
                    start_time=scheduling._parse(hours[0]),
                    end_time=scheduling._parse(hours[1]),
                )
            )

    db.commit()
    db.refresh(technician)
    return technician_out(technician)


@router.patch("/admin/technicians/{technician_id}", response_model=schemas.TechnicianOut)
def update_technician(
    technician_id: str,
    payload: schemas.TechnicianUpdateIn,
    admin: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    technician = db.get(Technician, technician_id)
    if not technician:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Technician not found.")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(technician, field, value)
    db.commit()
    db.refresh(technician)
    return technician_out(technician)


@router.put(
    "/admin/technicians/{technician_id}/availability", response_model=schemas.TechnicianOut
)
def set_availability(
    technician_id: str,
    payload: schemas.AvailabilityIn,
    admin: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    technician = db.get(Technician, technician_id)
    if not technician:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Technician not found.")

    db.query(AvailabilityRule).filter(AvailabilityRule.technician_id == technician.id).delete()
    for rule in payload.rules:
        if rule.start_time >= rule.end_time:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "A working window must end after it starts."
            )
        db.add(
            AvailabilityRule(
                technician_id=technician.id,
                weekday=rule.weekday,
                start_time=rule.start_time,
                end_time=rule.end_time,
            )
        )
    db.commit()
    db.refresh(technician)
    return technician_out(technician)


@router.post("/admin/technicians/{technician_id}/time-off", response_model=schemas.TechnicianOut)
def add_time_off(
    technician_id: str,
    payload: schemas.TimeOffIn,
    admin: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    technician = db.get(Technician, technician_id)
    if not technician:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Technician not found.")
    if payload.starts_at >= payload.ends_at:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Time off must end after it starts.")
    db.add(
        TimeOff(
            technician_id=technician.id,
            starts_at=payload.starts_at,
            ends_at=payload.ends_at,
            reason=payload.reason,
        )
    )
    db.commit()
    db.refresh(technician)
    return technician_out(technician)


@router.delete(
    "/admin/time-off/{time_off_id}", status_code=status.HTTP_204_NO_CONTENT
)
def remove_time_off(
    time_off_id: str, admin: User = Depends(current_admin), db: Session = Depends(get_db)
):
    row = db.get(TimeOff, time_off_id)
    if row:
        db.delete(row)
        db.commit()


@router.get("/admin/settings", response_model=schemas.BookingSettingsOut)
def read_settings(admin: User = Depends(current_admin), db: Session = Depends(get_db)):
    return scheduling.get_settings(db)


@router.put("/admin/settings", response_model=schemas.BookingSettingsOut)
def update_settings(
    payload: schemas.BookingSettingsIn,
    admin: User = Depends(current_admin),
    db: Session = Depends(get_db),
):
    settings = scheduling.get_settings(db)
    fields = payload.model_dump(exclude_unset=True)

    # The lab's point is where every technician's day starts and ends, so it
    # cannot be allowed to drift from the address written above it. Typing a new
    # address used to leave the old coordinates in place, silently costing every
    # route from a building the lab had moved out of.
    picked = fields.pop("lab_latitude", None), fields.pop("lab_longitude", None)
    address_changed = "lab_address" in fields and fields["lab_address"] != settings.lab_address

    for field, value in fields.items():
        setattr(settings, field, value)

    if picked[0] is not None and picked[1] is not None:
        # A pin the lab dropped itself beats any lookup.
        settings.lab_latitude, settings.lab_longitude = picked
        settings.lab_geocode_source = "picked"
    elif address_changed:
        found = geo.geocode(settings.lab_address or "", settings.service_city or "", "")
        if found is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "That address could not be placed on the map. Drop the pin instead, or "
                "add the area and pincode.",
            )
        settings.lab_latitude, settings.lab_longitude, settings.lab_geocode_source = found

    db.commit()
    db.refresh(settings)
    return settings
