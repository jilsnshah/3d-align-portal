"""The practice-wide payments ledger.

    .venv/bin/python payment_ledger_test.py

Money used to be readable one case at a time. This is the page that gathers it,
and the questions worth asking of it are: does it show every charge, does it
show only this practice's, does it total the same figures the cases carry, and
does paying through it settle the real charge rather than a copy of one.
"""
import io
import os
import tempfile
from decimal import Decimal

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mktemp(suffix='.db')}"
os.environ["SECRET_KEY"] = "x" * 32
os.environ["STAFF_EMAIL"] = "staff@e.com"
os.environ["STAFF_PASSWORD"] = "staffpassword"
# Its own storage root, so a rerun never inherits the case folders of the last
# one and trips the "that folder already exists" guard.
os.environ["STORAGE_LOCAL_ROOT"] = tempfile.mkdtemp()

from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Doctor, ShippingRate  # noqa: E402

boot = TestClient(app)
boot.__enter__()
doc = TestClient(app, base_url="http://doctor")
other = TestClient(app, base_url="http://other")
lab = TestClient(app, base_url="http://lab")

for client, email, name in [(doc, "d@c.com", "Dr. Test"), (other, "o@c.com", "Dr. Other")]:
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


products = doc.get("/api/products").json()
er = next(p for p in products if p["code"] == "ER")
size = next(s for s in er["sizes"] if s["label"] == "1.0 mm")
shelf = doc.get("/api/accessories").json()


def order_product(client, name):
    return client.post("/api/orders", json={
        "new_patient": {"full_name": name},
        "product_id": er["id"], "product_size_id": size["id"], "quantity": 1,
    }).json()


def send_scan(oid):
    doc.post(f"/api/orders/{oid}/scan-route", json={"scan_route": "UPLOAD"})
    for slot in ["UPPER_ARCH", "LOWER_ARCH", "BITE"]:
        doc.post(f"/api/orders/{oid}/files",
                 data={"category": "INTRAORAL_SCAN", "slot": slot},
                 files={"upload": (f"{slot}.stl", io.BytesIO(STL), "model/stl")})
    return lab.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": ""})


def ledger(client=doc):
    return client.get("/api/payments").json()


print("=" * 72)
print("AN EMPTY PRACTICE")
print("=" * 72)
led = ledger()
check("a practice with no charges reads zero, not an error",
      led["outstanding"] == "0.00" and led["pending"] == [] and led["history"] == [],
      str(led)[:120])
check("and still names its financial year", led["financial_year"].startswith("FY "),
      led["financial_year"])

print()
print("=" * 72)
print("A CHARGE APPEARS THE MOMENT IT IS RAISED")
print("=" * 72)

# A by-product is priced the moment it is ordered, so its charge exists long
# before it is payable. The ledger has to show it — that is the whole point of
# telling a clinic what a by-product will cost before they commit to it.
p1 = order_product(doc, "Riya Mehta")
led = ledger()
check("the new order's charge is on the ledger", len(led["pending"]) == 1, str(led["pending"])[:120])
entry = led["pending"][0]
check("carrying the case it belongs to", entry["order_id"] == p1["id"], entry["order_id"])
check("and its reference", entry["order_reference"] == p1["order_number"], entry["order_reference"])
check("named by its patient", entry["subject"] == "Riya Mehta", entry["subject"])
check("with the case's own stage spelled out", bool(entry["order_status_label"]),
      entry["order_status_label"])
check("it is due, not paid", entry["status"] == "DUE", entry["status"])
check("and it is counted as outstanding",
      led["outstanding"] == entry["total"], f"{led['outstanding']} vs {entry['total']}")
check("nothing is in review yet", led["in_review"] == "0.00", led["in_review"])

# The figure has to be the same one the case itself shows. Two ledgers that
# disagree is worse than one ledger.
d = doc.get(f"/api/orders/{p1['id']}").json()
case_total = next(p for p in d["payments"] if p["kind"] == "PRODUCT_ORDER")["total"]
check("the amount matches what the case shows", entry["total"] == case_total,
      f"{entry['total']} vs {case_total}")
