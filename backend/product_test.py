"""End-to-end walk of a product order — the things the lab makes besides
staged aligner series.

    .venv/bin/python product_test.py

A product order is an aligner case with the middle removed. It shares the
doctor, the patient, the scan, the address, the shipment and the invoice; it
skips planning, simulation, the training fit, fit review and phases entirely.
These checks are mostly about that boundary holding: that a product never
raises an aligner fee, never asks for a plan, and that an aligner case is
unaffected by any of it.

Uses a throwaway SQLite file, so it never touches dev data.
"""

import io
import os
import tempfile

TMP = tempfile.mkdtemp(prefix="align-product-")
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", f"sqlite:///{TMP}/product.db"
)
os.environ["STORAGE_LOCAL_ROOT"] = f"{TMP}/storage"
os.environ["STAFF_EMAIL"] = "lab@3dalign.example.com"
os.environ["STAFF_PASSWORD"] = "labpassword"
os.environ["DCI_CHECK_ENABLED"] = "false"
os.environ["GOOGLE_MAPS_API_KEY"] = ""
os.environ["GOOGLE_MAPS_BROWSER_KEY"] = ""

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

BASE = "/api"
REQUIRED_VIEWS = (
    "INTRAORAL_FRONTAL", "BUCCAL_RIGHT", "BUCCAL_LEFT", "OCCLUSAL_UPPER", "OCCLUSAL_LOWER",
)
SCAN_SET = (("UPPER_ARCH", "upper.stl"), ("LOWER_ARCH", "lower.stl"), ("BITE", "bite.stl"))

failures = []


