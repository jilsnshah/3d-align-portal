# Scan Booking System — Plan

3D Align employs scan technicians who travel to clinics, take the intraoral
scan, and upload it against the case. This adds the booking layer that gets a
technician to the right clinic at the right time.

Three things have to be true when this is done:

1. A doctor picks a slot from a **calendar** that clearly shows what is free and
   what is taken.
2. A technician is **assigned automatically** from whoever is free in that slot.
3. A technician's day is **only the cases they were sent to**, so they cannot
   wander into someone else's case by accident.

> Replaces the placeholder `scan_appointments` table and the free-text
> `datetime-local` field. The `UPLOAD` and `COURIER` scan routes are unaffected.

---

## 1. Roles

Today there are two roles and the portal assumes **one** staff account. Add a
third.

| Role | Who | What they get |
|---|---|---|
| `DOCTOR` | Clinic | Their own cases (unchanged) |
| `ADMIN` | The lab | Everything, plus bookings, technicians, and settings |
| `TECHNICIAN` | Scan staff, 3–4 of them | The same case tools as admin, but their landing view is **today's assigned jobs** |

Technicians are not given a cut-down data model — they are lab staff and need to
see the case they are scanning. What they do **not** get is the admin furniture:

- managing other technicians or their availability
- booking settings
- doctor verification
- the all-cases list — they reach a case through their own schedule

So: same case powers, no admin surface, and a day view that keeps them in their
own lane. `TECHNICIAN` endpoints are scoped to *their* appointments; case
endpoints they share with admin.

**Migration:** the existing `STAFF` user becomes `ADMIN`. `current_staff` →
`current_admin`, plus `current_lab` (admin *or* technician) for the case
endpoints both use. Mechanical rename, one commit, before any booking code.

---

## 2. Configuration lives in the database

Every scheduling knob is admin-editable, not an env var:

| Setting | Default | Meaning |
|---|---|---|
| `slot_minutes` | 60 | Length of a scan visit |
| `travel_buffer_minutes` | 30 | Dead time either side of a job |
| `booking_horizon_days` | 30 | How far ahead a doctor may book |
| `min_notice_hours` | 24 | No bookings sooner than this |
| `working_hours` | Mon–Sat 09:00–18:00 | Per-weekday open/close, or closed |
| `max_daily_jobs` | 4 | Per technician |

One `booking_settings` row, edited from **Admin → Settings**. Working hours are
per weekday so Saturday can be a half day and Sunday closed.

---

## 3. Availability: computed, not generated

No slot table, no nightly job. Free times are derived on read from working hours
minus existing appointments minus time off. A roster change applies instantly.

**There is no slot grid.** A visit can start at any moment a technician can
actually reach the clinic. For each gap in a technician's day the scheduler
computes the window a visit fits into:

```
earliest start = previous job ends + travel(previous clinic -> this clinic) + margin
latest  start  = next job starts   - travel(this clinic -> next clinic)
                                   - the visit itself - margin
```

Everything between those two is bookable. A technician finishing in Bopal at
10:45 who needs 47 minutes to reach Maninagar offers **11:32**, not "the 11:30
hour is gone".

The doctor is shown:

- times on `booking_granularity_minutes` (default 15) across the open day, so
  unavailable times stay visible and a day is seen filling up, **plus**
- each window's exact earliest arrival, because that is the whole point

Everyone starts and ends the day at the lab, so the first and last visit are
costed against a real origin rather than being unconstrained.

A time is offered if *anyone* can reach it. The doctor picks a time; the system
picks the person.

### Travel times, with traffic

Resolved cheapest-first:

1. the `travel_estimates` cache, keyed on `(origin, destination, weekday+hour)`
   — a 09:00 Monday run and a 17:00 Friday run are different journeys, so the
   departure hour is part of the key. Entries expire after 14 days because
   traffic patterns drift.
2. **Google Routes** (`computeRouteMatrix`) with a `departureTime`, batching
   every origin against every destination in one request
3. straight-line distance x 1.4 road factor / `fallback_speed_kmph`

Two regimes:

- **Within two hours of departure**, the lookup is made live and never cached.
  A prediction is worthless when the traffic is already visible.
- **Further out**, the prediction is bucketed by weekday and hour and reused
  across every future booking that falls in the same slot.

Durations are **pessimistic** by default (`GOOGLE_TRAFFIC_MODEL`). A technician
arriving early is a non-event; arriving late in front of a waiting patient is
not, so the schedule is built against the bad traffic day rather than the
average one.

Rung 3 is what lets the system run with no API key at all, and what keeps
booking alive when the provider is down or out of quota. Scheduling never blocks
on a network call.

Addresses are geocoded **on write** — Google when a key is configured, an
offline table of Ahmedabad pincode centroids otherwise. An address that will not
resolve is still bookable; it falls back to the flat `travel_buffer_minutes`
rather than the system inventing a distance.

Travel is looked up once per technician per gap, not once per candidate time,
which is what keeps a month of calendar cheap.

### Re-validation

A visit booked three weeks ago was costed against *predicted* traffic. That
prediction is not a promise.

`services/routes.build_day_route` re-costs a technician's whole day against
current traffic and marks any stop whose projected arrival is later than its
booked time. It powers three things at once:

- the lab's route view (Bookings -> Routes)
- the technician's running sheet, refreshed every ten minutes
- the answer to "does today still hold?"

Without it, "never late" is a claim about an estimate made weeks earlier.

---

## 4. Assignment: cheapest insertion

The cost of a visit is what it **adds to the round**, not how far the technician
is in a straight line:

```
detour = travel(previous -> clinic) + travel(clinic -> next) - travel(previous -> next)
```

