"""The lab's payments book.

    .venv/bin/python staff_ledger_test.py

The clinic's ledger answers "what do I owe". This one answers a different
question over the same rows — "what is waiting for me to check, and what is
owed to us" — and the checks that matter are the ones where those two views
must not blur: a receipt already sent is a job on the lab's desk, not a debt to
chase; an orthodontist sees the money for their own cases and no one else's;
and verifying from this page has to settle the real charge rather than a copy.
"""
import io
import os
import tempfile
from decimal import Decimal

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mktemp(suffix='.db')}"
os.environ["SECRET_KEY"] = "x" * 32
os.environ["STAFF_EMAIL"] = "staff@e.com"
os.environ["STAFF_PASSWORD"] = "staffpassword"
os.environ["STORAGE_LOCAL_ROOT"] = tempfile.mkdtemp()

from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Doctor, ShippingRate, User  # noqa: E402

boot = TestClient(app)
boot.__enter__()
alpha = TestClient(app, base_url="http://alpha")
beta = TestClient(app, base_url="http://beta")
lab = TestClient(app, base_url="http://lab")
ortho = TestClient(app, base_url="http://ortho")

for client, email, name in [(alpha, "a@c.com", "Dr. Alpha"), (beta, "b@c.com", "Dr. Beta")]:
    client.post("/api/auth/register", json={
        "email": email, "password": "doctorpass1", "full_name": name,
        "phone": "+919812345678", "clinic_name": f"{name} Dental",
        "dental_council": "Gujarat State Dental Council", "registration_number": "A-1",
        "address": {"line1": "1 Rd", "city": "Surat", "state": "Gujarat", "pincode": "395001"},
    })
with SessionLocal() as db:
    for d in db.query(Doctor).all():
        d.verification_status = "VERIFIED"
    db.add(ShippingRate(city="Surat", amount=250))
    db.commit()
lab.post("/api/auth/login", json={"email": "staff@e.com", "password": "staffpassword"})

passed = failed = 0
STL = b"solid x\n" + b"f " * 40 + b"\nendsolid x\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}   {detail}")


products = alpha.get("/api/products").json()
er = next(p for p in products if p["code"] == "ER")
size = next(s for s in er["sizes"] if s["label"] == "1.0 mm")


def order_product(client, first, last):
    return client.post("/api/orders", json={
        "new_patient": {"first_name": first, "last_name": last},
        "product_id": er["id"], "product_size_id": size["id"], "quantity": 1,
    }).json()


def deliver(client, oid):
    """Take a by-product all the way to dispatched, where it is owed."""
    client.post(f"/api/orders/{oid}/scan-route", json={"scan_route": "UPLOAD"})
    for slot in ["UPPER_ARCH", "LOWER_ARCH", "BITE"]:
        client.post(f"/api/orders/{oid}/files",
                    data={"category": "INTRAORAL_SCAN", "slot": slot},
                    files={"upload": (f"{slot}.stl", io.BytesIO(STL), "model/stl")})
    lab.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": ""})
    lab.post(f"/api/staff/orders/{oid}/shipments", json={
        "shipment_type": "PRODUCT", "carrier": "Shree Tirupati", "tracking_number": "T1"})


def send_receipt(client, oid, ref):
    row = next(p for p in client.get(f"/api/orders/{oid}").json()["payments"]
               if p["status"] != "VERIFIED")
    client.post(f"/api/orders/{oid}/payments/{row['id']}/proof", data={"reference": ref},
                files={"upload": ("receipt.png", io.BytesIO(PNG), "image/png")})
    return row


def book():
    return lab.get("/api/staff/payments").json()


print("=" * 72)
print("AN EMPTY BOOK")
print("=" * 72)
b = book()
check("a lab with nothing raised reads zero, not an error",
      b["outstanding"] == "0.00" and b["to_verify"] == [] and b["pending"] == [],
      str(b)[:120])
check("and nobody owes anything yet", b["owed_by_doctor"] == [], str(b["owed_by_doctor"]))

print()
print("=" * 72)
print("EVERY CLINIC'S MONEY, IN ONE BOOK")
print("=" * 72)

a1 = order_product(alpha, "Riya", "Mehta")
b1 = order_product(beta, "Karan", "Shah")
b = book()
check("both clinics' charges are here", len(b["pending"]) == 2, str(len(b["pending"])))
names = {e["doctor_name"] for e in b["pending"]}
check("each charge names the clinic it belongs to", names == {"Dr. Alpha", "Dr. Beta"}, str(names))
check("and the practice as well",
      all(e["clinic_name"] for e in b["pending"]), str([e["clinic_name"] for e in b["pending"]]))
check("nothing is waiting to be checked yet", b["to_verify"] == [], str(b["to_verify"]))

