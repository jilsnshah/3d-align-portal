"""A technician's day as a route.

The same numbers drive three things: the map the lab looks at, the running
sheet the technician drives to, and the re-validation sweep.

That last one matters most. A visit booked three weeks ago was costed against
*predicted* traffic. Re-costing the day against current traffic is the only way
to find out that a route no longer holds while there is still time to move
something, rather than when a technician is sitting on Ashram Road.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date as date_type, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from ..enums import LIVE_APPOINTMENT_STATUSES
from ..models import Appointment, BookingSettings, Technician
from .scheduling import _as_utc, address_point, lab_point, local_day_bounds, _rostered_span
from .travel import Point, TravelService, route_polyline


@dataclass
class Stop:
    kind: str  # "lab" or "visit"
    label: str
    address: str
    point: Optional[Point]
    arrives_at: Optional[datetime]
    departs_at: Optional[datetime]
    leg_minutes: float = 0.0
    leg_km: float = 0.0
    appointment_id: str = ""
    order_reference: str = ""
    patient_name: str = ""
    booked_for: Optional[datetime] = None
    late_by_minutes: float = 0.0


@dataclass
class DayRoute:
    technician_id: str
    technician_name: str
    day: date_type
    stops: list[Stop] = field(default_factory=list)
    total_km: float = 0.0
    drive_minutes: float = 0.0
    onsite_minutes: float = 0.0
    warnings: list[str] = field(default_factory=list)
    polyline: str = ""

    @property
    def is_at_risk(self) -> bool:
        return any(s.late_by_minutes > 0 for s in self.stops)


def _describe(address) -> str:
    if address is None:
        return ""
    parts = [address.line1, address.city, address.pincode]
    return ", ".join(p for p in parts if p)


def build_day_route(
    db: Session,
    technician: Technician,
    day: date_type,
    settings: BookingSettings,
    travel: Optional[TravelService] = None,
) -> DayRoute:
    """Re-costs a technician's whole day against current traffic."""
    travel = travel or TravelService(db, settings)
    route = DayRoute(
        technician_id=technician.id,
        technician_name=technician.full_name,
        day=day,
    )

    day_start, day_end = local_day_bounds(day, settings)
    visits = sorted(
        (
            a
            for a in technician.appointments
            if a.status in LIVE_APPOINTMENT_STATUSES
            and day_start <= _as_utc(a.starts_at) < day_end
        ),
        key=lambda a: _as_utc(a.starts_at),
    )
    if not visits:
        return route

    base = lab_point(settings)
    span = _rostered_span(technician, day, settings)

    # Resolve the whole run in one batched call rather than a round trip per leg.
    points = [base] + [address_point(a.address) for a in visits] + [base]
    travel.prefetch(
        [
            (points[i], points[i + 1], _as_utc(visits[i].starts_at) if i < len(visits) else None)
            for i in range(len(points) - 1)
        ]
    )
    leaves_lab = span[0] if span else _as_utc(visits[0].starts_at)

    route.stops.append(
        Stop(
            kind="lab",
            label="Lab",
            address=settings.lab_address,
            point=base,
            arrives_at=None,
            departs_at=leaves_lab,
        )
    )

    cursor_point = base
    cursor_time = leaves_lab

    for appointment in visits:
        clinic = address_point(appointment.address)
        leg = travel.between(cursor_point, clinic, cursor_time)
        minutes = leg.minutes if leg else float(settings.travel_buffer_minutes)
        km = leg.distance_km if leg else 0.0

        projected = cursor_time + timedelta(minutes=minutes)
        booked = _as_utc(appointment.starts_at)
        # Arriving early is normal — the technician waits. Arriving after the
        # booked time is the thing worth shouting about.
        late = max(0.0, (projected - booked).total_seconds() / 60.0)
        starts = max(projected, booked)
        ends = _as_utc(appointment.ends_at)
        if ends <= starts:
            ends = starts + timedelta(minutes=settings.visit_duration_minutes)

        order = appointment.order
        route.stops.append(
            Stop(
                kind="visit",
                # A doctor runs one clinic, so the practice name is the stop.
                label=(
                    (order.doctor.clinic_name if order and order.doctor else "")
                    or (appointment.address.label if appointment.address else "")
                    or "Clinic"
                ),
                address=_describe(appointment.address),
                point=clinic,
                arrives_at=projected,
                departs_at=ends,
                leg_minutes=minutes,
                leg_km=km,
                appointment_id=appointment.id,
                order_reference=order.reference if order else "",
                patient_name=order.patient.full_name if order and order.patient else "",
                booked_for=booked,
                late_by_minutes=late,
            )
        )
        if late > 0:
            route.warnings.append(
                f"{order.reference if order else 'A visit'} at "
                f"{booked:%H:%M} is now {round(late)} min out of reach."
            )

        route.total_km += km
        route.drive_minutes += minutes
        route.onsite_minutes += (ends - starts).total_seconds() / 60.0
        cursor_point = clinic
        cursor_time = ends

    back = travel.between(cursor_point, base, cursor_time)
    back_minutes = back.minutes if back else float(settings.travel_buffer_minutes)
    route.stops.append(
        Stop(
            kind="lab",
            label="Lab",
            address=settings.lab_address,
            point=base,
            arrives_at=cursor_time + timedelta(minutes=back_minutes),
            departs_at=None,
            leg_minutes=back_minutes,
            leg_km=back.distance_km if back else 0.0,
        )
    )
    route.total_km += back.distance_km if back else 0.0
    route.drive_minutes += back_minutes

    drawn = route_polyline([s.point for s in route.stops if s.point], leaves_lab)
    if drawn:
        route.polyline = drawn["polyline"]

    if span and route.stops[-1].arrives_at and route.stops[-1].arrives_at > span[1]:
        over = (route.stops[-1].arrives_at - span[1]).total_seconds() / 60.0
        route.warnings.append(f"The day runs {round(over)} min past the end of shift.")

    return route


def google_maps_link(route: DayRoute) -> str:
    """A deep link the technician can drive from. No key, no cost, and it opens
    the native app on a phone."""
    points = [s.point for s in route.stops if s.point]
    if len(points) < 2:
        return ""
    origin = f"{points[0][0]},{points[0][1]}"
    destination = f"{points[-1][0]},{points[-1][1]}"
    waypoints = "|".join(f"{lat},{lng}" for lat, lng in points[1:-1])
    link = (
        "https://www.google.com/maps/dir/?api=1"
        f"&origin={origin}&destination={destination}&travelmode=driving"
    )
    return f"{link}&waypoints={waypoints}" if waypoints else link