check("delivery is on it, as a by-product's is",
      Decimal(entry["shipping_amount"]) == Decimal("250.00"), entry["shipping_amount"])

print()
print("=" * 72)
print("ONE PRACTICE NEVER SEES ANOTHER'S MONEY")
print("=" * 72)
order_product(other, "Not Yours")
led = ledger()
check("the other clinic's charge is absent",
      all(e["subject"] != "Not Yours" for e in led["pending"]), str(led["pending"])[:140])
check("and this clinic still has exactly its own one", len(led["pending"]) == 1)
other_led = ledger(other)
check("while the other clinic sees its own",
      len(other_led["pending"]) == 1 and other_led["pending"][0]["subject"] == "Not Yours",
      str(other_led["pending"])[:120])

print()
print("=" * 72)
print("PAYING MOVES IT ACROSS")
print("=" * 72)

send_scan(p1["id"])
lab.post(f"/api/staff/orders/{p1['id']}/shipments", json={
    "shipment_type": "PRODUCT", "carrier": "Shree Tirupati", "tracking_number": "T1"})

# The receipt goes through the case's own endpoint — the ledger is a view, and
# reading it must reflect a payment made anywhere.
row = ledger()["pending"][0]
doc.post(f"/api/orders/{row['order_id']}/payments/{row['id']}/proof",
         data={"reference": "UPI123"},
         files={"upload": ("receipt.png", io.BytesIO(PNG), "image/png")})
led = ledger()
check("a sent receipt leaves the outstanding column", led["outstanding"] == "0.00", led["outstanding"])
check("and lands in the one the lab is checking", led["in_review"] == row["total"],
      f"{led['in_review']} vs {row['total']}")
check("it is still pending, not history", len(led["pending"]) == 1 and led["history"] == [])

lab.post(f"/api/staff/orders/{row['order_id']}/payments/{row['id']}/verify",
         json={"approve": True, "reason": ""})
led = ledger()
check("once confirmed it moves to history", len(led["history"]) == 1 and led["pending"] == [],
      f"pending={len(led['pending'])} history={len(led['history'])}")
check("nothing is left owing", led["outstanding"] == "0.00" and led["in_review"] == "0.00")
check("the paid total is the charge", led["paid_total"] == row["total"],
      f"{led['paid_total']} vs {row['total']}")
check("and it counts inside this financial year", led["paid_this_year"] == row["total"],
      led["paid_this_year"])
hist = led["history"][0]
check("history keeps when it was confirmed", hist["verified_at"] is not None)
check("and the receipt the clinic sent", hist["reference"] == "UPI123", hist["reference"])
check("with the screenshot still reachable", hist["proof_file_id"] is not None)

print()
print("=" * 72)
print("A REJECTED RECEIPT IS OWED AGAIN, AND SORTS FIRST")
print("=" * 72)

p2 = order_product(doc, "Second Patient")
send_scan(p2["id"])
lab.post(f"/api/staff/orders/{p2['id']}/shipments", json={
    "shipment_type": "PRODUCT", "carrier": "Shree Tirupati", "tracking_number": "T2"})
row2 = next(e for e in ledger()["pending"] if e["order_id"] == p2["id"])
doc.post(f"/api/orders/{p2['id']}/payments/{row2['id']}/proof",
         data={"reference": "UPI999"},
         files={"upload": ("receipt.png", io.BytesIO(PNG), "image/png")})
lab.post(f"/api/staff/orders/{p2['id']}/payments/{row2['id']}/verify",
         json={"approve": False, "reason": "Wrong amount."})

led = ledger()
bad = next(e for e in led["pending"] if e["order_id"] == p2["id"])
check("a rejected receipt is owed again", bad["status"] == "REJECTED", bad["status"])
check("counted as outstanding, not in review",
      led["outstanding"] == bad["total"] and led["in_review"] == "0.00",
      f"{led['outstanding']} / {led['in_review']}")
check("and it carries the lab's reason", bad["rejected_reason"] == "Wrong amount.",
      bad["rejected_reason"])
check("the confirmed payment is untouched by it", len(led["history"]) == 1)

