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
    "users": [("full_name", "VARCHAR(200) NOT NULL DEFAULT ''")],
    "addresses": [
        ("latitude", "FLOAT"),
        ("longitude", "FLOAT"),
        ("geocode_source", "VARCHAR(20) NOT NULL DEFAULT ''"),
        ("geocoded_at", "TIMESTAMP"),
    ],
    "shipping_rates": [],
    "products": [],
    "product_sizes": [],
    "order_phases": [],
    "phase_fit_issues": [("awaiting", "VARCHAR(10) NOT NULL DEFAULT 'LAB'")],
    "phase_issue_messages": [],
    "payments": [],
    "booking_settings": [
        ("lab_geocode_source", "VARCHAR(30) NOT NULL DEFAULT ''"),
        ("upi_vpa", "VARCHAR(120) NOT NULL DEFAULT ''"),
        ("upi_payee_name", "VARCHAR(120) NOT NULL DEFAULT '3D Align'"),
        ("plan_fee", "NUMERIC(12,2) NOT NULL DEFAULT 2000"),
        ("training_fit_fee", "NUMERIC(12,2) NOT NULL DEFAULT 1500"),
        ("default_shipping_fee", "NUMERIC(12,2) NOT NULL DEFAULT 0"),
        ("timezone_name", "VARCHAR(60) NOT NULL DEFAULT 'Asia/Kolkata'"),
        ("lab_address", "VARCHAR(255) NOT NULL DEFAULT ''"),
        ("lab_latitude", "FLOAT"),
        ("lab_longitude", "FLOAT"),
        ("visit_duration_minutes", "INTEGER NOT NULL DEFAULT 45"),
        ("booking_granularity_minutes", "INTEGER NOT NULL DEFAULT 15"),
        ("travel_weight", "FLOAT NOT NULL DEFAULT 1.0"),
        ("fairness_weight", "FLOAT NOT NULL DEFAULT 0.5"),
        ("idle_weight", "FLOAT NOT NULL DEFAULT 0.5"),
        ("max_travel_minutes", "INTEGER NOT NULL DEFAULT 75"),
        ("fallback_speed_kmph", "FLOAT NOT NULL DEFAULT 22.0"),
        ("service_radius_km", "FLOAT NOT NULL DEFAULT 120.0"),
        ("day_visit_over_km", "FLOAT NOT NULL DEFAULT 45.0"),
    ],
    "travel_estimates": [
        ("bucket", "VARCHAR(10) NOT NULL DEFAULT ''"),
        ("expires_at", "TIMESTAMP"),
    ],
    "time_off": [
        ("status", "VARCHAR(20) NOT NULL DEFAULT 'APPROVED'"),
        ("requested_by_id", "VARCHAR(36)"),
        ("decided_by_id", "VARCHAR(36)"),
        ("decided_at", "DATETIME"),
        ("decision_note", "VARCHAR(300) NOT NULL DEFAULT ''"),
    ],
    "appointments": [
        ("needs_attention_at", "DATETIME"),
        ("attention_reason", "VARCHAR(300) NOT NULL DEFAULT ''"),
        ("is_day_visit", "BOOLEAN NOT NULL DEFAULT 0"),
    ],
    "orders": [
        # Backfilled by backfill_case_numbers.py, which also re-packs the AL
        # series so it only covers cases that actually reached planning.
        ("enquiry_number", "VARCHAR(30) NOT NULL DEFAULT ''"),
        ("records_revision", "INTEGER NOT NULL DEFAULT 1"),
        ("scan_revision", "INTEGER NOT NULL DEFAULT 1"),
        ("planning_revision", "INTEGER NOT NULL DEFAULT 1"),
        ("fit_round", "INTEGER NOT NULL DEFAULT 1"),
        ("phase_count", "INTEGER"),
        ("phase_fit_round", "INTEGER NOT NULL DEFAULT 1"),
        ("assigned_to_id", "VARCHAR(36)"),
        ("progress_round", "INTEGER NOT NULL DEFAULT 1"),
        ("refinement_round", "INTEGER NOT NULL DEFAULT 0"),
        ("kind", "VARCHAR(40) NOT NULL DEFAULT 'ALIGNER'"),
        ("product_id", "VARCHAR(36)"),
        ("product_size_id", "VARCHAR(36)"),
        ("quantity", "INTEGER NOT NULL DEFAULT 1"),
        ("extra_teeth", "INTEGER NOT NULL DEFAULT 0"),
        ("scan_reused_from_id", "VARCHAR(36)"),
        ("scan_received_at", "TIMESTAMP"),
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
    "treatment_plans": [
        ("final_discount", "NUMERIC(12,2) NOT NULL DEFAULT 0"),
        ("final_discount_reason", "VARCHAR(160) NOT NULL DEFAULT ''"),
    ],
}