A technician further away but already passing the door beats a nearer one who
would have to double back.

```
cost = travel_weight   x detour_minutes
     + fairness_weight x minutes_committed_above_the_team_average
     + idle_weight     x stranded_minutes_too_small_to_reuse
```

Lowest cost wins; ties break on name so the result is stable and testable.

- **fairness** stops the most central technician soaking up every job. It is
  weighted to break near-ties rather than to override routing — the lab set
  efficiency first, and `max_daily_jobs` remains the hard backstop.
- **idle** only counts gaps too small to hold another visit. Booking midday on
  an open diary is free; leaving twelve unusable minutes is not.

Every weight, the maximum travel per visit, and the fallback speed are editable
from the admin panel, so the lab can dial efficiency against fairness without a
deploy.

The chosen technician and a one-line reason — "47 min away from the previous
stop; adds 94 min to the route" — go on the appointment so an admin can see why,
and reassign in one click if someone calls in sick.

---

## 5. Appointment lifecycle

```
doctor books ──► ASSIGNED ──► EN_ROUTE ──► COMPLETED   (scan uploaded)
                     │
                     ├──────────────────► NO_SHOW      (reason required)
                     └──────────────────► CANCELLED    (doctor or admin)
```

| Status | Meaning |
|---|---|
| `ASSIGNED` | Booked, technician allocated |
| `EN_ROUTE` | On the way — the doctor sees it, which kills the "are they coming?" call |
| `COMPLETED` | Scan taken. **Set by the STL upload**, never by a button |
| `NO_SHOW` | Attended, could not scan |
| `CANCELLED` | With a reason |

**Completion is the upload.** Same rule as everywhere else in this system: the
file arriving is the event. A technician cannot close a job with no scan
attached, and that upload also advances the order `AWAITING_SCAN →
SCAN_SUBMITTED`. One code path.

Doctors may cancel up to `min_notice_hours` before; inside that window the portal
tells them to contact the lab. Admins can cancel or reassign at any time.

---

## 6. Technicians re-capture records

A technician at the chair will often retake the intraoral and extraoral
photographs — the clinic's originals were good enough to quote from, not
necessarily good enough to plan from.

So technicians can upload `RECORD_PHOTO` as well as `INTRAORAL_SCAN` during
`AWAITING_SCAN`, and doing so **bumps `records_revision`**. The clinic's set
becomes `v1 · superseded`, the technician's becomes `v2 · current`, and the file
list already renders that distinction. No new mechanism — the revision system
built for rejected scans covers this exactly.

---

## 7. API surface

```
# doctor
GET   /appointments/availability?order_id&from&to    calendar grid, free + taken
POST  /orders/{id}/appointment                        book a slot
POST  /appointments/{id}/cancel

# technician
GET   /tech/schedule?scope=today|upcoming|past        own jobs
POST  /tech/jobs/{id}/en-route
POST  /tech/jobs/{id}/no-show
      (case + upload endpoints are the shared lab ones)

# admin
GET   /admin/bookings?from&to&technician_id&status
POST  /admin/bookings/{id}/reassign
POST  /admin/bookings/{id}/cancel
GET   /admin/technicians
POST  /admin/technicians                              creates user + profile
PATCH /admin/technicians/{id}
PUT   /admin/technicians/{id}/availability            weekly rules
POST  /admin/technicians/{id}/time-off
GET   /admin/settings
PUT   /admin/settings
```

---

## 8. Screens

### Doctor — calendar slot picker

A real month calendar, not a dropdown. Each day shows how many slots are free;
clicking a day opens that day's times as chips — **free** ones clickable in gold,
**booked** ones visibly present but disabled, so the doctor can see the day is
filling rather than wondering why times vanished. Confirming books it and shows
the assigned technician.

### Technician — schedule first

Lands on **Today**: each job as a card with time, clinic, address, patient, and
status. Opening a job gives the case with the usual tools plus **On my way** and
the upload panel. Upcoming and past are separate tabs. No all-cases list.

### Admin — Bookings, beside Doctors

- **Week calendar** — technicians as columns, time down the side.
- **List** — filter by date, technician, status.
- **Detail** — reassign, cancel, and the event log.
- **Technicians** — roster, weekly availability, time off, capacity.
- **Settings** — the table in §2.

---

## 9. Order lifecycle integration

**No new order status.** `AWAITING_SCAN` already means "the scan has not
arrived"; the appointment carries the scheduling detail. Duplicating it into
`orders.status` is the mistake the original system made with its one `status`
string.

The progress rail's **Scan** phase gains a line underneath — "Technician booked,
Tue 18 Aug 10:00" — and the admin queue gains a bookings tile.

---

## 10. Build order

| Phase | Scope |
|---|---|
| **B1** | Role split (`ADMIN`, `TECHNICIAN`), `technicians` table, `booking_settings`, admin creates technician accounts |
| **B2** | Availability rules, time off, admin availability + settings editors |
| **B3** | Availability computation endpoint |
| **B4** | `appointments` table, assignment, book + cancel |
| **B5** | Doctor calendar picker |
| **B6** | Technician schedule portal, en route, no-show, record re-capture |
| **B7** | Admin Bookings: calendar, list, detail, reassign |
| **B8** | Tests per transition and per access rule |

---

## 11. Deliberately not doing

- **No scoring algorithm.** Least-loaded, that is all.
- **No service areas.** One city.
- **No concurrency machinery.** Availability is re-checked when the booking is
  written, which is enough at this volume; no locking, no retry loops.
- **No cut-down technician schema.** They are lab staff and see the case.
- **No new order status.**
