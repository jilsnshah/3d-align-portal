"""End-to-end walk of one aligner order, DRAFT through COMPLETED.

Run with the backend venv active:   python smoke_test.py
Uses a throwaway SQLite file, so it never touches dev data.
"""

import io
import os
import pathlib
import tempfile

TMP = tempfile.mkdtemp(prefix="align-smoke-")
os.environ["DATABASE_URL"] = f"sqlite:///{TMP}/smoke.db"
os.environ["STORAGE_LOCAL_ROOT"] = f"{TMP}/storage"
os.environ["STAFF_EMAIL"] = "staff@3dalign.example.com"
os.environ["STAFF_PASSWORD"] = "staffpassword"
os.environ["DCI_CHECK_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

PASS, FAIL = "  ok  ", " FAIL "
failures = []


def check(label, condition, detail=""):
    print(f"[{PASS if condition else FAIL}] {label}" + (f"  — {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(label)


with TestClient(app) as client:
    doctor = TestClient(app, base_url="http://doctor")
    staff = TestClient(app, base_url="http://staff")

    # -- onboarding ------------------------------------------------------
    r = doctor.post(
        "/api/auth/register",
        json={
            "email": "dr.mehta@clinic.example.com",
            "password": "supersecret123",
            "full_name": "Dr. Anita Mehta",
            "phone": "+919812345678",
            "clinic_name": "Mehta Dental Studio",
            "dental_council": "Gujarat State Dental Council",
            "registration_number": "GUJ-11234",
            "address": {
                "label": "Clinic",
                "line1": "12 Science City Road",
                "city": "Ahmedabad",
                "state": "Gujarat",
                "pincode": "380060",
                "is_default_shipping": True,
            },
        },
    )
    check("doctor registers", r.status_code == 201, r.text)

    r = doctor.post("/api/orders", json={"new_patient": {"full_name": "Riya Patel"}})
    check("unverified doctor is blocked", r.status_code == 403, r.text)

    r = staff.post("/api/auth/login", json={"email": "staff@3dalign.example.com", "password": "staffpassword"})
    check("staff signs in", r.status_code == 200, r.text)

    pending = staff.get("/api/staff/doctors?pending_only=true").json()
    check("doctor is in the verification queue", len(pending) == 1, str(pending))
    doctor_id = pending[0]["id"]

    r = staff.post(f"/api/staff/doctors/{doctor_id}/verify", json={"approve": True})
    check("staff verifies the doctor", r.status_code == 200, r.text)

    # -- draft and records ----------------------------------------------
    r = doctor.post(
        "/api/orders",
        json={
            "new_patient": {"full_name": "Riya Patel", "sex": "F"},
            "arch": "BOTH",
            "priority": "STANDARD",
            "chief_complaint": "Crowding, upper anteriors.",
        },
    )
    check("order draft created", r.status_code == 201, r.text)
    order = r.json()
    oid = order["id"]
    check("order number is human readable", order["order_number"].startswith("AL-"), order["order_number"])
    check("shipping address defaulted", order["shipping_address"] is not None)

    r = doctor.post(f"/api/orders/{oid}/submit")
    check("submit blocked without records", r.status_code == 400, r.text)

    for category, name in [("RECORD_PHOTO", "frontal.jpg"), ("OPG", "opg.jpg")]:
        r = doctor.post(
            f"/api/orders/{oid}/files",
            data={"category": category},
            files={"upload": (name, io.BytesIO(b"x" * 2048), "image/jpeg")},
        )
        check(f"upload {category}", r.status_code == 201, r.text)

    r = doctor.post(
        f"/api/orders/{oid}/files",
        data={"category": "TREATMENT_PLAN"},
        files={"upload": ("plan.pdf", io.BytesIO(b"x"), "application/pdf")},
    )
    check("doctor cannot upload a treatment plan", r.status_code == 403, r.text)

    r = doctor.post(f"/api/orders/{oid}/submit")
    check("order submits", r.status_code == 200 and r.json()["status"] == "SUBMITTED", r.text)

    r = staff.post(
        f"/api/orders/{oid}/files",
        data={"category": "TREATMENT_PLAN"},
        files={"upload": ("early-plan.pdf", io.BytesIO(b"x"), "application/pdf")},
    )
    check("staff cannot upload a plan before planning", r.status_code == 409, r.text)

    # -- review, records bounce, quote -----------------------------------
    check("staff queue shows the submission", staff.get("/api/staff/queue").json()["new_submissions"] == 1)

    staff.post(f"/api/staff/orders/{oid}/start-review")
    r = staff.post(f"/api/staff/orders/{oid}/request-records", json={"note": "OPG is unreadable."})
    check("records requested", r.json()["status"] == "RECORDS_REQUESTED", r.text)

    doctor.post(
        f"/api/orders/{oid}/files",
        data={"category": "OPG"},
        files={"upload": ("opg2.jpg", io.BytesIO(b"y" * 2048), "image/jpeg")},
    )
    r = doctor.post(f"/api/orders/{oid}/resubmit")
    check("doctor resubmits records", r.json()["status"] == "UNDER_REVIEW", r.text)

    r = staff.post(
        f"/api/staff/orders/{oid}/quotes",
        json={
            "estimated_aligners_upper": 18,
            "estimated_aligners_lower": 16,
            "line_items": [{"description": "Clear aligner treatment, both arches", "unit_price": "42000", "quantity": 1}],
            "tax": "7560",
        },
    )
    check("quote sent", r.json()["status"] == "QUOTED", r.text)
    quoted = r.json()
    check("quote totals computed", quoted["quotes"][0]["total"] == "49560.00", str(quoted["quotes"][0]))

    r = staff.post(
        f"/api/staff/orders/{oid}/quotes",
        json={
            "estimated_aligners_upper": 18,
            "estimated_aligners_lower": 16,
            "line_items": [{"description": "Clear aligner treatment, both arches", "unit_price": "39000", "quantity": 1}],
            "tax": "7020",
        },
    )
    versions = r.json()["quotes"]
    check("revised quote supersedes v1", versions[0]["status"] == "SUPERSEDED" and versions[1]["version"] == 2, str(versions))

    r = doctor.post(f"/api/orders/{oid}/quote/accept")
    check("doctor accepts the quote", r.json()["status"] == "AWAITING_SCAN", r.text)
    check("approved_at stamped", r.json()["approved_at"] is not None)

    # -- scan -------------------------------------------------------------
    r = doctor.post(
        f"/api/orders/{oid}/files",
        data={"category": "INTRAORAL_SCAN"},
        files={"upload": ("arch.jpg", io.BytesIO(b"z"), "image/jpeg")},
    )
    check("non-STL scan rejected", r.status_code == 400, r.text)

    r = doctor.post(
        f"/api/orders/{oid}/files",
        data={"category": "INTRAORAL_SCAN"},
        files={"upload": ("arch.stl", io.BytesIO(b"z" * 4096), "model/stl")},
    )
    check("STL scan accepted", r.status_code == 201, r.text)

    check("STL upload hands the scan to the lab", doctor.get(f"/api/orders/{oid}").json()["status"] == "SCAN_SUBMITTED")

    r = staff.post(f"/api/staff/orders/{oid}/scan/reject", json={"note": "Distal of 47 is cut off."})
    check("rejected scan goes back to the doctor", r.json()["status"] == "AWAITING_SCAN", r.text)

    r = staff.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": "x"})
    check("cannot accept a scan that has not arrived", r.status_code == 409, r.text)

    # A case must never reach planning without geometry, whatever route it took.
    doctor.post(f"/api/orders/{oid}/scan-route", json={"route": "COURIER", "courier_tracking": "T1"})
    r = staff.post(f"/api/staff/orders/{oid}/scan/received", json={"note": "arrived"})
    check("no back door past the scan requirement", r.status_code == 404, r.text)
    check(
        "courier route still needs an STL",
        doctor.get(f"/api/orders/{oid}").json()["status"] == "AWAITING_SCAN",
    )

    r = staff.post(
        f"/api/orders/{oid}/files",
        data={"category": "INTRAORAL_SCAN"},
        files={"upload": ("lab-digitised.stl", io.BytesIO(b"s" * 2048), "model/stl")},
    )
    check("staff can upload a scan they digitised", r.status_code == 201, r.text)
    check(
        "a staff upload advances the case too",
        staff.get(f"/api/staff/orders/{oid}").json()["status"] == "SCAN_SUBMITTED",
    )
    staff.post(f"/api/staff/orders/{oid}/scan/reject", json={"note": "Re-scan please."})
    detail = doctor.get(f"/api/orders/{oid}").json()
    check(
        "each scan rejection opens a new revision",
        detail["scan_revision"] == 3,
        str(detail["scan_revision"]),
    )
    check(
        "the earlier scans are marked superseded",
        all(not f["is_current"] for f in detail["files"] if f["category"] == "INTRAORAL_SCAN"),
    )
    check(
        "the case cannot be accepted while waiting on the replacement",
        staff.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": ""}).status_code == 409,
    )

    doctor.post(
        f"/api/orders/{oid}/files",
        data={"category": "INTRAORAL_SCAN"},
        files={"upload": ("arch-v2.stl", io.BytesIO(b"z" * 4096), "model/stl")},
    )
    r = staff.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": "Scan is clean."})
    check("staff accepts the scan", r.json()["status"] == "IN_PLANNING", r.text)

    # -- planning ---------------------------------------------------------
    r = staff.post(
        f"/api/staff/orders/{oid}/plans",
        json={"aligners_upper": 18, "aligners_lower": 16, "ipr_required": True, "summary": "IPR at 13-23."},
    )
    check("plan shared", r.json()["status"] == "PLAN_SHARED", r.text)

    r = doctor.post(f"/api/orders/{oid}/plan/respond", json={"approve": False, "revision_notes": "Reduce IPR."})
    check("revision sends it back to planning", r.json()["status"] == "IN_PLANNING", r.text)

    staff.post(f"/api/staff/orders/{oid}/plans", json={"aligners_upper": 18, "aligners_lower": 16})
    r = doctor.post(f"/api/orders/{oid}/plan/respond", json={"approve": True})
    check("plan approved starts production", r.json()["status"] == "TRAINING_ALIGNER_PRODUCTION", r.text)
    check("plan v2 recorded", len(r.json()["plans"]) == 2)

    # -- training aligner and fit ----------------------------------------
    r = staff.post(
        f"/api/staff/orders/{oid}/shipments",
        json={"shipment_type": "TRAINING_ALIGNER", "carrier": "Shree Tirupati", "tracking_number": "125600003371"},
    )
    check("training aligner shipped", r.json()["status"] == "TRAINING_ALIGNER_SHIPPED", r.text)
    training_id = r.json()["shipments"][0]["id"]

    r = staff.patch(f"/api/staff/shipments/{training_id}", json={"mark_delivered": True})
    check("delivery opens fit review", r.json()["status"] == "FIT_REVIEW", r.text)

    r = doctor.post(f"/api/orders/{oid}/fit-review", json={"fits": True})
    check("fit review needs a dispatch mode", r.status_code == 400, r.text)

    # A fit issue must produce a distinguishable second training aligner.
    r = doctor.post(f"/api/orders/{oid}/fit-review", json={"fits": False, "issue_notes": "Rocks on 16."})
    check("fit issue reported", r.json()["status"] == "FIT_ISSUE", r.text)

    r = staff.post(f"/api/staff/orders/{oid}/fit-issue/resolve?resolution=refabricate")
    check("refabricate advances the fit round", r.json()["fit_round"] == 2, str(r.json()["fit_round"]))

    r = staff.post(
        f"/api/staff/orders/{oid}/shipments",
        json={"shipment_type": "TRAINING_ALIGNER", "carrier": "Shree Tirupati", "tracking_number": "R2"},
    )
    rounds = sorted(s["fit_round"] for s in r.json()["shipments"] if s["shipment_type"] == "TRAINING_ALIGNER")
    check("the two training aligners are distinguishable", rounds == [1, 2], str(rounds))

    second = next(s for s in r.json()["shipments"] if s.get("fit_round") == 2)
    staff.patch(f"/api/staff/shipments/{second['id']}", json={"mark_delivered": True})

    r = doctor.post(f"/api/orders/{oid}/fit-review", json={"fits": True, "dispatch_mode": "PHASED"})
    check("fit confirmed starts aligner production", r.json()["status"] == "ALIGNER_PRODUCTION", r.text)
    check("dispatch mode recorded", r.json()["dispatch_mode"] == "PHASED")

    # -- phased dispatch --------------------------------------------------
    for phase, (lo, hi) in enumerate([(1, 8), (9, 16), (17, 18)], start=1):
        r = staff.post(
            f"/api/staff/orders/{oid}/shipments",
            json={
                "shipment_type": "ALIGNER_PHASE",
                "phase_number": phase,
                "aligner_range_from": lo,
                "aligner_range_to": hi,
                "carrier": "Shree Tirupati",
                "tracking_number": f"TRK-{phase:03d}",
            },
        )
        check(f"phase {phase} shipped", r.status_code == 200, r.text)

    detail = r.json()
    check("order is dispatching", detail["status"] == "DISPATCHING", detail["status"])
    check(
        "two training aligners plus three phases",
        len(detail["shipments"]) == 5,
        str(len(detail["shipments"])),
    )

    r = staff.post(f"/api/staff/orders/{oid}/complete")
    check("cannot complete with undelivered phases", r.status_code == 409, r.text)

    for shipment in detail["shipments"]:
        if shipment["shipment_type"] != "TRAINING_ALIGNER":
            staff.patch(f"/api/staff/shipments/{shipment['id']}", json={"mark_delivered": True})

    r = staff.post(f"/api/staff/orders/{oid}/complete")
    check("order completes", r.json()["status"] == "COMPLETED", r.text)

    # -- invariants -------------------------------------------------------
    final = staff.get(f"/api/staff/orders/{oid}").json()
    check("audit trail recorded every move", len(final["events"]) >= 12, str(len(final["events"])))
    check("timeline starts at submission", final["events"][0]["to_status"] == "SUBMITTED")

    r = staff.post(f"/api/staff/orders/{oid}/cancel", json={"reason": "too late"})
    check("completed orders are immutable", r.status_code == 409, r.text)

    notes = doctor.get("/api/notifications").json()
    check("doctor was notified along the way", len(notes) >= 6, str(len(notes)))

    # -- ownership --------------------------------------------------------
    other = TestClient(app, base_url="http://other")
    other.post(
        "/api/auth/register",
        json={
            "email": "dr.rao@clinic.example.com",
            "password": "supersecret123",
            "full_name": "Dr. Rao",
            "address": {"line1": "1 Road", "city": "Pune", "state": "Maharashtra", "pincode": "411001"},
        },
    )
    staff.post(f"/api/staff/doctors/{other.get('/api/auth/me').json()['doctor']['id']}/verify", json={"approve": True})
    r = other.get(f"/api/orders/{oid}")
    check("another doctor cannot read the order", r.status_code == 404, r.text)
    r = other.get("/api/staff/queue")
    check("doctors cannot reach staff endpoints", r.status_code == 403, r.text)

print()
if failures:
    print(f"{len(failures)} check(s) failed:")
    for f in failures:
        print(f"  - {f}")
    raise SystemExit(1)
print("All checks passed.")
