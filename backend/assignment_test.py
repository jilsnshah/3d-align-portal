"""Case assignment, and what an orthodontist can and cannot see.

An orthodontist works the same tools as the lab office — settings, bookings,
technicians, the case screens — but only on the cases assigned to them. That
makes this mostly a test about *absence*: the cases they must not find, the
actions they must not be able to take on someone else's case, and the fact that
knowing an id is not enough to reach one.

    .venv/bin/python assignment_test.py
"""

import io
import os
import tempfile

TMP = tempfile.mkdtemp(prefix="align-assign-")
os.environ["DATABASE_URL"] = f"sqlite:///{TMP}/assign.db"
os.environ["STORAGE_LOCAL_ROOT"] = f"{TMP}/storage"
os.environ["STAFF_EMAIL"] = "admin@3dalign.example.com"
os.environ["STAFF_PASSWORD"] = "adminpassword"
os.environ["DCI_CHECK_ENABLED"] = "false"
os.environ["GOOGLE_MAPS_API_KEY"] = ""
os.environ["GOOGLE_MAPS_BROWSER_KEY"] = ""

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

REQUIRED_VIEWS = [
    "INTRAORAL_FRONTAL",
    "BUCCAL_RIGHT",
    "BUCCAL_LEFT",
    "OCCLUSAL_UPPER",
    "OCCLUSAL_LOWER",
]
SCAN_SET = [("UPPER_ARCH", "upper.stl"), ("LOWER_ARCH", "lower.stl"), ("BITE", "bite.stl")]

failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"[  ok  ] {label}")
    else:
        print(f"[ FAIL ] {label}" + (f"  — {detail}" if detail else ""))
        failures.append(label)


def upload_records(session, order_id):
    for view in REQUIRED_VIEWS:
        session.post(
            f"/api/orders/{order_id}/files",
            data={"category": "RECORD_PHOTO", "slot": view},
            files={"upload": (f"{view.lower()}.jpg", io.BytesIO(b"x" * 600), "image/jpeg")},
        )
    session.post(
        f"/api/orders/{order_id}/files",
        data={"category": "OPG", "slot": ""},
        files={"upload": ("opg.jpg", io.BytesIO(b"x" * 600), "image/jpeg")},
    )


def upload_scan_set(session, order_id):
    for slot, name in SCAN_SET:
        session.post(
            f"/api/orders/{order_id}/files",
            data={"category": "INTRAORAL_SCAN", "slot": slot},
            files={"upload": (name, io.BytesIO(b"0" * 900), "application/octet-stream")},
        )


