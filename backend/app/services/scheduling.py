"""Availability and technician assignment.

Availability is computed on read rather than pre-generated into a slot table.
With a handful of technicians that is cheap, and a roster change takes effect
immediately instead of waiting for a regeneration job.

There is no slot grid. A visit can start at any time a technician can actually
reach the clinic, so a 15:35 arrival offers 15:35 rather than killing the whole
15:30-16:30 hour. For each gap in a technician's day the scheduler works out the
window a visit fits into:

    earliest start = previous job ends + travel(previous clinic -> this clinic)
    latest  start  = next job starts   - travel(this clinic -> next clinic)
                                       - the visit itself

Every minute between those two is bookable, so the doctor is offered times on a
fine granularity derived from real travel rather than from a fixed grid.

Assignment is cheapest insertion: the cost of a visit is what it adds to the
route, not how far the technician is in a straight line. A technician further
away but already passing the door beats a nearer one who would have to double
back. Fairness only breaks near-ties; max_daily_jobs stays the hard backstop.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date as date_type, datetime, time as time_type, timedelta, timezone
from typing import Optional, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from .. import enums
from ..enums import LIVE_APPOINTMENT_STATUSES
from ..models import Address, Appointment, BookingSettings, Technician
from .geo import LAB_DEFAULT, LAB_DEFAULT_ADDRESS
from .travel import Point, TravelService

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
    changed = False
    if not row.working_hours:
        row.working_hours = dict(DEFAULT_WORKING_HOURS)
        changed = True
    if row.lab_latitude is None or row.lab_longitude is None:
        row.lab_latitude, row.lab_longitude = LAB_DEFAULT
        row.lab_address = row.lab_address or LAB_DEFAULT_ADDRESS
        changed = True
    if changed:
        db.commit()
    return row


@dataclass
class Slot:
    starts_at: datetime
    ends_at: datetime
    available: bool
    reason: str = ""


@dataclass
class Window:
    """A continuous range of start times a visit fits into, for one technician."""

    technician: Technician
    earliest: datetime
    latest: datetime
    detour_minutes: float
    inbound_minutes: float

    def contains(self, starts_at: datetime) -> bool:
        return self.earliest <= starts_at <= self.latest


def lab_zone(settings: BookingSettings) -> ZoneInfo:
    """The wall clock the lab actually works to."""
    try:
        return ZoneInfo(settings.timezone_name or "Asia/Kolkata")
    except Exception:  # pragma: no cover - a bad name must not stop scheduling
        return ZoneInfo("Asia/Kolkata")


def local_moment(day: date_type, at: time_type, settings: BookingSettings) -> datetime:
    """A wall-clock time on a date, as the instant it really is."""
    return datetime.combine(day, at, tzinfo=lab_zone(settings)).astimezone(timezone.utc)


def local_day_bounds(day: date_type, settings: BookingSettings) -> tuple[datetime, datetime]:
    """Midnight to midnight in the lab's city, not in UTC."""
    zone = lab_zone(settings)
    start = datetime.combine(day, time_type.min, tzinfo=zone)
    return start.astimezone(timezone.utc), (start + timedelta(days=1)).astimezone(timezone.utc)


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
    return local_moment(day, opens, settings), local_moment(day, closes, settings)


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


def address_point(address: Optional[Address]) -> Optional[Point]:
    if address is None or address.latitude is None or address.longitude is None:
        return None
    return (address.latitude, address.longitude)


def lab_point(settings: BookingSettings) -> Optional[Point]:
    if settings.lab_latitude is None or settings.lab_longitude is None:
        return None
    return (settings.lab_latitude, settings.lab_longitude)


def visit_length(settings: BookingSettings) -> timedelta:
    return timedelta(minutes=settings.visit_duration_minutes or settings.slot_minutes or 45)


# --------------------------------------------------------------------------
# One technician's day
# --------------------------------------------------------------------------


@dataclass
class _Commitment:
    starts_at: datetime
    ends_at: datetime
    point: Optional[Point]


