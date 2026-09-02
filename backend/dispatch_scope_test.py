"""Phases and their photographs belong to aligner cases and to nothing else.

    .venv/bin/python dispatch_scope_test.py

A by-product and an accessory go out in one parcel. They have no phases to
divide, no training aligner to fit, and no progress to photograph. Three ways
in were open anyway, because each was gated on status alone and both kinds
reach DISPATCHING like anything else that ships:

  * an ALIGNER_PHASE shipment was accepted on a by-product;
  * progress photographs opened at DISPATCHING;
  * phase-fit photographs did the same.

This drives both kinds to delivery and asserts every door is shut, while the
scan and the clinical photographs a by-product does use stay open.
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
from app.models import Doctor, Order, ShippingRate  # noqa: E402

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
STL = b"solid x\n" + b"f " * 40 + b"\nendsolid x\n"

products = doc.get("/api/products").json()
er = next(p for p in products if p["code"] == "ER")
size = er["sizes"][0]
shelf = doc.get("/api/accessories").json()


def audit(label, oid, expect_status):
    d = doc.get(f"/api/orders/{oid}").json()
    print(f"  {label:<22} status={d['status']:<20} "
          f"dispatch_mode={d.get('dispatch_mode')}  "
          f"phase_count={d.get('phase_count')}  "
          f"phases={len(d.get('phase_plan') or [])}  divided={d.get('phases_divided')}")
    if d["status"] != expect_status:
        fails.append(f"{label}: status {d['status']} != {expect_status}")
    if d.get("dispatch_mode") is not None:
        fails.append(f"{label}: has a dispatch mode")
    if d.get("phase_count"):
        fails.append(f"{label}: has a phase count")
    if d.get("phase_plan"):
        fails.append(f"{label}: has phases")
    if d.get("phases_divided"):
        fails.append(f"{label}: reads as divided")
    return d


print("BY-PRODUCT")
o = doc.post("/api/orders", json={
    "new_patient": {"full_name": "P"}, "product_id": er["id"],
    "product_size_id": size["id"], "quantity": 1,
}).json()
oid = o["id"]
audit("placed", oid, "AWAITING_SCAN")

doc.post(f"/api/orders/{oid}/scan-route", json={"scan_route": "UPLOAD"})
for slot in ["UPPER_ARCH", "LOWER_ARCH", "BITE"]:
    doc.post(f"/api/orders/{oid}/files",
             data={"category": "INTRAORAL_SCAN", "slot": slot},
             files={"upload": (f"{slot}.stl", io.BytesIO(STL), "model/stl")})
lab.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": ""})
audit("on the bench", oid, "PRODUCT_FABRICATION")

# The clinic cannot ask for phases: the route that sets them is gated on a
# status a by-product never reaches.
r = doc.post(f"/api/orders/{oid}/fit-review",
             json={"fits": True, "dispatch_mode": "PHASED", "phase_count": 3})
print(f"  asking for phases      {r.status_code}  {str(r.json().get('detail',''))[:60]}")
if r.status_code < 400:
    fails.append("a by-product accepted a dispatch mode")

r = lab.post(f"/api/staff/orders/{oid}/shipments", json={
    "shipment_type": "PRODUCT", "carrier": "Shree Tirupati", "tracking_number": "T1"})
print(f"  one shipment           {r.status_code}  status={r.json().get('status')}")
if r.status_code != 200:
    fails.append(f"by-product should ship in one go: {r.text[:100]}")
d = audit("dispatched", oid, "DISPATCHING")
if len(d.get("shipments") or []) != 1:
    fails.append(f"expected exactly one shipment, got {len(d.get('shipments') or [])}")

# A second shipment on the same order would be the phased behaviour leaking in.
r = lab.post(f"/api/staff/orders/{oid}/shipments", json={
    "shipment_type": "ALIGNER_PHASE", "carrier": "X", "tracking_number": "T2",
    "aligner_range_to": 5})
print(f"  a phase shipment       {r.status_code}  {str(r.json().get('detail',''))[:60]}")
if r.status_code < 400:
    fails.append("a by-product accepted an aligner-phase shipment")

# Progress and phase-fit photographs open at DISPATCHING, which a by-product
# reaches — so status alone never kept them off it.
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
for cat in ["PROGRESS_PHOTO", "PHASE_FIT_PHOTO", "FIT_ISSUE_PHOTO"]:
    r = doc.post(f"/api/orders/{oid}/files",
                 data={"category": cat, "slot": "PROGRESS_UPPER_IN"},
                 files={"upload": ("p.png", io.BytesIO(PNG), "image/png")})
    print(f"  {cat:<18}     {r.status_code}  {str(r.json().get('detail',''))[:58]}")
    if r.status_code < 400:
        fails.append(f"a by-product accepted a {cat}")
    # The lab must not be able to put one there either.
    r = lab.post(f"/api/staff/orders/{oid}/files" if False else f"/api/orders/{oid}/files",
                 data={"category": cat, "slot": "PROGRESS_UPPER_IN"},
                 files={"upload": ("p.png", io.BytesIO(PNG), "image/png")})
    if r.status_code < 400:
        fails.append(f"the lab put a {cat} on a by-product")

# And the panel does not appear on the case page.
sets = {rs["category"] for rs in doc.get(f"/api/orders/{oid}").json()["record_sets"]}
print(f"  panels shown           {sorted(sets)}")
for banned in ["PROGRESS_PHOTO", "PHASE_FIT_PHOTO", "FIT_ISSUE_PHOTO", "TREATMENT_PLAN"]:
    if banned in sets:
        fails.append(f"a by-product shows a {banned} panel")
if "INTRAORAL_SCAN" not in sets:
    fails.append("a by-product should still show the scan panel")
if "RECORD_PHOTO" not in sets:
    fails.append("a by-product should still show clinical photographs")

# One parcel, delivered, nothing after it — the order finishes itself rather
# than waiting for someone to confirm what the delivery already said.
ship = doc.get(f"/api/orders/{oid}").json()["shipments"][0]
r = doc.post(f"/api/orders/{oid}/shipments/{ship['id']}/delivered")
print(f"  marked delivered       {r.status_code}  status={r.json().get('status')}")
if r.json().get("status") != "COMPLETED":
    fails.append(f"a delivered by-product should complete itself, got {r.json().get('status')}")

print()
print("ACCESSORY")
a = doc.post("/api/orders", json={
    "accessories": [{"accessory_id": shelf[0]["id"], "quantity": 2}]}).json()
aid = a["id"]
audit("placed", aid, "PRODUCT_FABRICATION")
r = doc.post(f"/api/orders/{aid}/fit-review",
             json={"fits": True, "dispatch_mode": "PHASED", "phase_count": 2})
print(f"  asking for phases      {r.status_code}  {str(r.json().get('detail',''))[:60]}")
if r.status_code < 400:
    fails.append("an accessory accepted a dispatch mode")

print()
print("DATABASE")
with SessionLocal() as db:
    for row in db.query(Order).all():
        if row.kind in ("PRODUCT", "ACCESSORY"):
            if row.phases:
                fails.append(f"{row.reference}: {len(row.phases)} phase row(s) in the database")
            if row.dispatch_mode is not None:
                fails.append(f"{row.reference}: dispatch_mode {row.dispatch_mode}")
    print("  no phase rows on any non-aligner order"
          if not fails else "  see failures")

print()
if fails:
    print("FAIL:\n  " + "\n  ".join(fails))
    raise SystemExit(1)
print("All checks passed.")
