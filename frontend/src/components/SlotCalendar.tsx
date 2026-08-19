/* Month calendar for booking a scan visit.

   Times come from real travel windows rather than a fixed grid, so a day can
   offer 15:35 as easily as 15:30. Unreachable times stay visible and disabled
   rather than disappearing, so the doctor can see a day filling up instead of
   wondering where the times went. */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { api, formatTime, toISODate } from "../api";
import type { Slot } from "../api";
import { Loading } from "./ui";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

/** Fine granularity means a lot of buttons; splitting the day keeps them
    scannable. Empty halves are dropped rather than shown as a bare heading. */
function slotSections(slots: Slot[]): { label: string; slots: Slot[] }[] {
  const morning = slots.filter((s) => new Date(s.starts_at).getHours() < 13);
  const afternoon = slots.filter((s) => new Date(s.starts_at).getHours() >= 13);
  return [
    { label: "Morning", slots: morning },
    { label: "Afternoon", slots: afternoon },
  ].filter((section) => section.slots.length > 0);
}

export default function SlotCalendar({
  onPick,
  selected,
  addressId,
}: {
  onPick: (slot: Slot) => void;
  selected: Slot | null;
  /** Which clinic the technician is travelling to. Availability depends on it:
      a clinic across the city fits into fewer of a technician's gaps. */
  addressId?: string | null;
}) {
  const today = new Date();
  const [month, setMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [openDay, setOpenDay] = useState<string | null>(null);

  // A slot chosen for one clinic may not be reachable for another, so switching
  // address clears the picked day rather than silently keeping a stale time.
  useEffect(() => {
    setOpenDay(null);
  }, [addressId]);

  const from = toISODate(new Date(month.getFullYear(), month.getMonth(), 1));
  const to = toISODate(new Date(month.getFullYear(), month.getMonth() + 1, 0));

  const days = useQuery({
    queryKey: ["availability", from, to, addressId ?? ""],
    queryFn: () => api.availability(from, to, addressId ?? undefined),
  });

  // The month only knows which days have capacity; exact times are fetched
  // when a day is actually opened, because working them out costs a routing
  // call per leg of every technician's day.
  const dayDetail = useQuery({
    queryKey: ["availability-day", openDay, addressId ?? ""],
    queryFn: () => api.dayAvailability(openDay!, addressId ?? undefined),
    enabled: Boolean(openDay),
  });

  const byDate = useMemo(() => {
    const map = new Map<string, { open: boolean; closed: boolean }>();
    days.data?.forEach((d) =>
      map.set(d.date, { open: d.technicians_free > 0, closed: d.closed }),
    );
    return map;
  }, [days.data]);

  // Monday-first grid, padded so the 1st lands on the right weekday.
  const cells: (Date | null)[] = [];
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7;
  for (let i = 0; i < lead; i += 1) cells.push(null);
  const lastDate = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  for (let d = 1; d <= lastDate; d += 1) {
    cells.push(new Date(month.getFullYear(), month.getMonth(), d));
  }

  const openSlots = dayDetail.data?.slots ?? [];

  return (
    <div className="stack-sm">
      <div className="cal-head">
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
        >
          ‹
        </button>
        <strong>
          {MONTH_NAMES[month.getMonth()]} {month.getFullYear()}
        </strong>
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
        >
          ›
        </button>
      </div>

      {days.isLoading ? (
        <Loading what="availability" />
      ) : (
        <>
          <div className="cal-grid">
            {DAY_INITIALS.map((d, i) => (
              <div key={i} className="cal-dow">
                {d}
              </div>
            ))}
            {cells.map((date, index) => {
              if (!date) return <div key={`pad-${index}`} />;
              const key = toISODate(date);
              const info = byDate.get(key);
              const hasRoom = info?.open ?? false;
              const closed = info?.closed ?? true;
              const isOpen = openDay === key;

              return (
                <button
                  key={key}
                  type="button"
                  disabled={!hasRoom}
                  className={`cal-day${hasRoom ? " has-slots" : ""}${isOpen ? " open" : ""}`}
                  onClick={() => setOpenDay(key)}
                >
                  <span className="n">{date.getDate()}</span>
                  <span className="s">
                    {closed ? "closed" : hasRoom ? "open" : "full"}
                  </span>
                </button>
              );
            })}
          </div>

          <p className="cal-legend">
            <span className="swatch free" /> has capacity
            <span className="swatch full" /> fully booked or closed
          </p>

          {openDay && (
            <div className="card" style={{ marginTop: 4 }}>
              <h4 style={{ marginBottom: 10 }}>
                {new Date(`${openDay}T00:00:00`).toLocaleDateString("en-IN", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
              </h4>
              {dayDetail.isLoading ? (
                <Loading what="times" />
              ) : openSlots.length === 0 ? (
                <p className="dim">The lab is closed this day.</p>
              ) : openSlots.every((s) => !s.available) ? (
                <p className="dim">
                  No technician can reach you on this day. Try another.
                </p>
              ) : (
                <div className="stack-sm">
                  {openSlots.length === 1 &&
                    new Date(openSlots[0].ends_at).getTime() -
                      new Date(openSlots[0].starts_at).getTime() >
                      4 * 60 * 60 * 1000 && (
                      <div className="banner banner-warn">
                        This clinic is outside the service city, so a technician comes out for the
                        whole day. Booking it takes one person off every other visit that day.
                      </div>
                    )}
                  {slotSections(openSlots).map((section) => (
                    <div key={section.label}>
                      <h4 style={{ marginBottom: 7 }}>
                        {section.label}
                        <span className="dim" style={{ marginLeft: 8, fontWeight: 400 }}>
                          {section.slots.filter((s) => s.available).length} available
                        </span>
                      </h4>
                      <div className="slot-grid">
                        {section.slots.map((slot) => {
                          const isSelected = selected?.starts_at === slot.starts_at;
                          return (
                            <button
                              key={slot.starts_at}
                              type="button"
                              disabled={!slot.available}
                              title={slot.available ? "Available" : slot.reason}
                              className={`slot${isSelected ? " picked" : ""}`}
                              onClick={() => onPick(slot)}
                            >
                              {formatTime(slot.starts_at)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
