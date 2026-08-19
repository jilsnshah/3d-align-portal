"""Re-resolves every address after a Google key is configured.

Addresses geocoded from the offline pincode table collapse every clinic in a
postal division onto one point. Once a real geocoder is available this replaces
those with street-level coordinates, and clears the cached travel estimates that
were derived from them.

    .venv/bin/python regeocode.py
"""

from app.config import settings
from app.db import SessionLocal
from app.models import Address, TravelEstimate
from app.services.geo import geocode

if not settings.google_maps_api_key:
    raise SystemExit("No GOOGLE_MAPS_API_KEY set — nothing to upgrade.")

db = SessionLocal()
addresses = db.query(Address).all()

upgraded = 0
for address in addresses:
    if address.geocode_source == "google":
        continue
    found = geocode(address.line1, address.city, address.pincode)
    if found is None or found[2] != "google":
        print(f"  ~ {address.line1[:40]:<40} still on {address.geocode_source or 'nothing'}")
        continue
    address.latitude, address.longitude, address.geocode_source = found
    upgraded += 1
    print(f"  + {address.line1[:40]:<40} -> {address.latitude:.5f}, {address.longitude:.5f}")

# Estimates keyed on the old centroids are now meaningless.
dropped = db.query(TravelEstimate).delete()
db.commit()
print(f"\n{upgraded}/{len(addresses)} address(es) upgraded; {dropped} cached travel estimate(s) cleared.")
