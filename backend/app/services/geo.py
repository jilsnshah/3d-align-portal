"""Coordinates for clinic addresses.

No routing provider is configured yet, so this resolves an address to a point
using an offline table of Ahmedabad pincode centroids. The numbers are
approximate — good enough to tell a clinic in Bopal from one in Maninagar, which
is all scheduling needs — and are replaced the moment a real geocoder is wired
in behind ``geocode``.

Precision here is deliberately coarse: this is location data about real
practices, and a pincode centroid is the least the scheduler can work with.
"""

from __future__ import annotations

import logging
import re
from typing import Optional, Tuple

log = logging.getLogger(__name__)

# Approximate centroids for the Ahmedabad service area. Sourced from the
# published centre points of each postal division and rounded to three decimals
# (~100 m), which is far finer than the scheduler needs.
PINCODE_CENTROIDS: dict[str, Tuple[float, float]] = {
    "380001": (23.026, 72.588),  # Lal Darwaja / Bhadra
    "380004": (23.045, 72.593),  # Shahibaug
    "380006": (23.032, 72.556),  # Ellisbridge
    "380007": (23.011, 72.548),  # Ambawadi
    "380008": (22.995, 72.601),  # Maninagar
    "380009": (23.037, 72.564),  # Navrangpura
    "380013": (23.058, 72.579),  # Naranpura
    "380015": (23.005, 72.507),  # Vejalpur / Prahladnagar
    "380051": (23.028, 72.510),  # Vastrapur
    "380052": (23.048, 72.523),  # Sola
    "380054": (23.043, 72.525),  # Thaltej
    "380058": (23.033, 72.464),  # Bopal
    "380059": (23.019, 72.478),  # Ghuma / South Bopal
    "380060": (23.056, 72.500),  # Science City
    "380061": (23.077, 72.526),  # Gota
    "380063": (23.089, 72.545),  # Chandkheda approach
    "382330": (23.108, 72.628),  # Naroda
    "382345": (23.089, 72.617),  # Nikol
    "382350": (23.073, 72.647),  # Odhav
    "382424": (22.975, 72.625),  # Vatva
    "382443": (22.962, 72.585),  # Narol
    "382481": (23.104, 72.592),  # Chandkheda
}

# Where the lab itself sits, used as everyone's start and end of day.
LAB_DEFAULT = (23.056, 72.500)  # Science City Road, Sola
LAB_DEFAULT_ADDRESS = "3D Align Lab, Science City Road, Sola, Ahmedabad 380060"


def _clean_pincode(value: str) -> Optional[str]:
    match = re.search(r"\b(\d{6})\b", value or "")
    return match.group(1) if match else None


def _google_geocode(line1: str, city: str, pincode: str) -> Optional[Tuple[float, float, str]]:
    """Street-level coordinates from Google, when a key is configured.

    Records how good the match was. Google always answers something — a typo'd
    street still resolves, to the middle of the city — so a vague match is
    marked as such rather than being trusted like a rooftop hit.
    """
    from ..config import settings

    if not settings.google_maps_api_key:
        return None

    import httpx

    address = ", ".join(part for part in (line1, city, pincode) if part)
    try:
        response = httpx.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            params={
                "address": address,
                "components": "country:IN",
                "key": settings.google_maps_api_key,
            },
            timeout=settings.google_maps_timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("status") != "OK" or not payload.get("results"):
            log.warning("Geocoding %s returned %s", pincode, payload.get("status"))
            return None
        best = payload["results"][0]
        point = best["geometry"]["location"]
        precision = best["geometry"].get("location_type", "")
        # APPROXIMATE means Google fell back to the town or postal district.
        # partial_match means it could not match what was typed and substituted
        # something — a Thaltej address answering with a Vastrapur road. Both
        # are worth a flag. GEOMETRIC_CENTER on a real road is a fine answer.
        vague = bool(best.get("partial_match")) or precision == "APPROXIMATE"
        return (
            float(point["lat"]),
            float(point["lng"]),
            "google-approximate" if vague else "google",
        )
    except Exception:
        log.exception("Geocoding failed; falling back to the pincode table")
        return None


def geocode(line1: str, city: str, pincode: str) -> Optional[Tuple[float, float, str]]:
    """Best-effort point for an address. Returns (lat, lng, source) or None.

    Google first when a key is set, then the offline pincode table. The pincode
    fallback is coarse — every clinic in a postal division collapses to one
    point — which is enough to choose between technicians across a city but not
    for street-level routing.
    """
    found = _google_geocode(line1, city, pincode)
    if found is not None:
        return found

    code = _clean_pincode(pincode) or _clean_pincode(line1)
    if code and code in PINCODE_CENTROIDS:
        lat, lng = PINCODE_CENTROIDS[code]
        return lat, lng, "pincode"
    return None


def locate(address, lab: Optional[Tuple[float, float]] = None, radius_km: float = 120.0) -> bool:
    """Fills in an Address's coordinates. True when it resolved.

    Called on write rather than at booking time — an address moves rarely, and
    the scheduler should never wait on a lookup.

    A result implausibly far from the lab is thrown away. Google will happily
    resolve a Delhi address for an Ahmedabad practice, and routing a technician
    900 km is worse than admitting the address is unusable.
    """
    from datetime import datetime, timezone

    from .travel import haversine_km

    found = geocode(address.line1, address.city, address.pincode)
    if found is None:
        address.geocode_source = "unresolved"
        return False

    lat, lng, source = found
    if lab is not None and haversine_km(lab, (lat, lng)) > radius_km:
        log.warning(
            "Address %s resolved %.0f km from the lab; leaving it unlocated",
            address.pincode,
            haversine_km(lab, (lat, lng)),
        )
        address.latitude = address.longitude = None
        address.geocode_source = "out-of-area"
        return False

    address.latitude, address.longitude, address.geocode_source = lat, lng, source
    address.geocoded_at = datetime.now(timezone.utc)
    return True


