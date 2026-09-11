"""Every patient carries a system reference, PT-00001, unique where a name is not.

Run with the backend venv active:   python patient_number_test.py
Uses a throwaway SQLite file; TEST_DATABASE_URL runs it against Postgres.
"""

import os
import re
import tempfile

TMP = tempfile.mkdtemp(prefix="align-ptno-")
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", f"sqlite:///{TMP}/ptno.db"
)
os.environ["STORAGE_LOCAL_ROOT"] = f"{TMP}/storage"
os.environ["STAFF_EMAIL"] = "staff@3dalign.example.com"
os.environ["STAFF_PASSWORD"] = "staffpassword"
os.environ["DCI_CHECK_ENABLED"] = "false"
os.environ["GOOGLE_MAPS_API_KEY"] = ""
os.environ["GOOGLE_MAPS_BROWSER_KEY"] = ""

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.db import engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Counter, Patient  # noqa: E402
from app.services.numbering import PATIENT_COUNTER, backfill_patient_numbers  # noqa: E402

PASS, FAIL = "PASS", "FAIL"
failures = []
SHAPE = re.compile(r"^PT-\d{5,}$")


def check(label, condition, detail=""):
    print(f"[{PASS if condition else FAIL}] {label}" + (f"  — {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(label)


def seq(number):
    return int(number[3:])


with TestClient(app) as client:
    doctor = TestClient(app, base_url="http://doctor")
    staff = TestClient(app, base_url="http://staff")

    r = doctor.post(
        "/api/auth/register",
        json={
            "email": "dr.number@clinic.example.com",
            "password": "supersecret123",
            "full_name": "Dr. Nandini Rao",
            "phone": "+919812300000",
            "clinic_name": "Rao Dental",
            "dental_council": "Gujarat State Dental Council",
            "registration_number": "GUJ-55501",
            "address": {
                "label": "Clinic",
                "line1": "1 Ashram Road",
                "city": "Ahmedabad",
                "state": "Gujarat",
                "pincode": "380009",
                "is_default_shipping": True,
            },
        },
    )
    check("doctor registers", r.status_code == 201, r.text[:160])
    staff.post("/api/auth/login", json={"email": "staff@3dalign.example.com", "password": "staffpassword"})
    doctor_id = doctor.get("/api/auth/me").json()["doctor"]["id"]
    r = staff.post(f"/api/staff/doctors/{doctor_id}/verify", json={"approve": True})
    check("staff verifies the doctor", r.status_code == 200, r.text[:160])

    # -- two patients of the same name ------------------------------------
    a = doctor.post("/api/patients", json={"first_name": "Isha", "last_name": "Trivedi"}).json()
    b = doctor.post("/api/patients", json={"first_name": "Isha", "last_name": "Trivedi"}).json()
    check("a new patient is given a number", SHAPE.match(a.get("patient_number", "")) is not None, str(a))
    check("so is the second of the same name", SHAPE.match(b.get("patient_number", "")) is not None, str(b))
    check("and the two numbers differ", a["patient_number"] != b["patient_number"], f"{a} {b}")
    check("numbers run in order", seq(b["patient_number"]) == seq(a["patient_number"]) + 1, f"{a['patient_number']} {b['patient_number']}")

    # -- a patient added from the order form is numbered too --------------
    r = doctor.post("/api/orders", json={"new_patient": {"first_name": "Riya", "last_name": "Patel"}})
    check("an order can add its patient", r.status_code == 201, r.text[:160])
    order = r.json()
    riya = order.get("patient_number", "")
    check("that patient is numbered", SHAPE.match(riya) is not None, str(riya))
    check("and not with a number already given", riya not in (a["patient_number"], b["patient_number"]))
    check("the case names its patient by id", bool(order.get("patient_id")), str(order.get("patient_id")))

    # -- the lists carry it ------------------------------------------------
    listed = doctor.get("/api/patients?limit=50").json()
    numbers = [p["patient_number"] for p in listed]
    check("every listed patient has a number", all(SHAPE.match(n) for n in numbers), str(numbers))
    check("and no two share one", len(set(numbers)) == len(numbers), str(numbers))
    summaries = {o["id"]: o for o in doctor.get("/api/orders?limit=50").json()}
    row = summaries.get(order["id"], {})
    check("the case list carries the patient's id", row.get("patient_id") == order["patient_id"], str(row)[:200])
    check("and their number", row.get("patient_number") == riya, str(row)[:200])

    # -- searching by number -----------------------------------------------
    found = doctor.get("/api/patients", params={"search": b["patient_number"]}).json()
    check("a number finds exactly its patient", [p["id"] for p in found] == [b["id"]], str(found))
    found = doctor.get("/api/orders", params={"search": riya}).json()
    check("a number finds the patient's cases", any(o["id"] == order["id"] for o in found), str(found)[:200])
    found = staff.get("/api/staff/orders", params={"search": riya}).json()
    check("the lab can search by it too", any(o["id"] == order["id"] for o in found), str(found)[:200])

    # -- the database holds the line ---------------------------------------
    with Session(engine) as db:
        db.add(Patient(doctor_id=doctor_id, first_name="Copy", full_name="Copy", patient_number=a["patient_number"]))
        try:
            db.commit()
            refused = False
        except IntegrityError:
            db.rollback()
            refused = True
    check("the database refuses a repeated number", refused)

    # -- patients from before numbers existed ------------------------------
    with Session(engine) as db:
        for i in range(3):
            db.add(Patient(doctor_id=doctor_id, first_name=f"Old{i}", full_name=f"Old{i} Patient"))
        db.commit()
    r = doctor.get("/api/patients?limit=100")
    blanks = [p for p in r.json() if p["full_name"].startswith("Old")] if r.status_code == 200 else []
    check("an unnumbered patient does not break the list", r.status_code == 200, r.text[:160])
    check("and reads as blank until numbered", len(blanks) == 3 and all(p["patient_number"] == "" for p in blanks), str(blanks))

    with Session(engine) as db:
        before = max(seq(n) for n in numbers)
        count = backfill_patient_numbers(db)
        db.commit()
        old = db.query(Patient).filter(Patient.full_name.like("Old%")).order_by(Patient.created_at, Patient.id).all()
        olds = [p.patient_number for p in old]
        check("the backfill numbers each of them", count == 3 and all(SHAPE.match(n or "") for n in olds), str(olds))
        check("after every number already given", all(seq(n) > before for n in olds), f"{before} {olds}")
        check("and running it again changes nothing", backfill_patient_numbers(db) == 0)
        db.commit()

    # A counter left behind the table — a restored backup, say — is wound on
    # rather than allowed to hand out a number somebody already has.
    with Session(engine) as db:
        db.get(Counter, PATIENT_COUNTER).value = 0
        db.commit()
        backfill_patient_numbers(db)
        db.commit()
    highest = max(seq(n) for n in olds)
    r = doctor.post("/api/patients", json={"first_name": "After", "last_name": "Restore"})
    check("a patient added after a counter reset still gets a fresh number", r.status_code == 201 and seq(r.json()["patient_number"]) == highest + 1, r.text[:160])

print(f"\n{len(failures)} failure(s)" if failures else "\nAll patient number checks passed.")
raise SystemExit(1 if failures else 0)
