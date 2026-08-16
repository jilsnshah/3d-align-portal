"""Build one case with a deliberately messy records history.

    .venv/bin/python seed_records.py

Produces what a real case looks like after a few rounds: photo views retaken
individually, a scan set rejected and re-shot, one view still missing, and a
couple of files sitting in the recycle bin. Useful for seeing how revisions,
slots and the bin render together.

Talks to the API over HTTP, so nothing bypasses validation.
"""

import io
import struct
import sys
import zlib
from typing import Optional

import requests

BASE = "http://127.0.0.1:8000/api"
ADMIN = {"email": "staff@3dalign.com", "password": "changeme"}
DOCTOR = {"email": "dr.mehta@clinic.example.com", "password": "alignerdemo123"}
PATIENT = "Nikhil Bhatt"


def die(message: str, response: Optional[requests.Response] = None) -> None:
    print(f"\n  {message}")
    if response is not None:
        print(f"  {response.status_code} {response.text[:300]}")
    sys.exit(1)


def check(response: requests.Response, what: str) -> dict:
    if response.status_code >= 400:
        die(f"Failed to {what}.", response)
    return response.json() if response.content else {}


def png(r: int, g: int, b: int, w: int = 520, h: int = 390) -> bytes:
    """A solid-colour PNG, so the explorer previews show something real."""
    raw = b"".join(b"\x00" + bytes([r, g, b]) * w for _ in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


admin = requests.Session()
doctor = requests.Session()

try:
    requests.get(f"{BASE}/health", timeout=3)
except requests.exceptions.ConnectionError:
    die("The API is not running. Start it with:\n"
        "  .venv/bin/python -m uvicorn app.main:app --reload --port 8000")

check(admin.post(f"{BASE}/auth/login", json=ADMIN), "sign in as admin")
if doctor.post(f"{BASE}/auth/login", json=DOCTOR).status_code >= 400:
    die("The demo doctor is missing. Run seed_demo.py first.")


def put(session, order_id, category, slot, name, payload, mime):
    return session.post(
        f"{BASE}/orders/{order_id}/files",
        data={"category": category, "slot": slot},
        files={"upload": (name, io.BytesIO(payload), mime)},
    )


photo = lambda s, o, slot, name, rgb: put(s, o, "RECORD_PHOTO", slot, name, png(*rgb), "image/png")
stl = lambda s, o, slot, name: put(s, o, "INTRAORAL_SCAN", slot, name, b"solid demo" * 700, "model/stl")

VIEWS = [
    ("INTRAORAL_FRONTAL", (198, 122, 118)),
    ("BUCCAL_RIGHT", (178, 134, 110)),
    ("BUCCAL_LEFT", (178, 110, 134)),
    ("OCCLUSAL_UPPER", (148, 150, 182)),
    ("OCCLUSAL_LOWER", (148, 182, 150)),
    ("FACE_SMILE", (216, 200, 172)),
]

print("Creating the case…")
order = check(
    doctor.post(
        f"{BASE}/orders",
        json={
            "new_patient": {"full_name": PATIENT},
            "arch": "BOTH",
            "chief_complaint": "Crowding with a rotated 12. Wants a clear option.",
            "clinical_notes": "Periodontally stable. IPR acceptable to the patient.",
        },
    ),
    "create the case",
)
oid = order["id"]
print(f"  {order['order_number']} — {PATIENT}")

# --- round 1 of records, shot at the clinic ---------------------------------
print("\nRound 1 — clinic shoots the photo series")
for slot, rgb in VIEWS:
    photo(doctor, oid, slot, f"v1-{slot.lower()}.png", rgb)
put(doctor, oid, "OPG", "", "v1-opg.png", png(58, 58, 68, 780, 390), "image/png")
print(f"  {len(VIEWS)} photo views + OPG at v1")

# One view retaken immediately — the first frontal was blurred. Same revision,
# so the earlier shot goes to the bin rather than becoming a v2.
photo(doctor, oid, "INTRAORAL_FRONTAL", "v1-frontal-retake.png", (206, 128, 124))
print("  frontal retaken within v1 — the blurred one goes to the bin")

check(doctor.post(f"{BASE}/orders/{oid}/submit"), "submit")
check(admin.post(f"{BASE}/staff/orders/{oid}/start-review"), "start review")

# --- the lab bounces it back, which opens revision 2 ------------------------
print("\nLab asks for better records — opens v2")
check(
    admin.post(
        f"{BASE}/staff/orders/{oid}/request-records",
        json={"note": "Occlusal views are out of focus and the OPG is clipped on the left."},
    ),
    "request records",
)
for slot, rgb in [
    ("OCCLUSAL_UPPER", (140, 144, 190)),
    ("OCCLUSAL_LOWER", (140, 190, 144)),
    ("INTRAORAL_FRONTAL", (202, 126, 120)),
    ("BUCCAL_RIGHT", (172, 130, 106)),
    ("BUCCAL_LEFT", (172, 106, 130)),
]:
    photo(doctor, oid, slot, f"v2-{slot.lower()}.png", rgb)
put(doctor, oid, "OPG", "", "v2-opg.png", png(52, 52, 62, 800, 400), "image/png")
print("  5 views re-shot at v2 — the v1 round stays on file, superseded")
print("  (face smiling deliberately not re-shot, so v2 is missing an optional view)")

check(doctor.post(f"{BASE}/orders/{oid}/resubmit"), "resubmit")
check(
    admin.post(
        f"{BASE}/staff/orders/{oid}/quotes",
        json={
                        "category": "ALIGN_16_20",
            "tax": "7920",
        },
    ),
    "send the quote",
)
check(doctor.post(f"{BASE}/orders/{oid}/quote/accept"), "accept the quote")

# --- scan round 1, rejected -------------------------------------------------
print("\nScan v1 — uploaded, then rejected")
check(doctor.post(f"{BASE}/orders/{oid}/scan-route", json={"route": "UPLOAD"}), "choose upload")
for slot in ("UPPER_ARCH", "LOWER_ARCH", "BITE"):
    stl(doctor, oid, slot, f"v1-{slot.lower()}.stl")
print("  upper, lower and bite at v1 — case moved to review")
check(
    admin.post(
        f"{BASE}/staff/orders/{oid}/scan/reject",
        json={"note": "Distal of 47 is cut off and the bite does not seat."},
    ),
    "reject the scan",
)
print("  rejected — opens scan v2")

# --- scan round 2, deliberately incomplete ---------------------------------
for slot in ("UPPER_ARCH", "LOWER_ARCH"):
    stl(doctor, oid, slot, f"v2-{slot.lower()}.stl")
print("  upper and lower re-shot at v2; bite left missing on purpose")

# --- something in the bin --------------------------------------------------
detail = check(doctor.get(f"{BASE}/orders/{oid}"), "read the case")
photos = [s for s in detail["record_sets"] if s["category"] == "RECORD_PHOTO"][0]
spare = next((s["file"] for s in photos["slots"] if s["file"] and s["slot"] == "BUCCAL_LEFT"), None)
if spare:
    doctor.delete(f"{BASE}/orders/{oid}/files/{spare['id']}")
    print("\n  buccal left deleted — sits in the bin, recoverable")

# --- what it looks like now -------------------------------------------------
detail = check(doctor.get(f"{BASE}/orders/{oid}"), "read the case")
print(f"\n{order['order_number']} — {PATIENT}")
print(f"  status={detail['status']}  scan_complete={detail['scan_complete']}  bin={detail['binned_count']}\n")
for rs in detail["record_sets"]:
    state = "complete" if rs["complete"] else f"missing: {', '.join(rs['missing'])}" if rs["missing"] else "—"
    print(f"  {rs['label']:<22} v{rs['revision']}  {state}")
    for slot_state in rs["slots"]:
        mark = slot_state["file"]["filename"] if slot_state["file"] else ("— empty —" if slot_state["required"] else "— optional —")
        print(f"      {slot_state['label']:<22} {mark}")
    for extra in rs["extras"]:
        tag = "(current)" if extra["is_current"] else "(superseded)"
        print(f"      {tag:<22} v{extra['revision']} {extra['slot_label'] or extra['filename']}")

print(f"""
Open it as either:
  Doctor  {DOCTOR['email']} / {DOCTOR['password']}
  Admin   {ADMIN['email']} / {ADMIN['password']}
""")