def locate_for(db, address, picked: Optional[Tuple[float, float]] = None) -> bool:
    """``locate`` with the lab's own position and service radius filled in.

    A pin the doctor dropped themselves is taken at face value — subject to the
    same service-area check — because it is better evidence than anything a
    geocoder infers from a typed street name.
    """
    from datetime import datetime, timezone

    from .scheduling import get_settings, lab_point
    from .travel import haversine_km

    settings = get_settings(db)
    lab = lab_point(settings)

    if picked is not None:
        if lab is not None and haversine_km(lab, picked) > settings.service_radius_km:
            address.latitude = address.longitude = None
            address.geocode_source = "out-of-area"
            return False
        address.latitude, address.longitude = picked
        address.geocode_source = "picked"
        address.geocoded_at = datetime.now(timezone.utc)
        return True

    return locate(address, lab, settings.service_radius_km)


def search(query: str, near: Optional[Tuple[float, float]] = None) -> Optional[dict]:
    """Forward geocode a typed address so the map pin can follow the text."""
    from ..config import settings

    if not settings.google_maps_api_key or not query.strip():
        return None

    import httpx

    params = {
        "address": query.strip(),
        "components": "country:IN",
        "key": settings.google_maps_api_key,
    }
    if near is not None:
        # Bias towards the service area, so "MG Road" lands in the right city.
        params["bounds"] = (
            f"{near[0] - 0.5},{near[1] - 0.5}|{near[0] + 0.5},{near[1] + 0.5}"
        )
    try:
        response = httpx.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            params=params,
            timeout=settings.google_maps_timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("status") != "OK" or not payload.get("results"):
            return None
        best = payload["results"][0]
        point = best["geometry"]["location"]
        return {
            "lat": float(point["lat"]),
            "lng": float(point["lng"]),
            "address": best.get("formatted_address", ""),
            "approximate": bool(best.get("partial_match"))
            or best["geometry"].get("location_type") == "APPROXIMATE",
        }
    except Exception:
        log.exception("Address search failed")
        return None


def suggest(query: str, near: Optional[Tuple[float, float]] = None) -> list:
    """Place suggestions as the doctor types.

    Needs the Places API enabled on the project. Until it is, this returns
    nothing and the picker falls back to searching the typed address outright,
    so the map still follows what is written.
    """
    from ..config import settings

    if not settings.google_maps_api_key or len(query.strip()) < 3:
        return []

    import httpx

    body: dict = {"input": query.strip(), "includedRegionCodes": ["in"]}
    if near is not None:
        body["locationBias"] = {
            "circle": {
                "center": {"latitude": near[0], "longitude": near[1]},
                "radius": 50000.0,
            }
        }
    try:
        response = httpx.post(
            "https://places.googleapis.com/v1/places:autocomplete",
            json=body,
            headers={
                "X-Goog-Api-Key": settings.google_maps_api_key,
                "Content-Type": "application/json",
            },
            timeout=settings.google_maps_timeout_seconds,
        )
        if response.status_code == 403:
            log.info("Places API is not enabled; falling back to address search")
            return []
        response.raise_for_status()
        out = []
        for item in response.json().get("suggestions", []):
            prediction = item.get("placePrediction") or {}
            text = (prediction.get("text") or {}).get("text", "")
            if text:
                out.append({"text": text})
        return out[:6]
    except Exception:
        log.exception("Place suggestions failed")
        return []


# Google returns a flat list of components; these are the ones an Indian postal
# address is actually made of, most specific first.
_LINE1_PARTS = ("premise", "street_number", "route", "point_of_interest", "establishment")
_LINE2_PARTS = ("sublocality_level_2", "sublocality_level_1", "sublocality", "neighborhood")


def describe(point: Tuple[float, float]) -> Optional[dict]:
    """Reverse geocode, so the map can show and fill in what was pinned.

    Returns the formatted line plus the pieces an address form needs, so a
    doctor who has already marked their clinic does not then have to type the
    same address underneath it.

    Goes through the backend rather than the browser so the map key only ever
    needs permission to draw a map.
    """
    from ..config import settings

    if not settings.google_maps_api_key:
        return None

    import httpx

    try:
        response = httpx.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            params={
                "latlng": f"{point[0]},{point[1]}",
                "key": settings.google_maps_api_key,
            },
            timeout=settings.google_maps_timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("status") != "OK" or not payload.get("results"):
            return None

        best = payload["results"][0]
        parts: dict = {}
        for component in best.get("address_components", []):
            for kind in component.get("types", []):
                parts.setdefault(kind, component.get("long_name", ""))

        def first(keys) -> str:
            return next((parts[k] for k in keys if parts.get(k)), "")

        line1 = ", ".join(
            dict.fromkeys(x for x in (parts.get("premise"), parts.get("street_number"), parts.get("route")) if x)
        ) or first(_LINE1_PARTS)

        return {
            "formatted": best.get("formatted_address", ""),
            "line1": line1,
            "line2": first(_LINE2_PARTS),
            "city": parts.get("locality") or parts.get("administrative_area_level_3", ""),
            "state": parts.get("administrative_area_level_1", ""),
            "pincode": parts.get("postal_code", ""),
        }
    except Exception:
        log.exception("Reverse geocoding failed")
        return None