# An aligner case raises several charges of its own; the rejected one has to
# stay at the top of the list whatever else appears under it.
al = doc.post("/api/orders", json={"new_patient": {"full_name": "Aligner Case"},
                                   "arch": "BOTH"}).json()
for slot in ["INTRAORAL_FRONTAL", "BUCCAL_RIGHT", "BUCCAL_LEFT",
             "OCCLUSAL_UPPER", "OCCLUSAL_LOWER"]:
    doc.post(f"/api/orders/{al['id']}/files", data={"category": "RECORD_PHOTO", "slot": slot},
             files={"upload": (f"{slot}.png", io.BytesIO(PNG), "image/png")})
doc.post(f"/api/orders/{al['id']}/files", data={"category": "OPG"},
         files={"upload": ("opg.png", io.BytesIO(PNG), "image/png")})
doc.post(f"/api/orders/{al['id']}/submit")
lab.post(f"/api/staff/orders/{al['id']}/start-review", json={})
lab.post(f"/api/staff/orders/{al['id']}/quotes",
         json={"category": "ALIGN_16_20", "extras": [], "tax": "0"})
doc.post(f"/api/orders/{al['id']}/quote/accept")
send_scan(al["id"])

# An aligner's plan fee is not raised when the case reaches planning — it is
# raised when there is a plan to release. Nothing is owed until then, which is
# itself worth asserting.
led = ledger()
check("a case in planning owes nothing yet",
      all(e["order_id"] != al["id"] for e in led["pending"]),
      str([e["kind"] for e in led["pending"] if e["order_id"] == al["id"]]))

# The plan is reviewed in 3D, so it cannot be shared without its simulation.
for cat in ["TREATMENT_PLAN", "SIMULATION_MODEL"]:
    lab.post(f"/api/orders/{al['id']}/files", data={"category": cat},
             files={"upload": (f"{cat.lower()}.stl", io.BytesIO(STL), "model/stl")})
r = lab.post(f"/api/staff/orders/{al['id']}/plans",
             json={"aligners_upper": 10, "aligners_lower": 10, "final_price": "40000"})
check("the lab can share a plan", r.status_code == 200, r.text[:120])

led = ledger()
kinds = {e["kind"] for e in led["pending"]}
check("an aligner case's plan fee reaches the ledger too", "TREATMENT_PLAN" in kinds, str(kinds))
check("the rejected charge sorts to the top", led["pending"][0]["status"] == "REJECTED",
      led["pending"][0]["status"])
plan = next(e for e in led["pending"] if e["kind"] == "TREATMENT_PLAN")
check("the aligner's charge is named by its patient", plan["subject"] == "Aligner Case",
      plan["subject"])
check("and marked as an aligner case", plan["order_kind"] == "ALIGNER", plan["order_kind"])
check("the outstanding total adds every open charge",
      Decimal(led["outstanding"]) == sum(
          Decimal(e["total"]) for e in led["pending"] if e["status"] != "SUBMITTED"),
      led["outstanding"])

print()
print("=" * 72)
print("AN ACCESSORY ORDER, WHICH NAMES NO PATIENT")
print("=" * 72)
acc = doc.post("/api/orders", json={
    "accessories": [{"accessory_id": shelf[0]["id"], "quantity": 2}]}).json()
led = ledger()
entry = next((e for e in led["pending"] if e["order_id"] == acc["id"]), None)
check("a shelf order is on the ledger", entry is not None, str(acc)[:120])
if entry:
    # A shelf order has no patient, so it is named by what is in it. A blank
    # cell here would give the clinic a charge with nothing to place it by.
    check("named by what is in the box", entry["subject"] == "Outie \u00d72", entry["subject"])
    check("and it is marked as an accessory order", entry["order_kind"] == "ACCESSORY",
          entry["order_kind"])

print()
print("=" * 72)
print("THE LEDGER IS NOT A WAY IN")
print("=" * 72)
r = lab.get("/api/payments")
check("the lab has no practice ledger of its own", r.status_code in (401, 403),
      f"{r.status_code} {r.text[:80]}")
r = TestClient(app, base_url="http://anon").get("/api/payments")
check("and a signed-out caller gets nothing", r.status_code in (401, 403), r.status_code)

print()
print(f"{passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