# Roles were renamed when technicians arrived.
ROLE_RENAMES = [("STAFF", "ADMIN")]

# Everything below is SQLite: sqlite_master, "?" placeholders, and the
# rebuild-the-table trick SQLite needs for changes it cannot ALTER. A Postgres
# deployment has no dev database to patch — create_all() builds the current
# schema on first boot — so leaving early is the whole job there. The container
# runs this on every start, so this must return quietly rather than fail.
if engine.dialect.name != "sqlite":
    print(f"{engine.dialect.name}: nothing to patch, the schema is created whole.")
    raise SystemExit(0)

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


# --------------------------------------------------------------------------
# Column rebuilds
# --------------------------------------------------------------------------
# SQLite cannot relax a NOT NULL in place, so the table is rebuilt from the
# model. order_number became nullable when the AL series stopped being spent on
# cases that never reach planning.


def _relax_nullable(conn, table_name, column, model_table):
    row = conn.exec_driver_sql(
        f"SELECT sql FROM sqlite_master WHERE type='table' AND name='{table_name}'"
    ).scalar()
    if row is None or f"{column} VARCHAR" not in row or "NOT NULL" not in row:
        return False
    # Already nullable? The declaration for this column carries no NOT NULL.
    decl = [ln.strip() for ln in row.splitlines() if ln.strip().startswith(column + " ")]
    if decl and "NOT NULL" not in decl[0]:
        return False

    existing = {c["name"] for c in inspect(conn).get_columns(table_name)}
    wanted = [c.name for c in model_table.columns if c.name in existing]
    cols = ", ".join(f'"{c}"' for c in wanted)

    indexes = [
        r[0]
        for r in conn.exec_driver_sql(
            f"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='{table_name}'"
            " AND sql IS NOT NULL"
        ).fetchall()
    ]

    # legacy_alter_table stops SQLite from rewriting other tables' foreign keys
    # to point at the temporary name.
    conn.exec_driver_sql("PRAGMA legacy_alter_table=ON")
    for name in indexes:
        conn.exec_driver_sql(f'DROP INDEX IF EXISTS "{name}"')
    conn.exec_driver_sql(f'ALTER TABLE "{table_name}" RENAME TO "{table_name}__old"')
    model_table.create(bind=conn)
    conn.exec_driver_sql(
        f'INSERT INTO "{table_name}" ({cols}) SELECT {cols} FROM "{table_name}__old"'
    )
    conn.exec_driver_sql(f'DROP TABLE "{table_name}__old"')
    conn.exec_driver_sql("PRAGMA legacy_alter_table=OFF")
    return True


with engine.begin() as conn:
    # travel_estimates is a pure cache, and its unique constraint gained the
    # traffic bucket. Rebuilding it costs nothing but a few re-lookups, which
    # beats trying to reshape a constraint SQLite baked into the table.
    from app.models import TravelEstimate

    row = conn.exec_driver_sql(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='travel_estimates'"
    ).scalar()
    if row is not None and "bucket" not in row.split("UNIQUE")[-1]:
        conn.exec_driver_sql("DROP TABLE travel_estimates")
        TravelEstimate.__table__.create(bind=conn)
        print("  ~ travel_estimates rebuilt with the traffic bucket in its key")
        applied += 1

with engine.begin() as conn:
    from app.models import Order

    # The new unique index cannot be built while every row still holds the ''
    # default, so seed the enquiry refs first. backfill_case_numbers.py derives
    # the same values from the same ordering, so running it after is a no-op.
    blanks = conn.exec_driver_sql(
        "SELECT id, created_at FROM orders WHERE enquiry_number = '' ORDER BY created_at, id"
    ).fetchall()
    if blanks:
        seen = {}
        for order_id, created in blanks:
            year = str(created)[:4]
            seen[year] = seen.get(year, 0) + 1
            conn.exec_driver_sql(
                "UPDATE orders SET enquiry_number = ? WHERE id = ?",
                (f"EN-{year}-{seen[year]:04d}", order_id),
            )
        print(f"  + {len(blanks)} enquiry reference(s) seeded")
        applied += 1

    if _relax_nullable(conn, "orders", "order_number", Order.__table__):
        print("  ~ orders.order_number is now nullable")
        applied += 1

print(f"\n{applied} change(s) applied.")
