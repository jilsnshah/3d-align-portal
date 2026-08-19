"""One-time backfill for the split enquiry / AL numbering.

Before this change every case took an AL number the moment it was created, so
cases that never reached planning burned numbers out of the lab's production
series. Now a case carries an EN reference until it reaches planning.

This script brings an existing database in line:

  * every case gets an EN number, oldest first
  * cases that never reached planning give their AL number back
  * the remaining AL numbers are re-packed so the series is contiguous
  * local storage folders are renamed and file refs rewritten to match
  * the counters are reset so new cases carry on from the right place

    .venv/bin/python backfill_case_numbers.py [--dry-run]
"""

import sys
from collections import defaultdict

from app.db import SessionLocal
from app.enums import OrderStatus
from app.models import Counter, Order, StatusEvent
from app.services.storage import get_storage

DRY = "--dry-run" in sys.argv

db = SessionLocal()
storage = get_storage()

orders = db.query(Order).order_by(Order.created_at, Order.order_number).all()

# A case earned its AL number if it ever reached planning — not merely if it is
# sitting in a late status now. Cancelled-after-planning keeps its number, and
# that gap in the series is real history.
planned_ids = {
    e.order_id
    for e in db.query(StatusEvent).filter(StatusEvent.to_status == OrderStatus.IN_PLANNING).all()
}

en_seq = defaultdict(int)
al_seq = defaultdict(int)
plan = []

for order in orders:
    year = order.created_at.year
    en_seq[year] += 1
    enquiry = f"EN-{year}-{en_seq[year]:04d}"

    if order.id in planned_ids:
        al_seq[year] += 1
        al = f"AL-{year}-{al_seq[year]:04d}"
    else:
        al = None

    plan.append((order, order.order_number, enquiry, al))

width = max(len(str(old or "")) for _, old, _, _ in plan) if plan else 12
print(f"{'was':<{width}}  {'enquiry':<13} {'production':<13} status")
for order, old, enquiry, al in plan:
    print(f"{old or '—':<{width}}  {enquiry:<13} {al or '— (not planned)':<13} {order.status.value}")

if DRY:
    print("\ndry run — nothing written")
    raise SystemExit(0)

# Two passes: park every number under a temporary name first, so a case taking a
# number another case is still holding cannot collide with the unique index.
for order, old, _, _ in plan:
    order.order_number = f"tmp:{order.id}"
db.flush()

renames = []
for order, old, enquiry, al in plan:
    order.enquiry_number = enquiry
    order.order_number = al
    new_folder = al or enquiry
    if old and old != new_folder:
        renames.append((order, old, new_folder))
db.flush()

moved = 0
for order, old, new in renames:
    try:
        ref = storage.rename_order_folder(old, new)
    except Exception as exc:
        print(f"  ! could not rename {old} -> {new}: {exc}")
        continue
    if ref is None:
        continue
    order.storage_folder_ref = ref
    prefix = f"Orders/{old}/"
    for f in order.files:
        if f.storage_ref and f.storage_ref.startswith(prefix):
            f.storage_ref = f"Orders/{new}/" + f.storage_ref[len(prefix) :]
    moved += 1

for year, value in en_seq.items():
    key = f"enquiry:{year}"
    counter = db.get(Counter, key) or Counter(key=key, value=0)
    counter.value = value
    db.add(counter)

for year in set(list(al_seq) + [o.created_at.year for o, _, _, _ in plan]):
    key = f"order:{year}"
    counter = db.get(Counter, key) or Counter(key=key, value=0)
    counter.value = al_seq.get(year, 0)
    db.add(counter)

db.commit()

kept = sum(1 for _, _, _, al in plan if al)
print(f"\n{len(plan)} cases: {kept} hold an AL number, {len(plan) - kept} returned theirs.")
print(f"{moved} storage folders renamed.")
for year in sorted(en_seq):
    print(f"  {year}: next enquiry EN-{year}-{en_seq[year] + 1:04d}, next production AL-{year}-{al_seq.get(year, 0) + 1:04d}")
