# 3D Align — Order Portal

A web portal for a clear-aligner lab in Ahmedabad. Clinics onboard, place
orders, send scans, approve treatment plans, pay, and track shipments. The lab
runs its production queue, diary and technicians from the other side.

**Three things are sold, and they do not share a workflow.**

| | What it is | What it needs |
|---|---|---|
| **Aligners** | A planned course of treatment, delivered in phases | Records, a quote, a scan, planning, a fit aligner, phased dispatch |
| **By-products** | An appliance made to order — retainers, splints, trays, guards | A scan. Nothing else. |
| **Accessories** | Stock off a shelf — IPR strips, cleanser, retainer cases | Nothing at all |

Pushing all three down one pipeline is the mistake this codebase spent a while
making. Design notes and history are in [plan.md](plan.md).

```
backend/    FastAPI + SQLAlchemy 2.0 + Postgres (SQLite for local dev)
frontend/   React 18 + Vite + TypeScript
android/    Trusted Web Activity wrapper — no separate app code
```

---

## Run it

Two terminals. No database to install — it defaults to SQLite.

**Backend**

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --reload --port 8000
```

**Frontend**

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>.

The staff account is created on first boot from `STAFF_EMAIL` / `STAFF_PASSWORD`
(defaults: `staff@3dalign.com` / `changeme`). Register a doctor from the sign-in
page, approve it from the staff **Doctors** screen, then place an order.

Copy `.env.example` to `.env` at the repository root (or `backend/.env` —
both are read) to change anything. `SECRET_KEY` and `STAFF_PASSWORD` must be set
before this is exposed to anyone.

### Being signed in as both roles at once

The session is one httpOnly cookie, so signing in as staff replaces a doctor
session in the same browser. Cookies are scoped by hostname and ignore the port,
so use two hostnames for the same server:

| | |
|---|---|
| <http://localhost:5173> | staff |
| <http://127.0.0.1:5173> | doctor |

The **+ Account** button in the top bar does this for you — it opens a new tab
against a fresh session slot, so several roles can be watched side by side.

### Demo data

```bash
cd backend && .venv/bin/python seed_demo.py    # with the API running
```

Creates a verified doctor and six cases, one parked at each stage. It drives the
real HTTP API, so nothing bypasses validation. `seed_bulk.py` adds volume;
`simulate_day.py` seeds ten clinics and drives a full day through the scheduler.
To start clean, stop the server and delete `backend/dev.db`.

### Postgres instead of SQLite

```bash
docker compose up -d
DATABASE_URL=postgresql+psycopg://align:align@localhost:5432/align \
  backend/.venv/bin/python -m uvicorn app.main:app --reload
```

### Tests

Ten suites, all runnable directly, each against a throwaway database.

```bash
cd backend
for t in *_test.py; do .venv/bin/python "$t"; done
```

| Suite | Covers |
|---|---|
| `smoke_test.py` | The aligner case end to end — 231 assertions, including every recovery path |
| `product_test.py` | The three pipelines: where each starts, what it is asked for, that only aligners are quoted |
| `payment_flow_test.py` | When each kind is paid for, and what an unpaid appliance holds up |
| `order_integrity_test.py` | Frozen prices, patient-less stock orders, storage-rename failures |
| `booking_test.py` | The scan diary, technicians, travel and reassignment — 135 assertions |
| `routing_test.py` | Route building and travel estimates |
| `assignment_test.py` | Case assignment to orthodontists |
| `session_test.py` | Cookie sessions, rolling refresh, revocation |
| `storage_test.py` | Local and S3 storage backends |
| `viewer_test.py` | Mesh conversion and the 3D simulation |

`smoke_test.py` is the one that matters most: it is what makes the aligner
workflow safe to refactor around.

---

## How the system is put together

### One transition function

`Order.status` is only ever changed by `transitions.transition()`, which checks
the move against an explicit map, stamps timestamps, writes a `status_events`
audit row, and notifies the other party — all in one database transaction.
Endpoints never assign `order.status` directly. Illegal moves raise `409`.

That single rule is what keeps the workflow honest as the app grows.

### The three pipelines

All three share one `orders` table and one status enum. What differs is which
statuses each kind can reach, and how it gets in.

**Aligner** — the full clinical workflow.

```
DRAFT → SUBMITTED → UNDER_REVIEW → QUOTED → AWAITING_SCAN → SCAN_SUBMITTED
      → IN_PLANNING → PLAN_SHARED → TRAINING_ALIGNER_PRODUCTION
      → TRAINING_ALIGNER_SHIPPED → FIT_REVIEW → ALIGNER_PRODUCTION
      → DISPATCHING ⇄ PHASE_REVIEW → COMPLETED
