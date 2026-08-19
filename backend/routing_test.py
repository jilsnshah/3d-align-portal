"""The travel-aware scheduler, exercised directly.

Booking through the API is covered by booking_test.py. This drives the
scheduling functions themselves, where the geography can be controlled exactly:
two technicians, two clinics on opposite sides of Ahmedabad, and assertions
about which windows open and who gets the job.

    .venv/bin/python routing_test.py
"""

import os
import tempfile
from datetime import datetime, time, timedelta, timezone

TMP = tempfile.mkdtemp(prefix="align-routing-")
os.environ["DATABASE_URL"] = f"sqlite:///{TMP}/routing.db"
os.environ["STORAGE_LOCAL_ROOT"] = f"{TMP}/storage"
os.environ["STAFF_EMAIL"] = "admin@3dalign.example.com"
os.environ["STAFF_PASSWORD"] = "adminpassword"
os.environ["DCI_CHECK_ENABLED"] = "false"
# Never let a test bill the live Maps account or depend on a network round trip.
# Routing behaviour is exercised against stub providers instead.
os.environ["GOOGLE_MAPS_API_KEY"] = ""
os.environ["GOOGLE_MAPS_BROWSER_KEY"] = ""

from app.db import Base, SessionLocal, engine  # noqa: E402
from app.enums import AppointmentStatus, UserRole  # noqa: E402
from app.models import (  # noqa: E402
    Address,
    Appointment,
    AvailabilityRule,
    BookingSettings,
    Doctor,
    Order,
    Patient,
    Technician,
    User,
)
from app.services import scheduling  # noqa: E402
from app.services.geo import PINCODE_CENTROIDS  # noqa: E402
from app.services.travel import TravelService, haversine_km  # noqa: E402

Base.metadata.create_all(engine)

failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"[  ok  ] {label}")
    else:
        failures.append(label)
        print(f"[ FAIL ] {label}" + (f"  — {detail}" if detail else ""))


db = SessionLocal()

# -- a lab, two technicians, two clinics far apart ------------------------
BOPAL = PINCODE_CENTROIDS["380058"]      # far west
MANINAGAR = PINCODE_CENTROIDS["380008"]  # far south-east
NEAR_LAB = PINCODE_CENTROIDS["380052"]   # Sola, where the lab is

settings = scheduling.get_settings(db)
# This suite is about routing, so it works in UTC and the wall-clock behaviour
# is asserted separately at the end.
settings.timezone_name = "UTC"
settings.min_notice_hours = 0
settings.visit_duration_minutes = 45
settings.booking_granularity_minutes = 15
settings.travel_buffer_minutes = 10
settings.max_daily_jobs = 4
db.commit()

print(f"Bopal to Maninagar straight line: {haversine_km(BOPAL, MANINAGAR):.1f} km")


def make_technician(name):
    user = User(email=f"{name.lower()}@3dalign.example.com", password_hash="x", role=UserRole.TECHNICIAN)
    db.add(user)
    db.flush()
    tech = Technician(user_id=user.id, full_name=name, max_daily_jobs=4)
    db.add(tech)
    db.flush()
    for weekday in range(7):
        db.add(
            AvailabilityRule(
                technician_id=tech.id, weekday=weekday, start_time=time(9, 0), end_time=time(18, 0)
            )
        )
    db.flush()
    return tech


def make_clinic(point, label):
    doctor_user = User(email=f"{label}@clinic.example.com", password_hash="x", role=UserRole.DOCTOR)
    db.add(doctor_user)
    db.flush()
    doctor = Doctor(user_id=doctor_user.id, full_name=f"Dr {label}", clinic_name=label)
    db.add(doctor)
    db.flush()
    address = Address(
        doctor_id=doctor.id, line1=f"{label} Road", city="Ahmedabad", state="Gujarat",
        pincode="380001", latitude=point[0], longitude=point[1], geocode_source="test",
    )
    db.add(address)
    db.flush()
    return doctor, address


anil = make_technician("Anil")
bhavna = make_technician("Bhavna")
doc_bopal, addr_bopal = make_clinic(BOPAL, "Bopal")
doc_mani, addr_mani = make_clinic(MANINAGAR, "Maninagar")
doc_near, addr_near = make_clinic(NEAR_LAB, "Sola")
db.commit()

