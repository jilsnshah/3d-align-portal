"""Fill the running dev server with scan bookings across the coming week.

    .venv/bin/python seed_bookings.py

Creates cases that reach AWAITING_SCAN, books them across the technician roster,
then walks a few of them forward so the admin week grid shows every state:
scheduled, en route, completed, cancelled and no-show.

Talks to the API over HTTP, so everything goes through the same assignment and
validation as real traffic. Re-running adds more; to start clean, stop the server
and delete backend/dev.db.
"""

import os
import io
import sys
from collections import defaultdict

import pathlib
from itertools import cycle

import requests

DEMO = pathlib.Path(__file__).resolve().parent.parent / "demo-data"

FRONTALS = cycle([
    "photos/Class_II.jpg", "photos/Class1type2.jpg", "photos/Deep_bite.jpg",
    "photos/Sever_Crowding_of_teeth.jpg", "photos/Class_2_div_2_malocclusion.jpg",
    "photos/Clas2div2_atypical.jpg", "photos/Class2division1malocclusion.jpg",
    "photos/110216ek01.jpg", "photos/110216ek03.jpg", "photos/110216ek05.jpg",
])
UPPERS = cycle(["photos/110216ek07.jpg", "photos/110216ek08.jpg"])
LOWERS = cycle(["photos/110216ek09.jpg", "photos/110216ek10.jpg"])
OPGS = cycle(["radiographs/Basic_panoramic_radiograph.jpg", "radiographs/Mixed_dentition_pan.jpg"])


def asset(relative: str) -> bytes:
    return (DEMO / relative).read_bytes()

# SEED_BASE and SEED_STAFF_PASSWORD point these at a deployed portal;
# without them they target the local dev server as before.
BASE = os.environ.get("SEED_BASE", "http://127.0.0.1:8000") + "/api"
ADMIN = {
    "email": os.environ.get("SEED_STAFF_EMAIL", "staff@3dalign.com"),
    "password": os.environ.get("SEED_STAFF_PASSWORD", "changeme"),
}
DOCTOR = {"email": "dr.mehta@clinic.example.com", "password": "alignerdemo123"}
TECH_PASSWORD = "technician1"

PATIENTS = [
    ("Devang Joshi", "Crowding in the lower arch."),
    ("Ishita Bhatt", "Spacing, upper anteriors."),
    ("Neel Trivedi", "Class II, wants aligners."),
    ("Aarohi Desai", "Relapse after fixed appliances."),
    ("Vivaan Mehta", "Deep bite, mild crowding."),
    ("Tanvi Solanki", "Rotated 12 and 22."),
    ("Yash Chauhan", "Open bite, anterior."),
    ("Ridhi Parekh", "Midline shift."),
]


def die(message, response=None):
    print(f"\n  {message}")
    if response is not None:
        print(f"  {response.status_code} {response.text[:300]}")
    sys.exit(1)


def check(response, what):
    if response.status_code >= 400:
        die(f"Failed to {what}.", response)
    return response.json() if response.content else {}


admin = requests.Session()
doctor = requests.Session()

try:
    requests.get(f"{BASE}/health", timeout=3)
except requests.exceptions.ConnectionError:
    die("The API is not running. Start it with:\n"
        "  .venv/bin/python -m uvicorn app.main:app --reload --port 8000")

check(admin.post(f"{BASE}/auth/login", json=ADMIN), "sign in as admin")
if doctor.post(f"{BASE}/auth/login", json=DOCTOR).status_code >= 400:
    die("The demo doctor is missing. Run seed_demo.py first.")

technicians = check(admin.get(f"{BASE}/admin/technicians"), "read the roster")
if not technicians:
    die("No technicians on the roster. Add them from Admin -> Technicians first.")

# Sign each technician in so their own jobs can be advanced.
tech_sessions = {}
for tech in technicians:
    session = requests.Session()
    if session.post(
        f"{BASE}/auth/login", json={"email": tech["email"], "password": TECH_PASSWORD}
    ).status_code < 400:
        tech_sessions[tech["full_name"]] = session