```

| # | Status | Ball is with | What happens |
|---|---|---|---|
| 1 | `DRAFT` | Doctor | Patient, clinical detail, records upload. Not visible to the lab. |
| 2 | `SUBMITTED` | Doctor | Enquiry reference issued, storage folder created. |
| 3 | `UNDER_REVIEW` | Staff | Records checked for adequacy. |
| 4 | `RECORDS_REQUESTED` | Doctor | Bounced back with a note; upload panel reopens. |
| 5 | `QUOTED` | Doctor | An **Align band** is picked from the photographs. Accepting is the gate to production. |
| 6 | `AWAITING_SCAN` | Doctor | Upload an STL, book a scan visit, or courier an impression. |
| 7 | `SCAN_SUBMITTED` | Staff | A scan is with the lab to verify. Accept, or send back. |
| 8 | `IN_PLANNING` | Staff | AL number spent here. Treatment planning under way. |
| 9 | `PLAN_SHARED` | Doctor | Approve, or request a revision with notes. Gated on the plan fee. |
| 10 | `TRAINING_ALIGNER_PRODUCTION` | Staff | Training aligner fabricated. |
| 11 | `TRAINING_ALIGNER_SHIPPED` | Staff | Shipment created with carrier + tracking. |
| 12 | `FIT_REVIEW` | Doctor | Fit verdict **and** how many phases to dispatch in. |
| 13 | `FIT_ISSUE` | Staff | Rescan, replan, refabricate, or remake one phase. |
| 14 | `ALIGNER_PRODUCTION` | Staff | The batch in fabrication. |
| 15 | `DISPATCHING` | Staff | One shipment per phase. |
| 16 | `PHASE_REVIEW` | Staff | Progress photographs read; carry on, or take a mid-course scan. |
| 17 | `COMPLETED` | — | Terminal. |
| 18 | `CANCELLED` | — | With a reason, from any non-terminal state. Terminal. |

These are the eighteen an aligner case can reach. The enum has nineteen — the
extra is `PRODUCT_FABRICATION`, which belongs to the two pipelines below and is
unreachable from here.

**By-product** — priced from the catalogue, so there is nothing to quote.

```
(placed) → AWAITING_SCAN → SCAN_SUBMITTED → PRODUCT_FABRICATION
         → DISPATCHING → COMPLETED
