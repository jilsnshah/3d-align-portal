"""When each kind of order is paid for, and what an unpaid one holds up.

    .venv/bin/python payment_flow_test.py

Three different answers, because they are three different transactions:

  * an aligner case collects per phase, one phase behind delivery;
  * an accessory is stock and is paid for before it leaves the building;
  * a by-product is an appliance the lab has already made to a prescription,
    so it ships first and is paid after — and the brake on that becoming an
    open tab is that the clinic settles it before starting another.
"""
import io
import os
import tempfile

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mktemp(suffix='.db')}"
os.environ["SECRET_KEY"] = "x" * 32
os.environ["STAFF_EMAIL"] = "staff@e.com"
os.environ["STAFF_PASSWORD"] = "staffpassword"

from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Doctor, ShippingRate  # noqa: E402

boot = TestClient(app)
boot.__enter__()
doc = TestClient(app, base_url="http://doctor")
lab = TestClient(app, base_url="http://lab")

doc.post("/api/auth/register", json={
    "email": "d@c.com", "password": "doctorpass1", "full_name": "Dr. Test",
    "phone": "+919812345678", "clinic_name": "T Dental",
    "dental_council": "Gujarat State Dental Council", "registration_number": "A-1",
    "address": {"line1": "1 Rd", "city": "Surat", "state": "Gujarat", "pincode": "395001"},
})
with SessionLocal() as db:
    db.query(Doctor).one().verification_status = "VERIFIED"
    db.add(ShippingRate(city="Surat", amount=250))
    db.commit()
lab.post("/api/auth/login", json={"email": "staff@e.com", "password": "staffpassword"})

fails = []
STL = b"solid x\n" + b"f " * 40 + b"\nendsolid x\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64

products = doc.get("/api/products").json()
er = next(p for p in products if p["code"] == "ER")
size = next(s for s in er["sizes"] if s["label"] == "1.0 mm")
shelf = doc.get("/api/accessories").json()


def order_product(name):
    return doc.post("/api/orders", json={
        "new_patient": {"full_name": name},
        "product_id": er["id"], "product_size_id": size["id"], "quantity": 1,
    })


def send_scan(oid):
    doc.post(f"/api/orders/{oid}/scan-route", json={"scan_route": "UPLOAD"})
    for slot in ["UPPER_ARCH", "LOWER_ARCH", "BITE"]:
        doc.post(
            f"/api/orders/{oid}/files",
            data={"category": "INTRAORAL_SCAN", "slot": slot},
            files={"upload": (f"{slot}.stl", io.BytesIO(STL), "model/stl")},
        )
    return lab.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": ""})


def ship(oid):
    return lab.post(f"/api/staff/orders/{oid}/shipments", json={
        "shipment_type": "PRODUCT", "carrier": "Shree Tirupati", "tracking_number": "T1",
    })


def send_receipt(oid, reference="UPI123"):
    """The clinic pays by UPI and sends the screenshot."""
    d = doc.get(f"/api/orders/{oid}").json()
    row = next(p for p in d["payments"] if p["kind"] == "PRODUCT_ORDER")
    doc.post(
        f"/api/orders/{oid}/payments/{row['id']}/proof",
        data={"reference": reference},
        files={"upload": ("receipt.png", io.BytesIO(PNG), "image/png")},
    )
    return row


def pay(oid, approve=True):
    row = send_receipt(oid)
    return lab.post(
        f"/api/staff/orders/{oid}/payments/{row['id']}/verify",
        json={"approve": approve, "reason": "" if approve else "Wrong amount."},
    )


print("=" * 72)
print("BY-PRODUCT — ships first, paid after")
print("=" * 72)

first = order_product("First Patient").json()
oid = first["id"]
print(f"placed                 {first['status']}")

r = send_scan(oid)
print(f"scan accepted          {r.status_code} {r.json().get('status')}")

r = ship(oid)
print(f"shipped UNPAID         {r.status_code} {r.json().get('status')}")
if r.status_code != 200:
    fails.append(f"a by-product should ship before payment: {r.status_code} {r.text[:120]}")

