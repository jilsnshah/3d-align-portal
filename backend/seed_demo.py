"""Populate the running dev server with demo cases at every stage.

    .venv/bin/python seed_demo.py

Talks to the API over HTTP, so everything it creates goes through the same
validation and transitions as real traffic. Re-running adds another six cases to
the same demo doctor rather than replacing them — to start clean, stop the
server and delete backend/dev.db.
"""

import os
import io
import sys
from typing import Optional

import requests

# SEED_BASE and SEED_STAFF_PASSWORD point these at a deployed portal;
# without them they target the local dev server as before.
BASE = os.environ.get("SEED_BASE", "http://127.0.0.1:8000") + "/api"
STAFF = {
    "email": os.environ.get("SEED_STAFF_EMAIL", "staff@3dalign.com"),
    "password": os.environ.get("SEED_STAFF_PASSWORD", "changeme"),
}
DOCTOR = {"email": "dr.mehta@clinic.example.com", "password": "alignerdemo123"}


def die(message: str, response: Optional[requests.Response] = None) -> None:
    print(f"\n  {message}")
    if response is not None:
        print(f"  {response.status_code} {response.text[:300]}")
    sys.exit(1)


def check(response: requests.Response, what: str) -> dict:
    if response.status_code >= 400:
        die(f"Failed to {what}.", response)
    return response.json() if response.content else {}


staff = requests.Session()
doctor = requests.Session()

try:
    requests.get(f"{BASE}/health", timeout=3)
except requests.exceptions.ConnectionError:
    die("The API is not running. Start it with:\n"
        "  .venv/bin/python -m uvicorn app.main:app --reload --port 8000")

print("Signing in as staff…")
check(staff.post(f"{BASE}/auth/login", json=STAFF), "sign in as staff")

print("Registering the demo doctor…")
registration = doctor.post(
    f"{BASE}/auth/register",
    json={
        **DOCTOR,
        "full_name": "Dr. Anita Mehta",
        "phone": "+91 98123 45678",
        "clinic_name": "Mehta Dental Studio",
        "dental_council": "Gujarat State Dental Council",
        "registration_number": "GUJ-11234",
        "address": {
            "label": "Clinic",
            "line1": "12 Science City Road, Sola",
            "city": "Ahmedabad",
            "state": "Gujarat",
            "pincode": "380060",
            "is_default_shipping": True,
        },
    },
)
if registration.status_code == 409:
    print("  Already registered — signing in instead.")
    check(doctor.post(f"{BASE}/auth/login", json=DOCTOR), "sign in as the demo doctor")
else:
    check(registration, "register the demo doctor")

doctor_id = check(doctor.get(f"{BASE}/auth/me"), "read the doctor profile")["doctor"]["id"]
check(
    staff.post(f"{BASE}/staff/doctors/{doctor_id}/verify", json={"approve": True}),
    "verify the doctor",
)
print("  Verified.")


import pathlib
from itertools import cycle

DEMO = pathlib.Path(__file__).resolve().parent.parent / "demo-data"

if not DEMO.exists():
    die(f"demo-data not found at {DEMO}. It ships with the repo.")


def _read(relative: str) -> bytes:
    path = DEMO / relative
    if not path.exists():
        die(f"Missing demo asset: {relative}")
    return path.read_bytes()


# Real clinical photographs, openly licensed — see demo-data/ATTRIBUTION.md.
# There are no true buccal views in the set, so each patient is dealt a
# different mix; the point is that the portal looks like real cases on a
# screen share, not that the anatomy is exact.
FRONTALS = [
    "photos/Sever_Crowding_of_teeth.jpg",
    "photos/Class_2_div_2_malocclusion.jpg",
    "photos/Deep_bite.jpg",
    "photos/Clas2div2_atypical.jpg",
    "photos/Class_II.jpg",
    "photos/Class1type2.jpg",
    "photos/Class2division1malocclusion.jpg",
    "photos/110216ek01.jpg",
    "photos/110216ek03.jpg",
    "photos/110216ek05.jpg",
]
OCCLUSAL_UPPER = ["photos/110216ek07.jpg", "photos/110216ek08.jpg"]
OCCLUSAL_LOWER = ["photos/110216ek09.jpg", "photos/110216ek10.jpg"]
OPGS = ["radiographs/Basic_panoramic_radiograph.jpg", "radiographs/Mixed_dentition_pan.jpg"]

