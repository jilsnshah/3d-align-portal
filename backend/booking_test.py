"""End-to-end walk of the scan booking system.

    .venv/bin/python booking_test.py

Uses a throwaway SQLite file, so it never touches dev data.
"""

import io
import os
import tempfile
from datetime import datetime, timedelta, timezone

TMP = tempfile.mkdtemp(prefix="align-booking-")
# TEST_DATABASE_URL runs the same walk against Postgres, which is what a
# deployment uses. SQLite by default so the suite needs no server.
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", f"sqlite:///{TMP}/booking.db"
)
os.environ["STORAGE_LOCAL_ROOT"] = f"{TMP}/storage"
os.environ["STAFF_EMAIL"] = "admin@3dalign.example.com"
os.environ["STAFF_PASSWORD"] = "adminpassword"
os.environ["DCI_CHECK_ENABLED"] = "false"
# Never let a test bill the live Maps account or depend on a network round trip.
# Routing behaviour is exercised against stub providers instead.
os.environ["GOOGLE_MAPS_API_KEY"] = ""
os.environ["GOOGLE_MAPS_BROWSER_KEY"] = ""

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

    # The lab's point is where every technician's day starts and ends. Typing a
    # new address used to move the words and leave the coordinates behind, so
    # every route was costed from a building the lab had left.
    before = admin.get("/api/admin/settings").json()
    r = admin.put(
        "/api/admin/settings",
        json={"lab_address": "Prahladnagar Garden Road, Ahmedabad 380015", "service_city": "Ahmedabad"},
    )
    check("the lab address can be changed", r.status_code == 200, r.text[:160])
    moved = r.json()
    check(
        "and the coordinates follow it rather than staying put",
        (moved["lab_latitude"], moved["lab_longitude"])
        != (before["lab_latitude"], before["lab_longitude"]),
        f"{before['lab_latitude']},{before['lab_longitude']} -> "
        f"{moved['lab_latitude']},{moved['lab_longitude']}",
    )
    check(
        "and land where that address actually is",
        (moved["lab_latitude"], moved["lab_longitude"]) == (23.005, 72.507),
        f"{moved['lab_latitude']},{moved['lab_longitude']}",
    )
    check(
        "with the accuracy on the record, so a coarse point reads as coarse",
        moved["lab_geocode_source"] == "pincode",
        moved["lab_geocode_source"],
    )

    r = admin.put(
        "/api/admin/settings",
        json={"lab_address": "Somewhere entirely", "lab_latitude": 23.0301, "lab_longitude": 72.5100},
    )
    check(
        "a pin the lab drops itself wins over the lookup",
        (r.json()["lab_latitude"], r.json()["lab_longitude"]) == (23.0301, 72.51)
        and r.json()["lab_geocode_source"] == "picked",
        r.text[:200],
    )

    r = admin.put("/api/admin/settings", json={"lab_address": "qqqqzzzz nowhere at all"})
    check(
        "an address that cannot be placed is refused rather than silently kept",
        r.status_code == 400,
        f"{r.status_code} {r.text[:140]}",
    )
    kept = admin.get("/api/admin/settings").json()
    check(
        "and the previous point is left untouched",
        (kept["lab_latitude"], kept["lab_longitude"]) == (23.0301, 72.51),
        f"{kept['lab_latitude']},{kept['lab_longitude']}",
    )
    # Put it back so the routing assertions below run from the usual origin.
    admin.put(
        "/api/admin/settings",
        json={
            "lab_address": before["lab_address"],
            "lab_latitude": before["lab_latitude"],
            "lab_longitude": before["lab_longitude"],
        },
    )

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

    # The month view is the cheap one: which days are worth clicking, with no
    # travel lookups at all.
    r = doctor.get(f"/api/appointments/availability?from={today}&to={today + timedelta(days=13)}")
    check("availability returns a calendar", r.status_code == 200, r.text)
    days = r.json()
    check("14 days returned", len(days) == 14, str(len(days)))
    check("sunday is closed", any(d["closed"] for d in days), "no closed day found")
    check(
        "the month view carries capacity but not times",
        all(d["slots"] == [] for d in days) and any(d["technicians_free"] > 0 for d in days),
        str([(d["date"], d["technicians_free"], len(d["slots"])) for d in days[:3]]),
    )
    check(
        "a week of detail is the most that can be asked for at once",
        doctor.get(
            f"/api/appointments/availability?from={today}"
            f"&to={today + timedelta(days=13)}&detail=true"
        ).status_code
        == 400,
    )

    open_days = [d for d in days if d["technicians_free"] > 0]
    check("there are days with capacity", len(open_days) > 0)

    # Exact times are fetched only for a chosen day.
    def slots_on(date_str):
        return doctor.get(
            f"/api/appointments/availability?from={date_str}&to={date_str}&detail=true"
        ).json()[0]

    day = None
    for candidate in open_days:
        detail = slots_on(candidate["date"])
        if any(s["available"] for s in detail["slots"]):
            day = detail
            break
    check("a chosen day returns real times", day is not None)
    check(
        "the grid shows taken slots too, not just free ones",
        len(day["slots"]) >= day["free_count"],
        f"{len(day['slots'])} slots, {day['free_count']} free",
    )

    # Pick a free slot that has a following slot on the same day, so the travel
    # buffer's effect on the neighbour can be asserted.
    slot = next(
        s for i, s in enumerate(day["slots"]) if s["available"] and i + 1 < len(day["slots"])
    )
    bookable = [day]

    # -- booking ----------------------------------------------------------
    r = doctor.post(f"/api/orders/{oid}/appointment", json={
        "starts_at": slot["starts_at"], "contact_name": "Front desk", "contact_phone": "+919812345678",
        "access_notes": "Second floor, lift on the right.",
    })
    check("doctor books the slot", r.status_code == 200, r.text)
    booking = r.json()["appointment"]
    check("a technician was assigned automatically", booking["technician_name"] in techs, str(booking))
    check(
        "the assignment reason explains the routing",
        "away from the previous stop" in booking["assignment_reason"],
        booking["assignment_reason"],
    )
    check("scan route switched to appointment", r.json()["scan_route"] == "APPOINTMENT")

    r = doctor.post(f"/api/orders/{oid}/appointment", json={"starts_at": slot["starts_at"]})
    check("a case cannot be double-booked", r.status_code == 409, r.text)

    r = doctor.post(f"/api/orders/{oid}/scan-route", json={"route": "APPOINTMENT"})
    check("the old free-text appointment route is closed off", r.status_code == 400, r.text)

    # -- the buffer actually blocks the neighbouring slot ------------------
    oid2 = case_awaiting_scan("Kabir Nair")
    r = doctor.get(f"/api/appointments/availability?from={day['date']}&to={day['date']}&detail=true")
    slots = r.json()[0]["slots"]
    booked_index = next(i for i, s in enumerate(slots) if s["starts_at"] == slot["starts_at"])
    check("the booked slot is still free for the other technician", slots[booked_index]["available"])

    # fill the same slot with the second technician
    r = doctor.post(f"/api/orders/{oid2}/appointment", json={"starts_at": slot["starts_at"]})
    check("second case takes the other technician", r.status_code == 200, r.text)
    second_tech = r.json()["appointment"]["technician_name"]
    check("the two cases went to different technicians", second_tech != booking["technician_name"], second_tech)

    oid3 = case_awaiting_scan("Sana Kapoor")
    r = doctor.get(f"/api/appointments/availability?from={day['date']}&to={day['date']}&detail=true")
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

    # -- a cancelled visit must genuinely release everything ---------------
    # The dangerous failure is a cancellation that looks fine but leaves the
    # technician's calendar blocked, or the case unable to book again.
    cancelled = admin.get("/api/admin/bookings").json()
    dead = next(b for b in cancelled if b["status"] == "CANCELLED")
    check(
        "a cancelled visit is no longer live",
        dead["status"] == "CANCELLED",
        dead["status"],
    )
    r = doctor.post(f"/api/appointments/{dead['id']}/cancel", json={"reason": "again"})
    check("cancelling twice is refused", r.status_code == 409, r.text)

    freed_order = dead["order"]["id"] if isinstance(dead.get("order"), dict) else None
    if freed_order:
        r = doctor.get(f"/api/orders/{freed_order}")
        check(
            "the case goes back to awaiting its scan",
            r.json()["status"] == "AWAITING_SCAN",
            r.json()["status"],
        )
        day_of = dead["starts_at"][:10]
        detail = doctor.get(
            f"/api/appointments/availability?from={day_of}&to={day_of}&detail=true"
        ).json()[0]
        free_slot = next((s for s in detail["slots"] if s["available"]), None)
        check("the cancelled day still offers times", free_slot is not None)
        if free_slot:
            r = doctor.post(
                f"/api/orders/{freed_order}/appointment",
                json={"starts_at": free_slot["starts_at"]},
            )
            check("the case can be booked again after cancelling", r.status_code == 200, r.text[:120])
            rebooked = r.json()["appointment"]
            r = admin.post(
                f"/api/appointments/{rebooked['id']}/cancel", json={"reason": "tidy up"}
            )
            check("the replacement can be cancelled too", r.status_code == 200, r.text[:80])

    # -- a technician who could not scan also releases the slot ------------
    r = doctor.post(f"/api/orders/{oid3}/appointment", json={"starts_at": slot["starts_at"]})
    if r.status_code == 200:
        job = r.json()["appointment"]
        owner = next(t for t in techs.values() if t["full_name"] == job["technician_name"])
        session = tech_a if owner["full_name"] == techs["Anil Rathod"]["full_name"] else tech_b
        r = session.post(f"/api/tech/jobs/{job['id']}/no-show", json={"note": "Clinic shut."})
        if r.status_code == 200:
            check("could-not-scan closes the visit", r.json()["status"] == "NO_SHOW", r.text[:80])
            r = doctor.get(f"/api/orders/{oid3}")
            check(
                "the case is bookable again after a no-show",
                r.json()["status"] == "AWAITING_SCAN"
                and not any(a.get("is_live") for a in [r.json().get("appointment") or {}]),
                r.json()["status"],
            )


    # -- a technician asking the lab to hand a visit over -------------------
    # The handover reuses the ordinary reassignment path, so this checks the
    # request queue and the three ways out of it.
    live_jobs = [b for b in admin.get("/api/admin/bookings").json() if b["status"] == "ASSIGNED"]
    check("there is a live visit to hand over", len(live_jobs) > 0, str(len(live_jobs)))
    if live_jobs:
        job = live_jobs[0]
        owner = job["technician_name"]
        session = tech_a if owner == techs["Anil Rathod"]["full_name"] else tech_b

        r = session.post(
            f"/api/tech/jobs/{job['id']}/reassign-request",
            json={"reason": "Car broke down on the ring road."},
        )
        check("a technician can ask the lab to reassign", r.status_code == 200, r.text[:120])
        request_id = r.json()["id"]
        check("the request starts pending", r.json()["status"] == "PENDING", r.json()["status"])

        r = session.post(
            f"/api/tech/jobs/{job['id']}/reassign-request", json={"reason": "asking twice"}
        )
        check("the same visit cannot be queued twice", r.status_code == 409, r.text[:80])

        check(
            "the lab sees it in the queue",
            any(x["id"] == request_id for x in admin.get("/api/admin/reassignments").json()),
        )

        # A technician cannot touch somebody else's visit.
        other = tech_b if session is tech_a else tech_a
        r = other.post(
            f"/api/tech/jobs/{job['id']}/reassign-request", json={"reason": "not mine"}
        )
        check("a technician cannot hand over a visit that is not theirs", r.status_code == 404, r.text[:80])

        # Decline leaves it exactly where it was.
        r = admin.post(
            f"/api/admin/reassignments/{request_id}/resolve",
            json={"action": "DECLINE", "note": "No cover today."},
        )
        check("the lab can decline the request", r.status_code == 200, r.text[:100])
        check("declining marks it declined", r.json()["status"] == "DECLINED", r.json()["status"])
        after = [b for b in admin.get("/api/admin/bookings").json() if b["id"] == job["id"]][0]
        check("a declined request leaves the visit alone", after["technician_name"] == owner, after["technician_name"])
        r = admin.post(
            f"/api/admin/reassignments/{request_id}/resolve", json={"action": "ANY"}
        )
        check("a resolved request cannot be resolved again", r.status_code == 409, r.text[:80])

        # Now actually hand it over, by name.
        r = session.post(
            f"/api/tech/jobs/{job['id']}/reassign-request", json={"reason": "Still stuck."}
        )
        second = r.json()["id"]
        target = next(t for t in techs.values() if t["full_name"] != owner)
        r = admin.post(
            f"/api/admin/reassignments/{second}/resolve",
            json={"action": "TECHNICIAN", "technician_id": target["id"], "force": True},
        )
        check("the lab can name the replacement", r.status_code == 200, r.text[:120])
        moved = [b for b in admin.get("/api/admin/bookings").json() if b["id"] == job["id"]][0]
        check(
            "the visit moved to the named technician",
            moved["technician_name"] == target["full_name"],
            moved["technician_name"],
        )
        check(
            "the handover is on the record",
            "Reassigned by the lab" in moved["assignment_reason"],
            moved["assignment_reason"],
        )

        # When nobody else can take it, the refusal must fit the situation. The
        # booking-time wording ("the nearest time that works is 16:34") is advice
        # the lab cannot act on here — the visit's time is fixed.
        r = other.post(
            f"/api/tech/jobs/{job['id']}/reassign-request", json={"reason": "Cannot make it."}
        )
        if r.status_code == 200:
            stuck = r.json()["id"]
            holder = target["full_name"]
            for name, tech in techs.items():
                if name != holder:
                    admin.post(
                        f"/api/admin/technicians/{tech['id']}/time-off",
                        json={
                            "starts_at": f"{job['starts_at'][:10]}T00:00:00Z",
                            "ends_at": f"{job['starts_at'][:10]}T23:59:00Z",
                            "reason": "Leave",
                        },
                    )
            r = admin.post(f"/api/admin/reassignments/{stuck}/resolve", json={"action": "ANY"})
            check(
                "handing over to nobody is refused",
                r.status_code == 409,
                r.text[:100],
            )
            detail = r.json().get("detail", "")
            check(
                "the refusal names who is holding it",
                holder in detail,
                detail,
            )
            check(
                "the refusal does not offer a time the lab cannot book",
                "nearest time that works" not in detail,
                detail,
            )

    # -- a clinic outside the service city takes a whole day ---------------
    # The drive there and back leaves no room for anything else, so the visit
    # has to occupy the shift rather than a slot inside it.
    admin.put("/api/admin/settings", json={"day_visit_over_km": 45})
    far = admin.get("/api/admin/settings").json()
    check("the day-visit threshold is configurable", far["day_visit_over_km"] == 45, str(far))

    r = doctor.post(
        "/api/addresses",
        json={
            "label": "Vadodara branch",
            "line1": "Alkapuri",
            "city": "Vadodara",
            "state": "Gujarat",
            "pincode": "390007",
            "country": "India",
            "latitude": 22.3072,
            "longitude": 73.1812,
            "is_default_shipping": False,
        },
    )
    if r.status_code == 201:
        distant = r.json()["id"]
        check("a clinic 100 km out still resolves", r.json()["latitude"] is not None, r.text[:80])

        far_day = None
        for candidate in days:
            detail = doctor.get(
                f"/api/appointments/availability?from={candidate['date']}"
                f"&to={candidate['date']}&detail=true&address_id={distant}"
            ).json()[0]
            if detail["slots"] and detail["slots"][0]["available"]:
                far_day = detail
                break

        check("a distant clinic is offered a day", far_day is not None)
        if far_day:
            only = far_day["slots"]
            check(
                "it is offered as one whole day, not a list of times",
                len(only) == 1,
                f"{len(only)} slots offered",
            )
            span = (
                datetime.fromisoformat(only[0]["ends_at"].replace("Z", "+00:00"))
                - datetime.fromisoformat(only[0]["starts_at"].replace("Z", "+00:00"))
            ).total_seconds() / 3600
            check("the offer spans the shift", span >= 4, f"{span:.1f} hours")

            # oid3 may already hold a live visit from the earlier flows, so the
            # day visit gets its own case rather than skipping silently.
            fresh = doctor.post(
                "/api/orders",
                json={
                    "new_patient": {"full_name": "Vadodara Patient", "sex": "F"},
                    "arch": "BOTH",
                    "priority": "STANDARD",
                    "chief_complaint": "Crowding.",
                },
            ).json()["id"]
            upload_records(doctor, fresh)
            doctor.post(f"/api/orders/{fresh}/submit")
            admin.post(f"/api/staff/orders/{fresh}/start-review")
            admin.post(
                f"/api/staff/orders/{fresh}/quotes",
                json={"category": "ALIGN_16_20", "tax": "0"},
            )
            doctor.post(f"/api/orders/{fresh}/quote/accept")

            r = doctor.post(
                f"/api/orders/{fresh}/appointment",
                json={"starts_at": only[0]["starts_at"], "address_id": distant},
            )
            check("an out-of-city visit can be booked", r.status_code == 200, r.text[:140])
            if r.status_code == 200:
                visit = r.json()["appointment"]
                check("an out-of-city visit is marked as a day visit", visit["is_day_visit"], str(visit)[:120])
                check(
                    "the reason says the technician is out for the day",
                    "whole day" in visit["assignment_reason"],
                    visit["assignment_reason"],
                )
                booked = (
                    datetime.fromisoformat(visit["ends_at"].replace("Z", "+00:00"))
                    - datetime.fromisoformat(visit["starts_at"].replace("Z", "+00:00"))
                ).total_seconds() / 3600
                check("the appointment occupies the shift", booked >= 4, f"{booked:.1f} hours")

                # That technician must be gone from the ordinary pool.
                same = [
                    b
                    for b in admin.get("/api/admin/bookings").json()
                    if b["id"] == visit["id"]
                ]
                check("the day visit shows in the lab's calendar", len(same) == 1)

    # -- time off removes capacity ---------------------------------------
    r = doctor.get(f"/api/appointments/availability?from={day['date']}&to={day['date']}&detail=true")
    free_before = r.json()[0]["free_count"]
    for name, tech in techs.items():
        admin.post(f"/api/admin/technicians/{tech['id']}/time-off", json={
            "starts_at": f"{day['date']}T00:00:00Z", "ends_at": f"{day['date']}T23:59:00Z", "reason": "Team offsite",
        })
    r = doctor.get(f"/api/appointments/availability?from={day['date']}&to={day['date']}&detail=true")
    check("time off empties the day", r.json()[0]["free_count"] == 0, f"{free_before} -> {r.json()[0]['free_count']}")

    # ---------------------------------------------------------------------
    # Leave: asking, approving, and covering what it takes away
    # ---------------------------------------------------------------------
    def book_a_visit(patient):
        """A fresh case with a visit on the books, on whatever day still has
        room after everything above."""
        case = case_awaiting_scan(patient)
        horizon = doctor.get(
            f"/api/appointments/availability?from={today}&to={today + timedelta(days=13)}"
        ).json()
        # Latest day first: the earlier ones are congested by everything above,
        # and this needs a day where a colleague is genuinely free to take over.
        for candidate in reversed([d for d in horizon if d["technicians_free"] > 0]):
            detail = slots_on(candidate["date"])
            free = [x for x in detail["slots"] if x["available"]]
            if not free:
                continue
            r = doctor.post(f"/api/orders/{case}/appointment", json={
                "starts_at": free[0]["starts_at"],
                "contact_name": "Front desk",
                "contact_phone": "+919812345678",
            })
            if r.status_code == 200:
                return case
        raise AssertionError("no bookable slot left for the leave tests")

    # Clear the blanket time off the previous block added, or nothing is free.
    for row in admin.get("/api/admin/technicians").json():
        for off in row.get("time_off", []):
            admin.delete(f"/api/admin/time-off/{off['id']}")

    oid = book_a_visit("Leave Patient One")
    booking = admin.get("/api/admin/bookings").json()
    visit = next(b for b in booking if b["order"]["id"] == oid)
    holder = visit["technician_name"]
    starts = visit["starts_at"]
    day_of = starts[:10]

    tech = tech_a if holder == "Anil Rathod" else tech_b
    other = tech_b if tech is tech_a else tech_a

    # Asking is not the same as being off: the diary must not close on a
    # request, or a technician could strand their own visits by asking.
    r = tech.post("/api/tech/leave", json={
        "starts_at": f"{day_of}T00:00:00Z", "ends_at": f"{day_of}T23:59:00Z", "reason": "Family",
    })
    check("a technician can ask for leave", r.status_code == 201, r.text[:140])
    leave_id = r.json()["id"]
    check("which starts out pending", r.json()["status"] == "PENDING", r.json()["status"])
    check(
        "and says how many visits it would affect",
        r.json()["affected_visits"] >= 1,
        str(r.json()["affected_visits"]),
    )
    r = doctor.get(f"/api/appointments/availability?from={day_of}&to={day_of}&detail=true")
    check(
        "a pending request does not close the diary",
        r.status_code == 200 and r.json() and r.json()[0]["free_count"] > 0,
        r.text[:160],
    )

    r = admin.get("/api/admin/leave?pending_only=true")
    check("the lab sees it in the queue", any(x["id"] == leave_id for x in r.json()), r.text[:140])

    r = admin.post(f"/api/admin/leave/{leave_id}/decide", json={"approve": True})
    check("the lab can approve it", r.status_code == 200, r.text[:160])
    check("which records it as approved", r.json()["leave"]["status"] == "APPROVED", r.text[:140])
    moved = r.json()["covered"]
    stranded = r.json()["stranded"]
    check(
        "and the booked visit is handed to somebody else",
        len(moved) == 1 and moved[0]["technician_name"] != holder,
        str(moved) + str(stranded),
    )
    check("with nothing stranded while a colleague is free", stranded == [], str(stranded))

    after = admin.get("/api/admin/bookings").json()
    moved_visit = next(b for b in after if b["order"]["id"] == oid)
    check(
        "the visit keeps its slot — only the person changed",
        moved_visit["starts_at"] == starts and moved_visit["technician_name"] != holder,
        f"{moved_visit['starts_at']} {moved_visit['technician_name']}",
    )
    check("and is not flagged for the lab", moved_visit["needs_attention"] is False, str(moved_visit))

    r = admin.post(f"/api/admin/leave/{leave_id}/decide", json={"approve": True})
    check("a request cannot be answered twice", r.status_code == 409, r.text[:120])

    # Now the one nobody can cover: the colleague who took it goes off too.
    r = other.post("/api/tech/leave", json={
        "starts_at": f"{day_of}T00:00:00Z", "ends_at": f"{day_of}T23:59:00Z", "reason": "Also away",
    })
    second = r.json()["id"]
    r = admin.post(f"/api/admin/leave/{second}/decide", json={"approve": True})
    check("approving the second leave strands the visit", len(r.json()["stranded"]) == 1, r.text[:200])
    check("and nothing is silently moved", r.json()["covered"] == [], str(r.json()["covered"]))

    r = admin.get("/api/admin/bookings/attention")
    check("which puts it in front of the lab", len(r.json()) == 1, r.text[:200])
    stranded_id = r.json()[0]["id"]
    check(
        "with the reason it could not be covered",
        bool(r.json()[0]["attention_reason"]),
        r.json()[0]["attention_reason"],
    )

    # The lab can leave it standing.
    r = admin.post(f"/api/admin/bookings/{stranded_id}/attention", json={
        "action": "IGNORE", "note": "Anil will go anyway.",
    })
    check("the lab can let it stand", r.status_code == 200, r.text[:140])
    check("which clears the flag", r.json()["needs_attention"] is False, str(r.json()["needs_attention"]))
    check(
        "and the visit is still live",
        r.json()["status"] != "CANCELLED",
        r.json()["status"],
    )
    check("with the queue emptied", admin.get("/api/admin/bookings/attention").json() == [], "")

    r = admin.post(f"/api/admin/bookings/{stranded_id}/attention", json={"action": "IGNORE"})
    check("a settled visit cannot be settled again", r.status_code == 409, r.text[:120])

    # Or ask the clinic for another slot, which cancels this one.
    third = book_a_visit("Leave Patient Two")
    after = admin.get("/api/admin/bookings").json()
    third_visit = next(b for b in after if b["order"]["id"] == third)
    holder3 = third_visit["technician_name"]
    day3 = third_visit["starts_at"][:10]
    # Both away, so there is genuinely nobody to hand it to.
    for who in (tech_a, tech_b):
        r = who.post("/api/tech/leave", json={
            "starts_at": f"{day3}T00:00:00Z", "ends_at": f"{day3}T23:59:00Z", "reason": "Away",
        })
        admin.post(f"/api/admin/leave/{r.json()['id']}/decide", json={"approve": True})
    pending = admin.get("/api/admin/bookings/attention").json()
    check("a second stranding reaches the lab too", len(pending) >= 1, str(len(pending)))
    target = next(b for b in pending if b["order"]["id"] == third)
    r = admin.post(f"/api/admin/bookings/{target['id']}/attention", json={
        "action": "RESCHEDULE", "note": "Nobody free that day.",
    })
    check("the lab can ask the clinic for another slot", r.status_code == 200, r.text[:140])
    check("which cancels the visit", r.json()["status"] == "CANCELLED", r.json()["status"])
    check(
        "and says why on the booking",
        "Nobody free" in r.json()["cancel_reason"],
        r.json()["cancel_reason"],
    )
    check(
        "so the case can be booked again",
        doctor.get(f"/api/orders/{third}").json()["status"] == "AWAITING_SCAN",
        doctor.get(f"/api/orders/{third}").json()["status"],
    )

    # Declining changes nothing.
    r = tech_a.post("/api/tech/leave", json={
        "starts_at": f"{day_of}T09:00:00Z", "ends_at": f"{day_of}T10:00:00Z", "reason": "Errand",
    })
    r = admin.post(f"/api/admin/leave/{r.json()['id']}/decide", json={
        "approve": False, "note": "Too short notice.",
    })
    check("the lab can decline leave", r.json()["leave"]["status"] == "DECLINED", r.text[:140])
    check("and nothing is moved by a declined request", r.json()["covered"] == [], str(r.json()["covered"]))

print()
if failures:
    print(f"{len(failures)} check(s) failed:")
    for f in failures:
        print(f"  - {f}")
    raise SystemExit(1)
print("All checks passed.")