print(f"Roster: {', '.join(t['full_name'] for t in technicians)}")


def case_awaiting_scan(patient, complaint):
    order = check(
        doctor.post(
            f"{BASE}/orders",
            json={
                "new_patient": {"full_name": patient},
                "arch": "BOTH",
                "chief_complaint": complaint,
                "clinical_notes": "Periodontally stable. No active caries.",
            },
        ),
        "create a case",
    )
    for view, source in (
        ("INTRAORAL_FRONTAL", next(FRONTALS)),
        ("BUCCAL_RIGHT", next(FRONTALS)),
        ("BUCCAL_LEFT", next(FRONTALS)),
        ("OCCLUSAL_UPPER", next(UPPERS)),
        ("OCCLUSAL_LOWER", next(LOWERS)),
    ):
        check(
            doctor.post(
                f"{BASE}/orders/{order['id']}/files",
                data={"category": "RECORD_PHOTO", "slot": view},
                files={"upload": (f"{view.lower()}.jpg", io.BytesIO(asset(source)), "image/jpeg")},
            ),
            f"upload the {view.lower()} photo",
        )
    check(
        doctor.post(
            f"{BASE}/orders/{order['id']}/files",
            data={"category": "OPG", "slot": ""},
            files={"upload": ("opg.jpg", io.BytesIO(asset(next(OPGS))), "image/jpeg")},
        ),
        "upload the OPG",
    )
    check(doctor.post(f"{BASE}/orders/{order['id']}/submit"), "submit")
    check(admin.post(f"{BASE}/staff/orders/{order['id']}/start-review"), "start review")
    check(
        admin.post(
            f"{BASE}/staff/orders/{order['id']}/quotes",
            json={
                "category": "ALIGN_16_20",
            "tax": "7560",
            },
        ),
        "send a quote",
    )
    check(doctor.post(f"{BASE}/orders/{order['id']}/quote/accept"), "accept the quote")
    return order


# Collect free slots across the horizon, earliest first.
import datetime  # noqa: E402

today = datetime.date.today()
horizon = today + datetime.timedelta(days=13)
# The month view deliberately returns no slot times — working them out means
# asking the routing provider about every leg of every technician's day, which
# a doctor flicking through a calendar should not be billed for. Real times
# come from detail=true, which is capped at a week, so ask a week at a time.
free_slots = []
window = today
while window <= horizon:
    upto = min(window + datetime.timedelta(days=6), horizon)
    days = check(
        doctor.get(
            f"{BASE}/appointments/availability?from={window}&to={upto}&detail=true"
        ),
        f"read availability {window} to {upto}",
    )
    free_slots += [s["starts_at"] for d in days for s in d["slots"] if s["available"]]
    window = upto + datetime.timedelta(days=1)

if not free_slots:
    die("No free slots in the booking window. Check working hours and notice period.")

print(f"{len(free_slots)} free slot(s) available\n")

booked = []
for index, (patient, complaint) in enumerate(PATIENTS):
    if index >= len(free_slots):
        print("  (ran out of free slots)")
        break
    order = case_awaiting_scan(patient, complaint)
    response = doctor.post(
        f"{BASE}/orders/{order['id']}/appointment",
        json={
            "starts_at": free_slots[index],
            "contact_name": "Front desk",
            "contact_phone": "+91 98123 45678",
            "access_notes": "Second floor, lift on the right. Ask for the ortho room.",
        },
    )
    if response.status_code >= 400:
        print(f"  {patient:<16} could not be booked — {response.text[:80]}")
        continue
    detail = response.json()
    appointment = detail["appointment"]
    booked.append((order, appointment))
    when = appointment["starts_at"].replace("T", " ")[:16]
    print(f"  {order['order_number']}  {patient:<16} {when}  {appointment['technician_name']}")

if not booked:
    die("Nothing could be booked.")

print(f"\n{len(booked)} booking(s) created. Walking some forward…\n")