def check(label, condition, detail=""):
    mark = "  ok  " if condition else " FAIL "
    print(f"[{mark}] {label}" + (f"  — {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(label)


def upload_records(session, order_id):
    for view in REQUIRED_VIEWS:
        session.post(
            f"{BASE}/orders/{order_id}/files",
            data={"category": "RECORD_PHOTO", "slot": view},
            files={"upload": (f"{view.lower()}.jpg", io.BytesIO(b"x" * 600), "image/jpeg")},
        )
    session.post(
        f"{BASE}/orders/{order_id}/files",
        data={"category": "OPG", "slot": ""},
        files={"upload": ("opg.jpg", io.BytesIO(b"x" * 600), "image/jpeg")},
    )


def upload_scan(session, order_id):
    for slot, name in SCAN_SET:
        session.post(
            f"{BASE}/orders/{order_id}/files",
            data={"category": "INTRAORAL_SCAN", "slot": slot},
            files={"upload": (name, io.BytesIO(b"solid" * 800), "model/stl")},
        )


with TestClient(app) as boot:
    lab = TestClient(app, base_url="http://lab")
    doctor = TestClient(app, base_url="http://doctor")
    other = TestClient(app, base_url="http://other")

    lab.post(f"{BASE}/auth/login", json={"email": "lab@3dalign.example.com", "password": "labpassword"})

    # -- the catalogue ----------------------------------------------------
    r = doctor.get(f"{BASE}/products")
    check("the catalogue is readable without signing in", r.status_code == 200, r.text)
    products = {p["code"]: p for p in r.json()}
    check("all ten products are listed", len(products) == 10, str(sorted(products)))
    check(
        "the three the old classifier never knew about are there",
        {"SG", "ABP", "PBP"} <= set(products),
        str(sorted(products)),
    )
    essix = products["ER"]
    check("Essix is priced per size", len(essix["sizes"]) == 2, str(essix["sizes"]))
    check("a two-size product asks which", essix["has_choice_of_size"] is True)
    check("a one-size product does not", products["ABP"]["has_choice_of_size"] is False)
    check(
        "the pediatric retainer carries its per-tooth price",
        float(products["PR"]["per_tooth_price"]) == 100.0 and products["PR"]["included_teeth"] == 1,
        str(products["PR"]),
    )

    # -- registration -----------------------------------------------------
    doctor.post(f"{BASE}/auth/register", json={
        "email": "dr.rao@clinic.example.com", "password": "supersecret123",
        "full_name": "Dr. Kavita Rao", "phone": "+919812345678", "clinic_name": "Rao Dental",
        "address": {"line1": "9 Ashram Road", "city": "Ahmedabad", "state": "Gujarat",
                    "pincode": "380009", "is_default_shipping": True},
    })
    doctor_id = doctor.get(f"{BASE}/auth/me").json()["doctor"]["id"]
    lab.post(f"{BASE}/staff/doctors/{doctor_id}/verify", json={"approve": True})

    thin = [s for s in essix["sizes"] if s["label"] == "0.8 mm"][0]

    # -- ordering ---------------------------------------------------------
    r = doctor.post(f"{BASE}/orders", json={
        "new_patient": {"full_name": "Meera Iyer"},
        "product_id": essix["id"],
        "chief_complaint": "Retention after treatment.",
    })
    check("a multi-size product cannot be ordered without a size", r.status_code == 400, r.text)
    check("and the refusal names the product", "Essix" in r.text, r.text)

    r = doctor.post(f"{BASE}/orders", json={
        "new_patient": {"full_name": "Meera Iyer"},
        "product_id": products["ABP"]["id"],
    })
    check("a single-size product needs no size chosen", r.status_code == 201, r.text)
    plate = r.json()
    check("it took the only size there is", plate["id"] is not None)

    r = doctor.post(f"{BASE}/orders", json={
        "new_patient": {"full_name": "Sana Kapoor"},
        "product_id": products["ABP"]["id"],
        "extra_teeth": 3,
    })
    check(
        "extra teeth are refused on a product not priced that way",
        r.status_code == 400 and "per tooth" in r.text,
        r.text,
    )

    r = doctor.post(f"{BASE}/orders", json={
        "new_patient": {"full_name": "Anaya Shah"},
        "product_id": essix["id"], "product_size_id": thin["id"], "quantity": 3,
    })
    check("a sized product order is created", r.status_code == 201, r.text)
    order = r.json()
    oid = order["id"]

    summary = next(o for o in doctor.get(f"{BASE}/orders").json() if o["id"] == oid)
    check("it is marked as a product order", summary["kind"] == "PRODUCT", str(summary["kind"]))
    check(
        "the board says what was ordered",
        summary["product_label"] == "Essix Retainer · 0.8 mm · x3",
        summary["product_label"],
    )

    # -- through to a scan ------------------------------------------------
    upload_records(doctor, oid)
    doctor.post(f"{BASE}/orders/{oid}/submit")
    lab.post(f"{BASE}/staff/orders/{oid}/start-review")
    lab.post(f"{BASE}/staff/orders/{oid}/quotes", json={"category": "ALIGN_16_20", "tax": "0"})
    doctor.post(f"{BASE}/orders/{oid}/quote/accept")
    check(
        "a product order is quoted like any other case",
        doctor.get(f"{BASE}/orders/{oid}").json()["status"] == "AWAITING_SCAN",
    )

    r = doctor.get(f"{BASE}/orders/{oid}/scan-sources")
    check("a first-time patient has no scan to reuse", r.status_code == 200 and r.json() == [], r.text)

    upload_scan(doctor, oid)
    check(
        "the scan moves it along",
        doctor.get(f"{BASE}/orders/{oid}").json()["status"] == "SCAN_SUBMITTED",
    )

    # -- no aligner fees --------------------------------------------------
    kinds = {p["kind"] for p in doctor.get(f"{BASE}/orders/{oid}").json()["payments"]}
    check(
        "no treatment-plan fee is ever raised against a product",
        "TREATMENT_PLAN" not in kinds, str(kinds),
    )
    check("nor a training-fit fee", "TRAINING_FIT" not in kinds, str(kinds))

    # -- straight to the bench --------------------------------------------
    r = lab.post(f"{BASE}/staff/orders/{oid}/scan/accept", json={"note": ""})
    check("accepting the scan works", r.status_code == 200, r.text)
    check(
        "a product skips planning and goes to fabrication",
        r.json()["status"] == "PRODUCT_FABRICATION", r.json()["status"],
    )

    detail = doctor.get(f"{BASE}/orders/{oid}").json()
    charge = next((p for p in detail["payments"] if p["kind"] == "PRODUCT_ORDER"), None)
    check("one charge covers the order", charge is not None, str(detail["payments"]))
    check(
        "priced by size times quantity, not per unit",
        charge and float(charge["amount"]) == 3000.0,
        str(charge and charge["amount"]),
    )

    # -- payment gates dispatch -------------------------------------------
    r = lab.post(f"{BASE}/staff/orders/{oid}/shipments", json={
        "shipment_type": "PRODUCT", "carrier": "Shree Tirupati", "tracking_number": "PRD001",
    })
    check("it cannot ship unpaid", r.status_code == 402, r.text)

    doctor.post(
        f"{BASE}/orders/{oid}/payments/{charge['id']}/proof",
        data={"reference": "UPI-PRD-1"},
        files={"upload": ("receipt.jpg", io.BytesIO(b"x" * 500), "image/jpeg")},
    )
    lab.post(f"{BASE}/staff/orders/{oid}/payments/{charge['id']}/verify", json={"approve": True})
    r = lab.post(f"{BASE}/staff/orders/{oid}/shipments", json={
        "shipment_type": "PRODUCT", "carrier": "Shree Tirupati", "tracking_number": "PRD001",
    })
    check("once paid it ships", r.status_code == 200, r.text)
    check("and the case is dispatching", r.json()["status"] == "DISPATCHING", r.json()["status"])

    # -- reusing that patient's scan --------------------------------------
    patient_id = doctor.get(f"{BASE}/orders/{oid}").json()["patient_id"]
    r = doctor.post(f"{BASE}/orders", json={
        "patient_id": patient_id,
        "product_id": products["NG"]["id"],
        "product_size_id": products["NG"]["sizes"][0]["id"],
    })
    second = r.json()["id"]
    upload_records(doctor, second)
    doctor.post(f"{BASE}/orders/{second}/submit")
    lab.post(f"{BASE}/staff/orders/{second}/start-review")
    lab.post(f"{BASE}/staff/orders/{second}/quotes", json={"category": "ALIGN_16_20", "tax": "0"})
    doctor.post(f"{BASE}/orders/{second}/quote/accept")

    r = doctor.get(f"{BASE}/orders/{second}/scan-sources")
    check("the earlier scan is offered back", r.status_code == 200 and len(r.json()) == 1, r.text)
    source = r.json()[0]
    check("it is named by its reference", source["order_id"] == oid, str(source))

    r = doctor.post(f"{BASE}/orders/{second}/scan-reuse", json={"source_order_id": oid})
    check("reusing it is accepted", r.status_code == 200, r.text)
    check(
        "the case moves on as though a scan arrived",
        r.json()["status"] == "SCAN_SUBMITTED", r.json()["status"],
    )
    files = [f for f in r.json()["files"] if f["category"] == "INTRAORAL_SCAN"]
    check("all three scan files came across", len(files) == 3, str(len(files)))

    r = doctor.post(f"{BASE}/orders/{second}/scan-reuse", json={"source_order_id": oid})
    check("it cannot be done twice", r.status_code in (409, 422), r.text)

    r = lab.post(f"{BASE}/staff/orders/{second}/scan/accept", json={"note": ""})
    check(
        "a reused scan is still reviewed by the lab, not waved through",
        r.status_code == 200 and r.json()["status"] == "PRODUCT_FABRICATION",
        r.text[:120],
    )

    # -- another clinic cannot reach across ---------------------------------
    other.post(f"{BASE}/auth/register", json={
        "email": "dr.shah@other.example.com", "password": "supersecret123",
        "full_name": "Dr. Nikhil Shah", "phone": "+919800000000", "clinic_name": "Shah Dental",
        "address": {"line1": "1 CG Road", "city": "Ahmedabad", "state": "Gujarat",
                    "pincode": "380006", "is_default_shipping": True},
    })
    other_id = other.get(f"{BASE}/auth/me").json()["doctor"]["id"]
    lab.post(f"{BASE}/staff/doctors/{other_id}/verify", json={"approve": True})
    r = other.get(f"{BASE}/orders/{oid}/scan-sources")
    check("another clinic cannot list this patient's scans", r.status_code == 404, r.text)

    # -- an aligner case is untouched by any of it -------------------------
    r = doctor.post(f"{BASE}/orders", json={
        "new_patient": {"full_name": "Rohan Desai"}, "chief_complaint": "Crowding.",
    })
    aligner = r.json()["id"]
    summary = next(o for o in doctor.get(f"{BASE}/orders").json() if o["id"] == aligner)
    check("an order with no product is still an aligner case", summary["kind"] == "ALIGNER")
    check("and carries no product label", summary["product_label"] == "", summary["product_label"])

    upload_records(doctor, aligner)
    doctor.post(f"{BASE}/orders/{aligner}/submit")
    lab.post(f"{BASE}/staff/orders/{aligner}/start-review")
    lab.post(f"{BASE}/staff/orders/{aligner}/quotes", json={"category": "ALIGN_16_20", "tax": "0"})
    doctor.post(f"{BASE}/orders/{aligner}/quote/accept")
    upload_scan(doctor, aligner)
    r = lab.post(f"{BASE}/staff/orders/{aligner}/scan/accept", json={"note": ""})
    check(
        "an aligner case still goes to planning, not fabrication",
        r.json()["status"] == "IN_PLANNING", r.json()["status"],
    )

print()
if failures:
    print(f"{len(failures)} check(s) failed:")
    for f in failures:
        print(f"  - {f}")
    raise SystemExit(1)
print("All checks passed.")