DAY = (datetime.now(timezone.utc) + timedelta(days=3)).date()
while DAY.weekday() == 6:  # the lab is shut on Sunday
    DAY += timedelta(days=1)


def at(hour, minute=0):
    return datetime.combine(DAY, time(hour, minute), tzinfo=timezone.utc)


def book(tech, address, hour, minute=0):
    doctor = db.query(Doctor).filter(Doctor.id == address.doctor_id).one()
    patient = Patient(doctor_id=doctor.id, full_name="Test Patient")
    db.add(patient)
    db.flush()
    book.seq += 1
    order = Order(enquiry_number=f"EN-TEST-{book.seq:04d}", doctor_id=doctor.id, patient_id=patient.id)
    db.add(order)
    db.flush()
    appointment = Appointment(
        order_id=order.id, technician_id=tech.id,
        starts_at=at(hour, minute), ends_at=at(hour, minute) + timedelta(minutes=45),
        status=AppointmentStatus.ASSIGNED, address_id=address.id,
    )
    db.add(appointment)
    db.commit()
    return appointment


book.seq = 0
travel = TravelService(db, settings)

# -- 1. a window is a range, not a grid slot ------------------------------
book(anil, addr_bopal, 10, 0)  # Anil is in Bopal until 10:45
windows = scheduling.technician_windows(anil, DAY, MANINAGAR, settings, travel)
after = [w for w in windows if w.earliest > at(10, 45)]
check("a gap after an existing job produces a window", len(after) == 1, str(windows))

if after:
    w = after[0]
    minutes_travel = (w.earliest - at(10, 45)).total_seconds() / 60
    check(
        "the next visit cannot start until the technician has driven there",
        minutes_travel > 40,
        f"{minutes_travel:.0f} min after the previous job ends",
    )
    check(
        "the window start is a real arrival time, not a grid line",
        w.earliest.minute % 15 != 0,
        w.earliest.isoformat(),
    )

# -- 2. availability reflects the distance to *this* clinic ---------------
near_slots = scheduling.slots_for_day(db, DAY, settings, NEAR_LAB, TravelService(db, settings))
far_slots = scheduling.slots_for_day(db, DAY, settings, MANINAGAR, TravelService(db, settings))
near_free = sum(1 for s in near_slots if s.available)
far_free = sum(1 for s in far_slots if s.available)
check(
    "a clinic near the lab has more bookable times than one across town",
    near_free > far_free,
    f"near {near_free} vs far {far_free}",
)

# -- 3. cheapest insertion beats naive nearest ----------------------------
# Bhavna is free all day. Anil is already in Bopal at 10:00. A second Bopal
# visit should go to Anil, who is already there, even though both are free.
tech, reason = scheduling.assign_technician(
    db, at(12, 0), at(12, 45), settings, BOPAL, TravelService(db, settings)
)
check("a second visit next door goes to whoever is already there", tech.full_name == "Anil", f"{tech.full_name}: {reason}")

# The Maninagar visit at the same time should not go to Anil, who would have to
# cross the city; Bhavna starts from the lab and is much closer.
tech, reason = scheduling.assign_technician(
    db, at(12, 0), at(12, 45), settings, MANINAGAR, TravelService(db, settings)
)
check("a visit across town goes to the technician who can reach it", tech.full_name == "Bhavna", f"{tech.full_name}: {reason}")

# -- 4. the daily cap still holds -----------------------------------------
for hour in (11, 13, 15, 16):
    book(bhavna, addr_near, hour)
# The session keeps objects alive across commits, so the technician's
# appointment list has to be reloaded before it reflects the new bookings.
db.refresh(bhavna)
check(
    "a technician at the daily cap offers no windows",
    scheduling.technician_windows(bhavna, DAY, NEAR_LAB, settings, TravelService(db, settings)) == [],
    "cap should be reached",
)

# -- 5. no coordinates falls back to the flat buffer ----------------------
addr_unknown = Address(
    doctor_id=doc_near.id, line1="Unmapped Lane", city="Ahmedabad", state="Gujarat", pincode="999999"
)
db.add(addr_unknown)
db.commit()
unknown_windows = scheduling.technician_windows(
    anil, DAY, scheduling.address_point(addr_unknown), settings, TravelService(db, settings)
)
check(
    "an address with no coordinates is still bookable via the flat buffer",
    len(unknown_windows) > 0,
    "expected the buffer fallback to keep the day usable",
)

