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
    LIVE_APPOINTMENT_STATUSES,
    AppointmentStatus,
    OrderStatus,
    ScanRoute,
    UserRole,
)
from ..models import (
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
from ..serializers import appointment_out, order_detail, technician_out
from ..services import scheduling

router = APIRouter(tags=["bookings"])


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


# --------------------------------------------------------------------------
# Doctor — availability and booking
# --------------------------------------------------------------------------


@router.get("/appointments/availability", response_model=list[schemas.DayAvailability])
def availability(
    from_date: date_type = Query(..., alias="from"),
    to_date: date_type = Query(..., alias="to"),
    doctor: Doctor = Depends(verified_doctor),
    db: Session = Depends(get_db),
):
    settings = scheduling.get_settings(db)
    if (to_date - from_date).days > 62:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ask for at most two months at a time.")

    days = []
    cursor = from_date
    while cursor <= to_date:
        slots = scheduling.slots_for_day(db, cursor, settings)
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
            )
        )
        cursor += timedelta(days=1)
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
    ends_at = starts_at + timedelta(minutes=settings.slot_minutes)

    # Availability was advisory; this is the check that counts.
    try:
        technician, reason = scheduling.assign_technician(db, starts_at, ends_at, settings)
    except scheduling.SlotUnavailable as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

    appointment = Appointment(
        order_id=order.id,
        technician_id=technician.id,
        starts_at=starts_at,
        ends_at=ends_at,
        status=AppointmentStatus.ASSIGNED,
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
            body=f"{order.order_number} — {order.patient.full_name}\n{starts_at:%d %b %Y, %H:%M}",
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
            body=f"{order.order_number} — {payload.reason}",
        )
    )
    db.commit()
    db.refresh(order)
    return order_detail(order, user.role)


# --------------------------------------------------------------------------
# Technician — their own schedule
# --------------------------------------------------------------------------


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
        order_number=order.order_number,
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
            body=f"{appointment.order.order_number} — {technician.full_name} is heading over.",
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
            body=f"{appointment.order.order_number} — {payload.note}",
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
    )
    if not free and not payload.force:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{technician.full_name} is not free then. Re-send with force to override.",
        )

    previous = appointment.technician
    appointment.technician_id = technician.id
    appointment.assignment_reason = (
        f"Reassigned by the lab from {previous.full_name if previous else 'unassigned'}"
        f"{' (availability overridden)' if not free else ''}."
    )
    db.add(
        Notification(
            user_id=technician.user_id,
            order_id=appointment.order_id,
            title="Scan visit assigned to you",
            body=f"{appointment.order.order_number} — {_as_utc(appointment.starts_at):%d %b, %H:%M}",
        )
    )
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
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(settings, field, value)
    db.commit()
    db.refresh(settings)
    return settings
