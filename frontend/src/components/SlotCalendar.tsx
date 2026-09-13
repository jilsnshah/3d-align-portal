/* Booking a scan visit: the month, the day's times, and what has been picked,
   all in one frame.

   It used to be a month grid alone. Opening a day mounted the times underneath
   it, and picking a time mounted the notes and the booking button underneath
   those — so a doctor who clicked "Book a scan visit" saw a calendar appear
   below the fold, clicked a day, and had no idea anything had happened because
   the times were another screen further down. Three decisions, each hidden
   under the last.

   Now the month sits beside the day, so choosing a day fills the panel next to
   it rather than somewhere below; the first day with capacity is open on
   arrival, so times are on screen from the start; and the choice is repeated
   in a bar at the foot of the frame, where the button that acts on it lives.

   Times still come from real travel windows rather than a fixed grid, so a day
   can offer 15:35 as easily as 15:30. Unreachable times stay visible and
   disabled rather than disappearing, so the doctor can see a day filling up
   instead of wondering where the times went. */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { api, formatTime, toISODate } from "../api";
import type { Slot } from "../api";
import { bringIntoView } from "./Reveal";

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

function dayName(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
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
  /* Only after the doctor picks a day themselves does the times panel chase
     the screen on a phone; the one opened for them on arrival must not yank
     the page as it loads. */
  const chosenByHand = useRef(false);
  const times = useRef<HTMLDivElement | null>(null);

  // A slot chosen for one clinic may not be reachable for another, so switching
  // address clears the picked day rather than silently keeping a stale time.
  useEffect(() => {
    setOpenDay(null);
    chosenByHand.current = false;
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
    days.data?.forEach((d) => map.set(d.date, { open: d.technicians_free > 0, closed: d.closed }));
    return map;
  }, [days.data]);

  /* The soonest day anybody can come, opened on arrival: the panel beside the
     month is never empty, so the reader can see what booking a visit means
     without hunting for it. */
  const firstFree = useMemo(() => days.data?.find((d) => d.technicians_free > 0)?.date ?? null, [days.data]);
  useEffect(() => {
    if (!openDay && firstFree) setOpenDay(firstFree);
  }, [firstFree, openDay]);

  // On a phone the day panel sits under the month, so a day chosen by hand
  // brings its times up to the eye.
  useEffect(() => {
    if (!openDay || !chosenByHand.current) return;
    const frame = requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 900px)").matches) bringIntoView(times.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [openDay]);

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
  const free = openSlots.filter((s) => s.available).length;
  const thisMonth = month.getMonth() === today.getMonth() && month.getFullYear() === today.getFullYear();

  return (
    <div className="cal">
      <div className="cal-frame">
        <div className="cal-month">
          <div className="cal-head">
            <button
              type="button"
              className="cal-nav"
              disabled={thisMonth}
              aria-label="Previous month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            >
              ‹
            </button>
            <strong>
              {MONTH_NAMES[month.getMonth()]} {month.getFullYear()}
            </strong>
            <button
              type="button"
              className="cal-nav"
              aria-label="Next month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            >
              ›
            </button>
          </div>

          <div className="cal-grid" aria-busy={days.isLoading}>
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
              const isOpen = openDay === key;
              const picked = selected ? toISODate(new Date(selected.starts_at)) === key : false;

              return (
                <button
                  key={key}
                  type="button"
                  disabled={!hasRoom}
                  aria-pressed={isOpen}
                  className={`cal-day${hasRoom ? " has-slots" : ""}${isOpen ? " open" : ""}${picked ? " picked" : ""}`}
                  onClick={() => {
                    chosenByHand.current = true;
                    setOpenDay(key);
                  }}
                >
                  <span className="n">{date.getDate()}</span>
                  {picked && <span className="cal-tick" aria-hidden="true" />}
                </button>
              );
            })}
          </div>

          <p className="cal-legend">
            <span className="swatch free" /> a technician can come
            <span className="swatch full" /> closed or fully booked
          </p>
        </div>

        <div className="cal-times" ref={times}>
          {!openDay ? (
            <p className="cal-none">
              {days.isLoading ? "Reading the diary…" : "No day this month has room. Try the next one."}
            </p>
          ) : (
            <>
              <div className="cal-times-head">
                <b>{dayName(openDay)}</b>
                <span>
                  {dayDetail.isLoading
                    ? "Working out the times…"
                    : free > 0
                      ? `${free} time${free === 1 ? "" : "s"} a technician can reach you`
                      : "Nobody can reach you this day"}
                </span>
              </div>

              {dayDetail.isLoading ? (
                <div className="cal-skeleton" aria-hidden="true">
                  {Array.from({ length: 8 }, (_, i) => (
                    <span key={i} />
                  ))}
                </div>
              ) : openSlots.length === 0 ? (
                <p className="cal-none">The lab is closed this day. Pick another.</p>
              ) : free === 0 ? (
                <p className="cal-none">
                  Every time this day is already taken or too far to reach. Pick another day.
                </p>
              ) : (
                <div className="cal-sections">
                  {openSlots.length === 1 &&
                    new Date(openSlots[0].ends_at).getTime() - new Date(openSlots[0].starts_at).getTime() >
                      4 * 60 * 60 * 1000 && (
                      <div className="banner banner-warn">
                        This clinic is outside the service city, so a technician comes out for the whole
                        day. Booking it takes one person off every other visit that day.
                      </div>
                    )}
                  {slotSections(openSlots).map((section) => (
                    <div key={section.label} className="cal-part">
                      <h4>
                        {section.label}
                        <span>{section.slots.filter((s) => s.available).length} free</span>
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
                              aria-pressed={isSelected}
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
            </>
          )}
        </div>
      </div>

      {/* What has been chosen, said where the choosing happens — the button
          that acts on it is directly below this, inside the step. */}
      <p className={`cal-picked${selected ? " on" : ""}`} role="status">
        {selected ? (
          <>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m5 12.5 4.5 4.5L19 7.5" />
            </svg>
            <span>
              Picked <b>{new Date(selected.starts_at).toLocaleString("en-IN", {
                weekday: "long",
                day: "numeric",
                month: "long",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}</b> — confirm it below.
            </span>
          </>
        ) : (
          <span>Pick a time to carry on.</span>
        )}
      </p>
    </div>
  );
}