def _rostered_span(
    technician: Technician, day: date_type, settings: BookingSettings
) -> Optional[tuple[datetime, datetime]]:
    """When this technician is on duty that day, inside the lab's open hours."""
    lab = working_window(settings, day)
    if lab is None:
        return None
    rules = [r for r in technician.availability if r.weekday == day.weekday()]
    if not rules:
        return None

    starts = min(r.start_time for r in rules)
    ends = max(r.end_time for r in rules)
    span_start = max(lab[0], local_moment(day, starts, settings))
    span_end = min(lab[1], local_moment(day, ends, settings))
    return (span_start, span_end) if span_start < span_end else None


def _commitments(
    technician: Technician,
    day: date_type,
    settings: BookingSettings,
    ignore_appointment_id: Optional[str] = None,
) -> list[_Commitment]:
    day_start, day_end = local_day_bounds(day, settings)

    out: list[_Commitment] = []
    for appointment in technician.appointments:
        if appointment.status not in LIVE_APPOINTMENT_STATUSES:
            continue
        if ignore_appointment_id and appointment.id == ignore_appointment_id:
            continue
        starts = _as_utc(appointment.starts_at)
        if not (day_start <= starts < day_end):
            continue
        out.append(
            _Commitment(starts, _as_utc(appointment.ends_at), address_point(appointment.address))
        )
    return sorted(out, key=lambda c: c.starts_at)


def _time_off_blocks(
    technician: Technician, day: date_type, settings: BookingSettings
) -> list[tuple[datetime, datetime]]:
    day_start, day_end = local_day_bounds(day, settings)
    # Only approved leave closes the diary. A request that is still with the lab
    # must not block bookings, or a technician could strand their own visits
    # simply by asking for a day off.
    return [
        (_as_utc(off.starts_at), _as_utc(off.ends_at))
        for off in technician.time_off
        if off.status == enums.LeaveStatus.APPROVED
        and _as_utc(off.starts_at) < day_end
        and day_start < _as_utc(off.ends_at)
    ]


def technician_windows(
    technician: Technician,
    day: date_type,
    clinic: Optional[Point],
    settings: BookingSettings,
    travel: TravelService,
    ignore_appointment_id: Optional[str] = None,
) -> list[Window]:
    """Every range of start times this technician could take the visit in."""
    span = _rostered_span(technician, day, settings)
    if span is None:
        return []

    cap = technician.max_daily_jobs or settings.max_daily_jobs
    commitments = _commitments(technician, day, settings, ignore_appointment_id)
    if len(commitments) >= cap:
        return []

    length = visit_length(settings)
    buffer = timedelta(minutes=settings.travel_buffer_minutes)
    base = lab_point(settings)
    off_blocks = _time_off_blocks(technician, day, settings)

    # The day reads as: leave the lab, the jobs already booked, back to the lab.
    anchors = (
        [_Commitment(span[0], span[0], base)]
        + commitments
        + [_Commitment(span[1], span[1], base)]
    )

    def leg(a: Optional[Point], b: Optional[Point], depart_at: Optional[datetime] = None) -> float:
        # No coordinates for one end: fall back to the flat buffer rather than
        # inventing a distance.
        return travel.minutes(
            a, b, fallback=float(settings.travel_buffer_minutes), depart_at=depart_at
        )

    windows: list[Window] = []
    for before, after in zip(anchors, anchors[1:]):
        # Each leg is costed against the traffic at the hour it is actually
        # driven: leaving the previous stop, then leaving the clinic afterwards.
        inbound = leg(before.point, clinic, before.ends_at)
        leaves_clinic = before.ends_at + timedelta(minutes=inbound) + length
        outbound = leg(clinic, after.point, leaves_clinic)
        if settings.max_travel_minutes and inbound > settings.max_travel_minutes:
            continue

        earliest = before.ends_at + timedelta(minutes=inbound) + buffer
        # A computed arrival lands on an arbitrary second; nobody books 10:28:26.
        # Round up so the offered time is never earlier than the real arrival.
        if earliest.second or earliest.microsecond:
            earliest = (earliest + timedelta(minutes=1)).replace(second=0, microsecond=0)
        latest = after.starts_at - timedelta(minutes=outbound) - buffer - length
        earliest = max(earliest, span[0])
        latest = min(latest, span[1] - length)
        if earliest > latest:
            continue

        # Time off carves the window up; keep whichever pieces survive.
        pieces = [(earliest, latest)]
        for off_start, off_end in off_blocks:
            nxt: list[tuple[datetime, datetime]] = []
            for piece_start, piece_end in pieces:
                if off_end <= piece_start or off_start >= piece_end + length:
                    nxt.append((piece_start, piece_end))
                    continue
                if piece_start < off_start - length:
                    nxt.append((piece_start, min(piece_end, off_start - length)))
                if off_end < piece_end:
                    nxt.append((max(piece_start, off_end), piece_end))
            pieces = [(a, b) for a, b in nxt if a <= b]

        direct = leg(before.point, after.point, before.ends_at)
        detour = max(0.0, inbound + outbound - direct)
        for piece_start, piece_end in pieces:
            windows.append(Window(technician, piece_start, piece_end, detour, inbound))

    return windows