# The doctor's own page must not have gained the lab's columns.
mine = alpha.get("/api/payments").json()
check("a clinic still sees only its own", len(mine["pending"]) == 1, str(len(mine["pending"])))
check("and is not told whose money it is — it already knows",
      mine["pending"][0]["doctor_name"] == "", repr(mine["pending"][0]["doctor_name"]))

print()
print("=" * 72)
print("THE QUEUE IS RECEIPTS TO CHECK, NOT MONEY OWED")
print("=" * 72)

deliver(alpha, a1["id"])
deliver(beta, b1["id"])
row_a = send_receipt(alpha, a1["id"], "UPI-A-1")

b = book()
check("the sent receipt is in the queue", len(b["to_verify"]) == 1, str(len(b["to_verify"])))
check("named by the clinic that sent it", b["to_verify"][0]["doctor_name"] == "Dr. Alpha",
      b["to_verify"][0]["doctor_name"])
check("with the reference they gave", b["to_verify"][0]["reference"] == "UPI-A-1",
      b["to_verify"][0]["reference"])
check("and the screenshot to open", b["to_verify"][0]["proof_file_id"] is not None)
check("it counts as being checked, not as owed",
      b["in_review"] == b["to_verify"][0]["total"] and Decimal(b["outstanding"]) > 0,
      f"{b['in_review']} / {b['outstanding']}")

# The distinction that matters: a clinic that has paid must not be chased.
owed = {r["doctor_name"]: r for r in b["owed_by_doctor"]}
check("the clinic that has paid is off the chase list", "Dr. Alpha" not in owed, str(list(owed)))
check("the one that has not is on it", "Dr. Beta" in owed, str(list(owed)))
check("for what it actually owes",
      owed["Dr. Beta"]["amount"] == next(
          e["total"] for e in b["pending"] if e["doctor_name"] == "Dr. Beta"),
      str(owed.get("Dr. Beta")))
check("and how many charges that is", owed["Dr. Beta"]["charges"] == 1,
      str(owed["Dr. Beta"]["charges"]))

print()
print("=" * 72)
print("VERIFYING FROM HERE SETTLES THE REAL CHARGE")
print("=" * 72)

r = lab.post(f"/api/staff/orders/{a1['id']}/payments/{row_a['id']}/verify",
             json={"approve": True, "reason": ""})
check("the lab confirms it", r.status_code == 200, r.text[:120])
b = book()
check("the queue empties", b["to_verify"] == [], str(b["to_verify"]))
check("and it moves into what has been received", len(b["history"]) == 1)
check("counted in the lab's takings", b["paid_total"] == row_a["total"],
      f"{b['paid_total']} vs {row_a['total']}")
check("inside this financial year", b["paid_this_year"] == row_a["total"], b["paid_this_year"])
check("nothing is left in review", b["in_review"] == "0.00", b["in_review"])

# And the clinic's own page has to agree, because it is the same row.
mine = alpha.get("/api/payments").json()
check("the clinic sees it settled too", len(mine["history"]) == 1 and mine["pending"] == [],
      f"pending={len(mine['pending'])} history={len(mine['history'])}")

print()
print("=" * 72)
print("A REFUSED RECEIPT GOES BACK TO BEING OWED")
print("=" * 72)

row_b = send_receipt(beta, b1["id"], "UPI-B-1")
b = book()
check("it queues for checking", len(b["to_verify"]) == 1)
check("and Beta is off the chase list while it is being checked",
      all(r["doctor_name"] != "Dr. Beta" for r in b["owed_by_doctor"]),
      str([r["doctor_name"] for r in b["owed_by_doctor"]]))

r = lab.post(f"/api/staff/orders/{b1['id']}/payments/{row_b['id']}/verify",
             json={"approve": False, "reason": "Amount short by 250."})
check("the lab can refuse it", r.status_code == 200, r.text[:120])
b = book()
check("the queue empties again", b["to_verify"] == [], str(b["to_verify"]))
check("it is owed once more", any(r["doctor_name"] == "Dr. Beta" for r in b["owed_by_doctor"]),
      str([r["doctor_name"] for r in b["owed_by_doctor"]]))
bad = next(e for e in b["pending"] if e["doctor_name"] == "Dr. Beta")
check("carrying the reason the lab gave", bad["rejected_reason"] == "Amount short by 250.",
      bad["rejected_reason"])
check("and it sorts to the top of what is open", b["pending"][0]["status"] == "REJECTED",
      b["pending"][0]["status"])
check("refusing takes nothing off the takings", b["paid_total"] == row_a["total"],
      b["paid_total"])

print()
print("=" * 72)
print("NARROWING TO ONE CLINIC")
print("=" * 72)
doctors = lab.get("/api/staff/doctors").json()
beta_id = next(d["id"] for d in doctors if d["full_name"] == "Dr. Beta")
b = lab.get(f"/api/staff/payments?doctor_id={beta_id}").json()
check("only that clinic's charges come back",
      all(e["doctor_name"] == "Dr. Beta" for e in b["pending"] + b["history"]),
      str({e["doctor_name"] for e in b["pending"] + b["history"]}))
