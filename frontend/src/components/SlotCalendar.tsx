/* Month calendar for booking a scan visit.
   Booked slots stay visible and disabled rather than disappearing, so the
   doctor can see a day filling up instead of wondering where the times went. */

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { api, formatTime, toISODate } from "../api";
import type { Slot } from "../api";
import { Loading } from "./ui";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

export default function SlotCalendar({
  onPick,
  selected,
}: {
  onPick: (slot: Slot) => void;
  selected: Slot | null;
}) {
  const today = new Date();
  const [month, setMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [openDay, setOpenDay] = useState<string | null>(null);

  const from = toISODate(new Date(month.getFullYear(), month.getMonth(), 1));
  const to = toISODate(new Date(month.getFullYear(), month.getMonth() + 1, 0));

  const days = useQuery({
    queryKey: ["availability", from, to],
    queryFn: () => api.availability(from, to),
  });

  const byDate = useMemo(() => {
    const map = new Map<string, { free: number; closed: boolean; slots: Slot[] }>();
    days.data?.forEach((d) =>
      map.set(d.date, { free: d.free_count, closed: d.closed, slots: d.slots }),
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

  const openSlots = openDay ? (byDate.get(openDay)?.slots ?? []) : [];

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
              const free = info?.free ?? 0;
              const closed = info?.closed ?? true;
              const isOpen = openDay === key;

              return (
                <button
                  key={key}
                  type="button"
                  disabled={free === 0}
                  className={`cal-day${free > 0 ? " has-slots" : ""}${isOpen ? " open" : ""}`}
                  onClick={() => setOpenDay(key)}
                >
                  <span className="n">{date.getDate()}</span>
                  <span className="s">
                    {closed ? "closed" : free > 0 ? `${free} free` : "full"}
                  </span>
                </button>
              );
            })}
          </div>

          <p className="cal-legend">
            <span className="swatch free" /> slots free
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
              {openSlots.length === 0 ? (
                <p className="dim">The lab is closed this day.</p>
              ) : (
                <div className="slot-grid">
                  {openSlots.map((slot) => {
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
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
