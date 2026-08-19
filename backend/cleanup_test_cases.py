"""Removes cases created while exercising the system, before a client sees it.

Cancellation, handover and address flows were all verified against live data,
which left patients called "Force Test" and "Handover Edge" sitting in the case
list. Their stored files go too, so the disk does not keep 34 meshes for a case
nobody will open again.

    .venv/bin/python cleanup_test_cases.py [--dry-run]
"""

import pathlib
import re
import sys

from app.config import settings
from app.db import SessionLocal
from app.models import Order, Patient
from app.services import meshes

DRY = "--dry-run" in sys.argv

TEST_NAME = re.compile(
    r"^(force test|walk-in test|visit address test|handover edge|cancel test|edge test|"
    r"no-show test|enroute test|race |proof$|handover$|sim |pinned|probe|test )",
    re.I,
)

db = SessionLocal()
root = pathlib.Path(settings.storage_local_root)

patients = [p for p in db.query(Patient).all() if TEST_NAME.match(p.full_name or "")]
ids = {p.id for p in patients}
orders = [o for o in db.query(Order).all() if o.patient_id in ids]

freed = 0
blobs: list[pathlib.Path] = []
for order in orders:
    for f in order.files:
        target = root / f.storage_ref
        if target.is_file():
            freed += target.stat().st_size
            blobs.append(target)
        cached = meshes.cache_path(root, f.storage_ref)
        if cached.is_file():
            freed += cached.stat().st_size
            blobs.append(cached)

print(f"{len(orders)} case(s), {len(patients)} patient(s), {len(blobs)} stored file(s)")
for order in orders:
    live = len([f for f in order.files if not f.is_deleted])
    print(f"   {order.reference:<14} {order.patient.full_name:<22} {order.status.value:<16} {live} file(s)")
print(f"\nwould free {freed / 1e6:.0f} MB")

if DRY:
    print("\ndry run — nothing removed")
    raise SystemExit(0)

for order in orders:
    db.delete(order)          # files, appointments, events and quotes cascade
db.flush()
for patient in patients:
    db.delete(patient)
db.commit()

for blob in blobs:
    blob.unlink(missing_ok=True)

# Case folders left empty by the above.
orders_root = root / "Orders"
emptied = 0
if orders_root.is_dir():
    for folder in orders_root.iterdir():
        if folder.is_dir() and not any(p.is_file() for p in folder.rglob("*")):
            for sub in sorted(folder.rglob("*"), reverse=True):
                sub.rmdir()
            folder.rmdir()
            emptied += 1

print(f"\nremoved {len(orders)} case(s) and {len(patients)} patient(s)")
print(f"freed {freed / 1e6:.0f} MB, cleared {emptied} empty case folder(s)")
print(f"{db.query(Order).count()} case(s) remain")