_frontals = cycle(FRONTALS)
_uppers = cycle(OCCLUSAL_UPPER)
_lowers = cycle(OCCLUSAL_LOWER)
_opgs = cycle(OPGS)


def photo_set() -> list:
    """The five required views for one patient, each a different photograph so
    no two cases look identical in the file explorer."""
    return [
        ("INTRAORAL_FRONTAL", next(_frontals)),
        ("BUCCAL_RIGHT", next(_frontals)),
        ("BUCCAL_LEFT", next(_frontals)),
        ("OCCLUSAL_UPPER", next(_uppers)),
        ("OCCLUSAL_LOWER", next(_lowers)),
    ]


def new_case(patient: str, complaint: str, priority: str = "STANDARD") -> str:
    order = check(
        doctor.post(
            f"{BASE}/orders",
            json={
                "new_patient": {"full_name": patient},
                "arch": "BOTH",
                "priority": priority,
                "chief_complaint": complaint,
                "clinical_notes": "No active caries. Periodontally stable.",
            },
        ),
        "create an order",
    )
    for slot, asset in photo_set():
        check(
            doctor.post(
                f"{BASE}/orders/{order['id']}/files",
                data={"category": "RECORD_PHOTO", "slot": slot},
                files={"upload": (f"{slot.lower()}.jpg", io.BytesIO(_read(asset)), "image/jpeg")},
            ),
            f"upload the {slot.lower()} photo",
        )
    check(
        doctor.post(
            f"{BASE}/orders/{order['id']}/files",
            data={"category": "OPG", "slot": ""},
            files={"upload": ("opg.jpg", io.BytesIO(_read(next(_opgs))), "image/jpeg")},
        ),
        "upload the OPG",
    )
    check(doctor.post(f"{BASE}/orders/{order['id']}/submit"), "submit the order")
    return order["id"]


def quote(order_id: str, amount: int, upper: int, lower: int) -> None:
    check(staff.post(f"{BASE}/staff/orders/{order_id}/start-review"), "start review")
    check(
        staff.post(
            f"{BASE}/staff/orders/{order_id}/quotes",
            json={
                "estimated_aligners_upper": upper,
                "estimated_aligners_lower": lower,
                "category": "ALIGN_16_20",
                "tax": str(round(amount * 0.18)),
                "notes": "Includes refinements for 12 months.",
            },
        ),
        "send a quote",
    )


def upload_scan(order_id: str) -> None:
    check(
        doctor.post(f"{BASE}/orders/{order_id}/scan-route", json={"route": "UPLOAD"}),
        "choose a scan route",
    )
    # A scan is a set: upper, lower and bite. The case only advances once all
    # three are present.
    for slot, asset in (
        ("UPPER_ARCH", "scans/upper-arch.stl"),
        ("LOWER_ARCH", "scans/lower-arch.stl"),
        ("BITE", "scans/bite-registration.stl"),
    ):
        check(
            doctor.post(
                f"{BASE}/orders/{order_id}/files",
                data={"category": "INTRAORAL_SCAN", "slot": slot},
                files={"upload": (pathlib.Path(asset).name, io.BytesIO(_read(asset)), "model/stl")},
            ),
            f"upload the {slot.lower()} scan",
        )


