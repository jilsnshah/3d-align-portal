"""Populate the running dev server with demo cases at every stage.

    .venv/bin/python seed_demo.py

Talks to the API over HTTP, so everything it creates goes through the same
validation and transitions as real traffic. Re-running adds another six cases to
the same demo doctor rather than replacing them — to start clean, stop the
server and delete backend/dev.db.
"""

import io
import sys
from typing import Optional

import requests

BASE = "http://127.0.0.1:8000/api"
STAFF = {"email": "staff@3dalign.com", "password": "changeme"}
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


import struct
import zlib


def _png(seed: str, w: int = 520, h: int = 390) -> bytes:
    """A solid-colour PNG so previews show something, tinted per view."""
    tone = sum(ord(c) for c in seed)
    r, g, b = 150 + tone % 70, 120 + tone % 90, 120 + tone % 60
    raw = b"".join(b"\x00" + bytes([r, g, b]) * w for _ in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


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
    for slot in ("INTRAORAL_FRONTAL", "BUCCAL_RIGHT", "BUCCAL_LEFT", "OCCLUSAL_UPPER", "OCCLUSAL_LOWER"):
        check(
            doctor.post(
                f"{BASE}/orders/{order['id']}/files",
                data={"category": "RECORD_PHOTO", "slot": slot},
                files={"upload": (f"{slot.lower()}.png", io.BytesIO(_png(slot)), "image/png")},
            ),
            f"upload the {slot.lower()} photo",
        )
    check(
        doctor.post(
            f"{BASE}/orders/{order['id']}/files",
            data={"category": "OPG", "slot": ""},
            files={"upload": ("opg.png", io.BytesIO(_png("OPG", 780, 390)), "image/png")},
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
    for slot in ("UPPER_ARCH", "LOWER_ARCH", "BITE"):
        check(
            doctor.post(
                f"{BASE}/orders/{order_id}/files",
                data={"category": "INTRAORAL_SCAN", "slot": slot},
                files={"upload": (f"{slot.lower()}.stl", io.BytesIO(b"solid demo" * 512), "model/stl")},
            ),
            f"upload the {slot.lower()} scan",
        )


def share_plan(order_id: str, upper: int, lower: int, final_price: int = 60000) -> None:
    check(
        staff.post(f"{BASE}/staff/orders/{order_id}/scan/accept", json={"note": "Scan is clean."}),
        "accept the scan",
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
    doctor.post(f"{BASE}/orders/{case6}/fit-review", json={"fits": True, "dispatch_mode": "PHASED"}),
    "confirm the fit",
)
# Phases chain — each one has to be received and accepted before the next
# can ship, so the seed walks it the way a real case does.
first = check(
    staff.post(
        f"{BASE}/staff/orders/{case6}/shipments",
        json={
            "shipment_type": "ALIGNER_PHASE",
            "aligner_range_to": 8,
            "carrier": "Shree Tirupati",
            "tracking_number": "125600005001",
        },
    ),
    "dispatch phase 1",
)
phase1 = [s for s in first["shipments"] if s["shipment_type"] == "ALIGNER_PHASE"][-1]
check(doctor.post(f"{BASE}/orders/{case6}/shipments/{phase1['id']}/delivered"), "receive phase 1")
check(
    doctor.post(
        f"{BASE}/orders/{case6}/shipments/{phase1['id']}/phase-decision",
        json={"decision": "CONTINUE"},
    ),
    "ask for the next phase",
)
check(
    staff.post(
        f"{BASE}/staff/orders/{case6}/shipments",
        json={
            "shipment_type": "ALIGNER_PHASE",
            "aligner_range_to": 20,
            "carrier": "Shree Tirupati",
            "tracking_number": "125600005002",
        },
    ),
    "dispatch phase 2",
)
print("  AL…  dispatching — phase 1 received, phase 2 out, 10 aligners still to come")

print(f"""
Done.

  Staff    {STAFF['email']} / {STAFF['password']}
  Doctor   {DOCTOR['email']} / {DOCTOR['password']}

Open http://localhost:5173
""")
