"""Travel time between two points.

Resolution order, cheapest first:

    1. the ``travel_estimates`` cache — one service city and a stable set of
       clinics means the same pairs recur constantly
    2. a routing provider, when one is configured
    3. straight-line distance times a road factor, divided by an average city
       speed

The third rung is what makes the scheduler work with no API key at all, and what
keeps booking alive when a provider is down or out of quota. Nothing in the
scheduler is allowed to care which rung answered.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional, Sequence, Tuple

from sqlalchemy.orm import Session

from ..models import BookingSettings, TravelEstimate

log = logging.getLogger(__name__)

Point = Tuple[float, float]

# Straight line understates real driving. 1.4 is the usual detour factor for a
# dense Indian city grid.
ROAD_FACTOR = 1.4

# Inside this horizon a visit is close enough that live traffic beats any
# prediction, so the lookup is made live and never cached.
LIVE_TRAFFIC_HORIZON = timedelta(hours=2)

# How long a predicted bucket stays usable before it is re-fetched.
BUCKET_TTL = timedelta(days=14)

# A dropped connection should not silently downgrade a whole day's scheduling.
PROVIDER_ATTEMPTS = 3
RETRY_BASE_DELAY = 0.4

# Elements billed per matrix call. Routes allows far more; this keeps a single
# calendar render from ever turning into a surprise line on the invoice.
MAX_MATRIX_ELEMENTS = 100


def _is_transient(exc: Exception) -> bool:
    """Worth another go: timeouts, dropped connections, 5xx, and rate limits."""
    import httpx

    if isinstance(exc, (httpx.TimeoutException, httpx.TransportError)):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in (408, 429, 500, 502, 503, 504)
    return False


@dataclass(frozen=True)
class Leg:
    minutes: float
    distance_km: float
    source: str


def bucket_for(depart_at: Optional[datetime]) -> str:
    """Weekday and hour of departure — the traffic pattern a journey falls in."""
    if depart_at is None:
        return ""
    return f"{depart_at.weekday()}@{depart_at.hour:02d}"


def is_imminent(depart_at: Optional[datetime]) -> bool:
    if depart_at is None:
        return False
    return depart_at - datetime.now(timezone.utc) <= LIVE_TRAFFIC_HORIZON


def point_key(point: Point) -> str:
    """Cache key. Three decimals is ~100 m — fine enough that two clinics on the
    same street share an entry, coarse enough not to be a precise home address."""
    return f"{point[0]:.3f},{point[1]:.3f}"


def haversine_km(a: Point, b: Point) -> float:
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def _estimate(a: Point, b: Point, settings: BookingSettings) -> Leg:
    distance = haversine_km(a, b) * ROAD_FACTOR
    speed = settings.fallback_speed_kmph or 22.0
    return Leg(minutes=(distance / speed) * 60.0, distance_km=distance, source="estimate")


class TravelService:
    """Per-request travel lookups. Holds a small in-memory map on top of the
    database cache so one calendar render never asks for the same pair twice."""

    def __init__(self, db: Session, settings: BookingSettings):
        self.db = db
        self.settings = settings
        # Memo lives on the session, not the instance: a request can build more
        # than one service, and two of them queueing the same cache row would
        # collide on the unique pair index at commit.
        self._local: dict[tuple[str, str], Leg] = db.info.setdefault("travel_memo", {})

    def between(
        self,
        origin: Optional[Point],
        destination: Optional[Point],
        depart_at: Optional[datetime] = None,
    ) -> Optional[Leg]:
        """None when either end is unknown — the caller falls back to the flat
        travel buffer rather than pretending to know a distance."""
        if origin is None or destination is None:
            return None
        if origin == destination:
            return Leg(0.0, 0.0, "same-point")

        # A visit inside the live horizon is costed against traffic as it is
        # right now, and never cached: that answer is stale within minutes.
        if is_imminent(depart_at):
            return self._lookup(origin, destination, depart_at)

        bucket = bucket_for(depart_at)
        key = (point_key(origin), point_key(destination), bucket)
        if key in self._local:
            return self._local[key]

        now = datetime.now(timezone.utc)
        row = (
            self.db.query(TravelEstimate)
            .filter(
                TravelEstimate.origin_key == key[0],
                TravelEstimate.destination_key == key[1],
                TravelEstimate.bucket == bucket,
            )
            .first()
        )
        if row is not None:
            expires = row.expires_at
            if expires is not None and expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            # Refresh a row that has aged out, and upgrade a straight-line guess
            # written before a provider existed rather than serving it forever.
            stale = expires is not None and expires <= now
            guess = row.source == "estimate" and get_provider() is not None
            if stale or guess:
                leg = self._lookup(origin, destination, depart_at)
                row.minutes, row.distance_km, row.source = (
                    leg.minutes,
                    leg.distance_km,
                    leg.source,
                )
                row.expires_at = now + BUCKET_TTL
            else:
                leg = Leg(row.minutes, row.distance_km, row.source)
            self._local[key] = leg
            return leg

        leg = self._lookup(origin, destination, depart_at)
        self._local[key] = leg
        self.db.add(
            TravelEstimate(
                origin_key=key[0],
                destination_key=key[1],
                bucket=bucket,
                minutes=leg.minutes,
                distance_km=leg.distance_km,
                source=leg.source,
                expires_at=now + BUCKET_TTL,
            )
        )
        return leg

    def _lookup(
        self, origin: Point, destination: Point, depart_at: Optional[datetime] = None
    ) -> Leg:
        cells = self._call_provider([origin], [destination], depart_at)
        if cells and cells[0] and cells[0][0] is not None:
            return cells[0][0]
        return _estimate(origin, destination, self.settings)

    def _call_provider(
        self,
        origins: Sequence[Point],
        destinations: Sequence[Point],
        depart_at: Optional[datetime],
    ) -> Optional[list[list[Optional[Leg]]]]:
        """One matrix call, retried through transient failures.

        A dropped connection is not a reason to schedule the whole day off a
        straight-line guess, so transient errors are retried before giving up.
        """
        provider = get_provider()
        if provider is None:
            return None

        delay = RETRY_BASE_DELAY
        for attempt in range(1, PROVIDER_ATTEMPTS + 1):
            try:
                return provider.matrix(origins, destinations, depart_at)
            except Exception as exc:  # noqa: BLE001 - provider is best effort
                if attempt == PROVIDER_ATTEMPTS or not _is_transient(exc):
                    log.warning(
                        "Routing provider failed (%s); using straight-line estimates for "
                        "%s x %s point(s)",
                        exc,
                        len(origins),
                        len(destinations),
                    )
                    return None
                log.info("Routing provider attempt %s failed (%s); retrying", attempt, exc)
                time.sleep(delay)
                delay *= 2
        return None

    def prefetch(
        self, requests: Sequence[Tuple[Optional[Point], Optional[Point], Optional[datetime]]]
    ) -> None:
        """Resolve many legs in as few calls as possible.

        computeRouteMatrix exists to answer origins x destinations in one
        request. Called leg by leg it degenerates into one HTTP round trip per
        pair, which is both slow and needlessly expensive, so callers hand the
        whole set over first and then read the answers out of the cache.
        """
        if get_provider() is None:
            return

        wanted: dict[str, set] = {}
        for origin, destination, depart_at in requests:
            if origin is None or destination is None or origin == destination:
                continue
            if is_imminent(depart_at):
                continue  # live lookups are deliberately not shared
            bucket = bucket_for(depart_at)
            key = (point_key(origin), point_key(destination), bucket)
            if key in self._local:
                continue
            wanted.setdefault(bucket, set()).add((origin, destination, depart_at))

        for bucket, pairs in wanted.items():
            missing = [p for p in pairs if not self._cached(p[0], p[1], bucket)]
            if not missing:
                continue

            origins = sorted({p[0] for p in missing})
            destinations = sorted({p[1] for p in missing})
            # The cross product is what gets billed, so keep it to a sane size;
            # anything larger falls back to resolving pair by pair on demand.
            if len(origins) * len(destinations) > MAX_MATRIX_ELEMENTS:
                continue

            depart_at = missing[0][2]
            cells = self._call_provider(origins, destinations, depart_at)
            if cells is None:
                continue

            now = datetime.now(timezone.utc)
            for i, origin in enumerate(origins):
                for j, destination in enumerate(destinations):
                    leg = cells[i][j] if i < len(cells) and j < len(cells[i]) else None
                    if leg is None:
                        continue
                    key = (point_key(origin), point_key(destination), bucket)
                    if key in self._local:
                        continue
                    self._local[key] = leg
                    if self._cached(origin, destination, bucket) is None:
                        self.db.add(
                            TravelEstimate(
                                origin_key=key[0],
                                destination_key=key[1],
                                bucket=bucket,
                                minutes=leg.minutes,
                                distance_km=leg.distance_km,
                                source=leg.source,
                                expires_at=now + BUCKET_TTL,
                            )
                        )

    def _cached(self, origin: Point, destination: Point, bucket: str):
        return (
            self.db.query(TravelEstimate)
            .filter(
                TravelEstimate.origin_key == point_key(origin),
                TravelEstimate.destination_key == point_key(destination),
                TravelEstimate.bucket == bucket,
            )
            .first()
        )

    def minutes(
        self,
        origin: Optional[Point],
        destination: Optional[Point],
        fallback: float,
        depart_at: Optional[datetime] = None,
    ) -> float:
        """Travel minutes, or ``fallback`` when either end has no coordinates."""
        leg = self.between(origin, destination, depart_at)
        return fallback if leg is None else leg.minutes


# --------------------------------------------------------------------------
# Provider seam
# --------------------------------------------------------------------------
# Nothing is wired in yet. A Distance Matrix or Routes implementation goes here
# and needs one method: a matrix of origins against destinations, so asking
# "which technician is nearest" costs one call rather than one per technician.


class RoutingProvider:  # pragma: no cover - interface only
    def matrix(
        self,
        origins: Sequence[Point],
        destinations: Sequence[Point],
        depart_at: Optional[datetime] = None,
    ) -> list[list[Optional[Leg]]]:
        raise NotImplementedError


_provider: Optional[RoutingProvider] = None


def set_provider(provider: Optional[RoutingProvider]) -> None:
    global _provider
    _provider = provider


def get_provider() -> Optional[RoutingProvider]:
    return _provider


class GoogleRoutesProvider(RoutingProvider):
    """Google Routes API, traffic-aware.

    ``computeRouteMatrix`` covers every origin against every destination in one
    request, so asking which of five technicians is nearest costs a single call.

    Durations are pessimistic by default. A technician arriving early is a
    non-event; arriving late in front of a waiting patient is not, so the
    schedule is built against the bad traffic day rather than the average one.

    Any failure returns None for that pair and the caller drops to a
    straight-line estimate — a booking must never fail because a map service is
    having a bad day.
    """

    ENDPOINT = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix"

    def __init__(self, api_key: str, timeout: float = 6.0, traffic_model: str = "PESSIMISTIC"):
        if not api_key:
            raise ValueError("A Google Maps API key is required.")
        self.api_key = api_key
        self.timeout = timeout
        self.traffic_model = traffic_model

    @staticmethod
    def _waypoint(point: Point) -> dict:
        return {
            "waypoint": {
                "location": {"latLng": {"latitude": point[0], "longitude": point[1]}}
            }
        }

    def matrix(
        self,
        origins: Sequence[Point],
        destinations: Sequence[Point],
        depart_at: Optional[datetime] = None,
    ) -> list[list[Optional[Leg]]]:
        import httpx

        body: dict = {
            "origins": [self._waypoint(p) for p in origins],
            "destinations": [self._waypoint(p) for p in destinations],
            "travelMode": "DRIVE",
        }

        # A departure time is what makes the answer traffic-aware. Google
        # rejects times in the past, so anything stale is nudged forward.
        if depart_at is not None:
            when = max(depart_at, datetime.now(timezone.utc) + timedelta(minutes=1))
            body["departureTime"] = when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            # trafficModel is only accepted alongside TRAFFIC_AWARE_OPTIMAL.
            # Pair it with plain TRAFFIC_AWARE and the API returns HTTP 200 with
            # the rejection buried in each element's `status`, which reads as an
            # empty result unless you are looking for it.
            if self.traffic_model:
                body["routingPreference"] = "TRAFFIC_AWARE_OPTIMAL"
                body["trafficModel"] = self.traffic_model
            else:
                body["routingPreference"] = "TRAFFIC_AWARE"
        else:
            body["routingPreference"] = "TRAFFIC_UNAWARE"

        response = httpx.post(
            self.ENDPOINT,
            json=body,
            headers={
                "X-Goog-Api-Key": self.api_key,
                # `status` is in the mask deliberately: per-element failures
                # arrive inside a 200 response, and without it a rejected
                # request is indistinguishable from "no route exists".
                "X-Goog-FieldMask": (
                    "originIndex,destinationIndex,duration,distanceMeters,"
                    "condition,status"
                ),
            },
            timeout=self.timeout,
        )
        response.raise_for_status()

        out: list[list[Optional[Leg]]] = [
            [None for _ in destinations] for _ in origins
        ]
        for cell in response.json():
            status = cell.get("status") or {}
            if status.get("code"):
                # A malformed request fails per element, not per response.
                raise RuntimeError(
                    f"Routes rejected an element: {status.get('message', status)}"
                )
            if cell.get("condition") != "ROUTE_EXISTS":
                log.info(
                    "No route between origin %s and destination %s",
                    cell.get("originIndex", 0),
                    cell.get("destinationIndex", 0),
                )
                continue
            # Durations come back as "1234s".
            seconds = float(str(cell.get("duration", "0s")).rstrip("s") or 0)
            out[cell.get("originIndex", 0)][cell.get("destinationIndex", 0)] = Leg(
                minutes=seconds / 60.0,
                distance_km=cell.get("distanceMeters", 0) / 1000.0,
                source="google",
            )
        return out


def route_polyline(
    points: Sequence[Point], depart_at: Optional[datetime] = None
) -> Optional[dict]:
    """The drawn shape of a whole run, for the lab's map.

    Uses the server key and the Routes API we already pay for, so the browser
    key never needs permission to call Directions — the map only has to render
    a shape it is handed.
    """
    from ..config import settings

    if not settings.google_maps_api_key or len(points) < 2:
        return None

    import httpx

    def at(point: Point) -> dict:
        return {"location": {"latLng": {"latitude": point[0], "longitude": point[1]}}}

    body: dict = {
        "origin": at(points[0]),
        "destination": at(points[-1]),
        "travelMode": "DRIVE",
    }
    if len(points) > 2:
        body["intermediates"] = [at(p) for p in points[1:-1]]
    if depart_at is not None:
        when = max(depart_at, datetime.now(timezone.utc) + timedelta(minutes=1))
        body["departureTime"] = when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        body["routingPreference"] = "TRAFFIC_AWARE_OPTIMAL"
        body["trafficModel"] = settings.google_traffic_model

    try:
        response = httpx.post(
            "https://routes.googleapis.com/directions/v2:computeRoutes",
            json=body,
            headers={
                "X-Goog-Api-Key": settings.google_maps_api_key,
                "X-Goog-FieldMask": (
                    "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline"
                ),
            },
            timeout=settings.google_maps_timeout_seconds * 3,
        )
        response.raise_for_status()
        routes = response.json().get("routes") or []
        if not routes:
            return None
        first = routes[0]
        return {
            "polyline": first["polyline"]["encodedPolyline"],
            "distance_km": first.get("distanceMeters", 0) / 1000.0,
            "minutes": float(str(first.get("duration", "0s")).rstrip("s") or 0) / 60.0,
        }
    except Exception:
        log.exception("Could not fetch a route polyline; the map will fall back to markers")
        return None


def configure_from_settings() -> Optional[RoutingProvider]:
    """Registers a provider when a key is configured. Called once at startup."""
    from ..config import settings

    if not settings.google_maps_api_key:
        log.info("No Google Maps key set; travel times use straight-line estimates.")
        set_provider(None)
        return None

    provider = GoogleRoutesProvider(
        settings.google_maps_api_key,
        settings.google_maps_timeout_seconds,
        settings.google_traffic_model,
    )
    set_provider(provider)
    log.info(
        "Google Routes enabled for travel times (traffic model: %s).",
        settings.google_traffic_model,
    )
    return provider