```

Placing the order is the whole of the decision. No photographs are asked for up
front — the technician takes them at the scan visit if the product wants them.
All three arches are still required, at the scan stage where they belong.
Quoting one is refused outright: an Align band prices a course of treatment by
aligner count, and a retainer has neither.

**Accessory** — stock, so nothing is made and nothing is scanned.

```
(placed) → PRODUCT_FABRICATION ("Being packed") → DISPATCHING → COMPLETED
```

No patient is required. Several items and quantities ride on one order, and they
can also ride along on a by-product order — which is why the order dialog asks.

### Payment

Three transactions, three answers.

| | When it is paid | Blocks the next order? |
|---|---|---|
| Aligner | Per phase, one phase behind delivery | No |
| Accessory | Before it leaves the building | No |
| **By-product** | **After dispatch** | **Yes** |

A by-product is an appliance the lab has already made to a prescription, so
holding it hostage to a receipt helps nobody — it ships first. The brake on that
becoming an open tab is that a clinic settles what it has **already received**
before starting another. An order still on the bench owes nothing and holds
nothing.

Clinics pay by UPI and upload the screenshot; the lab verifies each one. Prices
are written onto the order when it is placed, so repricing the catalogue cannot
move a bill someone has already been shown.

### References

| Series | Shape | Spent when |
|---|---|---|
| Enquiry | `EN-2026-0001` | Every order, at creation |
| Aligner | `AL-2026-0001` | The case reaches planning |
| By-product | `3DAER(1.0)001` | It reaches the bench — code, thickness, per-product sequence |
| Accessory | `3DAACC001` | It reaches packing |

### Data model

Thirty-three tables in `backend/app/models.py`. The parts that matter:

- **`shipments` is a table, not a field.** Phased dispatch means several
  shipments per order, each with its own aligner range and tracking number.
- **`order_phases` carries its own state and round.** A mid-course rescan
  resumes at the earliest unfinished phase; a fit issue inside a delivered phase
  reopens only that phase. Neither can be inferred from the last shipment, which
  is why it is written down.
- **`quotes` and `treatment_plans` are versioned.** A new version supersedes the
  last; nothing is overwritten.
- **`products` / `product_sizes` / `accessories`** are the catalogue, editable by
  the lab. Each carries an `image_url`, empty until the lab photographs its own
  stock.
- **`patients` is an entity** scoped to a doctor. Null on an accessory order —
  restocking is the practice buying supplies, not clinical work.
- **`status_events`** is append-only and renders the timeline in both portals.
- Money is `numeric(12,2)`, quantized on write. Never float.

### Access control

- Session in an httpOnly, SameSite=Lax cookie — not a JWT in localStorage.
  Sixty-day lifetime with a rolling refresh, so an installed app does not ask
  for a password every time it is opened.
- Doctors resolve orders through one `owned_order()` helper that filters on
  `doctor_id`, so scoping cannot be forgotten endpoint by endpoint.
- `/api/staff/*` requires a lab role.
- Doctors are gated behind `VERIFIED` for everything except their own profile.
- Case files are authorised per request. Nothing is served by public link.
- Changing a password or deactivating an account revokes every open session.

### Case files

| `STORAGE_BACKEND` | Where files land |
|---|---|
| `local` (default) | `backend/storage/` |
| `s3` | Any S3-compatible bucket — Supabase, R2, B2 |
| `drive` | A Google service account on a Shared Drive |

```
<root>/Orders/AL-2026-0417/{records,scans,planning}/
```

Keyed on the order reference, which is renamed once when the order takes its
number. Nothing is ever shared publicly — the previous portal set
`{'type': 'anyone', 'role': 'reader'}` on patient folders, putting identifiable
records on permanent public URLs.

### The rest of it

- **3D simulation** — staged arch models are converted to a compact binary mesh
  format and stepped through in a three.js viewer. Bite registration uses a
  trimmed ICP fit.
- **Scan diary** — technicians, availability, time off, travel-aware routing
  through the Google Routes API, and reassignment requests.
- **Insights** — order volume, product and band breakdowns, and money collected,
  for both the clinic and the lab.
- **Notifications** — in-app, plus Web Push to installed devices.

---

## Android

`android/` wraps the deployed site as a Trusted Web Activity. There is no
separate app codebase: what ships is the same frontend, so a deploy updates the
app without a release.

```bash
cd android && node twa/build.mjs
```

Signed artifacts land in `android/dist/`.

> The release keystore and its password are **not** in this repository and must
> not be. Losing them means the app can never be updated.

---

## Deployment

Render (Docker) → Neon Postgres → Supabase storage, all on free tiers.
`migrate_dev.py` runs on every boot.

```bash
render deploys create <service-id>
```

`migrate_dev.py` has a section for changes both dialects can do and a section
below it that is SQLite-only. **New work belongs in the first one** — anything
added after the guard runs in development and silently skips production, which
has now happened twice.

---

## Still open

- **Composable pipelines.** The three workflows are three hardcoded pipelines,
  one in Python and one in TypeScript, rather than a declared object the two
  share. Adding a fourth product means editing both. Deliberately postponed.
- The order row still carries every workflow's fields regardless of kind — an
  accessory order has an `arch` and a `fit_round`. Its remedy is the same
  refactor.
- **Rotate the Refrens private key.** It was hardcoded in the old `portal.py`
  and is in that repository's git history.
- Alembic, in place of `create_all()` plus `migrate_dev.py`.
- Product photographs. `image_url` exists and is empty; the tiles show a marked
  placeholder until it is filled.
- GST treatment for intra-state versus inter-state.