def day_legs(
    technicians: list[Technician],
    day: date_type,
    clinic: Optional[Point],
    settings: BookingSettings,
) -> list[tuple]:
    """Every (origin, destination, departure) a day's availability will need."""
    base = lab_point(settings)
    out: list[tuple] = []
    for technician in technicians:
        span = _rostered_span(technician, day, settings)
        if span is None:
            continue
        anchors = (
            [_Commitment(span[0], span[0], base)]
            + _commitments(technician, day, settings)
            + [_Commitment(span[1], span[1], base)]
        )
        for before, after in zip(anchors, anchors[1:]):
            out.append((before.point, clinic, before.ends_at))
            out.append((clinic, after.point, before.ends_at))
            out.append((before.point, after.point, before.ends_at))
    return out


def active_technicians(db: Session) -> list[Technician]:
    return (
        db.query(Technician)
        .filter(Technician.is_active.is_(True))
        .order_by(Technician.full_name)
        .all()
    )


# --------------------------------------------------------------------------
# What the doctor sees
# --------------------------------------------------------------------------


def _candidate_times(
    span: tuple[datetime, datetime], settings: BookingSettings
) -> list[datetime]:
    """Start times on the booking granularity, across the open day."""
    step = timedelta(minutes=settings.booking_granularity_minutes or 15)
    length = visit_length(settings)
    out: list[datetime] = []
    cursor = span[0]
    while cursor + length <= span[1]:
        out.append(cursor)
        cursor += step
    return out


def requires_day_visit(clinic: Optional[Point], settings: BookingSettings) -> bool:
    """Is this clinic far enough out that it takes a whole day?

    Inside the service city a visit is one stop among several. Far enough out
    and the drive dominates: the technician goes there, does the scan, and comes
    back, and nothing else can be fitted around it. Booking it as a 45-minute
    slot would quietly promise a day that cannot happen.
    """
    from .travel import haversine_km

    base = lab_point(settings)
    if clinic is None or base is None or not settings.day_visit_over_km:
        return False
    return haversine_km(base, clinic) > settings.day_visit_over_km


def free_all_day(
    technician: Technician, day: date_type, settings: BookingSettings
) -> bool:
    """Nothing booked, rostered, and not on leave for any of it."""
    span = _rostered_span(technician, day, settings)
    if span is None:
        return False
    if _commitments(technician, day, settings):
        return False
    return not any(
        off_start <= span[0] and off_end >= span[1]
        for off_start, off_end in _time_off_blocks(technician, day, settings)
    )


def day_visit_window(
    day: date_type, settings: BookingSettings
) -> Optional[tuple[datetime, datetime]]:
    """A day visit runs the length of the shift."""
    return working_window(settings, day)


