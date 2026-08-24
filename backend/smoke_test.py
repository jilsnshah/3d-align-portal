"""End-to-end walk of one aligner order, DRAFT through COMPLETED.

Run with the backend venv active:   python smoke_test.py
Uses a throwaway SQLite file, so it never touches dev data.
"""

import io
from decimal import Decimal
import os
import pathlib
import tempfile

TMP = tempfile.mkdtemp(prefix="align-smoke-")
os.environ["DATABASE_URL"] = f"sqlite:///{TMP}/smoke.db"
os.environ["STORAGE_LOCAL_ROOT"] = f"{TMP}/storage"
os.environ["STAFF_EMAIL"] = "staff@3dalign.example.com"
os.environ["STAFF_PASSWORD"] = "staffpassword"
os.environ["DCI_CHECK_ENABLED"] = "false"
# Never let a test bill the live Maps account or depend on a network round trip.
# Routing behaviour is exercised against stub providers instead.
os.environ["GOOGLE_MAPS_API_KEY"] = ""
os.environ["GOOGLE_MAPS_BROWSER_KEY"] = ""

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

BASE_URL = "/api"

REQUIRED_VIEWS = ("INTRAORAL_FRONTAL", "BUCCAL_RIGHT", "BUCCAL_LEFT", "OCCLUSAL_UPPER", "OCCLUSAL_LOWER")


def binary_stl(triangles=1):
    """The smallest thing the mesh converter will accept."""
    import struct

    out = bytearray(b"smoke test" + b"\0" * 70)
    out += struct.pack("<I", triangles)
    for _ in range(triangles):
        out += struct.pack("<3f", 0.0, 0.0, 1.0)
        for point in ((0, 0, 0), (1, 0, 0), (0, 1, 0)):
            out += struct.pack("<3f", *point)
        out += b"\0\0"
    return io.BytesIO(bytes(out))


def upload_records(session, order_id, base="/api"):
    """The five required photographic views plus the OPG — the minimum the lab
    can quote from, and what /submit now enforces."""
    for view in REQUIRED_VIEWS:
        session.post(
            f"{base}/orders/{order_id}/files",
            data={"category": "RECORD_PHOTO", "slot": view},
            files={"upload": (f"{view.lower()}.jpg", io.BytesIO(b"x" * 600), "image/jpeg")},
        )
    return session.post(
        f"{base}/orders/{order_id}/files",
        data={"category": "OPG", "slot": ""},
        files={"upload": ("opg.jpg", io.BytesIO(b"x" * 600), "image/jpeg")},
    )

SCAN_SET = (("UPPER_ARCH", "upper-arch.stl"), ("LOWER_ARCH", "lower-arch.stl"), ("BITE", "bite.stl"))


def pay(doctor_session, staff_session, order_id, kind, phase=0, reference="UPI123456"):
    """The clinic pays by UPI, sends the screenshot, and the lab checks it."""
    detail = doctor_session.get(f"/api/orders/{order_id}").json()
    row = next(
        p
        for p in detail["payments"]
        if p["kind"] == kind and p["phase_number"] == phase
    )
    doctor_session.post(
        f"/api/orders/{order_id}/payments/{row['id']}/proof",
        data={"reference": reference},
        files={"upload": ("receipt.jpg", io.BytesIO(b"x" * 800), "image/jpeg")},
    )
    return staff_session.post(
        f"/api/staff/orders/{order_id}/payments/{row['id']}/verify", json={"approve": True}
    )


PROGRESS_VIEWS = [
    "PROGRESS_UPPER_IN",
    "PROGRESS_LOWER_IN",
    "PROGRESS_FRONTAL_IN",
    "PROGRESS_UPPER_OUT",
    "PROGRESS_LOWER_OUT",
    "PROGRESS_FRONTAL_OUT",
]


def upload_progress(session, order_id, views=PROGRESS_VIEWS):
    """The six views the clinic sends after a phase: upper, lower and frontal,
    each with the aligners in and out."""
    last = None
    for view in views:
        last = session.post(
            f"/api/orders/{order_id}/files",
            data={"category": "PROGRESS_PHOTO", "slot": view},
            files={"upload": (f"{view.lower()}.jpg", io.BytesIO(b"x" * 600), "image/jpeg")},
        )
    return last


def upload_fit_photos(session, order_id, views=None):
    """The same six views as progress, sent with a fit issue report."""
    last = None
    for view in views or PROGRESS_VIEWS:
        last = session.post(
            f"/api/orders/{order_id}/files",
            data={"category": "PHASE_FIT_PHOTO", "slot": view},
            files={"upload": (f"{view.lower()}.jpg", io.BytesIO(b"x" * 600), "image/jpeg")},
        )
    return last


