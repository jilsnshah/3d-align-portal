/* The ordered stops of a day, with the running clock.

   Arrival times are recomputed against traffic each time this is fetched, so a
   visit booked weeks ago that no longer fits shows up here as late rather than
   as a surprise on the day. */

import { formatTime } from "../api";
import type { DayRoute } from "../api";

function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function RouteSheet({
  route,
  navigable = false,
}: {
  route: DayRoute;
  navigable?: boolean;
}) {
  if (route.stops.length === 0) {
    return <div className="empty">No visits scheduled.</div>;
  }

  return (
    <div className="stack-sm">
      <div className="row" style={{ gap: 18 }}>
        <span className="num">
          <b>{route.stops.filter((s) => s.kind === "visit").length}</b>{" "}
          <span className="dim">stops</span>
        </span>
        <span className="num">
          <b>{route.total_km.toFixed(1)}</b> <span className="dim">km</span>
        </span>
        <span className="num">
          <b>{hours(route.drive_minutes)}</b> <span className="dim">driving</span>
        </span>
        <span className="num">
          <b>{hours(route.onsite_minutes)}</b> <span className="dim">on site</span>
        </span>
      </div>

      {route.warnings.map((warning) => (
        <div className="banner banner-danger" key={warning}>
          {warning}
        </div>
      ))}

      <ol className="route-list">
        {route.stops.map((stop, index) => (
          <li key={`${stop.kind}-${index}`} className={stop.late_by_minutes > 0 ? "late" : ""}>
            <span className="route-time num">
              {stop.arrives_at ? formatTime(stop.arrives_at) : formatTime(stop.departs_at ?? "")}
            </span>
            <span className="route-body">
              <b>{stop.label}</b>
              {stop.order_reference && (
                <span className="dim"> · {stop.order_reference}</span>
              )}
              {stop.patient_name && <span className="dim"> · {stop.patient_name}</span>}
              {stop.address && <span className="route-address">{stop.address}</span>}
              {stop.leg_km > 0 && (
                <span className="dim">
                  {stop.leg_km.toFixed(1)} km · {Math.round(stop.leg_minutes)} min drive
                </span>
              )}
              {stop.late_by_minutes > 0 && stop.booked_for && (
                <span className="route-late">
                  booked for {formatTime(stop.booked_for)} — arriving{" "}
                  {Math.round(stop.late_by_minutes)} min late
                </span>
              )}
              {navigable && stop.latitude != null && stop.longitude != null && (
                <a
                  className="route-nav"
                  href={`https://www.google.com/maps/dir/?api=1&destination=${stop.latitude},${stop.longitude}&travelmode=driving`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Navigate here ↗
                </a>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
