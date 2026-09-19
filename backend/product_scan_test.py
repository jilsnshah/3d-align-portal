"""The appliances that do not fit the ordinary pattern.

    .venv/bin/python product_scan_test.py

Every by-product is made from three scans: an upper arch, a lower arch and a
bite. Two are not. A TMJ splint is built to a corrected jaw position and a
mandibular jaw-correction appliance to an advanced one, so each needs a second
bite taken where the appliance will hold the jaw — without it the lab is
guessing at the very thing the appliance exists to change.

Those same two are only ever made as an upper-and-lower pair, while every other
appliance is a tray per arch that the clinic orders however many of. So there
are two exceptions running together, and what is tested here is that each
applies to exactly the products it should and to no others.
"""
import io
import os
import tempfile

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mktemp(suffix='.db')}"
os.environ["SECRET_KEY"] = "x" * 32
os.environ["STAFF_EMAIL"] = "staff@e.com"
os.environ["STAFF_PASSWORD"] = "staffpassword"
os.environ["STORAGE_LOCAL_ROOT"] = tempfile.mkdtemp()

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
    db.query(Doctor).order_by(Doctor.created_at.desc()).first().verification_status = "VERIFIED"  # the doctor just registered; a real database already has others
    db.add(ShippingRate(city="Surat", amount=250))
    db.commit()
lab.post("/api/auth/login", json={"email": "staff@e.com", "password": "staffpassword"})

passed = failed = 0
STL = b"solid x\n" + b"f " * 40 + b"\nendsolid x\n"


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}   {detail}")


catalogue = {p["code"]: p for p in doc.get("/api/products").json()}


def order(code, **kw):
    p = catalogue[code]
    body = {"new_patient": {"first_name": "Riya", "last_name": "Mehta"},
            "product_id": p["id"], "product_size_id": p["sizes"][0]["id"]}
    body.update(kw)
    return doc.post("/api/orders", json=body)


def upload(oid, slot):
    return doc.post(f"/api/orders/{oid}/files",
                    data={"category": "INTRAORAL_SCAN", "slot": slot},
                    files={"upload": (f"{slot}.stl", io.BytesIO(STL), "model/stl")})


def scan_set(oid):
    d = doc.get(f"/api/orders/{oid}").json()
    group = next(g for g in d["record_sets"] if g["category"] == "INTRAORAL_SCAN")
    return d, group


print("=" * 72)
print("WHICH APPLIANCES ARE THE EXCEPTIONS")
print("=" * 72)

check("a TMJ splint asks for a correction bite",
      catalogue["TMJ"]["extra_scan_label"] == "Correction bite",
      catalogue["TMJ"]["extra_scan_label"])
check("jaw correction asks for an advancement bite",
      catalogue["JA"]["extra_scan_label"] == "Advancement bite",
      catalogue["JA"]["extra_scan_label"])
check("and both are made as a pair", catalogue["TMJ"]["both_arches"] and catalogue["JA"]["both_arches"])

others = [c for c in catalogue if c not in ("TMJ", "JA")]
check("no other appliance asks for a second bite",
      all(not catalogue[c]["extra_scan_slot"] for c in others),
      str({c: catalogue[c]["extra_scan_slot"] for c in others if catalogue[c]["extra_scan_slot"]}))
check("and no other is locked to both arches",
      all(not catalogue[c]["both_arches"] for c in others),
      str([c for c in others if catalogue[c]["both_arches"]]))

print()
print("=" * 72)
print("AN ORDINARY APPLIANCE — THREE SCANS, AND A COUNT PER ARCH")
print("=" * 72)

r = order("ER", quantity_upper=2, quantity_lower=1)
check("an Essix can be ordered two upper and one lower", r.status_code == 201, r.text[:140])
o = r.json()
oid = o["id"]
check("the split is recorded", (o["quantity_upper"], o["quantity_lower"]) == (2, 1),
      f"{o['quantity_upper']}/{o['quantity_lower']}")
check("the total is their sum", o["quantity"] == 3, o["quantity"])
check("and the arch says both, because both were asked for", o["arch"] == "BOTH", o["arch"])

# The price must not have moved: three trays cost what three sets always cost.
d = doc.get(f"/api/orders/{oid}").json()
row = next(p for p in d["payments"] if p["kind"] == "PRODUCT_ORDER")
unit = float(catalogue["ER"]["sizes"][0]["price"])
check("three trays are priced as three", float(row["amount"]) == unit * 3,
      f"{row['amount']} vs {unit * 3}")

_, group = scan_set(oid)
slots = [s["slot"] for s in group["slots"]]
check("it asks for exactly the three ordinary scans",
      slots == ["UPPER_ARCH", "LOWER_ARCH", "BITE"], str(slots))
for slot in ["UPPER_ARCH", "LOWER_ARCH", "BITE"]:
    upload(oid, slot)
