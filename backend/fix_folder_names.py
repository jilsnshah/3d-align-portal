"""Strips directory prefixes left on files by folder uploads.

The browser names a folder upload by its relative path, so files landed as
"3D_ALIGN/7-S-3D_ALIGN.stl". Anything reading the name — the simulation
timeline above all — saw nothing it recognised.

    .venv/bin/python fix_folder_names.py
"""

from app.db import SessionLocal
from app.models import OrderFile

db = SessionLocal()
fixed = 0
for record in db.query(OrderFile).all():
    bare = record.filename.replace("\\", "/").rsplit("/", 1)[-1]
    if bare != record.filename:
        print(f"  {record.filename}  ->  {bare}")
        record.filename = bare
        fixed += 1

db.commit()
print(f"\n{fixed} filename(s) corrected")
