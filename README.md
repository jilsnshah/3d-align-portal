# 3D Align — Order Portal

A web portal for clear aligner cases. Dentists onboard, submit cases, approve
quotes and treatment plans, and track shipments. Lab staff run the production
queue from the other side.

One product line: **3D Aligners**. No chatbot, no WhatsApp — the design and
rationale are in [plan.md](plan.md).

```
backend/    FastAPI + SQLAlchemy + Postgres (SQLite for local dev)
frontend/   React + Vite + TypeScript
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
page, approve it from the staff **Doctors** screen, then submit a case.

Copy `.env.example` to `.env` to change anything. `SECRET_KEY` and
`STAFF_PASSWORD` must be set before this is exposed to anyone.

### Being signed in as both roles at once

The session is one httpOnly cookie, so signing in as staff replaces a doctor
session in the same browser — correct behaviour, awkward when you want to watch
both sides of a case.

Cookies are scoped by hostname and ignore the port, so use two hostnames for the
same server:

| | |
|---|---|
| <http://localhost:5173> | staff |
| <http://127.0.0.1:5173> | doctor |

An incognito window works too. Both rely on the dev server binding every
interface, which `server.host: true` in `vite.config.ts` handles.

### Demo data

```bash
cd backend && .venv/bin/python seed_demo.py    # with the API running
```

Creates a verified doctor and six cases, one parked at each stage of the
workflow. It drives the real HTTP API, so nothing bypasses validation. Re-running
adds six more; to start clean, stop the server and delete `backend/dev.db`.

### Postgres instead of SQLite

```bash
docker compose up -d
DATABASE_URL=postgresql+psycopg://align:align@localhost:5432/align \
  backend/.venv/bin/python -m uvicorn app.main:app --reload