def day_capacity(
    db: Session,
    day: date_type,
    settings: BookingSettings,
    clinic: Optional[Point] = None,
) -> tuple[bool, int]:
    """Whether a day is worth opening, without costing a single travel call.

    The month grid only needs to know which days are worth clicking. Working out
    exact times means asking Google how long every leg takes, so that is left
    until a day is actually chosen — otherwise painting a calendar bills for
    thirty days of routing the doctor never looks at.

    Returns (closed, technicians_with_capacity).
    """
    if working_window(settings, day) is None:
        return True, 0

    now = datetime.now(timezone.utc)
    span = working_window(settings, day)
    if span[1] < now + timedelta(hours=settings.min_notice_hours):
        return False, 0
    if span[0] > now + timedelta(days=settings.booking_horizon_days):
        return False, 0

    if requires_day_visit(clinic, settings):
        # Nothing part-booked will do: the whole day has to be clear.
        return False, sum(1 for t in active_technicians(db) if free_all_day(t, day, settings))

    free = 0
    for technician in active_technicians(db):
        if _rostered_span(technician, day, settings) is None:
            continue
        cap = technician.max_daily_jobs or settings.max_daily_jobs
        if len(_commitments(technician, day, settings)) >= cap:
            continue
        # A full day of leave leaves no room either.
        blocks = _time_off_blocks(technician, day, settings)
        if any(b[0] <= span[0] and b[1] >= span[1] for b in blocks):
            continue
        free += 1
    return False, free


def slots_for_day(
    db: Session,
    day: date_type,
    settings: BookingSettings,
    clinic: Optional[Point] = None,
    travel: Optional[TravelService] = None,
) -> list[Slot]:
    """Every candidate start time for a date, each marked free or not, so the
    calendar shows a day filling up rather than silently hiding times."""
    span = working_window(settings, day)
    if span is None:
        return []

    travel = travel or TravelService(db, settings)
    length = visit_length(settings)
    now = datetime.now(timezone.utc)
    earliest_allowed = now + timedelta(hours=settings.min_notice_hours)
    latest_allowed = now + timedelta(days=settings.booking_horizon_days)
    technicians = active_technicians(db)

    if requires_day_visit(clinic, settings):
        # One offer: the day itself.
        if span[0] < earliest_allowed or span[0] > latest_allowed:
            reason = "Too soon to book" if span[0] < earliest_allowed else "Beyond the booking window"
            return [Slot(span[0], span[1], False, reason)]
        anyone = any(free_all_day(t, day, settings) for t in technicians)
        return [
            Slot(
                span[0],
                span[1],
                anyone,
                "" if anyone else "No technician has a clear day for an out-of-city visit",
            )
        ]

    # Travel is looked up once per technician per gap, not once per candidate
    # time, and the whole day's legs are resolved in one batched call before any
    # of them is costed — computeRouteMatrix answers origins x destinations at
    # once, and asking leg by leg would be a round trip per pair.
    travel.prefetch(day_legs(technicians, day, clinic, settings))
    windows = [w for t in technicians for w in technician_windows(t, day, clinic, settings, travel)]

    # The grid keeps unavailable times on screen so a day visibly fills up. On
    # top of it, every window contributes its exact earliest arrival, which is
    # the whole point: a technician free at 15:35 offers 15:35, not 15:45.
    grid = _candidate_times(span, settings)
    exact = [
        w.earliest
        for w in windows
        if w.earliest + length <= span[1] and w.earliest not in set(grid)
    ]
    slots: list[Slot] = []
    for start in sorted(set(grid) | set(exact)):
        ends = start + length
        if start < earliest_allowed:
            slots.append(Slot(start, ends, False, "Too soon to book"))
        elif start > latest_allowed:
            slots.append(Slot(start, ends, False, "Beyond the booking window"))
        elif not technicians:
            slots.append(Slot(start, ends, False, "No technicians on the roster"))
        else:
            free = any(w.contains(start) for w in windows)
            slots.append(Slot(start, ends, free, "" if free else "No technician can reach you"))
    return slots


