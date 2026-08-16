"""Availability and technician assignment.

Availability is computed on read rather than pre-generated into a slot table.
With a handful of technicians that is cheap, and a roster change takes effect
immediately instead of waiting for a regeneration job.

Assignment is deliberately plain: of the technicians free for a slot, take the
one with the fewest jobs that day. No scoring, no routing — there is one service
city and four people. If routing ever matters, `assign_technician` is the single
place it changes.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date as date_type, datetime, time as time_type, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from ..enums import LIVE_APPOINTMENT_STATUSES
from ..models import Appointment, BookingSettings, Technician

DEFAULT_WORKING_HOURS = {
    "0": ["09:00", "18:00"],
    "1": ["09:00", "18:00"],
    "2": ["09:00", "18:00"],
    "3": ["09:00", "18:00"],
    "4": ["09:00", "18:00"],
    "5": ["09:00", "14:00"],
    "6": None,
}


def get_settings(db: Session) -> BookingSettings:
    """One row, created on first use so the admin panel always has something."""
    row = db.query(BookingSettings).first()
    if row is None:
        row = BookingSettings(working_hours=dict(DEFAULT_WORKING_HOURS))
        db.add(row)
        db.commit()
        db.refresh(row)
    if not row.working_hours:
        row.working_hours = dict(DEFAULT_WORKING_HOURS)
        db.commit()
    return row


@dataclass
class Slot:
    starts_at: datetime
    ends_at: datetime
    available: bool
    reason: str = ""


def _parse(value: str) -> time_type:
    hour, minute = value.split(":")
    return time_type(int(hour), int(minute))


def working_window(
    settings: BookingSettings, day: date_type
) -> Optional[tuple[datetime, datetime]]:
    """The lab's open hours for a date, or None when closed."""
    hours = (settings.working_hours or {}).get(str(day.weekday()))
    if not hours:
        return None
    opens, closes = _parse(hours[0]), _parse(hours[1])
    return (
        datetime.combine(day, opens, tzinfo=timezone.utc),
        datetime.combine(day, closes, tzinfo=timezone.utc),
    )


def _as_utc(value: datetime) -> datetime:
    """SQLite hands back naive datetimes; treat them as UTC."""
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def technician_is_free(
    db: Session,
    technician: Technician,
    starts_at: datetime,
    ends_at: datetime,
    settings: BookingSettings,
    ignore_appointment_id: Optional[str] = None,
) -> bool:
    """Free means: rostered for that window, not on leave, no job overlapping it
    once travel buffer is applied either side, and under the daily cap."""
    weekday = starts_at.weekday()
    rules = [r for r in technician.availability if r.weekday == weekday]
    if not rules:
        return False
    inside = any(
        r.start_time <= starts_at.time() and ends_at.time() <= r.end_time for r in rules
    )
    if not inside:
        return False

    for off in technician.time_off:
        if _as_utc(off.starts_at) < ends_at and starts_at < _as_utc(off.ends_at):
            return False

    buffer = timedelta(minutes=settings.travel_buffer_minutes)
    day_start = datetime.combine(starts_at.date(), time_type.min, tzinfo=timezone.utc)
    day_end = day_start + timedelta(days=1)

    jobs_today = 0
    for appointment in technician.appointments:
        if appointment.status not in LIVE_APPOINTMENT_STATUSES:
            continue
        if ignore_appointment_id and appointment.id == ignore_appointment_id:
            continue
        appointment_start = _as_utc(appointment.starts_at)
        appointment_end = _as_utc(appointment.ends_at)
        # Buffer applies to the existing job, so two visits cannot butt together.
        if appointment_start - buffer < ends_at and starts_at < appointment_end + buffer:
            return False
        if day_start <= appointment_start < day_end:
            jobs_today += 1

    cap = technician.max_daily_jobs or settings.max_daily_jobs
    return jobs_today < cap


def active_technicians(db: Session) -> list[Technician]:
    return (
        db.query(Technician)
        .filter(Technician.is_active.is_(True))
        .order_by(Technician.full_name)
        .all()
    )


def slots_for_day(db: Session, day: date_type, settings: BookingSettings) -> list[Slot]:
    """Every slot on the grid for a date, each marked free or not, so the
    calendar can show a day filling up rather than silently hiding times."""
    window = working_window(settings, day)
    if window is None:
        return []

    opens, closes = window
    length = timedelta(minutes=settings.slot_minutes)
    now = datetime.now(timezone.utc)
    earliest = now + timedelta(hours=settings.min_notice_hours)
    latest = now + timedelta(days=settings.booking_horizon_days)
    technicians = active_technicians(db)

    slots: list[Slot] = []
    cursor = opens
    while cursor + length <= closes:
        ends = cursor + length
        if cursor < earliest:
            slots.append(Slot(cursor, ends, False, "Too soon to book"))
        elif cursor > latest:
            slots.append(Slot(cursor, ends, False, "Beyond the booking window"))
        elif not technicians:
            slots.append(Slot(cursor, ends, False, "No technicians on the roster"))
        else:
            free = any(
                technician_is_free(db, t, cursor, ends, settings) for t in technicians
            )
            slots.append(Slot(cursor, ends, free, "" if free else "Fully booked"))
        cursor = ends

    return slots


class SlotUnavailable(RuntimeError):
    pass


def assign_technician(
    db: Session, starts_at: datetime, ends_at: datetime, settings: BookingSettings
) -> tuple[Technician, str]:
    """Pick whoever is free with the lightest day. Ties break on name so the
    outcome is stable and testable."""
    free = [
        t
        for t in active_technicians(db)
        if technician_is_free(db, t, starts_at, ends_at, settings)
    ]
    if not free:
        raise SlotUnavailable("That slot has just been taken. Please pick another time.")

    day_start = datetime.combine(starts_at.date(), time_type.min, tzinfo=timezone.utc)
    day_end = day_start + timedelta(days=1)

    def jobs_that_day(technician: Technician) -> int:
        return sum(
            1
            for a in technician.appointments
            if a.status in LIVE_APPOINTMENT_STATUSES
            and day_start <= _as_utc(a.starts_at) < day_end
        )

    chosen = min(free, key=lambda t: (jobs_that_day(t), t.full_name))
    reason = (
        f"Free for this slot; {jobs_that_day(chosen)} other job(s) that day"
        f" ({len(free)} technician(s) were available)."
    )
    return chosen, reason


def next_available_day(db: Session, settings: BookingSettings) -> Optional[date_type]:
    """Used by the calendar to open on a day that actually has slots."""
    today = datetime.now(timezone.utc).date()
    for offset in range(settings.booking_horizon_days + 1):
        day = today + timedelta(days=offset)
        if any(s.available for s in slots_for_day(db, day, settings)):
            return day
    return None