with TestClient(app) as boot:
    admin = TestClient(app, base_url="http://admin")
    ortho_a = TestClient(app, base_url="http://ortho-a")
    ortho_b = TestClient(app, base_url="http://ortho-b")
    doctor = TestClient(app, base_url="http://doctor")
    tech = TestClient(app, base_url="http://tech")

    admin.post(
        "/api/auth/login",
        json={"email": "admin@3dalign.example.com", "password": "adminpassword"},
    )

    # -- creating orthodontist accounts -----------------------------------
    r = admin.post(
        "/api/staff/orthodontists",
        json={
            "email": "ortho.a@3dalign.example.com",
            "password": "orthopassword1",
            "full_name": "Dr. Kavita Rao",
        },
    )
    check("the lab can create an orthodontist account", r.status_code == 201, r.text[:160])
    ortho_a_id = r.json()["id"]

    r = admin.post(
        "/api/staff/orthodontists",
        json={
            "email": "ortho.b@3dalign.example.com",
            "password": "orthopassword1",
            "full_name": "Dr. Sameer Joshi",
        },
    )
    ortho_b_id = r.json()["id"]

    r = admin.post(
        "/api/staff/orthodontists",
        json={
            "email": "ortho.a@3dalign.example.com",
            "password": "orthopassword1",
            "full_name": "Duplicate",
        },
    )
    check("an email cannot be taken twice", r.status_code == 409, r.text[:120])

    ortho_a.post(
        "/api/auth/login",
        json={"email": "ortho.a@3dalign.example.com", "password": "orthopassword1"},
    )
    ortho_b.post(
        "/api/auth/login",
        json={"email": "ortho.b@3dalign.example.com", "password": "orthopassword1"},
    )
    check(
        "an orthodontist signs in with their own role",
        ortho_a.get("/api/auth/me").json()["role"] == "ORTHODONTIST",
        ortho_a.get("/api/auth/me").text[:120],
    )

    # -- a couple of cases -------------------------------------------------
    doctor.post(
        "/api/auth/register",
        json={
            "email": "dr.mehta@clinic.example.com",
            "password": "supersecret123",
            "full_name": "Dr. Anita Mehta",
            "phone": "+919812345678",
            "clinic_name": "Mehta Dental",
            "address": {
                "line1": "12 Science City Road",
                "city": "Ahmedabad",
                "state": "Gujarat",
                "pincode": "380060",
                "is_default_shipping": True,
            },
        },
    )
    doctor_id = doctor.get("/api/auth/me").json()["doctor"]["id"]
    admin.post(f"/api/staff/doctors/{doctor_id}/verify", json={"approve": True})

    def case_in_planning(patient):
        o = doctor.post(
            "/api/orders",
            json={"new_patient": {"full_name": patient}, "chief_complaint": "Crowding."},
        ).json()
        upload_records(doctor, o["id"])
        doctor.post(f"/api/orders/{o['id']}/submit")
        admin.post(f"/api/staff/orders/{o['id']}/start-review")
        admin.post(
            f"/api/staff/orders/{o['id']}/quotes",
            json={"category": "ALIGN_16_20", "tax": "0"},
        )
        doctor.post(f"/api/orders/{o['id']}/quote/accept")
        upload_scan_set(doctor, o["id"])
        admin.post(f"/api/staff/orders/{o['id']}/scan/accept", json={"note": ""})
        return o["id"]

    case_a = case_in_planning("Riya Patel")
    case_b = case_in_planning("Arjun Rao")
    early = doctor.post(
        "/api/orders",
        json={"new_patient": {"full_name": "Early Draft"}, "chief_complaint": "Spacing."},
    ).json()["id"]

    check(
        "a case reaches planning unassigned",
        admin.get(f"/api/staff/orders/{case_a}").json()["assigned_to_id"] is None,
        admin.get(f"/api/staff/orders/{case_a}").text[:140],
    )

    # -- before assignment: an orthodontist sees nothing -------------------
    r = ortho_a.get("/api/staff/orders")
    check("an orthodontist starts with an empty case list", r.json() == [], r.text[:160])
    r = ortho_a.get(f"/api/staff/orders/{case_a}")
    check(
        "and cannot open an unassigned case even knowing its id",
        r.status_code == 404,
        f"{r.status_code} {r.text[:120]}",
    )
    check(
        "the refusal does not admit the case exists",
        "not found" in r.text.lower(),
        r.text[:120],
    )
    r = ortho_a.get("/api/staff/queue")
    check(
        "the queue is empty for them too",
        all(len(v) == 0 for v in r.json().values() if isinstance(v, list)),
        r.text[:200],
    )

    # -- assignment --------------------------------------------------------
    r = admin.post(f"/api/staff/orders/{early}/assign", json={"user_id": ortho_a_id})
    check(
        "an enquiry cannot be assigned — only the aligner series is handed over",
        r.status_code == 409 and "enquiry" in r.text.lower(),
        f"{r.status_code} {r.text[:160]}",
    )

    r = admin.post(f"/api/staff/orders/{case_a}/assign", json={"user_id": "nobody"})
    check("an unknown assignee is refused", r.status_code == 404, r.text[:120])

    r = admin.post(f"/api/staff/orders/{case_a}/assign", json={"user_id": doctor_id})
    check("a doctor cannot be assigned a case", r.status_code in (400, 404), r.text[:140])

    r = admin.post(f"/api/staff/orders/{case_a}/assign", json={"user_id": ortho_a_id})
    check("the lab assigns the case to an orthodontist", r.status_code == 200, r.text[:160])
    check(
        "and the case records who owns it",
        r.json()["assigned_to_id"] == ortho_a_id and r.json()["assigned_to_name"],
        r.text[:200],
    )

    admin.post(f"/api/staff/orders/{case_b}/assign", json={"user_id": ortho_b_id})

    # -- after assignment: strictly their own -----------------------------
    r = ortho_a.get("/api/staff/orders")
    check("the assignee now sees their case", len(r.json()) == 1, r.text[:200])
    check(
        "and only theirs",
        r.json()[0]["id"] == case_a,
        str([x["id"] for x in r.json()]),
    )
    r = ortho_a.get(f"/api/staff/orders/{case_a}")
    check("they can open it", r.status_code == 200, r.text[:140])
    r = ortho_a.get(f"/api/staff/orders/{case_b}")
    check(
        "but not one belonging to another orthodontist",
        r.status_code == 404,
        f"{r.status_code} {r.text[:120]}",
    )

    # Acting on someone else's case must fail the same way as reading it.
    r = ortho_a.post(f"/api/staff/orders/{case_b}/plans", json={
        "aligners_upper": 10, "aligners_lower": 10, "final_price": "40000",
    })
    check("nor share a plan on it", r.status_code == 404, f"{r.status_code} {r.text[:120]}")
    r = ortho_a.post(f"/api/staff/orders/{case_b}/scan/reject", json={"note": "no"})
    check("nor send its scan back", r.status_code == 404, f"{r.status_code} {r.text[:120]}")
    r = ortho_a.post(f"/api/staff/orders/{case_b}/assign", json={"user_id": ortho_a_id})
    check(
        "nor assign it to themselves",
        r.status_code in (403, 404),
        f"{r.status_code} {r.text[:120]}",
    )
    r = ortho_a.post(f"/api/staff/orders/{case_a}/assign", json={"user_id": ortho_b_id})
    check(
        "an orthodontist cannot reassign even their own case",
        r.status_code == 403,
        f"{r.status_code} {r.text[:120]}",
    )

    # -- what they can do on their own case --------------------------------
    r = ortho_a.post(f"/api/orders/{case_a}/files", data={"category": "TREATMENT_PLAN", "slot": ""},
                     files={"upload": ("plan.pdf", io.BytesIO(b"%PDF-1.4"), "application/pdf")})
    check("they can add planning files to their own case", r.status_code in (200, 201), r.text[:160])

    # -- the office tools stay open ---------------------------------------
    check("orthodontists reach the settings", ortho_a.get("/api/admin/settings").status_code == 200)
    check("and the booking calendar", ortho_a.get("/api/admin/bookings").status_code == 200)
    check("and the technician roster", ortho_a.get("/api/admin/technicians").status_code == 200)
    check("and pricing", ortho_a.get("/api/staff/pricing").status_code == 200)
    check("and the doctor directory", ortho_a.get("/api/staff/doctors").status_code == 200)

    r = ortho_a.post(
        "/api/staff/orthodontists",
        json={"email": "sneaky@x.com", "password": "password12345", "full_name": "Sneaky"},
    )
    check(
        "but they cannot create other orthodontists",
        r.status_code == 403,
        f"{r.status_code} {r.text[:120]}",
    )

    # -- the admin keeps the whole board ----------------------------------
    r = admin.get("/api/staff/orders")
    ids = {x["id"] for x in r.json()}
    check(
        "the admin still sees every case, assigned or not",
        {case_a, case_b, early} <= ids,
        str(len(ids)),
    )
    r = admin.get("/api/staff/orders?assigned_to=" + ortho_a_id)
    check(
        "and can filter the board by assignee",
        [x["id"] for x in r.json()] == [case_a],
        str([x["id"] for x in r.json()]),
    )
    r = admin.get("/api/staff/orders?assigned_to=unassigned")
    check(
        "and pick out what nobody owns yet",
        early in {x["id"] for x in r.json()} and case_a not in {x["id"] for x in r.json()},
        str([x["id"] for x in r.json()]),
    )

    # -- searching and paging obey the same scope --------------------------
    r = ortho_a.get("/api/staff/orders?search=Arjun")
    check(
        "searching cannot reach outside the assignment",
        r.json() == [],
        r.text[:160],
    )
    r = ortho_a.get("/api/staff/orders?search=Riya")
    check("but does find their own", len(r.json()) == 1, r.text[:160])
    r = ortho_a.get("/api/staff/orders?limit=200")
    check("nor can a big page", len(r.json()) == 1, str(len(r.json())))

    # -- reassignment and handing back ------------------------------------
    r = admin.post(f"/api/staff/orders/{case_a}/assign", json={"user_id": ortho_b_id})
    check("the lab can move a case to someone else", r.status_code == 200, r.text[:140])
    check(
        "the previous owner loses it immediately",
        ortho_a.get(f"/api/staff/orders/{case_a}").status_code == 404,
        "",
    )
    check(
        "and the new owner has it",
        ortho_b.get(f"/api/staff/orders/{case_a}").status_code == 200,
        "",
    )

    r = admin.post(f"/api/staff/orders/{case_a}/assign", json={"user_id": None})
    check("a case can be handed back to the lab", r.status_code == 200, r.text[:140])
    check("with no assignee recorded", r.json()["assigned_to_id"] is None, r.text[:140])
    check(
        "and nobody but the admin can see it again",
        ortho_b.get(f"/api/staff/orders/{case_a}").status_code == 404
        and admin.get(f"/api/staff/orders/{case_a}").status_code == 200,
        "",
    )

    # -- deactivation ------------------------------------------------------
    admin.post(f"/api/staff/orders/{case_a}/assign", json={"user_id": ortho_a_id})
    r = admin.patch(f"/api/staff/orthodontists/{ortho_a_id}", json={"is_active": False})
    check("an orthodontist can be deactivated", r.status_code == 200, r.text[:140])
    r = ortho_a.get("/api/staff/orders")
    check(
        "and is signed out of the portal",
        r.status_code == 401,
        f"{r.status_code} {r.text[:100]}",
    )
    check(
        "while their cases stay with the admin",
        admin.get(f"/api/staff/orders/{case_a}").status_code == 200,
        "",
    )
    r = admin.post(f"/api/staff/orders/{case_b}/assign", json={"user_id": ortho_a_id})
    check(
        "a deactivated orthodontist cannot be given new work",
        r.status_code in (400, 404, 409),
        f"{r.status_code} {r.text[:140]}",
    )

    # -- a technician is not an orthodontist -------------------------------
    admin.post(
        "/api/admin/technicians",
        json={
            "email": "tech@3dalign.example.com",
            "password": "techpassword1",
            "full_name": "Anil Rathod",
            "phone": "+919800000001",
        },
    )
    tech.post(
        "/api/auth/login",
        json={"email": "tech@3dalign.example.com", "password": "techpassword1"},
    )
    r = tech.get("/api/staff/orders")
    check(
        "technicians still cannot browse the case board",
        r.status_code == 403,
        f"{r.status_code} {r.text[:100]}",
    )
    r = admin.get("/api/staff/orthodontists")
    check(
        "the roster lists orthodontists only",
        all(x["role"] == "ORTHODONTIST" for x in r.json()) and len(r.json()) >= 2,
        r.text[:200],
    )

    # -- the doctor is untouched by any of this ----------------------------
    r = doctor.get("/api/orders")
    check(
        "the clinic still sees its own cases",
        len(r.json()) >= 3,
        str(len(r.json())),
    )
    seen = doctor.get(f"/api/orders/{case_b}").json()
    check(
        "and is told nothing about who is planning them",
        seen["assigned_to_id"] is None and seen["assigned_to_name"] == "",
        f"{seen['assigned_to_id']} {seen['assigned_to_name']}",
    )

print()
if failures:
    print(f"{len(failures)} check(s) failed:")
    for f in failures:
        print(f"  - {f}")
    raise SystemExit(1)
print("All checks passed.")
