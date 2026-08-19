"""Loads the sample staged plan into a case, so the 3D viewer has real data.

    .venv/bin/python seed_simulation.py [order-reference]
"""

import pathlib
import sys

from app.config import settings
from app.db import SessionLocal
from app.enums import FileCategory, OrderStatus, UserRole
from app.models import Order, OrderFile, User
from app.services.simulation import parse_name
from app.services.storage import get_storage

SOURCE = pathlib.Path(
    "/Users/jils/Projects/3d-align/demo-data/simulation/"
    "3D-Align Case-1176 (Nihar)/BioModels/3D_ALIGN"
)

db = SessionLocal()
lab = db.query(User).filter(User.role == UserRole.ADMIN).first()

wanted = sys.argv[1] if len(sys.argv) > 1 else None
if wanted:
    order = db.query(Order).filter(Order.order_number == wanted).one_or_none()
else:
    order = (
        db.query(Order)
        .filter(Order.status.in_([OrderStatus.PLAN_SHARED, OrderStatus.IN_PLANNING]))
        .order_by(Order.created_at.desc())
        .first()
    )
if order is None:
    raise SystemExit("No case in planning to attach the models to.")

existing = {f.filename for f in order.files if f.category == FileCategory.SIMULATION_MODEL}
storage = get_storage()
if order.storage_folder_ref is None:
    order.storage_folder_ref = storage.ensure_order_folder(order.reference)

added = 0
for path in sorted(SOURCE.glob("*.stl"), key=lambda p: (len(p.name), p.name)):
    if path.name in existing:
        continue
    if parse_name(path.name) is None:
        print(f"  skip {path.name} (not a staged export)")
        continue
    with path.open("rb") as handle:
        stored = storage.save(order.reference, "planning", path.name, handle, "model/stl")
    db.add(
        OrderFile(
            order_id=order.id,
            category=FileCategory.SIMULATION_MODEL,
            filename=path.name,
            mime_type="model/stl",
            size_bytes=stored.size_bytes,
            storage_ref=stored.ref,
            uploaded_by_id=lab.id,
            revision=order.planning_revision,
        )
    )
    added += 1
    if added % 8 == 0:
        db.commit()
        print(f"  {added} model(s)…", flush=True)

db.commit()
print(f"\n{added} staged model(s) attached to {order.reference} ({order.patient.full_name})")