d = doc.get(f"/api/orders/{oid}").json()
row = next(p for p in d["payments"] if p["kind"] == "PRODUCT_ORDER")
print(f"charge still open      {row['status']}  {row['total']}")
if row["status"] == "VERIFIED":
    fails.append("the charge should still be open after dispatch")

print()
print("=" * 72)
print("THE BRAKE — one unsettled appliance at a time")
print("=" * 72)

hold = doc.get("/api/ordering-hold").json()
print(f"hold                   can_order={hold['can_order_products']}  {hold['reference']} — {hold['reason']}")
if hold["can_order_products"]:
    fails.append("an unpaid by-product should hold the next one")

r = order_product("Second Patient")
print(f"second by-product      {r.status_code}  {str(r.json().get('detail',''))[:88]}")
if r.status_code != 409:
    fails.append(f"a second by-product should be refused, got {r.status_code}")

# An accessory is not held: it is paid before it leaves, so it cannot be
# both delivered and unpaid.
r = doc.post("/api/orders", json={
    "new_patient": {"full_name": "Stock"},
    "accessories": [{"accessory_id": shelf[0]["id"], "quantity": 1}],
})
print(f"accessory meanwhile    {r.status_code}  status={r.json().get('status')}")
if r.status_code >= 300:
    fails.append(f"an accessory must not be held by an unpaid by-product: {r.text[:110]}")
acc_id = r.json().get("id")

# Nor is an aligner case.
r = doc.post("/api/orders", json={"new_patient": {"full_name": "Aligner"}, "arch": "BOTH"})
print(f"aligner meanwhile      {r.status_code}  status={r.json().get('status')}")
if r.status_code >= 300:
    fails.append("an aligner case must not be held by an unpaid by-product")

print()
print("=" * 72)
print("ACCESSORY — paid before it leaves")
print("=" * 72)
r = ship(acc_id)
print(f"ship accessory UNPAID  {r.status_code}  {str(r.json().get('detail',''))[:80]}")
if r.status_code != 402:
    fails.append(f"an accessory must be paid before dispatch, got {r.status_code}")

r = pay(acc_id)
print(f"paid                   {r.status_code}")
r = ship(acc_id)
print(f"ship accessory PAID    {r.status_code}  status={r.json().get('status')}")
if r.status_code != 200:
    fails.append(f"a paid accessory should ship: {r.status_code} {r.text[:110]}")

print()
print("=" * 72)
print("SETTLING RELEASES THE BRAKE")
print("=" * 72)

# A receipt under review is not yet settled, and says so in its own words.
row = send_receipt(oid, "UPI999")
hold = doc.get("/api/ordering-hold").json()
print(f"receipt sent           can_order={hold['can_order_products']} — {hold['reason']}")
if hold["can_order_products"]:
    fails.append("a receipt under review is not yet settled")
if "checking" not in hold["reason"]:
    fails.append(f"the reason should say the receipt is being checked: {hold['reason']}")

# Rejected sends it back to unpaid.
lab.post(f"/api/staff/orders/{oid}/payments/{row['id']}/verify",
         json={"approve": False, "reason": "Wrong amount."})
hold = doc.get("/api/ordering-hold").json()
print(f"receipt rejected       can_order={hold['can_order_products']} — {hold['reason']}")
if hold["can_order_products"]:
    fails.append("a rejected receipt should still hold")

# Verified releases it.
r = pay(oid)
print(f"verified               {r.status_code}")
hold = doc.get("/api/ordering-hold").json()
print(f"hold lifted            can_order={hold['can_order_products']}")
if not hold["can_order_products"]:
    fails.append("a settled order should release the hold")

r = order_product("Third Patient")
print(f"next by-product        {r.status_code}  status={r.json().get('status')}")
if r.status_code >= 300:
    fails.append(f"the next by-product should be allowed: {r.status_code} {r.text[:110]}")

# A cancelled order owes nothing.
third = r.json()["id"]
doc.post(f"/api/orders/{third}/cancel", json={"reason": "Changed my mind."})
hold = doc.get("/api/ordering-hold").json()
print(f"after cancelling it    can_order={hold['can_order_products']}")
if not hold["can_order_products"]:
    fails.append("a cancelled order should not hold anything")

print()
if fails:
    print("FAIL:\n  " + "\n  ".join(fails))
    raise SystemExit(1)
print("All checks passed.")
