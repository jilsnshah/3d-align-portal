"""The lab can set the date a case counts as opened; a clinic cannot.

Cases reach the lab by phone, on WhatsApp and on paper, so the day a case is
typed in is often not the day the work arrived.
"""

import os
import tempfile

TMP = tempfile.mkdtemp(prefix="align-date-")
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL", f"sqlite:///{TMP}/date.db")
os.environ["STORAGE_LOCAL_ROOT"] = f"{TMP}/storage"
os.environ["STAFF_EMAIL"] = "staff@3dalign.example.com"
os.environ["STAFF_PASSWORD"] = "staffpassword"
os.environ["DCI_CHECK_ENABLED"] = "false"
os.environ["GOOGLE_MAPS_API_KEY"] = ""
os.environ["GOOGLE_MAPS_BROWSER_KEY"] = ""

from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Doctor, Order, StatusEvent  # noqa: E402

fails = []


def check(label, ok, detail=""):
    print(f"[ {'ok  ' if ok else 'FAIL'} ] {label}" + ("" if ok else f"  — {detail}"))
    if not ok:
        fails.append(label)


with TestClient(app) as client:
    doctor = TestClient(app, base_url="http://doctor")
    staff = TestClient(app, base_url="http://staff")

    r = doctor.post("/api/auth/register", json={
        "email": "date.test@clinic.example.com",
        "password": "supersecret123",
        "full_name": "Dr. Date",
        "phone": "+919812345678",
        "clinic_name": "Date Dental",
        "dental_council": "Gujarat State Dental Council",
        "registration_number": "GUJ-DATE-1",
        "address": {
            "label": "Clinic",
            "line1": "12 Science City Road",
            "city": "Ahmedabad",
            "state": "Gujarat",
            "pincode": "380060",
        },
    })
    check("the clinic registers", r.status_code in (200, 201), r.text[:160])
    db = SessionLocal()
    db.query(Doctor).order_by(Doctor.created_at.desc()).first().verification_status = "VERIFIED"
    db.commit()
    db.close()
    doctor.post("/api/auth/login", json={"email": "date.test@clinic.example.com", "password": "supersecret123"})
    staff.post("/api/auth/login", json={"email": "staff@3dalign.example.com", "password": "staffpassword"})

    r = doctor.post("/api/orders", json={"new_patient": {"first_name": "Riya", "last_name": "Patel"}})
    check("a case is created", r.status_code == 201, r.text)
    order_id = r.json()["id"]

    WANTED = "2026-03-04T09:30:00+00:00"  # the day the case really opened
    r = doctor.patch(f"/api/staff/orders/{order_id}/date", json={"opened_at": WANTED})
    check("the clinic cannot set its own date", r.status_code in (401, 403), f"{r.status_code} {r.text[:80]}")

    r = staff.patch(f"/api/staff/orders/{order_id}/date", json={"opened_at": WANTED})
    check("the lab can set it", r.status_code == 200, r.text[:120])
    check("and it comes back on the case", (r.json().get("created_at") or "").startswith("2026-03-04"), r.json().get("created_at"))

    db = SessionLocal()
    stored = db.get(Order, order_id)
    check("it is stored", stored.created_at.strftime("%Y-%m-%d") == "2026-03-04", str(stored.created_at))
    noted = [e for e in db.query(StatusEvent).filter(StatusEvent.order_id == order_id) if "Case opened date set to" in (e.note or "")]
    check("the change is in the case's history", len(noted) == 1, [e.note for e in noted])
    db.close()

    r = staff.get("/api/staff/orders")
    row = next((o for o in r.json() if o["id"] == order_id), None)
    check("the case list carries the date", bool(row) and (row.get("created_at") or "").startswith("2026-03-04"),
          row and row.get("created_at"))

print("\nFAIL:" if fails else "\nall good")
for f in fails:
    print(" ", f)
raise SystemExit(1 if fails else 0)