def upload_scan_set(session, order_id, prefix=""):
    """A scan is a set — upper, lower and bite — so the case only advances once
    every required view is present."""
    last = None
    for slot, name in SCAN_SET:
        last = session.post(
            f"{BASE_URL}/orders/{order_id}/files",
            data={"category": "INTRAORAL_SCAN", "slot": slot},
            files={"upload": (prefix + name, io.BytesIO(b"solid" * 800), "model/stl")},
        )
    return last


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

    # The lab's payment settings: where UPI transfers go, what the two fixed
    # fees are, and what delivery costs.
    r = staff.put(
        "/api/admin/settings",
        json={
            "upi_vpa": "3dalign@okhdfcbank",
            "upi_payee_name": "3D Align Labs",
            "plan_fee": "2000",
            "training_fit_fee": "1500",
            "default_shipping_fee": "250",
        },
    )
    check("the lab's UPI details are configurable", r.status_code == 200, r.text[:140])
    check("and read back", r.json()["upi_vpa"] == "3dalign@okhdfcbank", r.text[:140])

    r = staff.put("/api/staff/shipping-rates", json=[{"city": "Ahmedabad", "amount": "150"}])
    check("shipping is priced per city", r.status_code == 200, r.text[:140])

    # A rate is matched against the city the clinic typed. One spelled even
    # slightly differently reaches nobody and quietly bills the default, so the
    # coverage is counted rather than assumed.
    r = staff.put("/api/staff/shipping-rates", json=[{"city": "Ahmedabaad", "amount": "999"}])
    rows = {x["city"]: x for x in staff.get("/api/staff/shipping-rates").json()}
    check(
        "a rate that matches no clinic says so",
        rows["Ahmedabaad"]["clinics"] == 0,
        str(rows["Ahmedabaad"]),
    )
    check(
        "while a real one shows what it covers",
        rows["Ahmedabad"]["clinics"] >= 1,
        str(rows["Ahmedabad"]),
    )
    cities = {c["city"]: c for c in staff.get("/api/staff/delivery-cities").json()}
    check(
        "and the cities offered are the ones clinics are really in",
        "Ahmedabad" in cities and "Ahmedabaad" not in cities,
        str(list(cities)),
    )
    staff.put(
        "/api/staff/shipping-rates",
        json=[{"city": "Ahmedabaad", "amount": "999", "is_active": False}],
    )

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
    check(
        "a new case carries an enquiry reference, not a production number",
        order["order_number"].startswith("EN-"),
        order["order_number"],
    )
    check("shipping address defaulted", order["shipping_address"] is not None)

    r = doctor.post(f"/api/orders/{oid}/submit")
    check("submit blocked without records", r.status_code == 400, r.text)

    r = upload_records(doctor, oid)
    check("upload the required records set", r.status_code == 201, r.text)

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
                        "category": "ALIGN_16_20",
            "tax": "7560",
        },
    )
    check("quote sent", r.json()["status"] == "QUOTED", r.text)
    quoted = r.json()
    q0 = quoted["quotes"][0]
    check(
        "the expected quote is a range, not a single figure",
        q0["category"] == "ALIGN_16_20"
        and q0["category_price"] == "40000.00"
        and q0["category_price_max"] == "50000.00"
        and q0["total"] == "47560.00"
        and q0["total_max"] == "57560.00",
        str((q0["category_price"], q0["category_price_max"], q0["total"], q0["total_max"])),
    )

    r = staff.post(
        f"/api/staff/orders/{oid}/quotes",
        json={"category": "ALIGN_12_16", "tax": "7020"},
    )
    versions = r.json()["quotes"]
    check(
        "a revised quote can move the case to a different band",
        versions[1]["category"] == "ALIGN_12_16"
        and versions[1]["category_price"] == "30000.00"
        and versions[1]["category_price_max"] == "40000.00",
        str((versions[1]["category"], versions[1]["category_price"], versions[1]["category_price_max"])),
    )
    check("revised quote supersedes v1", versions[0]["status"] == "SUPERSEDED" and versions[1]["version"] == 2, str(versions))

    r = doctor.post(f"/api/orders/{oid}/quote/accept")
    check("doctor accepts the quote", r.json()["status"] == "AWAITING_SCAN", r.text)
    check("approved_at stamped", r.json()["approved_at"] is not None)

    # -- scan -------------------------------------------------------------
    r = doctor.post(
        f"/api/orders/{oid}/files",
        data={"category": "INTRAORAL_SCAN", "slot": "UPPER_ARCH"},
        files={"upload": ("arch.jpg", io.BytesIO(b"z"), "image/jpeg")},
    )
    check("non-STL scan rejected", r.status_code == 400, r.text)

    r = doctor.post(
        f"/api/orders/{oid}/files",
        data={"category": "INTRAORAL_SCAN", "slot": "UPPER_ARCH"},
        files={"upload": ("arch.stl", io.BytesIO(b"z" * 4096), "model/stl")},
    )
    check("STL scan accepted", r.status_code == 201, r.text)
    check(
        "one arch is not a scan — the case stays put",
        doctor.get(f"/api/orders/{oid}").json()["status"] == "AWAITING_SCAN",
    )

    upload_scan_set(doctor, oid)
    check("the complete set hands the scan to the lab", doctor.get(f"/api/orders/{oid}").json()["status"] == "SCAN_SUBMITTED")

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

    r = upload_scan_set(staff, oid, prefix="lab-")
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
    superseded_set = [
        s for s in doctor.get(f"/api/orders/{oid}").json()["record_sets"]
        if s["category"] == "INTRAORAL_SCAN"
    ][0]
    check(
        "an earlier round stays visible rather than vanishing",
        len(superseded_set["extras"]) >= 1
        and all(not e["is_current"] for e in superseded_set["extras"]),
        str([(e["filename"], e["revision"]) for e in superseded_set["extras"]]),
    )
    check(
        "a complete earlier round does not satisfy the new one",
        not superseded_set["complete"],
        str(superseded_set["missing"]),
    )
    check(
        "the earlier scans are marked superseded",
        all(not f["is_current"] for f in detail["files"] if f["category"] == "INTRAORAL_SCAN"),
    )
    check(
        "the case cannot be accepted while waiting on the replacement",
        staff.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": ""}).status_code == 409,
    )

    upload_scan_set(doctor, oid, prefix="v2-")
    enquiry_ref = doctor.get(f"/api/orders/{oid}").json()["order_number"]
    check(
        "reference is still the enquiry ref right up to planning",
        enquiry_ref.startswith("EN-"),
        enquiry_ref,
    )

    r = staff.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": "Scan is clean."})
    check("staff accepts the scan", r.json()["status"] == "IN_PLANNING", r.text)
    check(
        "reaching planning spends an AL number",
        r.json()["order_number"].startswith("AL-"),
        r.json()["order_number"],
    )
    al_number = r.json()["order_number"]
    check(
        "the doctor sees the same AL number",
        doctor.get(f"/api/orders/{oid}").json()["order_number"] == al_number,
    )
    check(
        "records uploaded before the number existed are still downloadable",
        doctor.get(
            f"/api/orders/{oid}/files/"
            f"{doctor.get(f'/api/orders/{oid}').json()['files'][0]['id']}/download"
        ).status_code
        == 200,
    )

    # -- planning ---------------------------------------------------------
    # The clinic approves movement it can see, so the plan cannot be published
    # until the staged models and the plan document are attached.
    r_nofiles = staff.post(
        f"/api/staff/orders/{oid}/plans",
        json={"aligners_upper": 18, "aligners_lower": 16, "final_price": "72000", "final_tax": "3000"},
    )
    check(
        "a plan cannot be shared without the simulation files",
        r_nofiles.status_code == 409 and "simulation files" in r_nofiles.text,
        r_nofiles.text[:120],
    )

    staff.post(
        f"/api/orders/{oid}/files",
        data={"category": "SIMULATION_MODEL"},
        files={"upload": ("0-S-3D_ALIGN_PA.stl", binary_stl(), "model/stl")},
    )
    r_noplan = staff.post(
        f"/api/staff/orders/{oid}/plans",
        json={"aligners_upper": 18, "aligners_lower": 16, "final_price": "72000", "final_tax": "3000"},
    )
    check(
        "nor without the plan document",
        r_noplan.status_code == 409 and "plan document" in r_noplan.text,
        r_noplan.text[:120],
    )
    staff.post(
        f"/api/orders/{oid}/files",
        data={"category": "TREATMENT_PLAN"},
        files={"upload": ("plan.pdf", io.BytesIO(b"%PDF-1.4 plan"), "application/pdf")},
    )

    # A discount larger than the price would invoice a negative amount.
    bad = staff.post(
        f"/api/staff/orders/{oid}/plans",
        json={"aligners_upper": 18, "aligners_lower": 16, "final_price": "72000",
              "final_discount": "80000", "final_tax": "3000"},
    )
    check("a discount bigger than the price is refused", bad.status_code == 400, bad.text[:120])

    r = staff.post(
        f"/api/staff/orders/{oid}/plans",
        json={"aligners_upper": 18, "aligners_lower": 16, "final_price": "72000",
              "final_discount": "6000", "final_discount_reason": "Referral scheme",
              "final_tax": "3000",
              "ipr_required": True, "summary": "IPR at 13-23."},
    )
    check("the plan publishes once both are attached", r.status_code == 200, r.text[:120])
    check("plan shared", r.json()["status"] == "PLAN_SHARED", r.text)
    # Every aligner count the plan can produce must fall in a priced band —
    # a gap here used to reject a perfectly ordinary 46-aligner case.
    bands = staff.get("/api/staff/pricing").json()

    def band_for(count):
        return next(
            (
                b
                for b in bands
                if count >= b["range_from"] and (b["range_to"] is None or count <= b["range_to"])
            ),
            None,
        )

    unbanded = [n for n in range(6, 101) if band_for(n) is None]
    check("every aligner count from 6 to 100 has a band", not unbanded, str(unbanded[:12]))
    check("the 40–70 band covers the old gap", band_for(46)["category"] == "ALIGN_40_70", str(band_for(46)))
    shared_plan = r.json()["plans"][-1]
    check(
        "the plan records the real aligner count",
        shared_plan["total_aligners"] == 34,
        str(shared_plan["total_aligners"]),
    )
    check(
        "the lab types the final price directly",
        shared_plan["final_price"] == "72000.00" and shared_plan["final_total"] == "69000.00",
        str((shared_plan["final_price"], shared_plan["final_total"])),
    )
    # 72000 less 6000 discount, plus 3000 tax.
    check(
        "the discount comes off the price before tax",
        shared_plan["final_discount"] == "6000.00"
        and shared_plan["final_total"] == "69000.00",
        str((shared_plan["final_discount"], shared_plan["final_total"])),
    )
    check(
        "the reason for the discount is kept for the clinic",
        shared_plan["final_discount_reason"] == "Referral scheme",
        shared_plan["final_discount_reason"],
    )
    # The estimate is a placeholder — the real figure overwrites it in place, so
    # a case never carries two prices.
    live = [q for q in r.json()["quotes"] if q["status"] != "SUPERSEDED"][-1]
    check(
        "the final price replaces the estimated range on the quote",
        live["total"] == shared_plan["final_total"]
        and live["total_max"] == shared_plan["final_total"]
        and live["is_final"],
        f"quote now {live['total']}–{live['total_max']} (final {shared_plan['final_total']})",
    )
    check(
        "and the quote reads as the aligner count, not a band",
        f"{shared_plan['total_aligners']} aligners" in live["line_items"][0]["description"],
        live["line_items"][0]["description"],
    )
    r_noprice = staff.post(
        f"/api/staff/orders/{oid}/plans", json={"aligners_upper": 10, "aligners_lower": 10}
    )
    check("a plan cannot be shared without a final price", r_noprice.status_code in (400, 409), r_noprice.text[:100])

    # -- the treatment plan fee -------------------------------------------
    # The plan is released against a fee, so until it is paid the clinic can
    # neither read the plan nor answer it.
    locked = doctor.get(f"/api/orders/{oid}").json()
    check("the clinic cannot see the plan before paying", locked["plan_locked"] and locked["plans"] == [], str(locked["plan_locked"]))
    check(
        "and the 3D simulation is behind the same fee",
        doctor.get(f"/api/orders/{oid}/files/simulation").status_code == 402,
        "",
    )
    r = doctor.post(f"/api/orders/{oid}/plan/respond", json={"approve": True})
    check("nor approve it", r.status_code == 402, r.text[:120])

    due = next(p for p in locked["payments"] if p["kind"] == "TREATMENT_PLAN")
    check("the plan fee is raised at 2000", str(due["total"]) == "2000.00", str(due["total"]))
    check(
        "with a UPI link the clinic's phone can open",
        due["upi_link"].startswith("upi://pay?") and "am=2000.00" in due["upi_link"],
        due["upi_link"],
    )

    # The plan is not only hidden from the case detail — nothing that is part
    # of it may leak out by another route while it is unpaid.
    check(
        "the aligner count does not leak before payment",
        locked["total_aligners"] == 0,
        str(locked["total_aligners"]),
    )
    check(
        "nor the band the plan confirmed",
        locked["category_confirmed"] is False,
        str(locked["category_confirmed"]),
    )
    check(
        "the plan documents are not listed",
        not any(r["category"] == "TREATMENT_PLAN" for r in locked["record_sets"]),
        str([r["category"] for r in locked["record_sets"]]),
    )
    plan_files = [
        f
        for rs in staff.get(f"/api/staff/orders/{oid}").json()["record_sets"]
        if rs["category"] == "TREATMENT_PLAN"
        for f in rs["extras"] + [x["file"] for x in rs["slots"] if x["file"]]
    ]
    check(
        "and cannot be downloaded either",
        all(
            doctor.get(f"/api/orders/{oid}/files/{f['id']}/download").status_code == 402
            for f in plan_files
        ),
        str(len(plan_files)),
    )
    shared_note = next(
        (e["note"] for e in locked["events"] if e["to_status"] == "PLAN_SHARED"), ""
    )
    check(
        "and the timeline does not spell the plan out",
        "aligners" not in shared_note.lower(),
        shared_note,
    )

    r = pay(doctor, staff, oid, "TREATMENT_PLAN")
    check("the lab verifies the receipt", r.status_code == 200, r.text[:120])
    unlocked = doctor.get(f"/api/orders/{oid}").json()
    check("which releases the plan", not unlocked["plan_locked"] and unlocked["plans"], "")
    check(
        "along with the aligner count and the plan documents",
        unlocked["total_aligners"] == 34
        and any(r["category"] == "TREATMENT_PLAN" for r in unlocked["record_sets"]),
        str(unlocked["total_aligners"]),
    )
    check(
        "and the documents become downloadable",
        all(
            doctor.get(f"/api/orders/{oid}/files/{f['id']}/download").status_code == 200
            for f in plan_files
        ),
        "",
    )
    check(
        "and the simulation with it",
        doctor.get(f"/api/orders/{oid}/files/simulation").status_code == 200,
        "",
    )

    r = doctor.post(f"/api/orders/{oid}/plan/respond", json={"approve": False, "revision_notes": "Reduce IPR."})
    check("revision sends it back to planning", r.json()["status"] == "IN_PLANNING", r.text)

    staff.post(f"/api/staff/orders/{oid}/plans",
               json={"aligners_upper": 18, "aligners_lower": 16, "final_price": "72000", "final_tax": "3000"})
    r = doctor.post(f"/api/orders/{oid}/plan/respond", json={"approve": True})
    check("plan approved starts production", r.json()["status"] == "TRAINING_ALIGNER_PRODUCTION", r.text)
    check("plan v2 recorded", len(r.json()["plans"]) == 2)

    # -- the training fit fee ---------------------------------------------
    r = staff.post(
        f"/api/staff/orders/{oid}/shipments",
        json={"shipment_type": "TRAINING_ALIGNER", "carrier": "Shree Tirupati", "tracking_number": "EARLY"},
    )
    check("the training aligner waits on its fee", r.status_code == 402, r.text[:120])

    fee = next(
        p for p in doctor.get(f"/api/orders/{oid}").json()["payments"]
        if p["kind"] == "TRAINING_FIT"
    )
    check("the training fit fee is raised at 1500", str(fee["total"]) == "1500.00", str(fee["total"]))
    pay(doctor, staff, oid, "TRAINING_FIT")

    # -- training aligner and fit ----------------------------------------
    r = staff.post(
        f"/api/staff/orders/{oid}/shipments",
        json={"shipment_type": "TRAINING_ALIGNER", "carrier": "Shree Tirupati", "tracking_number": "125600003371"},
    )
    check("training aligner shipped", r.json()["status"] == "TRAINING_ALIGNER_SHIPPED", r.text)
    training_id = r.json()["shipments"][0]["id"]

    # The clinic receives the parcel, so it can confirm arrival itself.
    r = doctor.post(f"/api/orders/{oid}/shipments/{training_id}/delivered")
    check("the clinic can confirm delivery", r.status_code == 200, r.text[:120])
    check("delivery opens fit review", r.json()["status"] == "FIT_REVIEW", r.json().get("status"))
    r = doctor.post(f"/api/orders/{oid}/shipments/{training_id}/delivered")
    check("confirming twice is refused", r.status_code == 409, r.text[:100])

    r = doctor.post(f"/api/orders/{oid}/fit-review", json={"fits": True})
    check("fit review needs a dispatch mode", r.status_code == 400, r.text)

    # A fit issue must produce a distinguishable second training aligner.
    r = doctor.post(f"/api/orders/{oid}/fit-review", json={"fits": False, "issue_notes": "Rocks on 16."})
    check("fit issue reported", r.json()["status"] == "FIT_ISSUE", r.text)

    # A training aligner that does not fit is a fit problem, not a planning
    # problem: rescanning must not redraw the treatment plan.
    plans_before = len(staff.get(f"/api/staff/orders/{oid}").json()["plans"])
    r = staff.post(f"/api/staff/orders/{oid}/fit-issue/resolve?resolution=rescan")
    check("a fit issue can be sent back for a scan", r.status_code == 200, r.text[:140])
    check("which reopens the scan step", r.json()["status"] == "AWAITING_SCAN", r.json()["status"])
    check("marked as a refinement", r.json()["refinement_round"] == 1, str(r.json()["refinement_round"]))

    upload_scan_set(doctor, oid, prefix="refit-")
    r = staff.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": ""})
    check(
        "the rescan goes back to a training aligner rather than into planning",
        r.json()["status"] == "TRAINING_ALIGNER_PRODUCTION",
        r.json()["status"],
    )
    check(
        "and the treatment plan is untouched",
        len(r.json()["plans"]) == plans_before,
        f"{len(r.json()['plans'])} vs {plans_before}",
    )

    check("the rescan advanced the fit round", r.json()["fit_round"] == 2, str(r.json()["fit_round"]))

    # Round two goes out against the new scan, and still does not fit — which is
    # what a refabrication is for.
    r = staff.post(
        f"/api/staff/orders/{oid}/shipments",
        json={"shipment_type": "TRAINING_ALIGNER", "carrier": "Shree Tirupati", "tracking_number": "R2"},
    )
    second = next(x for x in r.json()["shipments"] if x.get("fit_round") == 2)
    staff.patch(f"/api/staff/shipments/{second['id']}", json={"mark_delivered": True})
    r = doctor.post(f"/api/orders/{oid}/fit-review", json={"fits": False, "issue_notes": "Still rocks."})
    check("a second fit issue is accepted", r.json()["status"] == "FIT_ISSUE", r.json()["status"])

    r = staff.post(f"/api/staff/orders/{oid}/fit-issue/resolve?resolution=refabricate")
    check("refabricate advances the fit round", r.json()["fit_round"] == 3, str(r.json()["fit_round"]))
    check(
        "and remakes the aligner rather than asking for another scan",
        r.json()["status"] == "TRAINING_ALIGNER_PRODUCTION",
        r.json()["status"],
    )

    r = staff.post(
        f"/api/staff/orders/{oid}/shipments",
        json={"shipment_type": "TRAINING_ALIGNER", "carrier": "Shree Tirupati", "tracking_number": "R3"},
    )
    rounds = sorted(x["fit_round"] for x in r.json()["shipments"] if x["shipment_type"] == "TRAINING_ALIGNER")
    check("every training aligner is distinguishable", rounds == [1, 2, 3], str(rounds))

    third = next(x for x in r.json()["shipments"] if x.get("fit_round") == 3)
    staff.patch(f"/api/staff/shipments/{third['id']}", json={"mark_delivered": True})

    # 18 upper and 16 lower run as 18 steps, so at five aligners a phase the
    # clinic may ask for at most three.
    before = staff.get(f"/api/staff/orders/{oid}").json()
    check(
        "the case is as long as its longer arch, not both added together",
        before["aligner_steps"] == 18 and before["total_aligners"] == 34,
        str((before["aligner_steps"], before["total_aligners"])),
    )
    # Five is the working size of a phase and the last one takes the remainder,
    # so 18 steps go out as at most four phases (5, 5, 5, 3) rather than three
    # of six. That means rounding the cap up.
    check("the phase cap rounds up", before["max_phases"] == 4, str(before["max_phases"]))

    r = doctor.post(f"/api/orders/{oid}/fit-review", json={"fits": True, "dispatch_mode": "PHASED"})
    check("a phased dispatch must say how many phases", r.status_code == 400, r.text[:140])

    r = doctor.post(
        f"/api/orders/{oid}/fit-review",
        json={"fits": True, "dispatch_mode": "PHASED", "phase_count": 9},
    )
    check("more phases than the case allows is refused", r.status_code == 400, r.text[:140])

    # A fourteen-step arch splits 5, 5, 4 — the short batch lands at the end,
    # where the patient is finishing, not at the start.
    fourteen = staff.get(f"/api/staff/orders/{oid}").json()
    check(
        "the cap allows a short final phase rather than a long one",
        fourteen["max_phases"] == 4,
        str(fourteen["max_phases"]),
    )

    r = doctor.post(
        f"/api/orders/{oid}/fit-review",
        json={"fits": True, "dispatch_mode": "PHASED", "phase_count": 3},
    )
    check("fit confirmed starts aligner production", r.json()["status"] == "ALIGNER_PRODUCTION", r.text)
    check("dispatch mode recorded", r.json()["dispatch_mode"] == "PHASED")
    check("the phase count is recorded", r.json()["phase_count"] == 3, str(r.json()["phase_count"]))

    spans = r.json()["phase_plan"]
    check("a span is worked out for every phase", len(spans) == 3, str(len(spans)))
    sizes = [x["to_step"] - x["from_step"] + 1 for x in spans]
    check(
        "phases are filled evenly with the remainder last",
        sizes == [6, 6, 6],
        str(sizes),
    )
    check(
        "the phases run end to end and cover the whole series",
        spans[0]["from_step"] == 1
        and spans[-1]["to_step"] == 18
        and all(spans[i + 1]["from_step"] == spans[i]["to_step"] + 1 for i in range(len(spans) - 1)),
        str([(x["from_step"], x["to_step"]) for x in spans]),
    )
    check(
        "no phase is shorter than five aligners",
        all(x["to_step"] - x["from_step"] + 1 >= 5 for x in spans),
        str([x["to_step"] - x["from_step"] + 1 for x in spans]),
    )
    check(
        "the shorter arch stops at its own last aligner",
        spans[-1]["upper_to"] == 18 and spans[-1]["lower_to"] == 16,
        str((spans[-1]["upper_to"], spans[-1]["lower_to"])),
    )

    # -- phased dispatch --------------------------------------------------
    # Phases chain: each starts where the last accepted one ended, and the next
    # cannot ship until the clinic has received the previous and said carry on.
    steps = staff.get(f"/api/staff/orders/{oid}").json()["aligner_steps"]
    check("the plan's step count drives the phases", steps == 18, str(steps))

    def ship_phase(runs_to):
        return staff.post(
            f"/api/staff/orders/{oid}/shipments",
            json={
                "shipment_type": "ALIGNER_PHASE",
                "aligner_range_to": runs_to,
                "carrier": "Shree Tirupati",
                "tracking_number": f"TRK-{runs_to:03d}",
            },
        )

    # -- production money -------------------------------------------------
    # The quote was 75,000. The plan fee and the training-fit fee were collected
    # separately, so production is what is left of it, split across the phases,
    # with delivery added to each.
    detail = doctor.get(f"/api/orders/{oid}").json()
    phases = [p for p in detail["payments"] if p["kind"] == "PRODUCTION_PHASE"]
    check("one charge per production phase", len(phases) == 3, str(len(phases)))
    check(
        "the two fixed fees come off the quote rather than being charged again",
        sum(Decimal(p["amount"]) for p in phases) == Decimal("71500.00"),
        str(sum(Decimal(p["amount"]) for p in phases)),
    )
    by_phase = {p["phase_number"]: Decimal(p["shipping_amount"]) for p in phases}
    check(
        "the first delivery is not charged",
        by_phase[1] == Decimal("0"),
        str(by_phase[1]),
    )
    check(
        "every batch after it carries the city's rate",
        all(by_phase[n] == Decimal("150.00") for n in by_phase if n > 1),
        str(by_phase),
    )
    labels = [c["label"] for c in detail["charges"]]
    check(
        "the breakdown itemises what the clinic is paying for",
        all(
            x in labels
            for x in [
                "Align category",
                "Quoted price",
                "Treatment plan fee",
                "Training fit aligner fee",
                "Production aligners",
                "Delivery",
                "Total for this case",
            ]
        ),
        str(labels),
    )

    # Payment runs a phase behind delivery: the first batch goes out on trust,
    # and each one after it is released by the payment for the one before.
    # The clinic asked for three phases of an 18-step case, so the spans are
    # 1-6, 7-12 and 13-18.
    r = ship_phase(6)
    check("the first phase ships without payment", r.status_code == 200, r.text[:140])
    check("phase 1 ships", r.status_code == 200, r.text[:120])
    phase1 = [s for s in r.json()["shipments"] if s["shipment_type"] == "ALIGNER_PHASE"][-1]
    check("it starts at aligner 1 without being told", phase1["aligner_range_from"] == 1, str(phase1))
    check(
        "phase 1 covers the span the clinic's choice implies",
        phase1["aligner_range_to"] == 6,
        str(phase1["aligner_range_to"]),
    )

    check("the next phase is blocked until the clinic receives this one", ship_phase(12).status_code == 409)
    doctor.post(f"/api/orders/{oid}/shipments/{phase1['id']}/delivered")
    check("and still blocked until the clinic decides", ship_phase(12).status_code == 409)

    # Asking for the batch again is the same event as an aligner in it not
    # fitting, so there is one route for it and it is the one that collects the
    # arch, the aligner and the photographs.
    r = doctor.post(
        f"/api/orders/{oid}/shipments/{phase1['id']}/phase-decision",
        json={"decision": "REPEAT", "notes": "Trays 3-4 warped."},
    )
    check(
        "asking for a remake goes through the fit issue report",
        r.status_code == 409 and "Report a fit issue instead" in r.text,
        r.text[:170],
    )

    upload_fit_photos(doctor, oid)
    r = doctor.post(
        f"/api/orders/{oid}/phase-fit-issue",
        json={"arch": "UPPER", "aligner_number": 3, "notes": "Trays 3-4 warped."},
    )
    check("the clinic reports it against the aligner", r.json()["status"] == "FIT_ISSUE", r.text[:140])

    r = staff.post(
        f"/api/staff/orders/{oid}/phase-fit-issue/resolve",
        json={"resolution": "REMAKE", "comments": "Retrimming the batch."},
    )
    check("a remake reopens production", r.json()["status"] == "ALIGNER_PRODUCTION", r.json()["status"])
    check(
        "and the next batch is phase 1 round 2",
        (r.json()["next_phase_number"], r.json()["next_phase_round"]) == (1, 2),
        str((r.json()["next_phase_number"], r.json()["next_phase_round"])),
    )
    r = ship_phase(6)
    check("a remade phase is not charged again", r.status_code == 200, r.text[:140])
    redo = [s for s in r.json()["shipments"] if s["shipment_type"] == "ALIGNER_PHASE"][-1]
    check(
        "which ships as phase 1 round 2 over the same aligners",
        (redo["phase_number"], redo["phase_round"], redo["aligner_range_from"], redo["aligner_range_to"])
        == (1, 2, 1, 6),
        str(redo),
    )
    doctor.post(f"/api/orders/{oid}/shipments/{redo['id']}/delivered")

    # A phase is not signed off on the clinic's word alone — the lab has to see
    # how the teeth actually moved before committing the next batch.
    r = doctor.post(
        f"/api/orders/{oid}/shipments/{redo['id']}/phase-decision", json={"decision": "CONTINUE"}
    )
    check("carrying on needs the progress photographs", r.status_code == 409, r.text[:160])

    upload_progress(doctor, oid, PROGRESS_VIEWS[:4])
    r = doctor.post(
        f"/api/orders/{oid}/shipments/{redo['id']}/phase-decision", json={"decision": "CONTINUE"}
    )
    check("a partial set is still refused", r.status_code == 409, r.text[:160])
    check(
        "and it says which views are missing",
        "aligner out" in r.text,
        r.text[:160],
    )

    upload_progress(doctor, oid, PROGRESS_VIEWS[4:])
    r = doctor.post(
        f"/api/orders/{oid}/shipments/{redo['id']}/phase-decision", json={"decision": "CONTINUE"}
    )
    check("the clinic asks for the next phase", r.status_code == 200, r.text[:120])
    check(
        "which hands the phase to the lab to review, not straight to production",
        r.json()["status"] == "PHASE_REVIEW",
        r.json()["status"],
    )
    # Wearing the batch through and sending the photographs is what finishes a
    # phase, so delivery has already moved on before the lab looks at them.
    check(
        "sending the photographs completes the phase",
        {p["phase"]: p for p in r.json()["phase_plan"]}[1]["status"] == "COMPLETED",
        str(r.json()["phase_plan"]),
    )
    check(
        "and delivery moves on to the next one",
        r.json()["next_phase_from"] == 7,
        str(r.json()["next_phase_from"]),
    )

    # The lab cannot ship while the photographs are still unreviewed.
    check("no phase ships during the review", ship_phase(12).status_code == 409)

    r = staff.post(
        f"/api/staff/orders/{oid}/phase-review",
        json={"outcome": "CONTINUE", "note": "Tracking the plan."},
    )
    check("the lab clears the phase", r.status_code == 200, r.text[:140])
    check(
        "which puts the next batch back on the bench",
        r.json()["status"] == "ALIGNER_PRODUCTION",
        r.json()["status"],
    )
    check(
        "phase 1 stays completed through the review",
        next(p for p in r.json()["phase_plan"] if p["phase"] == 1)["status"] == "COMPLETED",
        str(r.json()["phase_plan"]),
    )
    check("and delivery is at aligner 7", r.json()["next_phase_from"] == 7, str(r.json()["next_phase_from"]))

    # Phase 2 is released by the payment for phase 1, not its own.
    r = ship_phase(12)
    check(
        "phase 2 waits on the payment for phase 1",
        r.status_code == 402 and "Phase 1 has not been paid" in r.text,
        r.text[:160],
    )
    check(
        "paying a later phase does not unlock it",
        (
            pay(doctor, staff, oid, "PRODUCTION_PHASE", 3).status_code == 200
            and ship_phase(12).status_code == 402
        ),
        "",
    )

    pay(doctor, staff, oid, "PRODUCTION_PHASE", 1)
    r = ship_phase(12)
    check("paying phase 1 releases phase 2", r.status_code == 200, r.text[:160])
    phase2 = [s for s in r.json()["shipments"] if s["shipment_type"] == "ALIGNER_PHASE"][-1]
    check("phase 2 runs 7–12", (phase2["aligner_range_from"], phase2["aligner_range_to"]) == (7, 12), str(phase2))
    doctor.post(f"/api/orders/{oid}/shipments/{phase2['id']}/delivered")

    # -- a phase that is not tracking: rescan without replanning -----------
    # Each phase collects its own photographs, so phase 1's do not stand in for
    # phase 2's.
    r = doctor.post(
        f"/api/orders/{oid}/shipments/{phase2['id']}/phase-decision", json={"decision": "CONTINUE"}
    )
    check("each phase needs its own photographs", r.status_code == 409, r.text[:140])

    upload_progress(doctor, oid)
    r = doctor.post(
        f"/api/orders/{oid}/shipments/{phase2['id']}/phase-decision", json={"decision": "CONTINUE"}
    )
    check("phase 2 goes for review", r.json()["status"] == "PHASE_REVIEW", r.text[:140])

    r = staff.post(f"/api/staff/orders/{oid}/phase-review", json={"outcome": "RESCAN"})
    check("a rescan has to say why", r.status_code == 400, r.text[:140])

    plan_versions_before = len(staff.get(f"/api/staff/orders/{oid}").json()["plans"])
    r = staff.post(
        f"/api/staff/orders/{oid}/phase-review",
        json={"outcome": "RESCAN", "note": "Lower canine not tracking; 2 mm behind the plan."},
    )
    check("the lab can send the case back for a scan", r.status_code == 200, r.text[:140])
    check("which reopens the scan step", r.json()["status"] == "AWAITING_SCAN", r.json()["status"])
    # The second time this case has been rescanned without replanning — the
    # first was the training aligner that would not fit.
    check("and records it as a refinement", r.json()["refinement_round"] == 2, str(r.json()["refinement_round"]))
    check(
        "the phase question does not follow the case out of dispatch",
        r.json()["awaiting_phase_decision"] is None,
        str(r.json()["awaiting_phase_decision"]),
    )
    check(
        "the clinic is asked how the scan will arrive again",
        r.json()["scan_route"] is None,
        str(r.json()["scan_route"]),
    )

    upload_scan_set(doctor, oid, prefix="refine-")
    r = staff.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": ""})
    check("the refinement scan is accepted", r.status_code == 200, r.text[:140])
    check(
        "and goes straight to a training aligner, not back into planning",
        r.json()["status"] == "TRAINING_ALIGNER_PRODUCTION",
        r.json()["status"],
    )
    check(
        "the treatment plan is left alone",
        len(r.json()["plans"]) == plan_versions_before,
        f"{len(r.json()['plans'])} vs {plan_versions_before}",
    )

    r = staff.post(
        f"/api/staff/orders/{oid}/shipments",
        json={"shipment_type": "TRAINING_ALIGNER", "carrier": "Shree Tirupati", "tracking_number": "R3"},
    )
    refit = [x for x in r.json()["shipments"] if x["shipment_type"] == "TRAINING_ALIGNER"][-1]
    r = doctor.post(f"/api/orders/{oid}/shipments/{refit['id']}/delivered")
    check("the refinement training aligner opens a fit review", r.json()["status"] == "FIT_REVIEW", r.json()["status"])

    # The case is already divided, so the fit review must not ask how it ships.
    before_fit = staff.get(f"/api/staff/orders/{oid}").json()
    check(
        "a divided case is still divided going into the fit review",
        before_fit["phases_divided"] is True,
        str(before_fit["phases_divided"]),
    )
    r = doctor.post(f"/api/orders/{oid}/fit-review", json={"fits": True})
    check(
        "confirming it does not ask how to ship all over again",
        r.status_code == 200,
        r.text[:140],
    )
    check(
        "and the division is untouched by the refinement",
        len(r.json()["phase_plan"]) == 3 and r.json()["phase_count"] == 3,
        str(r.json()["phase_count"]),
    )
    check("the case returns to production", r.json()["status"] == "ALIGNER_PRODUCTION", r.json()["status"])
    check(
        "the clinic's original dispatch choice survives the refinement",
        (r.json()["dispatch_mode"], r.json()["phase_count"]) == ("PHASED", 3),
        str((r.json()["dispatch_mode"], r.json()["phase_count"])),
    )
    # Phase 2 was interrupted, not finished, so delivery resumes there — not at
    # phase 3, and not back at phase 1.
    plan_now = {p["phase"]: p for p in r.json()["phase_plan"]}
    check(
        "the rescan resumes at the phase after the completed one",
        r.json()["next_phase_from"] == 13 and r.json()["next_phase_number"] == 3,
        str((r.json()["next_phase_number"], r.json()["next_phase_from"])),
    )
    check(
        "the phases whose photographs were sent stay completed",
        plan_now[1]["status"] == "COMPLETED" and plan_now[2]["status"] == "COMPLETED",
        str([plan_now[1]["status"], plan_now[2]["status"]]),
    )
    check(
        "and the phase it resumes at is still on its first round",
        plan_now[3]["status"] == "NOT_STARTED" and plan_now[3]["round"] == 1,
        str(plan_now[3]),
    )
    check(
        "the spans themselves never moved",
        [(p["from_step"], p["to_step"]) for p in r.json()["phase_plan"]]
        == [(1, 6), (7, 12), (13, 18)],
        str(r.json()["phase_plan"]),
    )

    check("a phase cannot run past its own span", ship_phase(40).status_code == 400)

    pay(doctor, staff, oid, "PRODUCTION_PHASE", 1)
    # The refinement produced a second training aligner and did not charge for
    # it — the training fit fee is once per case.
    fit_charges = [
        p for p in doctor.get(f"/api/orders/{oid}").json()["payments"]
        if p["kind"] == "TRAINING_FIT"
    ]
    check(
        "the training fit fee was raised exactly once across three aligners",
        len(fit_charges) == 1 and str(fit_charges[0]["total"]) == "1500.00",
        str(fit_charges),
    )
    plan_charges = [
        p for p in doctor.get(f"/api/orders/{oid}").json()["payments"]
        if p["kind"] == "TREATMENT_PLAN"
    ]
    check(
        "and the plan fee once, across a revision and two rescans",
        len(plan_charges) == 1 and str(plan_charges[0]["total"]) == "2000.00",
        str(plan_charges),
    )

    r = ship_phase(18)
    check(
        "the final phase waits on the payment for phase 2",
        r.status_code == 402 and "Phase 2 has not been paid" in r.text,
        r.text[:160],
    )
    pay(doctor, staff, oid, "PRODUCTION_PHASE", 2)

    # -- a fit issue inside a phase ---------------------------------------
    r = ship_phase(18)
    check("phase 3 ships", r.status_code == 200, r.text[:140])
    p3 = [x for x in r.json()["shipments"] if x["shipment_type"] == "ALIGNER_PHASE"][-1]
    doctor.post(f"/api/orders/{oid}/shipments/{p3['id']}/delivered")

    r = doctor.post(
        f"/api/orders/{oid}/phase-fit-issue",
        json={"arch": "UPPER", "aligner_number": 15, "notes": "Rocks on 15."},
    )
    check("a fit issue needs its six photographs", r.status_code == 409, r.text[:160])

    upload_fit_photos(doctor, oid)
    r = doctor.post(
        f"/api/orders/{oid}/phase-fit-issue",
        json={"arch": "UPPER", "aligner_number": 4, "notes": "Not in this phase."},
    )
    check("an aligner outside the phase is refused", r.status_code == 400, r.text[:160])

    r = doctor.post(
        f"/api/orders/{oid}/phase-fit-issue",
        json={"arch": "UPPER", "aligner_number": 15, "notes": "Rocks on the upper 15."},
    )
    check("the clinic can report a fit issue mid-phase", r.status_code == 200, r.text[:160])
    check("which stops the case for the lab", r.json()["status"] == "FIT_ISSUE", r.json()["status"])
    plan_now = {p["phase"]: p for p in r.json()["phase_plan"]}
    check(
        "and puts that phase back to unfinished",
        plan_now[3]["status"] == "ISSUE",
        str(plan_now[3]),
    )
    check(
        "while the phases behind it stay completed",
        plan_now[1]["status"] == "COMPLETED" and plan_now[2]["status"] == "COMPLETED",
        str([plan_now[1]["status"], plan_now[2]["status"]]),
    )
    check("no further batch can be made meanwhile", ship_phase(18).status_code == 409)

    # 1. answered with instructions. Advice does not close the issue — only the
    # clinic can say whether it worked, so the two sides talk until it does.
    r = staff.post(f"/api/staff/orders/{oid}/phase-fit-issue/resolve", json={"resolution": "COMMENTS"})
    check("instructions have to say something", r.status_code == 400, r.text[:140])
    r = staff.post(
        f"/api/staff/orders/{oid}/phase-fit-issue/resolve",
        json={"resolution": "COMMENTS", "comments": "Wear 14 for four more days, then go on."},
    )
    check("the lab can answer with instructions", r.status_code == 200, r.text[:140])
    check("which hands the case back to the clinic", r.json()["status"] == "DISPATCHING", r.json()["status"])
    issue = next(i for i in r.json()["phase_issues"] if i["status"] == "OPEN")
    check("but the issue is not closed by advice", issue["awaiting"] == "CLINIC", str(issue["awaiting"]))
    check(
        "and the phase stays unfinished while it is open",
        {p["phase"]: p for p in r.json()["phase_plan"]}[3]["status"] == "ISSUE",
        str(r.json()["phase_plan"]),
    )
    check("no batch is made while it is open", ship_phase(18).status_code == 409)

    # The clinic tries it and says what happened; it goes back to the lab.
    r = doctor.post(
        f"/api/orders/{oid}/phase-fit-issue/reply",
        json={"message": "Still lifting on the distal after four days."},
    )
    check("the clinic can answer back", r.status_code == 200, r.text[:140])
    check("which returns it to the lab", r.json()["status"] == "FIT_ISSUE", r.json()["status"])
    issue = next(i for i in r.json()["phase_issues"] if i["status"] == "OPEN")
    check("with the turn on the lab", issue["awaiting"] == "LAB", str(issue["awaiting"]))

    r = staff.post(
        f"/api/staff/orders/{oid}/phase-fit-issue/resolve",
        json={"resolution": "COMMENTS", "comments": "Add chewies for two days."},
    )
    issue = next(i for i in r.json()["phase_issues"] if i["status"] == "OPEN")
    check(
        "the exchange can go round again and is kept in order",
        [m["from_lab"] for m in issue["messages"]] == [True, False, True],
        str([m["from_lab"] for m in issue["messages"]]),
    )

    # The clinic closes it, because they are the one who can see it worked.
    r = doctor.post(f"/api/orders/{oid}/phase-fit-issue/resolve")
    check("the clinic closes the issue", r.status_code == 200, r.text[:140])
    closed = r.json()["phase_issues"][-1]
    check(
        "recorded as settled by the clinic",
        closed["status"] == "RESOLVED" and closed["resolution"] == "CLINIC_CONFIRMED",
        str((closed["status"], closed["resolution"])),
    )
    check("with no issue left open", r.json()["open_phase_issue"] is None, str(r.json()["open_phase_issue"]))
    # Closing the issue is not completing the phase — the batch is still being
    # worn, and the progress photographs are what finish it.
    check(
        "the phase is back with the clinic, still unfinished",
        {p["phase"]: p for p in r.json()["phase_plan"]}[3]["status"] == "ACTIVE",
        str(r.json()["phase_plan"]),
    )

    # 2. reported again, and this time remade — which does close it outright.
    upload_fit_photos(doctor, oid)
    r = doctor.post(
        f"/api/orders/{oid}/phase-fit-issue",
        json={"arch": "LOWER", "aligner_number": 15, "notes": "Still rocking."},
    )
    check("a second report is accepted", r.json()["status"] == "FIT_ISSUE", r.text[:140])
    revisions = [i["photo_revision"] for i in r.json()["phase_issues"]]
    check(
        "each report keeps its own photographs",
        len(set(revisions)) == len(revisions),
        str(revisions),
    )
    r = staff.post(
        f"/api/staff/orders/{oid}/phase-fit-issue/resolve",
        json={"resolution": "REMAKE", "comments": "Retrimming 15."},
    )
    check("the lab can remake the phase", r.json()["status"] == "ALIGNER_PRODUCTION", r.text[:140])
    check(
        "and a remake closes the issue outright",
        r.json()["open_phase_issue"] is None
        and r.json()["phase_issues"][-1]["resolution"] == "REMAKE",
        str(r.json()["phase_issues"][-1]),
    )
    remade = {p["phase"]: p for p in r.json()["phase_plan"]}[3]
    check(
        "as the next round of the same phase, over the same aligners",
        remade["round"] == 2
        and remade["status"] == "NOT_STARTED"
        and (remade["from_step"], remade["to_step"]) == (13, 18),
        str(remade),
    )

    r = ship_phase(18)
    phase3 = [s for s in r.json()["shipments"] if s["shipment_type"] == "ALIGNER_PHASE"][-1]
    check("the final phase runs 13–18", (phase3["aligner_range_from"], phase3["aligner_range_to"]) == (13, 18), str(phase3))
    check("and is flagged as final", phase3["is_final_phase"])
    check("the case is still dispatching", r.json()["status"] == "DISPATCHING", r.json()["status"])

    # The last batch gets the same fit check as any other — completing silently
    # would leave a badly fitting final phase with no way back.
    r = doctor.post(f"/api/orders/{oid}/shipments/{phase3['id']}/delivered")
    check("receiving the final phase does not complete the case", r.json()["status"] == "DISPATCHING", r.json()["status"])
    check(
        "the clinic is asked about it like any other phase",
        r.json()["awaiting_phase_decision"] == phase3["id"],
        str(r.json()["awaiting_phase_decision"]),
    )
    # A fit issue on the *last* aligner of a phase counts the phase as worn
    # through, exactly as sending the photographs would.
    upload_fit_photos(doctor, oid)
    r = doctor.post(
        f"/api/orders/{oid}/phase-fit-issue",
        json={"arch": "UPPER", "aligner_number": 18, "notes": "Tight on the very last one."},
    )
    check("the last aligner of a phase can be reported too", r.status_code == 200, r.text[:160])
    check(
        "but it leaves the phase complete rather than unfinished",
        {p["phase"]: p for p in r.json()["phase_plan"]}[3]["status"] == "COMPLETED",
        str(r.json()["phase_plan"]),
    )
    check(
        "so a rescan from there would not re-enter it",
        r.json()["next_phase_number"] == 3
        and all(p["status"] == "COMPLETED" for p in r.json()["phase_plan"]),
        str(r.json()["phase_plan"]),
    )
    staff.post(
        f"/api/staff/orders/{oid}/phase-fit-issue/resolve",
        json={"resolution": "COMMENTS", "comments": "Normal at the end of a batch."},
    )
    doctor.post(f"/api/orders/{oid}/phase-fit-issue/resolve")

    r = doctor.post(
        f"/api/orders/{oid}/shipments/{phase3['id']}/phase-decision", json={"decision": "CONTINUE"}
    )
    check("accepting the final phase completes the case", r.json()["status"] == "COMPLETED", r.json()["status"])
    detail = staff.get(f"/api/staff/orders/{oid}").json()
    # Three training aligners before the series started and a fourth after the
    # mid-course refinement; phase 1 and its remake, phase 2 and its remake
    # after the refinement, and the final phase.
    check("every batch is on the record", len(detail["shipments"]) == 9, str(len(detail["shipments"])))

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

    # -- searching, and delivering somewhere else --------------------------
    hit = doctor.get(f"/api/orders?search={order['order_number']}").json()
    check(
        "a doctor can find a case by its reference",
        any(o["id"] == oid for o in hit),
        str([o["order_number"] for o in hit]),
    )
    patient_id = doctor.get("/api/patients").json()[0]["id"]
    by_patient = doctor.get(f"/api/orders?patient_id={patient_id}").json()
    check(
        "cases can be listed for one patient",
        len(by_patient) > 0 and all(o["patient_name"] for o in by_patient),
        str(len(by_patient)),
    )
    check(
        "nonsense search finds nothing rather than everything",
        doctor.get("/api/orders?search=zzzznotathing").json() == [],
    )

    # A practice with several clinics picks where a batch goes, and cannot pick
    # somebody else's address.
    second = doctor.post(
        "/api/addresses",
        json={
            "label": "Second branch",
            "line1": "12 Other Road",
            "city": "Ahmedabad",
            "state": "Gujarat",
            "pincode": "380015",
            "country": "India",
            "is_default_shipping": False,
        },
    )
    check("a doctor can add another clinic address", second.status_code == 201, second.text[:120])
    r = other.post(
        "/api/addresses",
        json={
            "label": "Not yours",
            "line1": "9 Elsewhere",
            "city": "Pune",
            "state": "Maharashtra",
            "pincode": "411001",
            "country": "India",
            "is_default_shipping": False,
        },
    )
    if r.status_code == 201:
        stolen = doctor.post(
            f"/api/orders/{oid}/fit-review",
            json={"fits": True, "shipping_address_id": r.json()["id"]},
        )
        check(
            "another practice's address is refused",
            stolen.status_code in (404, 409),
            stolen.text[:100],
        )

    # -- long lists are paged ----------------------------------------------
    # A practice with hundreds of cases must not ship them all in one response,
    # and a search must reach past the first page.
    page = staff.get("/api/staff/orders?limit=3").json()
    check("a page never exceeds the size asked for", len(page) <= 3, str(len(page)))
    second = staff.get("/api/staff/orders?limit=3&offset=3").json()
    check(
        "the next page never repeats the first",
        not ({o["id"] for o in page} & {o["id"] for o in second}),
        "pages overlap",
    )
    check(
        "the page size is capped server-side",
        staff.get("/api/staff/orders?limit=5000").status_code == 422,
    )
    everything = staff.get("/api/staff/orders?limit=200").json()
    if len(everything) > 3:
        # Search runs in the database, so a case beyond the first page is found.
        last = everything[-1]
        found = staff.get(f"/api/staff/orders?search={last['patient_name']}&limit=200").json()
        check(
            "search reaches cases beyond the first page",
            any(o["id"] == last["id"] for o in found),
            f"{last['patient_name']} not found",
        )
    check(
        "the doctor's own list is paged too",
        len(doctor.get("/api/orders?limit=2").json()) <= 2,
    )
    check("patients are paged", len(doctor.get("/api/patients?limit=2").json()) <= 2)

    # -- the AL series is only spent on cases that reach planning -----------
    # The lab's complaint: quotes that are never accepted used to burn numbers.
    def fresh_case(name):
        r = doctor.post(
            "/api/orders",
            json={
                "new_patient": {"full_name": name, "sex": "F"},
                "arch": "BOTH",
                "priority": "STANDARD",
                "chief_complaint": "Spacing.",
            },
        )
        return r.json()["id"]

    abandoned = fresh_case("Abandoned Draft")
    declined = fresh_case("Declined Quote")
    proceeds = fresh_case("Goes To Planning")

    check(
        "none of the three has taken a production number",
        all(
            doctor.get(f"/api/orders/{o}").json()["order_number"].startswith("EN-")
            for o in (abandoned, declined, proceeds)
        ),
    )

    # The declined one is quoted but never accepted; the third goes all the way.
    for oid_ in (declined, proceeds):
        upload_records(doctor, oid_)
        doctor.post(f"/api/orders/{oid_}/submit")
        staff.post(f"/api/staff/orders/{oid_}/start-review")
        staff.post(
            f"/api/staff/orders/{oid_}/quotes",
            json={"category": "ALIGN_16_20", "tax": "0"},
        )

    doctor.post(f"/api/orders/{proceeds}/quote/accept")
    doctor.post(f"/api/orders/{proceeds}/scan-route", json={"scan_route": "UPLOAD"})
    upload_scan_set(doctor, proceeds, prefix="v1")
    r = staff.post(f"/api/staff/orders/{proceeds}/scan/accept", json={"note": "clean"})

    check(
        "the case that reached planning takes the next AL number",
        r.json()["order_number"] == f"AL-{al_number.split('-')[1]}-0002",
        f"{r.json()['order_number']} after {al_number}",
    )
    check(
        "the abandoned draft never took one",
        doctor.get(f"/api/orders/{abandoned}").json()["order_number"].startswith("EN-"),
    )
    check(
        "the unaccepted quote never took one",
        doctor.get(f"/api/orders/{declined}").json()["order_number"].startswith("EN-"),
    )

    # A case that loops back through planning must not take a second number.
    staff.post(
        f"/api/staff/orders/{proceeds}/plans",
        json={"aligners_upper": 8, "aligners_lower": 8, "final_price": "45000", "final_tax": "0"},
    )
    doctor.post(
        f"/api/orders/{proceeds}/plan/respond",
        json={"approve": False, "revision_notes": "Reduce IPR."},
    )
    check(
        "re-entering planning does not spend another number",
        doctor.get(f"/api/orders/{proceeds}").json()["order_number"]
        == f"AL-{al_number.split('-')[1]}-0002",
    )


print()
if failures:
    print(f"{len(failures)} check(s) failed:")
    for f in failures:
        print(f"  - {f}")
    raise SystemExit(1)
print("All checks passed.")
