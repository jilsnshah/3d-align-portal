/* A technician's day, drawn.

   The interactive map needs the Maps JavaScript API, whose key is embedded in
   the page by design and protected by an HTTP referrer restriction. Until that
   key is configured the component still does its job: the ordered stops, the
   legs and the totals are all computed on the server, so the list and the
   "open in Google Maps" link work with no key at all. */

import { useEffect, useRef, useState } from "react";

import type { DayRoute } from "../api";

declare global {
  interface Window {
    google?: any;
    __alignMapsLoading?: Promise<void>;
  }
}

function loadMaps(key: string): Promise<void> {
  if (window.google?.maps) return Promise.resolve();
  if (window.__alignMapsLoading) return window.__alignMapsLoading;

  window.__alignMapsLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=geometry`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google Maps could not be loaded."));
    document.head.appendChild(script);
  });
  return window.__alignMapsLoading;
}

export default function RouteMap({ route }: { route: DayRoute }) {
  const holder = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const points = route.stops.filter((s) => s.latitude != null && s.longitude != null);
  const key = route.browser_map_key;

  useEffect(() => {
    if (!key || points.length < 2 || !holder.current) return;
    let cancelled = false;

    loadMaps(key)
      .then(() => {
        if (cancelled || !holder.current) return;
        const maps = window.google.maps;
        const map = new maps.Map(holder.current, {
          center: { lat: points[0].latitude!, lng: points[0].longitude! },
          zoom: 11,
          mapTypeControl: false,
          streetViewControl: false,
        });

        // The shape comes from the server's Routes call, so the browser key
        // only needs permission to render a map — not to call Directions.
        const bounds = new maps.LatLngBounds();
        points.forEach((stop, index) => {
          const position = { lat: stop.latitude!, lng: stop.longitude! };
          bounds.extend(position);
          new maps.Marker({
            map,
            position,
            label:
              stop.kind === "lab"
                ? { text: "L", color: "#0b0b0c", fontWeight: "700" }
                : { text: String(index), color: "#0b0b0c", fontWeight: "700" },
            title: `${stop.label}${stop.address ? ` — ${stop.address}` : ""}`,
          });
        });

        if (route.polyline && maps.geometry?.encoding) {
          new maps.Polyline({
            map,
            path: maps.geometry.encoding.decodePath(route.polyline),
            strokeColor: "#b8912f",
            strokeOpacity: 0.9,
            strokeWeight: 5,
          });
        }
        map.fitBounds(bounds, 48);
      })
      .catch((err) => !cancelled && setFailed(err.message));

    return () => {
      cancelled = true;
    };
  }, [key, route.technician_id, route.date, points.length]);

  if (points.length < 2) return null;

  return (
    <div className="stack-sm">
      {key && !failed && <div ref={holder} className="route-map" />}
      {failed && <div className="banner banner-warn">{failed}</div>}
      {!key && (
        <div className="waiting">
          Add a Maps browser key to draw the route here. The stops, distances and times below
          are already calculated.
        </div>
      )}
      {route.maps_url && (
        <a className="btn-ghost" href={route.maps_url} target="_blank" rel="noreferrer"
           style={{ display: "inline-block", textDecoration: "none", padding: "8px 14px" }}>
          Open the full route in Google Maps ↗
        </a>
      )}
    </div>
  );
}