check("and those three hand it to the lab",
      doc.get(f"/api/orders/{oid}").json()["status"] == "SCAN_SUBMITTED",
      doc.get(f"/api/orders/{oid}").json()["status"])

print()
print("=" * 72)
print("ONE ARCH ONLY")
print("=" * 72)
r = order("LEACH", quantity_upper=0, quantity_lower=2)
o = r.json()
check("a lower-only order is allowed", r.status_code == 201, r.text[:140])
check("counted as two", o["quantity"] == 2 and o["quantity_lower"] == 2,
      f"{o['quantity']}/{o['quantity_lower']}")
check("and the arch says lower", o["arch"] == "LOWER", o["arch"])

r = order("SG", quantity_upper=1, quantity_lower=0)
check("an upper-only order says upper", r.json()["arch"] == "UPPER", r.json()["arch"])

r = order("NG", quantity_upper=0, quantity_lower=0)
check("but nothing at all is refused", r.status_code == 400, f"{r.status_code} {r.text[:110]}")

print()
print("=" * 72)
print("A TMJ SPLINT — FOUR SCANS, AND SETS RATHER THAN ARCHES")
print("=" * 72)

r = order("TMJ", quantity=2)
check("it is ordered in sets", r.status_code == 201, r.text[:140])
t = r.json()
tid = t["id"]
check("two sets are two", t["quantity"] == 2, t["quantity"])
check("both arches, always", t["arch"] == "BOTH", t["arch"])
check("and no arch split is recorded, because there was no choice",
      (t["quantity_upper"], t["quantity_lower"]) == (0, 0),
      f"{t['quantity_upper']}/{t['quantity_lower']}")

# Naming arches on a paired appliance must not quietly change what is made.
r2 = order("TMJ", quantity_upper=5, quantity_lower=1)
check("an arch split sent for a paired appliance is ignored, not obeyed",
      r2.json()["arch"] == "BOTH" and r2.json()["quantity_upper"] == 0,
      f"{r2.json()['arch']} {r2.json()['quantity_upper']}")

_, group = scan_set(tid)
slots = [s["slot"] for s in group["slots"]]
check("it asks for a fourth scan",
      slots == ["UPPER_ARCH", "LOWER_ARCH", "BITE", "CORRECTION_BITE"], str(slots))
check("and it is required, not optional",
      all(s["required"] for s in group["slots"]),
      str([(s["slot"], s["required"]) for s in group["slots"]]))

for slot in ["UPPER_ARCH", "LOWER_ARCH", "BITE"]:
    upload(tid, slot)
d, group = scan_set(tid)
check("the ordinary three are not enough on their own", d["status"] == "AWAITING_SCAN",
      d["status"])
check("and it says which one is still missing",
      group["missing"] == ["Correction bite"], str(group["missing"]))

r = upload(tid, "CORRECTION_BITE")
check("the correction bite is accepted", r.status_code == 201, r.text[:140])
check("and completes the set",
      doc.get(f"/api/orders/{tid}").json()["status"] == "SCAN_SUBMITTED",
      doc.get(f"/api/orders/{tid}").json()["status"])
r = lab.post(f"/api/staff/orders/{tid}/scan/accept", json={"note": ""})
check("the lab can then take it on", r.json().get("status") == "PRODUCT_FABRICATION",
      r.text[:140])

print()
print("=" * 72)
print("JAW CORRECTION — THE SAME, WITH ITS OWN BITE")
print("=" * 72)

# The previous appliance is unpaid, and one unsettled by-product holds the next
# — so it is settled before this one is placed.
row = next(p for p in doc.get(f"/api/orders/{tid}").json()["payments"]
           if p["status"] != "VERIFIED")
lab.post(f"/api/staff/orders/{tid}/shipments", json={
    "shipment_type": "PRODUCT", "carrier": "X", "tracking_number": "T"})
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
doc.post(f"/api/orders/{tid}/payments/{row['id']}/proof", data={"reference": "UPI1"},
         files={"upload": ("r.png", io.BytesIO(PNG), "image/png")})
lab.post(f"/api/staff/orders/{tid}/payments/{row['id']}/verify",
         json={"approve": True, "reason": ""})

j = order("JA", quantity=1).json()
jid = j["id"]
_, group = scan_set(jid)
slots = [s["slot"] for s in group["slots"]]
check("jaw correction asks for the advancement bite instead",
      slots == ["UPPER_ARCH", "LOWER_ARCH", "BITE", "ADVANCEMENT_BITE"], str(slots))
check("not the correction bite — they are different appliances",
      "CORRECTION_BITE" not in slots, str(slots))

# A slot belonging to a different appliance must not be accepted here. Checked
# before the set is complete, because a finished set locks uploads for its own
# reason and would refuse this for the wrong one.
r = upload(jid, "CORRECTION_BITE")
check("the other appliance's bite is refused on this one", r.status_code == 400,
      f"{r.status_code} {r.text[:110]}")
