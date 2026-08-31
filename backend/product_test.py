"""The three pipelines, each walked end to end against the real API.

    .venv/bin/python product_test.py

smoke_test.py covers the aligner case in 231 assertions and never touches a
by-product or an accessory, which is how a by-product came to require an
invented aligner band for a year without anyone noticing. This covers what
that one does not: that a fixed-price order starts where it should, is never
quoted, waits on the right things, and that the aligner path is unchanged.
"""
import os, tempfile, io
os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mktemp(suffix='.db')}"
os.environ["SECRET_KEY"] = "x" * 32
os.environ["STAFF_EMAIL"] = "staff@e.com"
os.environ["STAFF_PASSWORD"] = "staffpassword"

from decimal import Decimal
from fastapi.testclient import TestClient
from app.main import app
from app.db import SessionLocal
from app.models import Doctor, ShippingRate

boot = TestClient(app); boot.__enter__()
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
products = doc.get("/api/products").json()
er = next(p for p in products if p["code"] == "ER")
size = next(s for s in er["sizes"] if s["label"] == "1.0 mm")   # 500
shelf = doc.get("/api/accessories").json()

STL = b"solid x\n" + b"f " * 40 + b"\nendsolid x\n"
def upload_scan(oid, prefix=""):
    for slot in ["UPPER_ARCH", "LOWER_ARCH", "BITE"]:
        r = doc.post(
            f"/api/orders/{oid}/files",
            data={"category": "INTRAORAL_SCAN", "slot": slot},
            files={"upload": (f"{prefix}{slot}.stl", io.BytesIO(STL), "model/stl")},
        )
        if r.status_code >= 300:
            fails.append(f"scan upload {slot}: {r.status_code} {r.text[:110]}")

print("=" * 74)
print("BY-PRODUCT — Essix Retainer 1.0 mm, catalogue price 500")
print("=" * 74)

o = doc.post("/api/orders", json={
    "new_patient": {"full_name": "Product Patient"},
    "product_id": er["id"], "product_size_id": size["id"], "quantity": 1,
}).json()
oid = o["id"]
print(f"1. placed               status={o['status']}  label={o['status_label']}")
if o["status"] != "AWAITING_SCAN":
    fails.append(f"a by-product should start at AWAITING_SCAN, got {o['status']}")

d = doc.get(f"/api/orders/{oid}").json()
print(f"   asked for up front   {d['submit_blockers'] or 'nothing'}")
if d["submit_blockers"]:
    fails.append(f"a by-product is still gated on {d['submit_blockers']}")
if d["quotes"]:
    fails.append("a by-product was given a quote")

# The lab must not be able to band it.
r = lab.post(f"/api/staff/orders/{oid}/quotes",
             json={"category": "ALIGN_16_20", "extras": [], "tax": "0"})
print(f"2. lab tries a band     {r.status_code}  {str(r.json().get('detail',''))[:70]}")
if r.status_code != 400:
    fails.append(f"a by-product accepted an aligner band: {r.status_code}")

# The scan is what it actually waits on — and all three arches are required.
doc.post(f"/api/orders/{oid}/scan-route", json={"scan_route": "UPLOAD"})
r = doc.post(
    f"/api/orders/{oid}/files",
    data={"category": "INTRAORAL_SCAN", "slot": "UPPER_ARCH"},
    files={"upload": ("u.stl", io.BytesIO(STL), "model/stl")},
)
after_one = doc.get(f"/api/orders/{oid}").json()
print(f"3. one arch only        status={after_one['status']}  (still waiting)")
if after_one["status"] != "AWAITING_SCAN":
    fails.append("one arch should not advance the case")

for slot in ["LOWER_ARCH", "BITE"]:
    doc.post(
        f"/api/orders/{oid}/files",
        data={"category": "INTRAORAL_SCAN", "slot": slot},
        files={"upload": (f"{slot}.stl", io.BytesIO(STL), "model/stl")},
    )
d = doc.get(f"/api/orders/{oid}").json()
print(f"4. all three arches     status={d['status']}")
if d["status"] != "SCAN_SUBMITTED":
    fails.append(f"a complete scan should hand it to the lab, got {d['status']}")

