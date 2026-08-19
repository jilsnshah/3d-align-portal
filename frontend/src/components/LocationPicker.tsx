/* Drop a pin on your own front door.

   A typed address is a guess: Google answers a Thaltej street with a Vastrapur
   road and nothing looks wrong until a technician is parked outside the wrong
   building. Letting the clinic place the pin themselves replaces that guess
   with the one piece of evidence nobody can argue with.

   The map key is public by design and restricted by HTTP referrer; reverse
   geocoding goes through the backend so the server key stays there. */

import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import type { ResolvedAddress } from "../api";

export interface PickedLocation {
  lat: number;
  lng: number;
}

function loadMaps(key: string): Promise<void> {
  if (window.google?.maps) return Promise.resolve();
  if (window.__alignMapsLoading) return window.__alignMapsLoading;
  window.__alignMapsLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=geometry`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google Maps could not be loaded."));
    document.head.appendChild(script);
  });
  return window.__alignMapsLoading;
}

export default function LocationPicker({
  value,
  onChange,
  onResolved,
  query = "",
}: {
  value: PickedLocation | null;
  onChange: (next: PickedLocation | null) => void;
  /** The address the pin landed on, so the form below can fill itself in. */
  onResolved?: (address: ResolvedAddress) => void;
  /** The address as typed in the form. The pin follows it until the doctor
      moves the pin themselves, at which point their placement wins. */
  query?: string;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const marker = useRef<any>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<{ text: string }[]>([]);
  // Once the pin is placed by hand, typing must not drag it away again.
  const pinnedByHand = useRef(false);

  // Keep the callback in a ref so the map is built once, not on every keystroke.
  const report = useRef(onChange);
  report.current = onChange;
  const resolved = useRef(onResolved);
  resolved.current = onResolved;
  const moveTo = useRef<((lat: number, lng: number, address?: string) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;

    api
      .mapConfig()
      .then((config) => {
        if (cancelled) return;
        if (!config.browser_key) {
          setFailed("Map picker is not configured. The typed address will be used instead.");
          return;
        }
        return loadMaps(config.browser_key).then(() => {
          if (cancelled || !holder.current) return;
          const maps = window.google.maps;
          const centre = value ?? config.centre ?? { lat: 23.0225, lng: 72.5714 };
          const map = new maps.Map(holder.current, {
            center: centre,
            zoom: value ? 16 : 12,
            mapTypeControl: false,
            streetViewControl: false,
          });
          marker.current = new maps.Marker({
            map,
            position: centre,
            draggable: true,
          });

          const settle = (position: any) => {
            const next = { lat: position.lat(), lng: position.lng() };
            marker.current.setPosition(next);
            report.current(next);
            setBusy(true);
            api
              .reverseGeocode(next.lat, next.lng)
              .then((r) => {
                setLabel(r.address);
                resolved.current?.(r.parts);
              })
              .catch(() => setLabel(""))
              .finally(() => setBusy(false));
          };

          marker.current.addListener("dragend", (e: any) => {
            pinnedByHand.current = true;
            settle(e.latLng);
          });
          map.addListener("click", (e: any) => {
            pinnedByHand.current = true;
            settle(e.latLng);
          });
          moveTo.current = (lat: number, lng: number, address?: string) => {
            const next = new maps.LatLng(lat, lng);
            marker.current.setPosition(next);
            map.setCenter(next);
            map.setZoom(16);
            report.current({ lat, lng });
            if (address) setLabel(address);
          };
          setReady(true);
          if (value) settle(new maps.LatLng(value.lat, value.lng));
        });
      })
      .catch((err) => !cancelled && setFailed(err.message));

    return () => {
      cancelled = true;
    };
    // Built once; the pin is moved through the marker, not by rebuilding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The address the doctor is typing drives the pin, the way a map search does.
  useEffect(() => {
    if (!ready || pinnedByHand.current) return;
    const text = query.trim();
    if (text.length < 8) return;
    const timer = setTimeout(() => {
      setBusy(true);
      api
        .searchAddress(text)
        .then((r) => {
          if (r.result && moveTo.current) {
            moveTo.current(r.result.lat, r.result.lng, r.result.address);
          }
        })
        .catch(() => undefined)
        .finally(() => setBusy(false));
    }, 700);
    return () => clearTimeout(timer);
  }, [query, ready]);

  // Explicit search box, for when the form address is not what you want.
  useEffect(() => {
    const text = search.trim();
    if (text.length < 3) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .suggestAddress(text)
        .then((r) => setHits(r.suggestions))
        .catch(() => setHits([]));
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  function goTo(text: string) {
    setBusy(true);
    setHits([]);
    api
      .searchAddress(text)
      .then((r) => {
        if (r.result && moveTo.current) {
          pinnedByHand.current = true;
          moveTo.current(r.result.lat, r.result.lng, r.result.address);
          // Fill the form from where the pin actually landed.
          api
            .reverseGeocode(r.result.lat, r.result.lng)
            .then((rev) => resolved.current?.(rev.parts))
            .catch(() => undefined);
        }
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }

  function useMyLocation() {
    if (!navigator.geolocation) return;
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (marker.current && window.google?.maps) {
          marker.current.setPosition(next);
          marker.current.getMap().setCenter(next);
          marker.current.getMap().setZoom(16);
        }
        pinnedByHand.current = true;
        report.current(next);
        api
          .reverseGeocode(next.lat, next.lng)
          .then((r) => {
            setLabel(r.address);
            resolved.current?.(r.parts);
          })
          .catch(() => setLabel(""))
          .finally(() => setBusy(false));
      },
      () => setBusy(false),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }

  if (failed) return <div className="banner banner-warn">{failed}</div>;

  return (
    <div className="stack-sm">
      <div className="pick-search">
        <input
          placeholder="Search for a landmark, road or area"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              goTo(search);
            }
          }}
        />
        {hits.length > 0 && (
          <ul className="pick-hits">
            {hits.map((h) => (
              <li key={h.text}>
                <button type="button" onClick={() => { setSearch(h.text); goTo(h.text); }}>
                  {h.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div ref={holder} className="pick-map" />
      <div className="row-between" style={{ alignItems: "flex-start", gap: 12 }}>
        <span className="dim pick-where">
          {busy
            ? "Locating…"
            : label
              ? label
              : ready
                ? "Drag the pin, or tap the map, to mark your clinic."
                : "Loading map…"}
        </span>
        <button type="button" className="btn-ghost btn-sm" onClick={useMyLocation}>
          Use my current location
        </button>
      </div>
      {value && (
        <span className="dim num">
          pinned at {value.lat.toFixed(5)}, {value.lng.toFixed(5)}
        </span>
      )}
    </div>
  );
}