check("and the message says what it will take instead",
      "ADVANCEMENT_BITE" in r.text, r.text[:140])

for slot in ["UPPER_ARCH", "LOWER_ARCH", "BITE", "ADVANCEMENT_BITE"]:
    upload(jid, slot)
check("all four hand it over",
      doc.get(f"/api/orders/{jid}").json()["status"] == "SCAN_SUBMITTED",
      doc.get(f"/api/orders/{jid}").json()["status"])

print()
print("=" * 72)
print("AN ALIGNER CASE IS UNTOUCHED BY ANY OF IT")
print("=" * 72)
al = doc.post("/api/orders", json={
    "new_patient": {"first_name": "Meera", "last_name": "Patel"},
    "arch": "BOTH", "intake": "SCAN_DIRECT"}).json()
_, group = scan_set(al["id"])
slots = [s["slot"] for s in group["slots"]]
check("a case still asks for three scans and no more",
      slots == ["UPPER_ARCH", "LOWER_ARCH", "BITE"], str(slots))
r = upload(al["id"], "CORRECTION_BITE")
check("and refuses an appliance's bite", r.status_code == 400, r.status_code)

print()
print("=" * 72)
print("SHELF ITEMS NAME NOBODY")
print("=" * 72)
shelf = doc.get("/api/accessories").json()
r = doc.post("/api/orders", json={"accessories": [{"accessory_id": shelf[0]["id"], "quantity": 3}]})
check("a shelf order is placed with no patient at all", r.status_code == 201, r.text[:140])
check("and reads as aligner accessories", r.json()["patient_name"] == "Aligner accessories",
      r.json()["patient_name"])
check("it goes straight to packing", r.json()["status"] == "PRODUCT_FABRICATION",
      r.json()["status"])

# A name sent anyway is ignored rather than refused: nothing about restocking
# is about a person, so there is nothing for it to mean.
r = doc.post("/api/orders", json={
    "new_patient": {"first_name": "Someone", "last_name": "Else"},
    "accessories": [{"accessory_id": shelf[0]["id"], "quantity": 1}]})
check("a name sent with a shelf order is ignored, not refused", r.status_code == 201,
      f"{r.status_code} {r.text[:110]}")
check("and it is still aligner accessories", r.json()["patient_name"] == "Aligner accessories",
      r.json()["patient_name"])

# An appliance is still made for someone, accessories riding along or not.
p = catalogue["ER"]
r = doc.post("/api/orders", json={
    "product_id": p["id"], "product_size_id": p["sizes"][0]["id"],
    "quantity_upper": 1, "quantity_lower": 0,
    "accessories": [{"accessory_id": shelf[0]["id"], "quantity": 1}]})
check("but an appliance with accessories on it still needs a patient",
      r.status_code == 400, f"{r.status_code} {r.text[:110]}")

print()
print("=" * 72)
print("THE CATALOGUE CARDS")
print("=" * 72)
import pathlib  # noqa: E402

from app.services.catalogue import IMAGES  # noqa: E402

PUBLIC = pathlib.Path(__file__).resolve().parent.parent / "frontend" / "public"
for code, url in sorted(IMAGES.items()):
    on_disk = PUBLIC / url.lstrip("/")
    check(f"{code}'s card is actually shipped", on_disk.is_file(), str(on_disk))

for code, product in sorted(catalogue.items()):
    if code in IMAGES:
        check(f"{code} shows its card", product["image_url"] == IMAGES[code],
              product["image_url"])
    else:
        check(f"{code} has no card and says so", product["image_url"] == "",
              product["image_url"])

# The cards are ours to keep correct, so one withdrawn from the catalogue has
# to stop being served from a path that no longer exists — while a photograph
# the lab put up itself is left alone.
from app.db import SessionLocal as _S  # noqa: E402
from app.models import Product as _P  # noqa: E402
from app.services.catalogue import ensure_products  # noqa: E402

with _S() as db:
    er = db.query(_P).filter(_P.code == "ER").one()
    abp = db.query(_P).filter(_P.code == "ABP").one()
    er.image_url = "/products/WITHDRAWN.jpg"
    abp.image_url = "https://the-lab-put-this-here.example/abp.png"
    db.commit()
    ensure_products(db)
    db.commit()
    db.refresh(er)
    db.refresh(abp)
    check("a card we no longer ship is replaced by the one we do",
          er.image_url == IMAGES["ER"], er.image_url)
    check("and a picture the lab put up itself is left alone",
          abp.image_url == "https://the-lab-put-this-here.example/abp.png", abp.image_url)

    # And withdrawing one entirely clears it rather than leaving a dead path.
    er.image_url = "/products/GONE.jpg"
    db.commit()
    saved = IMAGES.pop("ER")
    try:
        ensure_products(db)
        db.commit()
        db.refresh(er)
        check("a product dropped from the map loses its card", er.image_url == "",
              er.image_url)
    finally:
        IMAGES["ER"] = saved

print()
print(f"{passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