r = lab.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": ""})
print(f"5. lab accepts scan     {r.status_code}  status={r.json().get('status')}  ref={r.json().get('order_number')}")
if r.json().get("status") != "PRODUCT_FABRICATION":
    fails.append(f"scan accept should reach the bench, got {r.json().get('status')}")

d = doc.get(f"/api/orders/{oid}").json()
money = {c["label"]: Decimal(c["amount"]) for c in d["charges"]}
print(f"6. charged              {money.get('Total for this order')}  (500 + 250 delivery)")
if money.get("Total for this order") != Decimal("750.00"):
    fails.append(f"by-product total {money.get('Total for this order')}")

print()
print("=" * 74)
print("ACCESSORY — 2 IPR strips")
print("=" * 74)
a = doc.post("/api/orders", json={
    "new_patient": {"full_name": "Accessory Patient"},
    "accessories": [{"accessory_id": shelf[2]["id"], "quantity": 2}],
}).json()
print(f"1. placed               status={a['status']}  label={a['status_label']}  ref={a['order_number']}")
if a["status"] != "PRODUCT_FABRICATION":
    fails.append(f"an accessory should start at packing, got {a['status']}")
ad = doc.get(f"/api/orders/{a['id']}").json()
print(f"   asked for up front   {ad['submit_blockers'] or 'nothing'}")
if ad["submit_blockers"]:
    fails.append(f"an accessory is gated on {ad['submit_blockers']}")
r = lab.post(f"/api/staff/orders/{a['id']}/quotes",
             json={"category": "ALIGN_16_20", "extras": [], "tax": "0"})
if r.status_code != 400:
    fails.append(f"an accessory accepted an aligner band: {r.status_code}")
print(f"2. lab tries a band     {r.status_code}  {str(r.json().get('detail',''))[:70]}")

print()
print("=" * 74)
print("ALIGNER — unchanged")
print("=" * 74)
al = doc.post("/api/orders", json={"new_patient": {"full_name": "Aligner Patient"}, "arch": "BOTH"}).json()
ad = doc.get(f"/api/orders/{al['id']}").json()
print(f"1. created              status={ad['status']}")
print(f"   asked for up front   {ad['submit_blockers']}")
if ad["status"] != "DRAFT":
    fails.append("an aligner case must still open as a draft")
if not ad["submit_blockers"]:
    fails.append("an aligner case must still require its records")

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
for slot in ["INTRAORAL_FRONTAL", "BUCCAL_RIGHT", "BUCCAL_LEFT", "OCCLUSAL_UPPER", "OCCLUSAL_LOWER"]:
    doc.post(f"/api/orders/{al['id']}/files",
             data={"category": "RECORD_PHOTO", "slot": slot},
             files={"upload": (f"{slot}.png", io.BytesIO(PNG), "image/png")})
doc.post(f"/api/orders/{al['id']}/files",
         data={"category": "OPG"},
         files={"upload": ("opg.png", io.BytesIO(PNG), "image/png")})
r = doc.post(f"/api/orders/{al['id']}/submit")
print(f"2. submitted            {r.status_code} status={r.json().get('status')}")
if r.json().get("status") != "SUBMITTED":
    fails.append(f"an aligner case must still stop at SUBMITTED, got {r.json().get('status')}")
lab.post(f"/api/staff/orders/{al['id']}/start-review", json={})
r = lab.post(f"/api/staff/orders/{al['id']}/quotes",
             json={"category": "ALIGN_16_20", "extras": [], "tax": "0"})
print(f"3. lab bands it         {r.status_code} status={r.json().get('status')}")
if r.status_code != 200:
    fails.append(f"an aligner case must still be quotable: {r.status_code} {r.text[:110]}")
r = doc.post(f"/api/orders/{al['id']}/quote/accept")
print(f"4. doctor accepts       {r.status_code} status={r.json().get('status')}")
if r.json().get("status") != "AWAITING_SCAN":
    fails.append("aligner quote acceptance broken")

print()
if fails:
    print("FAIL:\n  " + "\n  ".join(fails))
    raise SystemExit(1)
print("All checks passed.")