# 1 — en route
if len(booked) > 1:
    order, appointment = booked[1]
    session = tech_sessions.get(appointment["technician_name"])
    if session:
        r = session.post(f"{BASE}/tech/jobs/{appointment['id']}/en-route")
        print(f"  {order['order_number']}  en route ({appointment['technician_name']})"
              if r.status_code < 400 else f"  en-route failed: {r.text[:80]}")

# 2 — completed, by uploading the scan
if len(booked) > 2:
    order, appointment = booked[2]
    session = tech_sessions.get(appointment["technician_name"])
    if session:
        session.post(f"{BASE}/tech/jobs/{appointment['id']}/en-route")
        session.post(
            f"{BASE}/orders/{order['id']}/files",
            data={"category": "RECORD_PHOTO", "slot": "INTRAORAL_FRONTAL"},
            files={"upload": ("chairside-retake.jpg", io.BytesIO(asset(next(FRONTALS))), "image/jpeg")},
        )
        # The visit only closes once the whole scan set is on the case.
        for slot, src in (("UPPER_ARCH", "scans/upper-arch.stl"),
                          ("LOWER_ARCH", "scans/lower-arch.stl"),
                          ("BITE", "scans/bite-registration.stl")):
            r = session.post(
                f"{BASE}/orders/{order['id']}/files",
                data={"category": "INTRAORAL_SCAN", "slot": slot},
                files={"upload": (pathlib.Path(src).name, io.BytesIO(asset(src)), "model/stl")},
            )
        state = admin.get(f"{BASE}/admin/bookings").json()
        closed = any(b["id"] == appointment["id"] and b["status"] == "COMPLETED" for b in state)
        print(f"  {order['order_number']}  full scan set uploaded, visit {'completed' if closed else 'still open'}"
              if r.status_code < 400 else f"  upload failed: {r.text[:80]}")

# 3 — no-show
if len(booked) > 3:
    order, appointment = booked[3]
    session = tech_sessions.get(appointment["technician_name"])
    if session:
        r = session.post(
            f"{BASE}/tech/jobs/{appointment['id']}/no-show",
            json={"note": "Clinic closed on arrival, nobody available."},
        )
        print(f"  {order['order_number']}  no-show recorded"
              if r.status_code < 400 else f"  no-show failed: {r.text[:80]}")

# 4 — cancelled by the lab
if len(booked) > 4:
    order, appointment = booked[4]
    r = admin.post(
        f"{BASE}/appointments/{appointment['id']}/cancel",
        json={"reason": "Technician unwell — clinic asked to rebook."},
    )
    print(f"  {order['order_number']}  cancelled by the lab"
          if r.status_code < 400 else f"  cancel failed: {r.text[:80]}")

# 5 — reassigned to somebody else
if len(booked) > 5 and len(technicians) > 1:
    order, appointment = booked[5]
    # Try each other technician — the conflict guard will refuse the busy ones.
    for other in [t for t in technicians if t["full_name"] != appointment["technician_name"]]:
        r = admin.post(
            f"{BASE}/admin/bookings/{appointment['id']}/reassign",
            json={"technician_id": other["id"]},
        )
        if r.status_code < 400:
            print(f"  {order['order_number']}  reassigned to {other['full_name']}")
            break
    else:
        print(f"  {order['order_number']}  no free technician to reassign to")

rows = check(admin.get(f"{BASE}/admin/bookings"), "read bookings")
by_status = defaultdict(int)
by_tech = defaultdict(int)
for row in rows:
    by_status[row["status"]] += 1
    by_tech[row["technician_name"]] += 1

print(f"\n{len(rows)} booking(s) total")
for status, count in sorted(by_status.items()):
    print(f"  {status:<12} {count}")
print()
for name, count in sorted(by_tech.items()):
    print(f"  {name:<16} {count}")

print(f"""
Look at:
  Admin  -> Bookings      week grid + list      staff@3dalign.com / changeme
  Tech   -> My schedule   {technicians[0]['email']} / {TECH_PASSWORD}
  Doctor -> a case awaiting scan shows its booked visit
""")