# -- 5b. the exact arrival time is offered, not just the grid -------------
# Anil is in Bopal until 10:45 and Maninagar is a long drive; the first offer
# after that should be his real arrival, which will not be a quarter hour.
mani_slots = scheduling.slots_for_day(db, DAY, settings, MANINAGAR, TravelService(db, settings))
off_grid = [
    s for s in mani_slots
    if s.available and s.starts_at.minute % settings.booking_granularity_minutes != 0
]
check(
    "a real arrival time is offered alongside the grid",
    len(off_grid) > 0,
    "expected at least one off-grid start time",
)

# -- 6. the cache stops repeat lookups ------------------------------------
from app.models import TravelEstimate  # noqa: E402

db.commit()
cached = db.query(TravelEstimate).count()
before = cached
shared = TravelService(db, settings)
for _ in range(5):
    scheduling.slots_for_day(db, DAY, settings, MANINAGAR, shared)
db.commit()
check(
    "repeat availability lookups do not add cache rows",
    db.query(TravelEstimate).count() == before,
    f"{before} -> {db.query(TravelEstimate).count()}",
)
check("travel estimates were cached at all", cached > 0, str(cached))

# -- 7. a routing provider replaces the estimates -------------------------
# Stubbed, not the real API: the point is that a provider is consulted, its
# numbers win over the straight-line guess, and cached estimates get upgraded
# rather than shadowing real data forever.
from app.services.travel import Leg, RoutingProvider, set_provider  # noqa: E402


class StubProvider(RoutingProvider):
    calls = 0
    departures = []

    def matrix(self, origins, destinations, depart_at=None):
        StubProvider.calls += 1
        StubProvider.departures.append(depart_at)
        return [[Leg(minutes=12.0, distance_km=5.0, source="google") for _ in destinations] for _ in origins]


estimates_before = db.query(TravelEstimate).filter(TravelEstimate.source == "estimate").count()
check("estimates were stored while no provider was configured", estimates_before > 0, str(estimates_before))

set_provider(StubProvider())
db.info.pop("travel_memo", None)  # a fresh request would not share the memo
upgraded = TravelService(db, settings)
depart = datetime.combine(DAY, time(11, 0), tzinfo=timezone.utc)
leg = upgraded.between(BOPAL, MANINAGAR, depart)
db.commit()

check("the provider is consulted once a key is configured", StubProvider.calls > 0)
check("provider numbers replace the straight-line guess", leg.source == "google" and leg.minutes == 12.0, str(leg))

from app.services.travel import bucket_for  # noqa: E402

pair = db.query(TravelEstimate).filter(
    TravelEstimate.origin_key == "23.033,72.464",
    TravelEstimate.destination_key == "22.995,72.601",
)
row = pair.filter(TravelEstimate.bucket == bucket_for(depart)).one()
check("the cached estimate was upgraded in place, not duplicated", row.source == "google", row.source)
check(
    "traffic buckets are kept apart, one row per hour of the week",
    len({r.bucket for r in pair.all()}) == pair.count(),
    str([(r.bucket, r.source) for r in pair.all()]),
)
check(
    "the departure time is passed to the provider so the answer is traffic-aware",
    any(d is not None for d in StubProvider.departures),
    str(StubProvider.departures[:3]),
)


class BrokenProvider(RoutingProvider):
    def matrix(self, origins, destinations, depart_at=None):
        raise RuntimeError("quota exceeded")


set_provider(BrokenProvider())
db.info.pop("travel_memo", None)
fresh = TravelService(db, settings)
survived = fresh.between(NEAR_LAB, (23.108, 72.628), depart)
db.commit()
check(
    "a failing provider degrades to an estimate instead of breaking booking",
    survived is not None and survived.source == "estimate",
    str(survived),
)
set_provider(None)


# -- 8. the day route and the re-validation sweep -------------------------
from app.services.routes import build_day_route, google_maps_link  # noqa: E402

set_provider(None)
db.info.pop("travel_memo", None)
db.refresh(anil)
route = build_day_route(db, anil, DAY, settings)