class SlotUnavailable(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Assignment
# --------------------------------------------------------------------------


def _load_minutes(technician: Technician, day: date_type, settings: BookingSettings) -> float:
    """Committed minutes that day — the fairness signal."""
    return sum(
        (c.ends_at - c.starts_at).total_seconds() / 60.0
        for c in _commitments(technician, day, settings)
    )


def technician_is_free(
    db: Session,
    technician: Technician,
    starts_at: datetime,
    ends_at: datetime,
    settings: BookingSettings,
    ignore_appointment_id: Optional[str] = None,
    clinic: Optional[Point] = None,
    travel: Optional[TravelService] = None,
) -> bool:
    """Can this technician take a visit starting then, travel included."""
    travel = travel or TravelService(db, settings)
    windows = technician_windows(
        technician, starts_at.date(), clinic, settings, travel, ignore_appointment_id
    )
    return any(w.contains(starts_at) for w in windows)


def assign_technician(
    db: Session,
    starts_at: datetime,
    ends_at: datetime,
    settings: BookingSettings,
    clinic: Optional[Point] = None,
    travel: Optional[TravelService] = None,
    exclude_ids: Optional[set] = None,
    ignore_appointment_id: Optional[str] = None,
) -> Tuple[Technician, str]:
    """Cheapest insertion. Ties break on name so the outcome is deterministic.

    ``exclude_ids`` and ``ignore_appointment_id`` exist for handing a visit over:
    the technician giving it up is excluded, and their current booking is
    ignored so it does not block whoever picks it up.
    """
    travel = travel or TravelService(db, settings)
    day = starts_at.date()
    technicians = [t for t in active_technicians(db) if t.id not in (exclude_ids or set())]

    # Outside the service city the drive dominates: whoever goes is gone for the
    # day, so the question is who has a clear one rather than whose route it fits.
    if requires_day_visit(clinic, settings):
        free = [t for t in technicians if free_all_day(t, day, settings)]
        if not free:
            raise SlotUnavailable(
                "This clinic is outside the service city, so a visit takes a whole day "
                "and nobody has one free. Please pick another day."
            )
        from .travel import haversine_km

        base = lab_point(settings)
        distance = haversine_km(base, clinic) if base and clinic else 0
        chosen = min(free, key=lambda t: t.full_name)
        return chosen, (
            f"Out-of-city visit, about {distance:.0f} km from the lab — "
            f"{chosen.full_name} is out for the whole day "
            f"({len(free)} had a clear day)."
        )

    travel.prefetch(day_legs(technicians, day, clinic, settings))

    candidates: list[tuple[float, str, Technician, Window]] = []
    loads = {t.id: _load_minutes(t, day, settings) for t in technicians}
    average_load = (sum(loads.values()) / len(loads)) if loads else 0.0

    for technician in technicians:
        for window in technician_windows(
            technician, day, clinic, settings, travel, ignore_appointment_id
        ):
            if not window.contains(starts_at):
                continue
            # Dead time this insertion strands. Only slivers count: a gap wide
            # enough to hold another visit is not waste, so booking midday on an
            # open diary is free, while leaving 12 unusable minutes is not.
            reusable = (visit_length(settings).total_seconds() / 60.0) + settings.travel_buffer_minutes
            before = (starts_at - window.earliest).total_seconds() / 60.0
            after = (window.latest - starts_at).total_seconds() / 60.0
            idle = sum(g for g in (before, after) if 0 < g < reusable)
            over = max(0.0, loads[technician.id] - average_load)
            cost = (
                settings.travel_weight * window.detour_minutes
                + settings.fairness_weight * over
                + settings.idle_weight * idle
            )
            candidates.append((cost, technician.full_name, technician, window))
            break

    if not candidates:
        raise SlotUnavailable(_why_not(db, starts_at, settings, clinic, travel, technicians))

    cost, _, chosen, window = min(candidates, key=lambda c: (c[0], c[1]))
    reason = (
        f"{round(window.inbound_minutes)} min away from the previous stop; "
        f"adds {round(window.detour_minutes)} min to the route "
        f"({len(candidates)} technician(s) could reach it)."
    )
    return chosen, reason


def _why_not(
    db: Session,
    starts_at: datetime,
    settings: BookingSettings,
    clinic: Optional[Point],
    travel: TravelService,
    technicians: list[Technician],
) -> str:
    """Explain a refusal.

    "That slot has just been taken" was wrong almost every time it appeared: the
    usual reason is that nobody can *drive* there by then. A clinic told the
    truth can pick a workable time; a clinic told a slot was taken retries the
    same one.
    """
    if not technicians:
        return "No technicians are on the roster."

    zone = lab_zone(settings)
    day = starts_at.date()
    windows = [w for t in technicians for w in technician_windows(t, day, clinic, settings, travel)]

    if not windows:
        rostered = [t for t in technicians if _rostered_span(t, day, settings)]
        if not rostered:
            return "Nobody is rostered on that day."
        capped = all(
            len(_commitments(t, day, settings)) >= (t.max_daily_jobs or settings.max_daily_jobs)
            for t in rostered
        )
        if capped:
            return "Every technician is fully booked that day. Please pick another day."
        return "No technician can reach this clinic on that day."

    # There is capacity, just not then. Point at the nearest time that works.
    starts = sorted({w.earliest for w in windows if w.earliest > starts_at})
    ends = sorted({w.latest for w in windows if w.latest < starts_at}, reverse=True)
    nearest = None
    if starts and ends:
        nearest = starts[0] if (starts[0] - starts_at) <= (starts_at - ends[0]) else ends[0]
    else:
        nearest = starts[0] if starts else (ends[0] if ends else None)

    asked = starts_at.astimezone(zone).strftime("%H:%M")
    if nearest is None:
        return f"No technician can reach this clinic by {asked}."
    return (
        f"No technician can reach this clinic by {asked}. "
        f"The nearest time that works is {nearest.astimezone(zone).strftime('%H:%M')}."
    )


def next_available_day(
    db: Session,
    settings: BookingSettings,
    clinic: Optional[Point] = None,
) -> Optional[date_type]:
    """Used by the calendar to open on a day that actually has slots."""
    today = datetime.now(timezone.utc).date()
    travel = TravelService(db, settings)
    for offset in range(settings.booking_horizon_days + 1):
        day = today + timedelta(days=offset)
        if any(s.available for s in slots_for_day(db, day, settings, clinic, travel)):
            return day
    return None


def cover_leave(
    db: Session,
    technician: Technician,
    starts_at: datetime,
    ends_at: datetime,
    settings: BookingSettings,
) -> tuple:
    """Find someone else for every visit approved leave takes away.

    Each visit is offered to the rest of the team on its own merits — the same
    cheapest-insertion the original booking used, with the technician going on
    leave excluded and their booking ignored so it does not block whoever picks
    it up. Kept at the time the clinic already agreed to: moving the person is
    invisible to the patient, moving the appointment is not.

    Returns (covered, stranded) where each entry is (appointment, technician or
    reason).
    """
    covered: list = []
    stranded: list = []

    live = [
        a
        for a in technician.appointments
        if a.status in LIVE_APPOINTMENT_STATUSES
        and _as_utc(a.starts_at) < ends_at
        and starts_at < _as_utc(a.ends_at)
    ]
    # Earliest first, so the fullest diaries are competed for in the order the
    # day actually runs.
    live.sort(key=lambda a: _as_utc(a.starts_at))

    travel = TravelService(db, settings)
    for appointment in live:
        try:
            chosen, reason = assign_technician(
                db,
                _as_utc(appointment.starts_at),
                _as_utc(appointment.ends_at),
                settings,
                clinic=address_point(appointment.address),
                travel=travel,
                exclude_ids={technician.id},
                ignore_appointment_id=appointment.id,
            )
        except SlotUnavailable as exc:
            stranded.append((appointment, str(exc)))
            continue
        covered.append((appointment, chosen, reason))

    return covered, stranded
