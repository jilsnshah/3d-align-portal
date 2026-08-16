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

BASE_URL = "/api"

REQUIRED_VIEWS = ("INTRAORAL_FRONTAL", "BUCCAL_RIGHT", "BUCCAL_LEFT", "OCCLUSAL_UPPER", "OCCLUSAL_LOWER")


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
    r = staff.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": "Scan is clean."})
    check("staff accepts the scan", r.json()["status"] == "IN_PLANNING", r.text)

    # -- planning ---------------------------------------------------------
    r = staff.post(
        f"/api/staff/orders/{oid}/plans",
        json={"aligners_upper": 18, "aligners_lower": 16, "final_price": "72000", "final_tax": "3000",
              "ipr_required": True, "summary": "IPR at 13-23."},
    )
    check("plan shared", r.json()["status"] == "PLAN_SHARED", r.text)
    shared_plan = r.json()["plans"][-1]
    check(
        "the plan records the real aligner count",
        shared_plan["total_aligners"] == 34,
        str(shared_plan["total_aligners"]),
    )
    check(
        "the lab types the final price directly",
        shared_plan["final_price"] == "72000.00" and shared_plan["final_total"] == "75000.00",
        str((shared_plan["final_price"], shared_plan["final_total"])),
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

    r = doctor.post(f"/api/orders/{oid}/plan/respond", json={"approve": False, "revision_notes": "Reduce IPR."})
    check("revision sends it back to planning", r.json()["status"] == "IN_PLANNING", r.text)

    staff.post(f"/api/staff/orders/{oid}/plans",
               json={"aligners_upper": 18, "aligners_lower": 16, "final_price": "72000", "final_tax": "3000"})
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
    # Phases chain: each starts where the last accepted one ended, and the next
    # cannot ship until the clinic has received the previous and said carry on.
    total = staff.get(f"/api/staff/orders/{oid}").json()["total_aligners"]
    check("the plan's aligner count drives the phases", total == 34, str(total))

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

    r = ship_phase(8)
    check("phase 1 ships", r.status_code == 200, r.text[:120])
    phase1 = [s for s in r.json()["shipments"] if s["shipment_type"] == "ALIGNER_PHASE"][-1]
    check("it starts at aligner 1 without being told", phase1["aligner_range_from"] == 1, str(phase1))

    check("the next phase is blocked until the clinic receives this one", ship_phase(20).status_code == 409)
    doctor.post(f"/api/orders/{oid}/shipments/{phase1['id']}/delivered")
    check("and still blocked until the clinic decides", ship_phase(20).status_code == 409)

    # A remake keeps the phase number and advances its round, exactly like the
    # training aligner — and sends the case back to the bench first.
    r = doctor.post(
        f"/api/orders/{oid}/shipments/{phase1['id']}/phase-decision",
        json={"decision": "REPEAT", "notes": "Trays 3-4 warped."},
    )
    check("a remake reopens production", r.json()["status"] == "ALIGNER_PRODUCTION", r.json()["status"])
    check(
        "and the next batch is phase 1 round 2",
        (r.json()["next_phase_number"], r.json()["next_phase_round"]) == (1, 2),
        str((r.json()["next_phase_number"], r.json()["next_phase_round"])),
    )
    r = ship_phase(8)
    redo = [s for s in r.json()["shipments"] if s["shipment_type"] == "ALIGNER_PHASE"][-1]
    check(
        "which ships as phase 1 round 2 over the same aligners",
        (redo["phase_number"], redo["phase_round"], redo["aligner_range_from"], redo["aligner_range_to"])
        == (1, 2, 1, 8),
        str(redo),
    )
    doctor.post(f"/api/orders/{oid}/shipments/{redo['id']}/delivered")

    r = doctor.post(
        f"/api/orders/{oid}/shipments/{redo['id']}/phase-decision", json={"decision": "CONTINUE"}
    )
    check("the clinic asks for the next phase", r.status_code == 200, r.text[:120])
    check("which now starts at aligner 9", r.json()["next_phase_from"] == 9, str(r.json()["next_phase_from"]))

    r = ship_phase(20)
    phase2 = [s for s in r.json()["shipments"] if s["shipment_type"] == "ALIGNER_PHASE"][-1]
    check("phase 2 runs 9–20", (phase2["aligner_range_from"], phase2["aligner_range_to"]) == (9, 20), str(phase2))
    doctor.post(f"/api/orders/{oid}/shipments/{phase2['id']}/delivered")
    doctor.post(f"/api/orders/{oid}/shipments/{phase2['id']}/phase-decision", json={"decision": "CONTINUE"})

    check("a phase cannot run past the plan", ship_phase(40).status_code == 400)
    r = ship_phase(34)
    phase3 = [s for s in r.json()["shipments"] if s["shipment_type"] == "ALIGNER_PHASE"][-1]
    check("the final phase runs 21–34", (phase3["aligner_range_from"], phase3["aligner_range_to"]) == (21, 34), str(phase3))
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
    r = doctor.post(
        f"/api/orders/{oid}/shipments/{phase3['id']}/phase-decision", json={"decision": "CONTINUE"}
    )
    check("accepting the final phase completes the case", r.json()["status"] == "COMPLETED", r.json()["status"])
    detail = staff.get(f"/api/staff/orders/{oid}").json()
    check("every batch is on the record", len(detail["shipments"]) == 6, str(len(detail["shipments"])))

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
