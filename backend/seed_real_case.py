"""Put a real staged case behind a demo order, so the 3D viewer has real data.

seed_demo.py builds cases over HTTP with stand-in geometry, which is enough to
populate a board but renders as a single triangle. This replaces one case's
scans and staged models with an actual export: three intraoral scans including
the bite registration, and every arch the lab staged.

The bite matters. Without it the viewer falls back to a nominal articulation and
the arches float in the wrong relationship; with it the staged models are
registered into the patient's own occlusion.

Runs against whatever DATABASE_URL and storage backend the environment names, so
it can load a deployed portal directly rather than pushing 270 MB through it:

    DATABASE_URL=... STORAGE_BACKEND=s3 S3_...=... \
      .venv/bin/python seed_real_case.py [AL-2026-0001]
"""

import pathlib
import sys

from app.db import SessionLocal
from app.enums import FileCategory, OrderStatus, UserRole
from app.models import Order, OrderFile, User
from app.services.simulation import parse_name
from app.services.storage import get_storage

CASE = pathlib.Path(
    "/Users/jils/Projects/3d-align/demo-data/simulation/3D-Align Case-1176 (Nihar)"
)
SCANS = CASE / "Scan Files"
STAGES = CASE / "BioModels" / "3D_ALIGN"

# The scanner's own names, mapped to the slots the portal files them under.
SCAN_SLOTS = (
    ("UPPER_ARCH", "UPPER JAW.stl"),
    ("LOWER_ARCH", "LOWER JAW.stl"),
    ("BITE", "BITE.stl"),
)


def main() -> int:
    db = SessionLocal()
    lab = db.query(User).filter(User.role == UserRole.ADMIN).first()
    if lab is None:
        raise SystemExit("No lab account to attribute the upload to.")

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

    storage = get_storage()
    if order.storage_folder_ref is None:
        order.storage_folder_ref = storage.ensure_order_folder(order.reference)

    # The stand-ins go first. Leaving them in place would put a one-triangle
    # arch on the same step as the real one and the timeline would show both.
    replaced = 0
    for existing in order.files:
        if existing.category in (FileCategory.SIMULATION_MODEL, FileCategory.INTRAORAL_SCAN):
            if not existing.is_deleted:
                storage.delete(existing.storage_ref)
                db.delete(existing)
                replaced += 1
    db.flush()
    print(f"  cleared {replaced} stand-in file(s)")

    def attach(path: pathlib.Path, category, slot: str = "") -> None:
        with path.open("rb") as handle:
            stored = storage.save(order.reference, "scans" if slot else "planning",
                                  path.name, handle, "model/stl")
        db.add(
            OrderFile(
                order_id=order.id,
                category=category,
                filename=path.name,
                mime_type="model/stl",
                size_bytes=stored.size_bytes,
                storage_ref=stored.ref,
                slot=slot,
                uploaded_by_id=lab.id,
                revision=order.planning_revision,
            )
        )

    for slot, name in SCAN_SLOTS:
        path = SCANS / name
        if not path.is_file():
            raise SystemExit(f"Missing scan: {path}")
        attach(path, FileCategory.INTRAORAL_SCAN, slot)
        print(f"  scan  {name} ({path.stat().st_size / 1048576:.1f} MB)")
    db.commit()

    staged = sorted(
        (p for p in STAGES.glob("*.stl") if parse_name(p.name)),
        key=lambda p: (parse_name(p.name)[0], parse_name(p.name)[1]),
    )
    for index, path in enumerate(staged, start=1):
        attach(path, FileCategory.SIMULATION_MODEL)
        if index % 4 == 0:
            db.commit()
            print(f"  staged {index}/{len(staged)}…", flush=True)
    db.commit()

    print(f"\n{len(staged)} staged model(s) and 3 scan(s) on {order.reference}"
          f" ({order.patient.full_name})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
