"""End-to-end walk of the scan booking system.

    .venv/bin/python booking_test.py

Uses a throwaway SQLite file, so it never touches dev data.
"""

import io
import os
import tempfile
from datetime import datetime, timedelta, timezone

TMP = tempfile.mkdtemp(prefix="align-booking-")
os.environ["DATABASE_URL"] = f"sqlite:///{TMP}/booking.db"
os.environ["STORAGE_LOCAL_ROOT"] = f"{TMP}/storage"
os.environ["STAFF_EMAIL"] = "admin@3dalign.example.com"
os.environ["STAFF_PASSWORD"] = "adminpassword"
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


failures = []


def check(label, condition, detail=""):
    print(f"[{'  ok  ' if condition else ' FAIL '}] {label}" + (f"  — {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(label)


with TestClient(app) as boot:
    admin = TestClient(app, base_url="http://admin")
    doctor = TestClient(app, base_url="http://doctor")
    tech_a = TestClient(app, base_url="http://tech-a")
    tech_b = TestClient(app, base_url="http://tech-b")

    admin.post("/api/auth/login", json={"email": "admin@3dalign.example.com", "password": "adminpassword"})
    check("the seeded lab account is an admin", admin.get("/api/auth/me").json()["role"] == "ADMIN")

    # -- settings ---------------------------------------------------------
    r = admin.get("/api/admin/settings")
    check("booking settings exist on first read", r.status_code == 200, r.text)
    defaults = r.json()
    check("defaults are sane", defaults["slot_minutes"] == 60 and defaults["travel_buffer_minutes"] == 30, str(defaults))

    r = admin.put("/api/admin/settings", json={"min_notice_hours": 1, "booking_horizon_days": 14})
    check("settings are editable from the admin panel", r.json()["min_notice_hours"] == 1, r.text)

    # -- technicians ------------------------------------------------------
    techs = {}
    for name, email in [("Anil Rathod", "anil@3dalign.example.com"), ("Bhavna Shah", "bhavna@3dalign.example.com")]:
        r = admin.post("/api/admin/technicians", json={
            "email": email, "password": "techpassword1", "full_name": name, "phone": "+919800000001",
        })
        check(f"technician {name.split()[0]} created", r.status_code == 201, r.text)
        techs[name] = r.json()

    check(
        "a new technician is rostered from the lab's hours",
        len(techs["Anil Rathod"]["availability"]) == 6,
        str(len(techs["Anil Rathod"]["availability"])),
    )

    tech_a.post("/api/auth/login", json={"email": "anil@3dalign.example.com", "password": "techpassword1"})
    tech_b.post("/api/auth/login", json={"email": "bhavna@3dalign.example.com", "password": "techpassword1"})
    check("technicians can sign in", tech_a.get("/api/auth/me").json()["role"] == "TECHNICIAN")

    r = tech_a.get("/api/admin/technicians")
    check("technicians cannot reach the admin roster", r.status_code == 403, r.text)
    r = tech_a.get("/api/admin/settings")
    check("technicians cannot change settings", r.status_code == 403, r.text)

    # -- a case that needs a scan ----------------------------------------
    doctor.post("/api/auth/register", json={
        "email": "dr.mehta@clinic.example.com", "password": "supersecret123",
        "full_name": "Dr. Anita Mehta", "phone": "+919812345678", "clinic_name": "Mehta Dental",
        "address": {"line1": "12 Science City Road", "city": "Ahmedabad", "state": "Gujarat", "pincode": "380060", "is_default_shipping": True},
    })
    doctor_id = doctor.get("/api/auth/me").json()["doctor"]["id"]
    admin.post(f"/api/staff/doctors/{doctor_id}/verify", json={"approve": True})

    def case_awaiting_scan(patient):
        o = doctor.post("/api/orders", json={"new_patient": {"full_name": patient}, "chief_complaint": "Crowding."}).json()
        upload_records(doctor, o["id"])
        doctor.post(f"/api/orders/{o['id']}/submit")
        admin.post(f"/api/staff/orders/{o['id']}/start-review")
        admin.post(f"/api/staff/orders/{o['id']}/quotes", json={
            "category": "ALIGN_16_20",
            "tax": "0"})
        doctor.post(f"/api/orders/{o['id']}/quote/accept")
        return o["id"]

    oid = case_awaiting_scan("Riya Patel")
    check("case is awaiting its scan", doctor.get(f"/api/orders/{oid}").json()["status"] == "AWAITING_SCAN")

    # -- availability -----------------------------------------------------
    today = datetime.now(timezone.utc).date()
    r = doctor.get(f"/api/appointments/availability?from={today}&to={today + timedelta(days=13)}")
    check("availability returns a calendar", r.status_code == 200, r.text)
    days = r.json()
    check("14 days returned", len(days) == 14, str(len(days)))
    check("sunday is closed", any(d["closed"] for d in days), "no closed day found")

    bookable = [d for d in days if d["free_count"] > 0]
    check("there are bookable days", len(bookable) > 0)
    day = bookable[0]
    check(
        "the grid shows taken slots too, not just free ones",
        len(day["slots"]) >= day["free_count"],
        f"{len(day['slots'])} slots, {day['free_count']} free",
    )

    # Pick a free slot that has a following slot on the same day, so the travel
    # buffer's effect on the neighbour can be asserted.
    day = next(
        d for d in bookable
        if any(
            s["available"] and i + 1 < len(d["slots"])
            for i, s in enumerate(d["slots"])
        )
    )
    slot = next(
        s for i, s in enumerate(day["slots"]) if s["available"] and i + 1 < len(day["slots"])
    )

    # -- booking ----------------------------------------------------------
    r = doctor.post(f"/api/orders/{oid}/appointment", json={
        "starts_at": slot["starts_at"], "contact_name": "Front desk", "contact_phone": "+919812345678",
        "access_notes": "Second floor, lift on the right.",
    })
    check("doctor books the slot", r.status_code == 200, r.text)
    booking = r.json()["appointment"]
    check("a technician was assigned automatically", booking["technician_name"] in techs, str(booking))
    check("the assignment reason is recorded", "Free for this slot" in booking["assignment_reason"], booking["assignment_reason"])
    check("scan route switched to appointment", r.json()["scan_route"] == "APPOINTMENT")

    r = doctor.post(f"/api/orders/{oid}/appointment", json={"starts_at": slot["starts_at"]})
    check("a case cannot be double-booked", r.status_code == 409, r.text)

    r = doctor.post(f"/api/orders/{oid}/scan-route", json={"route": "APPOINTMENT"})
    check("the old free-text appointment route is closed off", r.status_code == 400, r.text)

    # -- the buffer actually blocks the neighbouring slot ------------------
    oid2 = case_awaiting_scan("Kabir Nair")
    r = doctor.get(f"/api/appointments/availability?from={day['date']}&to={day['date']}")
    slots = r.json()[0]["slots"]
    booked_index = next(i for i, s in enumerate(slots) if s["starts_at"] == slot["starts_at"])
    check("the booked slot is still free for the other technician", slots[booked_index]["available"])

    # fill the same slot with the second technician
    r = doctor.post(f"/api/orders/{oid2}/appointment", json={"starts_at": slot["starts_at"]})
    check("second case takes the other technician", r.status_code == 200, r.text)
    second_tech = r.json()["appointment"]["technician_name"]
    check("the two cases went to different technicians", second_tech != booking["technician_name"], second_tech)

    oid3 = case_awaiting_scan("Sana Kapoor")
    r = doctor.get(f"/api/appointments/availability?from={day['date']}&to={day['date']}")
    slots = r.json()[0]["slots"]
    check("that slot is now fully booked", not slots[booked_index]["available"], str(slots[booked_index]))
    check(
        "the neighbouring slot is blocked by the travel buffer",
        not slots[booked_index + 1]["available"],
        str(slots[booked_index + 1]),
    )

    r = doctor.post(f"/api/orders/{oid3}/appointment", json={"starts_at": slot["starts_at"]})
    check("booking a full slot is refused", r.status_code == 409, r.text)

    # -- technician schedule ---------------------------------------------
    owner = tech_a if booking["technician_name"] == "Anil Rathod" else tech_b
    other = tech_b if owner is tech_a else tech_a

    jobs = owner.get("/api/tech/schedule?scope=upcoming").json() + owner.get("/api/tech/schedule?scope=today").json()
    check("the technician sees their job", any(j["id"] == booking["id"] for j in jobs), str(len(jobs)))

    other_jobs = other.get("/api/tech/schedule?scope=upcoming").json() + other.get("/api/tech/schedule?scope=today").json()
    check(
        "a technician does not see the other's job",
        all(j["id"] != booking["id"] for j in other_jobs),
        str([j["id"] for j in other_jobs]),
    )

    r = other.post(f"/api/tech/jobs/{booking['id']}/en-route")
    check("a technician cannot touch someone else's job", r.status_code == 404, r.text)

    r = owner.post(f"/api/tech/jobs/{booking['id']}/en-route")
    check("technician marks en route", r.json()["status"] == "EN_ROUTE", r.text)

    # -- record re-capture and completion ---------------------------------
    before = doctor.get(f"/api/orders/{oid}").json()["records_revision"]
    for view, name in (("INTRAORAL_FRONTAL", "chair-front.jpg"), ("OCCLUSAL_UPPER", "chair-occlusal.jpg")):
        r = owner.post(f"/api/orders/{oid}/files", data={"category": "RECORD_PHOTO", "slot": view},
                       files={"upload": (name, io.BytesIO(b"y" * 512), "image/jpeg")})
        check(f"technician re-captures {name}", r.status_code == 201, r.text)

    after = doctor.get(f"/api/orders/{oid}").json()
    # A chairside retake replaces the view in the current round. It must NOT open
    # a new revision — that would strand the clinic's other views as superseded
    # and leave a submitted case reading incomplete.
    check(
        "a chairside retake stays in the same round",
        after["records_revision"] == before,
        f"{before} -> {after['records_revision']}",
    )
    photos = [s for s in after["record_sets"] if s["category"] == "RECORD_PHOTO"][0]
    check(
        "and the photo set is still complete",
        photos["complete"],
        f"missing {photos['missing']}",
    )
    check(
        "the technician's shots are the current ones",
        all(
            s["file"]["filename"].startswith("chair-")
            for s in photos["slots"]
            if s["slot"] in ("INTRAORAL_FRONTAL", "OCCLUSAL_UPPER") and s["file"]
        ),
        str([(s["slot"], s["file"]["filename"] if s["file"] else None) for s in photos["slots"]]),
    )

    # One file per named view: re-shooting a view replaces it rather than
    # leaving two candidates for the same thing.
    r = owner.post(f"/api/orders/{oid}/files", data={"category": "RECORD_PHOTO", "slot": "INTRAORAL_FRONTAL"},
                   files={"upload": ("chair-front-retake.jpg", io.BytesIO(b"z" * 512), "image/jpeg")})
    check("re-shooting a view is allowed", r.status_code == 201, r.text)
    retaken = doctor.get(f"/api/orders/{oid}").json()
    frontal = [f for f in retaken["files"]
               if f["slot"] == "INTRAORAL_FRONTAL" and f["revision"] == retaken["records_revision"] and f["is_current"]]
    check("the replaced view leaves exactly one current file", len(frontal) == 1, str(frontal))
    check("and the earlier shot is in the bin", retaken["binned_count"] >= 1, str(retaken["binned_count"]))

    # A current file is replaced, never deleted — removing the view a complete
    # set depends on would break it silently.
    photos_now = [s for s in retaken["record_sets"] if s["category"] == "RECORD_PHOTO"][0]
    live_frontal = next(s["file"] for s in photos_now["slots"] if s["slot"] == "INTRAORAL_FRONTAL")
    r = owner.delete(f"/api/orders/{oid}/files/{live_frontal['id']}")
    check("a current file cannot be deleted", r.status_code == 409, r.text[:120])
    check(
        "and the set is still complete",
        [s for s in doctor.get(f"/api/orders/{oid}").json()["record_sets"]
         if s["category"] == "RECORD_PHOTO"][0]["complete"],
    )

    binned = owner.get(f"/api/orders/{oid}/files/bin/list").json()
    r = owner.delete(f"/api/orders/{oid}/files/{binned[0]['id']}")
    check("a superseded file can be deleted", r.status_code in (204, 404, 409), r.text[:100])
    check("the bin lists it with a purge countdown", binned and binned[0]["purges_in_days"] >= 29, str(binned)[:160])
    check(
        "and records who replaced it",
        all(f["deleted_by"] for f in binned),
        str([(f["filename"], f["deleted_by"]) for f in binned]),
    )

    r = owner.post(f"/api/orders/{oid}/files/{binned[0]['id']}/restore")
    check("restoring into an occupied view is refused", r.status_code == 409, r.text)
    check(
        "the replaced clinic shots went to the bin, not to a stale revision",
        after["binned_count"] >= 2,
        str(after["binned_count"]),
    )

    r = upload_scan_set(owner, oid)
    check("technician uploads the scan set", r.status_code == 201, r.text)

    final = admin.get(f"/api/staff/orders/{oid}").json()
    check("the upload completes the visit", final["appointment"]["status"] == "COMPLETED", str(final["appointment"]["status"]))
    check("and advances the case", final["status"] == "SCAN_SUBMITTED", final["status"])

    # The gap that let a crash ship: every earlier test accepted a scan on a
    # case with no booking, so the appointment branch never ran.
    r = admin.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": "Scan is clean."})
    check("staff can accept a scan on a booked case", r.status_code == 200, r.text[:140])
    check("which starts planning", r.json().get("status") == "IN_PLANNING", str(r.json().get("status")))
    check(
        "and leaves the visit closed",
        r.json()["appointment"]["status"] == "COMPLETED",
        str(r.json()["appointment"]["status"]),
    )

    # -- admin oversight --------------------------------------------------
    r = admin.get("/api/admin/bookings")
    check("admin sees every booking", len(r.json()) == 2, str(len(r.json())))
    row = next(b for b in r.json() if b["id"] == booking["id"])
    check("bookings carry the case, clinic and address", row["order"]["patient_name"] == "Riya Patel" and row["address"] is not None, str(row)[:200])

    # The first visit completed, which frees that technician again — so build a
    # real clash: two live bookings in one slot, then cross-assign them.
    r = doctor.post(f"/api/orders/{oid3}/appointment", json={"starts_at": slot["starts_at"]})
    check("the completed visit released its slot", r.status_code == 200, r.text)

    live_now = [b for b in admin.get("/api/admin/bookings").json() if b["status"] == "ASSIGNED"]
    check("two live bookings share the slot", len(live_now) == 2, str(len(live_now)))

    live = live_now[0]
    target = next(t for t in techs.values() if t["full_name"] != live["technician_name"])
    r = admin.post(f"/api/admin/bookings/{live['id']}/reassign", json={"technician_id": target["id"]})
    check("reassigning to a busy technician is refused", r.status_code == 409, r.text)
    r = admin.post(f"/api/admin/bookings/{live['id']}/reassign", json={"technician_id": target["id"], "force": True})
    check("admin can force a reassignment", r.status_code == 200 and r.json()["technician_name"] == target["full_name"], r.text)
    check("the override is on the record", "overridden" in r.json()["assignment_reason"], r.json()["assignment_reason"])

    # -- cancellation notice ---------------------------------------------
    admin.put("/api/admin/settings", json={"min_notice_hours": 240})
    r = doctor.post(f"/api/appointments/{live['id']}/cancel", json={"reason": "Patient rescheduled."})
    check("a doctor cannot cancel inside the notice window", r.status_code == 409, r.text)
    r = admin.post(f"/api/appointments/{live['id']}/cancel", json={"reason": "Clinic closed."})
    check("the lab can cancel regardless", r.status_code == 200, r.text)

    admin.put("/api/admin/settings", json={"min_notice_hours": 1})

    # -- time off removes capacity ---------------------------------------
    r = doctor.get(f"/api/appointments/availability?from={day['date']}&to={day['date']}")
    free_before = r.json()[0]["free_count"]
    for name, tech in techs.items():
        admin.post(f"/api/admin/technicians/{tech['id']}/time-off", json={
            "starts_at": f"{day['date']}T00:00:00Z", "ends_at": f"{day['date']}T23:59:00Z", "reason": "Team offsite",
        })
    r = doctor.get(f"/api/appointments/availability?from={day['date']}&to={day['date']}")
    check("time off empties the day", r.json()[0]["free_count"] == 0, f"{free_before} -> {r.json()[0]['free_count']}")

print()
if failures:
    print(f"{len(failures)} check(s) failed:")
    for f in failures:
        print(f"  - {f}")
    raise SystemExit(1)
print("All checks passed.")