check("the route starts and ends at the lab", route.stops[0].kind == "lab" and route.stops[-1].kind == "lab", str([s.kind for s in route.stops]))
check("every visit is on the route", sum(1 for s in route.stops if s.kind == "visit") >= 1, str(len(route.stops)))
check("the route totals real distance", route.total_km > 0 and route.drive_minutes > 0, f"{route.total_km} km / {route.drive_minutes} min")
check("legs carry their own distance", any(s.leg_km > 0 for s in route.stops[1:]), "no leg distances")
check("a deep link is produced for navigation", google_maps_link(route).startswith("https://www.google.com/maps/dir/"), google_maps_link(route)[:60])

# Force a visit that cannot be reached in time and confirm the sweep says so.
far = book(anil, addr_mani, 11, 0)  # Anil is in Bopal until 10:45; Maninagar is ~56 min
db.refresh(anil)
risky = build_day_route(db, anil, DAY, settings)
late_stops = [s for s in risky.stops if s.late_by_minutes > 0]
check(
    "re-costing the day flags a visit that can no longer be reached in time",
    len(late_stops) > 0 and risky.is_at_risk,
    f"{[(s.order_reference, round(s.late_by_minutes)) for s in risky.stops if s.kind == 'visit']}",
)
check("the warning names the problem", any("out of reach" in w for w in risky.warnings), str(risky.warnings))


# -- 9. real-time calling: batching and retry -----------------------------
import httpx  # noqa: E402

from app.services.travel import bucket_for as _bucket  # noqa: E402


class CountingProvider(RoutingProvider):
    """Counts HTTP round trips and the elements each one covers."""

    def __init__(self):
        self.calls = 0
        self.elements = 0

    def matrix(self, origins, destinations, depart_at=None):
        self.calls += 1
        self.elements += len(origins) * len(destinations)
        return [
            [Leg(minutes=15.0, distance_km=6.0, source="google") for _ in destinations]
            for _ in origins
        ]


db.query(TravelEstimate).delete()
db.commit()
counting = CountingProvider()
set_provider(counting)
db.info.pop("travel_memo", None)

batched = TravelService(db, settings)
day_for_calls = DAY + timedelta(days=1)
while day_for_calls.weekday() == 6:
    day_for_calls += timedelta(days=1)
scheduling.slots_for_day(db, day_for_calls, settings, MANINAGAR, batched)
db.commit()

check(
    "a whole day of availability is a handful of calls, not one per leg",
    counting.calls <= 4,
    f"{counting.calls} call(s) covering {counting.elements} element(s)",
)
print(f"         ({counting.calls} provider call(s), {counting.elements} matrix element(s))")

before_calls = counting.calls
scheduling.slots_for_day(db, day_for_calls, settings, MANINAGAR, TravelService(db, settings))
db.commit()
check(
    "the second render is served from cache with no further calls",
    counting.calls == before_calls,
    f"{before_calls} -> {counting.calls}",
)


class FlakyProvider(RoutingProvider):
    """Fails twice with a transient error, then succeeds."""

    def __init__(self):
        self.attempts = 0

    def matrix(self, origins, destinations, depart_at=None):
        self.attempts += 1
        if self.attempts < 3:
            raise httpx.ConnectError("connection reset")
        return [[Leg(minutes=9.0, distance_km=3.0, source="google") for _ in destinations] for _ in origins]


flaky = FlakyProvider()
set_provider(flaky)
db.info.pop("travel_memo", None)
retried = TravelService(db, settings).between(BOPAL, NEAR_LAB, depart)
db.commit()
check(
    "a transient network error is retried rather than downgraded to a guess",
    retried is not None and retried.source == "google" and flaky.attempts == 3,
    f"attempts={flaky.attempts} source={retried.source if retried else None}",
)


class DeniedProvider(RoutingProvider):
    """A revoked key: retrying will never help."""

    def __init__(self):
        self.attempts = 0

    def matrix(self, origins, destinations, depart_at=None):
        self.attempts += 1
        request = httpx.Request("POST", "https://routes.googleapis.com/")
        raise httpx.HTTPStatusError(
            "denied", request=request, response=httpx.Response(403, request=request)
        )


