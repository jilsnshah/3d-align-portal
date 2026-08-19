"""Resolves coordinates for addresses that predate travel-aware scheduling.

    .venv/bin/python backfill_geo.py
"""

from app.db import SessionLocal
from app.models import Address
from app.services.geo import locate

db = SessionLocal()
pending = db.query(Address).filter(Address.latitude.is_(None)).all()

found = 0
for address in pending:
    if locate(address):
        found += 1
        print(f"  {address.line1[:38]:<38} {address.pincode}  -> {address.latitude}, {address.longitude}")
    else:
        print(f"  {address.line1[:38]:<38} {address.pincode}  -- no match, flat buffer will be used")

db.commit()
print(f"\n{found}/{len(pending)} address(es) located.")