def settle(order_id: str, kind: str, phase: int = 0) -> None:
    """Walk one charge through: the clinic pays by UPI, uploads the receipt,
    the lab checks it. Nothing downstream unlocks until this has happened."""
    detail = doctor.get(f"{BASE}/orders/{order_id}").json()
    row = next(
        (
            p
            for p in detail.get("payments", [])
            if p["kind"] == kind and p.get("phase_number", 0) == phase
        ),
        None,
    )
    if row is None:
        return
    doctor.post(
        f"{BASE}/orders/{order_id}/payments/{row['id']}/proof",
        data={"reference": "UPI" + order_id[:8].upper()},
        files={"upload": ("receipt.jpg", io.BytesIO(b"x" * 800), "image/jpeg")},
    )
    check(
        staff.post(
            f"{BASE}/staff/orders/{order_id}/payments/{row['id']}/verify",
            json={"approve": True},
        ),
        f"verify the {kind.lower().replace('_', ' ')} payment",
    )


def staged_stl(step: int) -> io.BytesIO:
    """A minimal valid binary STL standing in for one staged arch.

    Deliberately synthetic. The real scans under demo-data belong to a named
    patient, and seeding pushes files to internet-facing storage.
    """
    import struct

    out = bytearray(f"stage {step}".encode() + b"\0" * 70)
    out += struct.pack("<I", 1)
    out += struct.pack("<3f", 0.0, 0.0, 1.0)
    for point in ((0, 0, 0), (1, 0, 0), (0, 1, 0)):
        out += struct.pack("<3f", *point)
    out += b"\0\0"
    return io.BytesIO(bytes(out))


def share_plan(order_id: str, upper: int, lower: int, final_price: int = 60000) -> None:
    check(
        staff.post(f"{BASE}/staff/orders/{order_id}/scan/accept", json={"note": "Scan is clean."}),
        "accept the scan",
    )
    # A plan cannot be shared until the clinic has something to look at: the
    # staged movement in 3D, and the plan document itself.
    for step in range(3):
        staff.post(
            f"{BASE}/orders/{order_id}/files",
            data={"category": "SIMULATION_MODEL"},
            files={"upload": (f"{step}-S-3D_ALIGN_PA.stl", staged_stl(step), "model/stl")},
        )
    staff.post(
        f"{BASE}/orders/{order_id}/files",
        data={"category": "TREATMENT_PLAN"},
        files={"upload": ("plan.pdf", io.BytesIO(b"%PDF-1.4 demo plan"), "application/pdf")},
    )
    check(
        staff.post(
            f"{BASE}/staff/orders/{order_id}/plans",
            json={
                "aligners_upper": upper,
                "aligners_lower": lower,
                "final_price": str(final_price),
                "final_tax": str(round(final_price * 0.18)),
                "ipr_required": True,
                "attachments_required": True,
                "summary": "IPR 0.3 mm between 13-23. Attachments on 14, 24, 35, 45.",
            },
        ),
        "share the plan",
    )
    # The plan and its 3D simulation stay sealed until the fee is paid.
    settle(order_id, "TREATMENT_PLAN")


print("\nBuilding demo cases…")

# 1 — sitting in the staff intake queue
new_case("Rohan Desai", "Spacing in the upper anteriors.")
print("  AL…  waiting for staff review")

# 2 — quote with the doctor
case2 = new_case("Priya Shah", "Crowding, wants a clear option.")
quote(case2, 42000, 18, 16)
print("  AL…  quote awaiting the doctor")

# 3 — waiting on a scan
case3 = new_case("Kabir Nair", "Class II div 1, mild crowding.", priority="EXPRESS")
quote(case3, 46000, 16, 14)
check(doctor.post(f"{BASE}/orders/{case3}/quote/accept"), "accept a quote")
print("  AL…  awaiting intraoral scan (express)")

# 4 — treatment plan with the doctor
case4 = new_case("Meera Iyer", "Relapse after fixed appliance therapy.")
quote(case4, 38000, 14, 12)
check(doctor.post(f"{BASE}/orders/{case4}/quote/accept"), "accept a quote")
upload_scan(case4)
share_plan(case4, 14, 12, final_price=38000)
print("  AL…  treatment plan awaiting approval")

