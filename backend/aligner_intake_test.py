"""The two doors into an aligner case.

    .venv/bin/python aligner_intake_test.py

A clinic that already has the patient in the chair with a scanner running does
not need an estimate first — it needs to hand the lab a scan. A clinic weighing
up whether to treat at all needs the estimate before anything else. Those are
two different questions, and the portal only ever asked the second one:

  photographs -> lab reads them -> expected quote -> clinic accepts -> scan

This adds the first door beside it, without moving the second:

  scan -> lab verifies it -> planning

Both meet at SCAN_SUBMITTED and share every stage after it. What is being
tested is that they meet there and nowhere earlier: that a direct case is never
asked for photographs it does not need or a quote it did not want, that a
quoted case still walks the path it always did, and that neither door can be
used to skip a step of the other.
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
from app.models import BookingSettings, Doctor, ShippingRate  # noqa: E402

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
    s = db.query(BookingSettings).first()
    if s is not None:
        s.upi_vpa = "3dalign@okhdfcbank"
    db.commit()
lab.post("/api/auth/login", json={"email": "staff@e.com", "password": "staffpassword"})

passed = failed = 0
STL = b"solid x\n" + b"f " * 40 + b"\nendsolid x\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
PHOTO_SLOTS = ["INTRAORAL_FRONTAL", "BUCCAL_RIGHT", "BUCCAL_LEFT",
               "OCCLUSAL_UPPER", "OCCLUSAL_LOWER"]


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}   {detail}")


def new_case(name, intake=None):
    body = {"new_patient": {"first_name": name, "last_name": ""}, "arch": "BOTH"}
    if intake is not None:
        body["intake"] = intake
    return doc.post("/api/orders", json=body)


def upload_records(oid):
    for slot in PHOTO_SLOTS:
        doc.post(f"/api/orders/{oid}/files", data={"category": "RECORD_PHOTO", "slot": slot},
                 files={"upload": (f"{slot}.png", io.BytesIO(PNG), "image/png")})
    doc.post(f"/api/orders/{oid}/files", data={"category": "OPG"},
             files={"upload": ("opg.png", io.BytesIO(PNG), "image/png")})


def upload_scan(oid):
    doc.post(f"/api/orders/{oid}/scan-route", json={"scan_route": "UPLOAD"})
    last = None
    for slot in ["UPPER_ARCH", "LOWER_ARCH", "BITE"]:
        last = doc.post(f"/api/orders/{oid}/files",
                        data={"category": "INTRAORAL_SCAN", "slot": slot},
                        files={"upload": (f"{slot}.stl", io.BytesIO(STL), "model/stl")})
    return last


def get(oid):
    return doc.get(f"/api/orders/{oid}").json()


print("=" * 72)
print("THE DIRECT DOOR — a scan, and nothing else asked for")
print("=" * 72)

r = new_case("Direct Patient", "SCAN_DIRECT")
check("a case can be opened asking for the direct door", r.status_code in (200, 201), r.text[:140])
direct = r.json()
oid = direct["id"]

# The whole point: the clinic already has the scan, so the case must not sit in
# a draft waiting for photographs the lab is not going to read.
check("it goes straight to awaiting the scan", direct["status"] == "AWAITING_SCAN",
      direct["status"])
check("and it is still an aligner case", direct["kind"] == "ALIGNER", direct["kind"])
check("the door it came in by is on the record", direct.get("intake") == "SCAN_DIRECT",
      str(direct.get("intake")))
check("nothing is outstanding before it can be worked on",
      direct["missing_categories"] == [], str(direct["missing_categories"]))

d = get(oid)
photo_groups = [g for g in d.get("file_groups", []) if g["category"] == "RECORD_PHOTO"]
if photo_groups:
    required_views = [s for s in photo_groups[0]["slots"] if s.get("required")]
    check("no photograph is marked required on a direct case", required_views == [],
          str([s["slot"] for s in required_views]))

# There is no estimate on this route, so there must be nothing pretending to be
# one — that is the bug that quoted a ₹500 retainer at ₹40,000.
check("no quote was raised", not d.get("quotes"), str(d.get("quotes"))[:100])
check("and no money is owed yet", not d.get("payments"), str(d.get("payments"))[:100])

print()
print("=" * 72)
print("IT MEETS THE OLD PATH AT THE SCAN, AND SHARES EVERYTHING AFTER")
print("=" * 72)

r = upload_scan(oid)
check("uploading the scan hands the case to the lab", r.status_code in (200, 201),
      r.text[:120])
d = get(oid)
check("which reads as scan under review", d["status"] == "SCAN_SUBMITTED", d["status"])
# It is still an enquiry: the AL series is only spent when a case reaches
# planning, and skipping the estimate must not skip that.
check("it is still on its enquiry number", (d.get("order_number") or "").startswith("EN-"),
      str(d.get("order_number")))

r = lab.post(f"/api/staff/orders/{oid}/scan/accept", json={"note": ""})
check("an accepted scan reaches planning", r.json().get("status") == "IN_PLANNING",
      r.text[:120])
check("and that is what spends the AL number",
      (r.json().get("order_number") or "").startswith("AL-"), str(r.json().get("order_number")))

# From here the case is indistinguishable from one that came in the other door.
for cat in ["TREATMENT_PLAN", "SIMULATION_MODEL"]:
    lab.post(f"/api/orders/{oid}/files", data={"category": cat},
             files={"upload": (f"{cat.lower()}.stl", io.BytesIO(STL), "model/stl")})
r = lab.post(f"/api/staff/orders/{oid}/plans",
             json={"aligners_upper": 18, "aligners_lower": 16, "final_price": "72000"})
check("the lab prices it at the plan, which is where its price comes from",
      r.status_code == 200, r.text[:140])
d = get(oid)
check("the case reaches plan shared", d["status"] == "PLAN_SHARED", d["status"])
plan_fee = next((p for p in d["payments"] if p["kind"] == "TREATMENT_PLAN"), None)
check("and the plan fee is raised exactly as on a quoted case", plan_fee is not None,
      str([p["kind"] for p in d["payments"]]))

print()
print("=" * 72)
print("THE QUOTED DOOR IS UNCHANGED")
print("=" * 72)

r = new_case("Quoted Patient")
quoted = r.json()
qid = quoted["id"]
check("a case opened with no door named still opens as a draft",
      quoted["status"] == "DRAFT", quoted["status"])
check("and is recorded as taking the quote first",
      quoted.get("intake") == "QUOTE_FIRST", str(quoted.get("intake")))
check("it is asked for its records before anything else",
      "RECORD_PHOTO" in quoted["missing_categories"], str(quoted["missing_categories"]))

r = doc.post(f"/api/orders/{qid}/submit")
check("and it cannot be submitted without them", r.status_code == 400, r.text[:120])

upload_records(qid)
r = doc.post(f"/api/orders/{qid}/submit")
check("with them it submits", r.json().get("status") == "SUBMITTED", r.text[:120])
lab.post(f"/api/staff/orders/{qid}/start-review", json={})
r = lab.post(f"/api/staff/orders/{qid}/quotes",
             json={"category": "ALIGN_16_20", "extras": [], "tax": "0"})
check("the lab still quotes it", r.status_code == 200, r.text[:120])
r = doc.post(f"/api/orders/{qid}/quote/accept")
check("and accepting still opens the scan stage",
      r.json().get("status") == "AWAITING_SCAN", r.text[:120])
upload_scan(qid)
check("its scan reaches the lab the same way", get(qid)["status"] == "SCAN_SUBMITTED",
      get(qid)["status"])

print()
print("=" * 72)
print("NEITHER DOOR IS A WAY ROUND THE OTHER")
print("=" * 72)

# The direct door must not become a way to be quoted without records, nor the
# quoted door a way to skip the estimate.
r = new_case("Not Reviewable", "SCAN_DIRECT")
sid = r.json()["id"]
r = lab.post(f"/api/staff/orders/{sid}/start-review", json={})
check("a direct case cannot be pulled into records review", r.status_code >= 400,
      f"{r.status_code} {r.text[:100]}")
r = lab.post(f"/api/staff/orders/{sid}/quotes",
             json={"category": "ALIGN_16_20", "extras": [], "tax": "0"})
check("and it cannot be quoted", r.status_code >= 400, f"{r.status_code} {r.text[:100]}")

r = new_case("Still Needs Quote")
nid = r.json()["id"]
upload_records(nid)
doc.post(f"/api/orders/{nid}/submit")
r = doc.post(f"/api/orders/{nid}/scan-route", json={"scan_route": "UPLOAD"})
r = doc.post(f"/api/orders/{nid}/files", data={"category": "INTRAORAL_SCAN", "slot": "UPPER_ARCH"},
             files={"upload": ("u.stl", io.BytesIO(STL), "model/stl")})
check("a quoted case cannot reach the lab by uploading a scan early",
      get(nid)["status"] == "SUBMITTED", get(nid)["status"])

# A rejected value must be refused rather than silently treated as the default.
r = doc.post("/api/orders", json={"new_patient": {"first_name": "Nonsense", "last_name": ""},
                                  "arch": "BOTH", "intake": "SOMETHING_ELSE"})
check("an unknown door is refused", r.status_code == 422, r.status_code)

print()
print("=" * 72)
print("THE OTHER KINDS ARE UNTOUCHED BY ANY OF IT")
print("=" * 72)

products = doc.get("/api/products").json()
er = next(p for p in products if p["code"] == "ER")
size = next(s for s in er["sizes"] if s["label"] == "1.0 mm")
r = doc.post("/api/orders", json={
    "new_patient": {"first_name": "Retainer", "last_name": "Patient"},
    "product_id": er["id"], "product_size_id": size["id"], "quantity": 1})
check("a by-product still goes straight to its scan",
      r.json().get("status") == "AWAITING_SCAN", r.json().get("status"))
check("and is not marked as taking either aligner door",
      r.json().get("intake") in (None, "", "QUOTE_FIRST"), str(r.json().get("intake")))

# Naming the direct door on a by-product must not change what it is or where
# it goes — the field belongs to aligner cases.
r = doc.post("/api/orders", json={
    "new_patient": {"first_name": "Retainer", "last_name": "Two"},
    "product_id": er["id"], "product_size_id": size["id"], "quantity": 1,
    "intake": "SCAN_DIRECT"})
check("naming a door on a by-product changes nothing about it",
      r.status_code in (200, 201) and r.json().get("kind") == "PRODUCT"
      and r.json().get("status") == "AWAITING_SCAN",
      f"{r.status_code} {r.json().get('kind')} {r.json().get('status')}")

shelf = doc.get("/api/accessories").json()
r = doc.post("/api/orders", json={"accessories": [{"accessory_id": shelf[0]["id"], "quantity": 1}]})
check("an accessory order still goes straight to packing",
      r.json().get("status") == "PRODUCT_FABRICATION", r.json().get("status"))

print()
print("=" * 72)
print("A DISCOUNT ON THE EXPECTED QUOTE")
print("=" * 72)

r = new_case("Discounted Patient")
did = r.json()["id"]
upload_records(did)
doc.post(f"/api/orders/{did}/submit")
lab.post(f"/api/staff/orders/{did}/start-review", json={})

# What the band costs on its own, so the discount can be checked against it
# rather than against a number typed into the test.
r = lab.post(f"/api/staff/orders/{did}/quotes",
             json={"category": "ALIGN_16_20", "extras": [], "tax": "0"})
plain = r.json()["quotes"][-1]
band_low, band_high = Decimal(plain["total"]), Decimal(plain["total_max"])

r = lab.post(f"/api/staff/orders/{did}/quotes", json={
    "category": "ALIGN_16_20", "extras": [], "tax": "0",
    "discount": "5000", "discount_reason": "Introductory offer"})
check("the lab can discount the estimate", r.status_code == 200, r.text[:140])
q = r.json()["quotes"][-1]
check("the discount is on the quote", Decimal(q["discount"]) == Decimal("5000"),
      q["discount"])
check("with the reason it was given for", q["discount_reason"] == "Introductory offer",
      q["discount_reason"])
check("it comes off the low end of the band",
      Decimal(q["total"]) == band_low - 5000, f"{q['total']} vs {band_low - 5000}")
check("and off the high end by the same amount — one case, not a proportion",
      Decimal(q["total_max"]) == band_high - 5000, f"{q['total_max']} vs {band_high - 5000}")
check("the subtotal still says what the treatment costs before it",
      Decimal(q["subtotal"]) == Decimal(plain["subtotal"]), q["subtotal"])

# Tax is charged on what is actually being asked for, not on the pre-discount
# figure — a clinic taxed on money it is not paying would be overcharged.
r = lab.post(f"/api/staff/orders/{did}/quotes", json={
    "category": "ALIGN_16_20", "extras": [], "tax": "900",
    "discount": "5000", "discount_reason": "Introductory offer"})
q = r.json()["quotes"][-1]
check("tax is added after the discount, not before",
      Decimal(q["total"]) == band_low - 5000 + 900,
      f"{q['total']} vs {band_low - 5000 + 900}")

r = lab.post(f"/api/staff/orders/{did}/quotes", json={
    "category": "ALIGN_16_20", "extras": [], "tax": "0", "discount": "999999"})
check("a discount larger than the estimate is refused", r.status_code == 400,
      f"{r.status_code} {r.text[:100]}")
r = lab.post(f"/api/staff/orders/{did}/quotes", json={
    "category": "ALIGN_16_20", "extras": [], "tax": "0", "discount": "-100"})
check("and a negative one is not a discount at all", r.status_code == 422, r.status_code)

# What the clinic accepts is what the clinic is held to.
q = doc.get(f"/api/orders/{did}").json()["quotes"][-1]
check("the clinic is shown the discounted figure",
      Decimal(q["total"]) == band_low - 5000 + 900, q["total"])
r = doc.post(f"/api/orders/{did}/quote/accept")
check("and accepting it opens the scan stage as ever",
      r.json().get("status") == "AWAITING_SCAN", r.text[:120])

print()
print("=" * 72)
print("A PATIENT IS NAMED IN TWO FIELDS")
print("=" * 72)

r = doc.post("/api/patients", json={"first_name": "Riya", "last_name": "Mehta", "sex": "F"})
check("a patient is created from a first and last name", r.status_code == 201, r.text[:120])
p = r.json()
check("both are kept apart", (p["first_name"], p["last_name"]) == ("Riya", "Mehta"), str(p))
check("and joined for everything that reads one name",
      p["full_name"] == "Riya Mehta", p["full_name"])
check("the chart number is gone", "external_ref" not in p, str(p.keys()))

r = doc.post("/api/patients", json={"first_name": "Meera"})
check("a patient with one name keeps it", r.json()["full_name"] == "Meera",
      repr(r.json()["full_name"]))
check("and gains no trailing space", r.json()["full_name"] == r.json()["full_name"].strip(),
      repr(r.json()["full_name"]))

r = doc.post("/api/patients", json={"first_name": "  Arjun  ", "last_name": "  Shah "})
check("whitespace either side is not part of the name",
      r.json()["full_name"] == "Arjun Shah", repr(r.json()["full_name"]))

r = doc.post("/api/patients", json={"first_name": "", "last_name": "Shah"})
check("a patient must have a first name", r.status_code == 422, r.status_code)

# The name the boards read has to be the joined one.
r = doc.post("/api/orders", json={
    "new_patient": {"first_name": "Kabir", "last_name": "Rao"}, "arch": "BOTH"})
check("a case names its patient by both",
      r.json()["patient_name"] == "Kabir Rao", r.json()["patient_name"])

# And it has to be findable by either half.
for needle in ["Kabir", "Rao"]:
    found = doc.get(f"/api/orders?search={needle}").json()
    check(f"the case is findable by {needle!r}",
          any(o["patient_name"] == "Kabir Rao" for o in found),
          str([o["patient_name"] for o in found]))

print()
print(f"{passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