check("and its takings are its own, not the lab's total", b["paid_total"] == "0.00",
      b["paid_total"])

print()
print("=" * 72)
print("WHO MAY READ THE BOOK")
print("=" * 72)

# An orthodontist has every screen, on their own cases only — so the money
# they see must narrow the same way the case boards do.
r = lab.post("/api/staff/orthodontists", json={
    "email": "o@lab.com", "password": "orthopass123", "full_name": "Dr. Ortho"})
if r.status_code < 300:
    ortho.post("/api/auth/login", json={"email": "o@lab.com", "password": "orthopass123"})
    seen = ortho.get("/api/staff/payments")
    check("an orthodontist may open the book", seen.status_code == 200, seen.text[:120])
    check("but sees nothing until a case is theirs",
          seen.json()["pending"] == [] and seen.json()["history"] == [],
          str(seen.json()["pending"])[:120])
    with SessionLocal() as db:
        uid = db.query(User).filter(User.email == "o@lab.com").one().id

    # Only a case in the aligner series can be handed over, so the narrowing is
    # tested on one — driven to planning, where a case takes its AL number and
    # becomes something an orthodontist can be given.
    al = beta.post("/api/orders", json={
        "new_patient": {"first_name": "Meera", "last_name": "Iyer"}, "arch": "BOTH"}).json()
    for slot in ["INTRAORAL_FRONTAL", "BUCCAL_RIGHT", "BUCCAL_LEFT",
                 "OCCLUSAL_UPPER", "OCCLUSAL_LOWER"]:
        beta.post(f"/api/orders/{al['id']}/files",
                  data={"category": "RECORD_PHOTO", "slot": slot},
                  files={"upload": (f"{slot}.png", io.BytesIO(PNG), "image/png")})
    beta.post(f"/api/orders/{al['id']}/files", data={"category": "OPG"},
              files={"upload": ("opg.png", io.BytesIO(PNG), "image/png")})
    beta.post(f"/api/orders/{al['id']}/submit")
    lab.post(f"/api/staff/orders/{al['id']}/start-review", json={})
    lab.post(f"/api/staff/orders/{al['id']}/quotes",
             json={"category": "ALIGN_16_20", "extras": [], "tax": "0"})
    beta.post(f"/api/orders/{al['id']}/quote/accept")
    beta.post(f"/api/orders/{al['id']}/scan-route", json={"scan_route": "UPLOAD"})
    for slot in ["UPPER_ARCH", "LOWER_ARCH", "BITE"]:
        beta.post(f"/api/orders/{al['id']}/files",
                  data={"category": "INTRAORAL_SCAN", "slot": slot},
                  files={"upload": (f"{slot}.stl", io.BytesIO(STL), "model/stl")})
    lab.post(f"/api/staff/orders/{al['id']}/scan/accept", json={"note": ""})
    for cat in ["TREATMENT_PLAN", "SIMULATION_MODEL"]:
        lab.post(f"/api/orders/{al['id']}/files", data={"category": cat},
                 files={"upload": (f"{cat.lower()}.stl", io.BytesIO(STL), "model/stl")})
    # A shared plan raises the plan fee, so the case now carries money.
    lab.post(f"/api/staff/orders/{al['id']}/plans",
             json={"aligners_upper": 18, "aligners_lower": 16, "final_price": "72000"})

    r = lab.post(f"/api/staff/orders/{al['id']}/assign", json={"user_id": uid})
    check("the case is handed to them", r.status_code == 200, r.text[:140])

    seen = ortho.get("/api/staff/payments").json()
    refs = {e["order_reference"] for e in seen["pending"]}
    check("and now they see the money on their own case",
          refs == {r.json()["order_number"]}, str(refs))
    check("and still nothing on anyone else's",
          all(e["doctor_name"] == "Dr. Beta" for e in seen["pending"]),
          str([(e["doctor_name"], e["order_reference"]) for e in seen["pending"]]))

    # The lab office keeps the whole board while the orthodontist has a slice.
    whole = lab.get("/api/staff/payments").json()
    check("the lab office still sees every clinic's",
          len(whole["pending"]) > len(seen["pending"]),
          f"lab={len(whole['pending'])} ortho={len(seen['pending'])}")
else:
    print(f"  (no orthodontist route: {r.status_code}) — skipping that pair")

r = alpha.get("/api/staff/payments")
check("a clinic cannot read the lab's book", r.status_code in (401, 403),
      f"{r.status_code} {r.text[:90]}")
r = TestClient(app, base_url="http://anon").get("/api/staff/payments")
check("nor can a signed-out caller", r.status_code in (401, 403), r.status_code)

print()
print(f"{passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