# 5 — fit review with the doctor
case5 = new_case("Arjun Rao", "Deep bite, wants aligners not braces.")
quote(case5, 51000, 18, 16)
check(doctor.post(f"{BASE}/orders/{case5}/quote/accept"), "accept a quote")
upload_scan(case5)
share_plan(case5, 18, 16, final_price=58000)
check(doctor.post(f"{BASE}/orders/{case5}/plan/respond", json={"approve": True}), "approve a plan")
# The training fit aligner is charged separately, before it can ship.
settle(case5, "TRAINING_FIT")
shipped = check(
    staff.post(
        f"{BASE}/staff/orders/{case5}/shipments",
        json={
            "shipment_type": "TRAINING_ALIGNER",
            "carrier": "Shree Tirupati",
            "tracking_number": "125600003371",
        },
    ),
    "ship the training aligner",
)
training = next(s for s in shipped["shipments"] if s["shipment_type"] == "TRAINING_ALIGNER")
check(
    staff.patch(f"{BASE}/staff/shipments/{training['id']}", json={"mark_delivered": True}),
    "mark the training aligner delivered",
)
print("  AL…  fit review awaiting the doctor")

# 6 — mid phased dispatch
case6 = new_case("Sana Kapoor", "Mild crowding, aesthetic concern.")
quote(case6, 40000, 16, 14)
check(doctor.post(f"{BASE}/orders/{case6}/quote/accept"), "accept a quote")
upload_scan(case6)
share_plan(case6, 16, 14, final_price=46000)
check(doctor.post(f"{BASE}/orders/{case6}/plan/respond", json={"approve": True}), "approve a plan")
# The training fit aligner is charged separately, before it can ship.
settle(case6, "TRAINING_FIT")
shipped = check(
    staff.post(
        f"{BASE}/staff/orders/{case6}/shipments",
        json={
            "shipment_type": "TRAINING_ALIGNER",
            "carrier": "Shree Tirupati",
            "tracking_number": "125600004422",
        },
    ),
    "ship the training aligner",
)
training = next(s for s in shipped["shipments"] if s["shipment_type"] == "TRAINING_ALIGNER")
check(
    staff.patch(f"{BASE}/staff/shipments/{training['id']}", json={"mark_delivered": True}),
    "mark delivered",
)
check(
    doctor.post(
        f"{BASE}/orders/{case6}/fit-review",
        # 16 upper aligners, so at most four batches of five. Three is a
        # realistic choice a clinic would make.
        json={"fits": True, "dispatch_mode": "PHASED", "phase_count": 3},
    ),
    "confirm the fit",
)
# Phase 1 goes out. The span is not passed in: the clinic's choice of three
# batches over 16 steps already decides it, and the lab deriving it is the
# point — nobody retypes aligner ranges per shipment.
first = check(
    staff.post(
        f"{BASE}/staff/orders/{case6}/shipments",
        json={
            "shipment_type": "ALIGNER_PHASE",
            # 16 steps over three batches: 6, 6, 4.
            "aligner_range_to": 6,
            "carrier": "Shree Tirupati",
            "tracking_number": "125600005001",
        },
    ),
    "dispatch phase 1",
)
phase1 = [s for s in first["shipments"] if s["shipment_type"] == "ALIGNER_PHASE"][-1]
check(doctor.post(f"{BASE}/orders/{case6}/shipments/{phase1['id']}/delivered"), "receive phase 1")
print("  AL…  dispatching — phase 1 with the clinic, two batches still to come")

print(f"""
Done.

  Staff    {STAFF['email']} / {STAFF['password']}
  Doctor   {DOCTOR['email']} / {DOCTOR['password']}

Open {os.environ.get("SEED_BASE", "http://localhost:5173")}
""")