denied = DeniedProvider()
set_provider(denied)
db.info.pop("travel_memo", None)
gave_up = TravelService(db, settings).between(MANINAGAR, BOPAL, depart)
db.commit()
check(
    "a permanent error is not retried, it falls straight back",
    denied.attempts == 1 and gave_up is not None and gave_up.source == "estimate",
    f"attempts={denied.attempts} source={gave_up.source if gave_up else None}",
)
set_provider(None)


# -- 9b. a booking sent in local time is stored as the right instant --------
from zoneinfo import ZoneInfo  # noqa: E402

from app.routers.bookings import _as_utc as booking_as_utc  # noqa: E402

IST = ZoneInfo("Asia/Kolkata")
asked = datetime(2026, 8, 20, 9, 30, tzinfo=IST)
stored = booking_as_utc(asked)
check(
    "an offset-aware booking is converted to UTC, not relabelled",
    stored.hour == 4 and stored.minute == 0 and stored.tzinfo == timezone.utc,
    f"09:30 IST stored as {stored}",
)
check(
    "it reads back as the time the clinic asked for",
    stored.astimezone(IST).strftime("%H:%M") == "09:30",
    stored.astimezone(IST).isoformat(),
)
naive = datetime(2026, 8, 20, 9, 30)
check(
    "a naive datetime is still treated as UTC",
    booking_as_utc(naive).hour == 9,
    str(booking_as_utc(naive)),
)


# -- 10. working hours are wall-clock in the lab's city --------------------
from app.services.scheduling import lab_zone, local_day_bounds, working_window  # noqa: E402

settings.timezone_name = "Asia/Kolkata"
db.commit()
opens, closes = working_window(settings, DAY)
local_open = opens.astimezone(lab_zone(settings))
check(
    "the lab opening hour is local, not UTC",
    local_open.strftime("%H:%M") == "09:00",
    f"09:00 in settings became {local_open:%H:%M} local / {opens:%H:%M} UTC",
)
check(
    "opening time is offset from UTC by the city's zone",
    opens.strftime("%H:%M") == "03:30",
    f"{opens:%H:%M} UTC",
)
start_utc, end_utc = local_day_bounds(DAY, settings)
check(
    "a day runs midnight to midnight locally",
    (end_utc - start_utc) == timedelta(days=1)
    and start_utc.astimezone(lab_zone(settings)).hour == 0,
    f"{start_utc} -> {end_utc}",
)
settings.timezone_name = "UTC"
db.commit()


# -- 11. a clinic's coordinates ------------------------------------------
from app.models import Address as Addr  # noqa: E402
from app.services.geo import locate_for  # noqa: E402

settings.service_radius_km = 120.0
settings.lab_latitude, settings.lab_longitude = 23.056, 72.500
db.commit()

# A pin the doctor dropped is trusted over anything inferred from the text.
picked = Addr(doctor_id=doc_near.id, line1="Somewhere vague", city="Ahmedabad",
              state="Gujarat", pincode="380058")
db.add(picked); db.flush()
ok = locate_for(db, picked, (23.0125, 72.5285))
check(
    "a doctor's own pin is used as given",
    ok and abs(picked.latitude - 23.0125) < 1e-6 and picked.geocode_source == "picked",
    f"{picked.latitude}, {picked.longitude}, {picked.geocode_source}",
)

# A pin in another city is refused rather than routed to.
far = Addr(doctor_id=doc_near.id, line1="Connaught Place", city="New Delhi",
           state="Delhi", pincode="110001")
db.add(far); db.flush()
ok = locate_for(db, far, (28.6304, 77.2177))
check(
    "a pin outside the service area is rejected, not routed to",
    not ok and far.latitude is None and far.geocode_source == "out-of-area",
    f"{far.latitude}, {far.geocode_source}",
)

# Without a pin and without a provider, the offline table still answers.
typed = Addr(doctor_id=doc_near.id, line1="Bopal Cross Road", city="Ahmedabad",
             state="Gujarat", pincode="380058")
db.add(typed); db.flush()
ok = locate_for(db, typed)
check(
    "a typed address still resolves with no routing provider configured",
    ok and typed.latitude is not None,
    f"{typed.latitude}, {typed.geocode_source}",
)
db.rollback()


print()
if failures:
    print(f"{len(failures)} check(s) failed:")
    for f in failures:
        print(f"  - {f}")
    raise SystemExit(1)
print("All checks passed.")