```

### Tests

```bash
cd backend && .venv/bin/python smoke_test.py
```

Walks one order from `DRAFT` to `COMPLETED` — including the records bounce-back,
quote revision, plan revision, phased dispatch, and the ownership and
immutability rules — against a throwaway database.

---

## How the system is put together

### One transition function

`Order.status` is only ever changed by `transitions.transition()`, which checks
the move against an explicit map, stamps timestamps, writes a `status_events`
audit row, and notifies the other party — all in one database transaction.
Endpoints never assign `order.status` directly. Illegal moves raise `409`.

That single rule is what keeps the workflow honest as the app grows.

### Order lifecycle

| # | Status | Ball is with | What happens |
|---|---|---|---|
| 1 | `DRAFT` | Doctor | Patient, clinical detail, records upload. Not visible to the lab. |
| 2 | `SUBMITTED` | Doctor | Order number issued, storage folder created. |
| 3 | `UNDER_REVIEW` | Staff | Records checked for adequacy. |
| 4 | `RECORDS_REQUESTED` | Doctor | Bounced back with a note; upload panel reopens. |
| 5 | `QUOTED` | Doctor | Priced quote sent. Accepting is the gate to production. |
| 6 | `AWAITING_SCAN` | Doctor | Nothing has arrived. Upload an STL, book a scan, or courier an impression. |
| 7 | `SCAN_SUBMITTED` | Staff | A scan is with the lab to verify. Accept, or send back for another. |
| 8 | `IN_PLANNING` | Staff | Scan accepted; treatment planning under way. |
| 9 | `PLAN_SHARED` | Doctor | Approve, or request a revision with notes. |
| 10 | `TRAINING_ALIGNER_PRODUCTION` | Staff | Training aligner fabricated. |
| 11 | `TRAINING_ALIGNER_SHIPPED` | Staff | Shipment created with carrier + tracking. |
| 12 | `FIT_REVIEW` | Doctor | Fit verdict **and** dispatch mode in one form. |
| 13 | `FIT_ISSUE` | Staff | Route back to planning, or refabricate. |
| 14 | `ALIGNER_PRODUCTION` | Staff | Full series in fabrication. |
| 15 | `DISPATCHING` | Staff | One shipment (`FULL`) or one per batch (`PHASED`). |
| 16 | `COMPLETED` | — | All shipments delivered. Terminal. |
| 17 | `CANCELLED` | — | With a reason, from any non-terminal state. Terminal. |

**The two scan states are deliberately separate.** "Awaiting scan" and "a scan is
here, check it" are different jobs with different owners, and collapsing them
meant the staff queue counted cases where nothing had been sent.

**An intraoral scan file is the only thing that moves a case out of
`AWAITING_SCAN`.** Whichever route the scan took — uploaded by the clinic from
its own scanner, taken at a booked appointment, or digitised by the lab from a
couriered impression — it ends up as an STL on the order, and that upload is what
advances it. There is no separate "mark received" action: it let staff push a
case all the way to `IN_PLANNING` with no geometry to plan from.
`Order.has_intraoral_scan` enforces it, and `scan/accept` refuses without one.

Quotes are **accept-only** right now — there is no decline path. A doctor who
wants a different price contacts the lab, and staff issue a new version that
supersedes the old one.

### Data model

Fourteen tables in `backend/app/models.py`. The parts that matter:

- **`shipments` is a table, not a field.** Phase-wise dispatch means several
  shipments per order, each with its own aligner range and tracking number.
- **`quotes` and `treatment_plans` are versioned.** A new version supersedes the
  last; nothing is overwritten, and the history stays on the record.
- **`patients` is an entity** scoped to a doctor, not a name copied per case.
- **`status_events`** is append-only and renders the timeline in both portals.
- Money is `numeric(12,2)`, quantized on write. Never float.

### Access control

- Session in an httpOnly, SameSite=Lax cookie — not a JWT in localStorage.
- Doctors resolve orders through one `owned_order()` helper that filters on
  `doctor_id`, so scoping cannot be forgotten endpoint by endpoint.
- `/api/staff/*` requires role `STAFF`.
- Doctors are gated behind `VERIFIED` for everything except their own profile.
- Case files are authorised per request. Nothing is served by public link.

### Case files

`STORAGE_BACKEND=local` (default) writes under `backend/storage/`.
`STORAGE_BACKEND=drive` uses a **Google service account on a Shared Drive**:

```
<root>/Orders/AL-2026-0417/{records,scans,planning}/
```

Keyed on order number, which never changes. Two deliberate departures from the
old system: a service account instead of an interactive OAuth token that
expires, and no public sharing — the previous portal set
`{'type': 'anyone', 'role': 'reader'}` on patient folders, putting identifiable
records on permanent public URLs.

---

## Ported from the old codebase

| Now | Was |
|---|---|
| `services/storage.py` | `mainlogic.upload_drive` / `get_or_create_folder` — service-account credentials, order-number tree, no public sharing |
| `services/billing.py` | `invoice_client.py` — credentials from environment, line items from the accepted quote |
| `services/registry.py` | `fire.search_dci_dentist` — the LLM name-matcher replaced with rapidfuzz, which is what it was approximating |

Dropped entirely: every LangChain prompt and chain, both LLM clients, the
WhatsApp webhook and message templates, Firebase, the Cloud Tasks delayed
webhook, and the Selenium courier scraper. Each classification the model used to
do is now a form field — a dropdown cannot misread "phase dispatch".

---

## Before this goes live

1. **Rotate the Refrens private key.** It was hardcoded in the old `portal.py`
   and is in this repository's git history. Anyone with repo access can issue
   invoices as the business.
2. Set `SECRET_KEY` and `STAFF_PASSWORD`; set `COOKIE_SECURE=true` behind HTTPS.
3. Move to Postgres and add Alembic migrations — the app currently calls
   `create_all()` at boot, which is fine for development but will not carry you
   through schema changes on live data.
4. Audit whatever the old system already shared publicly on Drive.

## Still open

Answers needed before the matching phase of work, carried over from
[plan.md](plan.md#10-open-questions):

- **How is an aligner case priced?** Per aligner, per arch, flat, banded? The
  quote builder currently takes free-form line items, which works but puts the
  pricing rule in the operator's head.
- Who marks a shipment delivered — staff, or the doctor confirming receipt?
- Who sets the phase batch size, the lab or the doctor?
- Refinements: `parent_order_id` is in the schema, unused. New order at a
  reduced price, or included in the original?
- GST treatment for intra-state versus inter-state.
