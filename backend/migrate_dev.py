"""Adds columns introduced after a dev database was already created.

SQLite cannot express the full range of schema changes, so this only handles
additive columns — which is all this project has needed so far. Alembic replaces
it before any deployment (see the README).

    .venv/bin/python migrate_dev.py
"""

from sqlalchemy import inspect, text

from app.db import engine

# Tables introduced later are created by create_all(); this only patches columns
# added to tables that already exist.
ADDITIONS = {
    "orders": [
        ("records_revision", "INTEGER NOT NULL DEFAULT 1"),
        ("scan_revision", "INTEGER NOT NULL DEFAULT 1"),
        ("planning_revision", "INTEGER NOT NULL DEFAULT 1"),
        ("fit_round", "INTEGER NOT NULL DEFAULT 1"),
    ],
    "order_files": [
        ("revision", "INTEGER NOT NULL DEFAULT 1"),
        ("slot", "VARCHAR(40) NOT NULL DEFAULT ''"),
        ("deleted_at", "TIMESTAMP"),
        ("deleted_by_id", "VARCHAR(36)"),
    ],
    "shipments": [
        ("fit_round", "INTEGER"),
        ("phase_decision", "VARCHAR(20)"),
        ("phase_round", "INTEGER"),
        ("decision_notes", "TEXT NOT NULL DEFAULT ''"),
    ],
    "quotes": [
        ("is_final", "BOOLEAN NOT NULL DEFAULT 0"),
        ("category_price_max", "NUMERIC(12,2) NOT NULL DEFAULT 0"),
        ("subtotal_max", "NUMERIC(12,2) NOT NULL DEFAULT 0"),
        ("total_max", "NUMERIC(12,2) NOT NULL DEFAULT 0"),
    ],
    "aligner_prices": [
        ("price_min", "NUMERIC(12,2) NOT NULL DEFAULT 0"),
        ("price_max", "NUMERIC(12,2) NOT NULL DEFAULT 0"),
    ],
    "fit_reviews": [("fit_round", "INTEGER NOT NULL DEFAULT 1")],
}

# Roles were renamed when technicians arrived.
ROLE_RENAMES = [("STAFF", "ADMIN")]

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

with engine.begin() as conn:
    if "users" in inspector.get_table_names():
        for old, new in ROLE_RENAMES:
            result = conn.execute(
                text("UPDATE users SET role = :new WHERE role = :old"), {"old": old, "new": new}
            )
            if result.rowcount:
                print(f"  ~ users.role {old} -> {new} ({result.rowcount} row(s))")
                applied += result.rowcount

    # The old placeholder table is superseded by `appointments`.
    if "scan_appointments" in inspector.get_table_names():
        conn.execute(text("DROP TABLE scan_appointments"))
        print("  - scan_appointments (replaced by appointments)")
        applied += 1

print(f"\n{applied} change(s) applied." if applied else "\nNothing to do — schema is current.")
