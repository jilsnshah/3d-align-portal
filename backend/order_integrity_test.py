"""What an order remembers, and what it does not need.

    .venv/bin/python order_integrity_test.py

Three things the audit found and this holds down:

  * a price is what the clinic was shown, not what the catalogue says today;
  * an accessory order is the practice buying supplies, so it names nobody;
  * a case folder that cannot be renamed tells the lab instead of a log file.
"""
import io
import os
import tempfile
from decimal import Decimal

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mktemp(suffix='.db')}"
os.environ["SECRET_KEY"] = "x" * 32
os.environ["STAFF_EMAIL"] = "staff@e.com"
os.environ["STAFF_PASSWORD"] = "staffpassword"

from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Doctor, Notification, Order, ProductSize, ShippingRate  # noqa: E402

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
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
products = doc.get("/api/products").json()
er = next(p for p in products if p["code"] == "ER")
size = next(s for s in er["sizes"] if s["label"] == "1.0 mm")   # 500
shelf = doc.get("/api/accessories").json()


def total_of(oid):
    d = doc.get(f"/api/orders/{oid}").json()
    row = [c for c in d["charges"] if c["label"] == "Total for this order"]
    return Decimal(row[0]["amount"]) if row else None


print("=" * 72)
print("F10 — the price is what the clinic was shown")
print("=" * 72)

o = doc.post("/api/orders", json={
    "new_patient": {"full_name": "Priced Patient"},
    "product_id": er["id"], "product_size_id": size["id"], "quantity": 2,
}).json()
oid = o["id"]
before = total_of(oid)
print(f"ordered at 2 x 500     total {before}  (+250 delivery)")
if before != Decimal("1250.00"):
    fails.append(f"opening total wrong: {before}")

# The lab doubles the catalogue price while that order is still open.
with SessionLocal() as db:
    row = db.get(ProductSize, size["id"])
    row.price = Decimal("1000")
    db.commit()
print("lab reprices to 1000")

after = total_of(oid)
print(f"the open order         total {after}")
if after != before:
    fails.append(f"an open order re-priced itself: {before} -> {after}")

fresh = doc.post("/api/orders", json={
    "patient_id": o["patient_id"],
    "product_id": er["id"], "product_size_id": size["id"], "quantity": 2,
}).json()
# The brake from the payment rules holds a second appliance, so this is
# expected to be refused — which is itself worth confirming still happens.
if "detail" not in fresh:
    print(f"a new order            total {total_of(fresh['id'])}")
    if total_of(fresh["id"]) != Decimal("2250.00"):
        fails.append("a new order should take the new price")
else:
    print(f"a new order            held: {fresh['detail'][:60]}")

# Settle the first, then confirm a genuinely new order takes the new price.
d = doc.get(f"/api/orders/{oid}").json()
pay_row = next(p for p in d["payments"] if p["kind"] == "PRODUCT_ORDER")
doc.post(f"/api/orders/{oid}/payments/{pay_row['id']}/proof",
         data={"reference": "UPI1"},
         files={"upload": ("r.png", io.BytesIO(PNG), "image/png")})
lab.post(f"/api/staff/orders/{oid}/payments/{pay_row['id']}/verify", json={"approve": True})
if total_of(oid) != before:
    fails.append("a settled order moved after verification")
print(f"after settling         total {total_of(oid)}  (unchanged)")

second = doc.post("/api/orders", json={
    "patient_id": o["patient_id"],
    "product_id": er["id"], "product_size_id": size["id"], "quantity": 2,
}).json()
new_total = total_of(second["id"])
print(f"the next order         total {new_total}  (takes the new price)")
if new_total != Decimal("2250.00"):
    fails.append(f"a new order should be priced at the new rate, got {new_total}")

print()
print("=" * 72)
print("F11 — an accessory order names nobody")
print("=" * 72)

a = doc.post("/api/orders", json={
    "accessories": [{"accessory_id": shelf[0]["id"], "quantity": 3}],
})
print(f"no patient given       {a.status_code}  status={a.json().get('status')}")
if a.status_code >= 300:
    fails.append(f"an accessory order should not need a patient: {a.text[:120]}")
else:
    ad = doc.get(f"/api/orders/{a.json()['id']}").json()
    print(f"reads as               {ad['patient_name']}")
    if ad["patient_name"] != "Practice stock":
        fails.append(f"patient_name on a stock order: {ad['patient_name']}")
    with SessionLocal() as db:
        row = db.get(Order, a.json()["id"])
        if row.patient_id is not None:
            fails.append("no patient row should have been invented")

    # It still lists, and the board does not fall over on it.
    board = lab.get("/api/staff/orders?series=accessory&limit=5").json()
    print(f"lab board              {len(board)} accessory order(s), first is {board[0]['patient_name']}")
    if not board:
        fails.append("the accessory board is empty")

# A clinic that wants it filed against someone still may.
named = doc.post("/api/orders", json={
    "new_patient": {"full_name": "Named Patient"},
    "accessories": [{"accessory_id": shelf[0]["id"], "quantity": 1}],
})
print(f"naming one is allowed  {named.status_code}  {named.json().get('patient_name')}")
if named.status_code >= 300:
    fails.append("naming a patient on a stock order should still work")

# An appliance still needs one.
r = doc.post("/api/orders", json={
    "product_id": er["id"], "product_size_id": size["id"], "quantity": 1,
})
print(f"an appliance still     {r.status_code}  {str(r.json().get('detail',''))[:56]}")
if r.status_code != 400:
    fails.append(f"an appliance must still name a patient, got {r.status_code}")

print()
print("=" * 72)
print("F13 — a folder that cannot be renamed is reported")
print("=" * 72)

from app.services import storage as storage_mod  # noqa: E402
from app.transitions import _rename_storage_folder  # noqa: E402


class Boom:
    def rename_order_folder(self, old, new):
        raise storage_mod.StorageError("disk on fire")


with SessionLocal() as db:
    order = db.query(Order).filter(Order.order_number.isnot(None)).first()
    before_n = db.query(Notification).count()
    real = storage_mod.get_storage
    storage_mod.get_storage = lambda: Boom()
    try:
        _rename_storage_folder(db, order)
    finally:
        storage_mod.get_storage = real
    db.commit()
    after_n = db.query(Notification).count()
    warned = (
        db.query(Notification)
        .filter(Notification.title == "Case folder could not be renamed")
        .first()
    )

print(f"rename fails           notifications {before_n} -> {after_n}")
if warned is None:
    fails.append("a failed rename told nobody")
else:
    print(f"the lab is told        {warned.body[:78]}…")

# And it is idempotent: renaming something already renamed is not an error.
st = storage_mod.get_storage()
st.ensure_order_folder("ALREADY-THERE")
again = st.rename_order_folder("NOT-HERE", "ALREADY-THERE")
print(f"already renamed        {'reported as done' if again else 'reported as missing'}")
if not again:
    fails.append("a folder already at its new name should report success")

print()
if fails:
    print("FAIL:\n  " + "\n  ".join(fails))
    raise SystemExit(1)
print("All checks passed.")
