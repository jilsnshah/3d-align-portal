"""Adds columns introduced after a dev database was already created.

SQLite cannot express the full range of schema changes, so this only handles
additive columns — which is all this project has needed so far. Alembic replaces
it before any deployment (see the README).

    .venv/bin/python migrate_dev.py
"""

from sqlalchemy import inspect, text

from app.db import engine

ADDITIONS = {
    "orders": [
        ("records_revision", "INTEGER NOT NULL DEFAULT 1"),
        ("scan_revision", "INTEGER NOT NULL DEFAULT 1"),
        ("planning_revision", "INTEGER NOT NULL DEFAULT 1"),
        ("fit_round", "INTEGER NOT NULL DEFAULT 1"),
    ],
    "order_files": [("revision", "INTEGER NOT NULL DEFAULT 1")],
    "shipments": [("fit_round", "INTEGER")],
    "fit_reviews": [("fit_round", "INTEGER NOT NULL DEFAULT 1")],
}

inspector = inspect(engine)
applied = 0

with engine.begin() as conn:
    for table, columns in ADDITIONS.items():
        if table not in inspector.get_table_names():
            print(f"  skip {table} (table does not exist yet)")
            continue
        existing = {c["name"] for c in inspector.get_columns(table)}
        for name, ddl in columns:
            if name in existing:
                continue
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
            print(f"  + {table}.{name}")
            applied += 1

print(f"\n{applied} column(s) added." if applied else "\nNothing to do — schema is current.")
