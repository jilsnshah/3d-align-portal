# 3D Align Order Portal — Build Plan

> **This is the design document written before the build.** Two things changed
> once it met reality, and the README is the accurate reference:
>
> - **Quotes are accept-only.** `QUOTE_DECLINED` was dropped; a doctor who wants
>   a different price contacts the lab, which issues a superseding version.
> - **`SCAN_SUBMITTED` was added back.** §4 below folds scan verification into
>   `AWAITING_SCAN`; that turned out to be wrong, because staff need to
>   distinguish "nothing has arrived" from "a scan is here, check it".

A web portal where dentists onboard, submit aligner cases, and track them to delivery — and where lab staff run the production queue.

**Scope:** 3D Aligners only. No chatbot, no WhatsApp.
**Stack:** FastAPI · Postgres · React
**Files:** Google Drive
**Notifications:** In-portal only

---

## 1. Premise

The old system stored a case as a loose dictionary hanging off a phone number, with the entire production stage crammed into one `status` string. That model cannot represent the things the business actually does — a case shipped in three phases, a quote that got revised, a treatment plan the doctor sent back. This build fixes that first and adds screens second.

### Four decisions already locked

| Decision | Choice | Why |
|---|---|---|
| Stack | FastAPI + Postgres + React | API-first. Separate deploys for backend and frontend. Room for a mobile client later. |
| File storage | Google Drive | The CAD team already works out of Drive folders. Portal owns the metadata; Drive holds the bytes. |
| Notifications | In-portal only | A notification row and an unread badge. No outbound mail, no messaging API, no compliance surface. |
| Quote | Hard gate | Production cannot start until the doctor has accepted a priced quote in writing. Recorded with who and when. |

### What changes structurally

- **A patient is an entity**, not a name string copied onto each case. Orders point at a patient; a doctor's patient list is queryable.
- **Shipments are rows.** Phase-wise dispatch means three, four, five shipments per order — each with its own aligner range and tracking number. The old single `tracking_id` field could never hold this.
- **Quotes and treatment plans are versioned.** Revision two supersedes revision one; both stay on the record.
- **Every status change writes an audit row** — from, to, who, when, why. The order timeline is a query over that table, not a reconstruction.
- **Shipping address comes from the doctor's saved addresses**, picked during checkout. This deletes the entire ask-for-location / confirm-location round trip.
- **Order numbers are human** — `AL-2026-0417`, not a UUID nobody can read over the phone.

---

## 2. Architecture

Three deployable pieces plus two external services. Keep the boundary sharp: the React app never talks to Drive or Refrens, only to the API.

| Piece | What it is | Notes |
|---|---|---|
| `api` | FastAPI, SQLAlchemy 2.0, Alembic, Pydantic v2 | Owns all business rules. One transition service is the only thing allowed to change `order.status`. |
| `web` | React + Vite + TypeScript, TanStack Query, React Router | Two shells behind one build: `/app` for doctors, `/staff` for the lab. |
| `db` | Postgres (Cloud SQL) | Enums as native Postgres types. Money as `numeric(12,2)`, never float. |
| `drive` | Google Drive (Shared Drive + service account) | Case files. Portal stores `drive_file_id` per file. |
| `refrens` | Refrens invoicing API | Wrapped behind a billing adapter so it can be swapped. |

### Auth and roles

- Session in an **httpOnly, Secure, SameSite=Lax cookie** — not a JWT in localStorage. This is a portal handling patient records; keep tokens out of reach of any injected script.
- Three roles: `DOCTOR`, `STAFF`, `ADMIN`. Enforced as a FastAPI dependency on every route, never in the frontend alone.
- Doctors can only read and write orders where `order.doctor_id` is their own. Write that as a query filter in one repository function so it cannot be forgotten per-endpoint.

### The one rule that keeps this clean

No endpoint sets `order.status` directly. Every change goes through:

```python
transition(order, to_status, actor, note)
```

which checks the move against an explicit allowed-transitions map, applies side effects, and writes a `status_events` row in the same database transaction. Illegal moves raise. This single function is what stops the new system from rotting into the old one.

---

## 3. Data model

Fourteen tables. Every one has `id` (UUID), `created_at`, and `updated_at` where mutable; those are omitted below for brevity.

### Identity

**`users`** — login identity for everyone, doctors and staff alike.

| Column | Type |
|---|---|
| `email` | citext unique |
| `password_hash` | text |
| `role` | enum DOCTOR \| STAFF \| ADMIN |
| `is_active` | bool |
| `last_login_at` | timestamptz |

**`doctors`** — professional profile, one per DOCTOR user. Carries the verification gate.

| Column | Type |
|---|---|
| `user_id` | → users |
| `full_name`, `phone` | text |
| `clinic_name` | text |
| `dental_council` | text |
| `registration_number` | text |
| `verification_status` | enum PENDING \| VERIFIED \| REJECTED |
| `dci_check_result` | jsonb |
| `verified_by` | → users |
| `verified_at`, `rejection_reason` | timestamptz, text |

**`addresses`** — clinic and shipping addresses. Orders freeze a reference at submit time.

| Column | Type |
|---|---|
| `doctor_id` | → doctors |
| `label` | text |
| `line1`, `line2`, `city`, `state` | text |
| `pincode` | text |
| `gst_state_code` | text |
| `is_default_shipping` | bool |
| `is_default_billing` | bool |

**`patients`** — scoped to a doctor. Never shared across clinics.

| Column | Type |
|---|---|
| `doctor_id` | → doctors |
| `full_name` | text |
| `date_of_birth` | date |
| `sex` | enum |
| `external_ref` | text — clinic's own chart no. |

### The order

**`orders`** — the spine. Everything else hangs off this.

| Column | Type |
|---|---|
| `order_number` | text unique — AL-2026-0417 |
| `doctor_id` | → doctors |
| `patient_id` | → patients |
| `parent_order_id` | → orders (refinements) |
| `status` | enum — see §4 |
| `arch` | enum UPPER \| LOWER \| BOTH |
| `priority` | enum STANDARD \| EXPRESS |
| `dispatch_mode` | enum FULL \| PHASED, null until fit review |
| `chief_complaint` | text |
| `clinical_notes` | text |
| `shipping_address_id` | → addresses |
| `assigned_staff_id` | → users |
| `submitted_at`, `approved_at` | timestamptz |
| `completed_at`, `cancelled_at` | timestamptz |

**`order_files`** — one row per uploaded artifact. Category drives which checklist item it satisfies.

| Column | Type |
|---|---|
| `order_id` | → orders |
| `category` | enum RECORD_PHOTO \| OPG \| LATERAL_CEPH \| CBCT \| INTRAORAL_SCAN \| TREATMENT_PLAN \| SIMULATION_VIDEO \| OTHER |
| `filename`, `mime_type` | text |
| `size_bytes` | bigint |
| `drive_file_id` | text |
| `uploaded_by` | → users |
| `is_deleted` | bool — soft delete |

**`status_events`** — append-only audit log. Renders the order timeline in both portals.

| Column | Type |
|---|---|
| `order_id` | → orders |
| `from_status`, `to_status` | enum |
| `actor_id` | → users, null = system |
| `note` | text |
| `metadata` | jsonb |

### Commercial and clinical

**`quotes`** — versioned. A new version supersedes the last; nothing is overwritten.

| Column | Type |
|---|---|
| `order_id` | → orders |
| `version` | int |
| `estimated_aligners_upper` | int |
| `estimated_aligners_lower` | int |
| `subtotal`, `tax`, `total` | numeric(12,2) |
| `status` | enum DRAFT \| SENT \| ACCEPTED \| DECLINED \| SUPERSEDED |
| `created_by` | → users |
| `sent_at`, `responded_at` | timestamptz |
| `decline_reason` | text |

**`quote_line_items`** — aligner fee, 3D model print, courier, express surcharge. Itemised, not hardcoded at invoice time.

| Column | Type |
|---|---|
| `quote_id` | → quotes |
| `description` | text |
| `unit_price` | numeric(12,2) |
| `quantity` | int |
| `amount` | numeric(12,2) |

**`treatment_plans`** — versioned like quotes. The plan PDF and simulation video live in `order_files`.

| Column | Type |
|---|---|
| `order_id` | → orders |
| `version` | int |
| `aligners_upper`, `aligners_lower` | int |
| `ipr_required` | bool |
| `attachments_required` | bool |
| `summary` | text |
| `status` | enum DRAFT \| SHARED \| APPROVED \| REVISION_REQUESTED |
| `revision_notes` | text |
| `shared_at`, `responded_at` | timestamptz |

**`scan_appointments`** — only for the in-house scanning path. Skip the table entirely if the lab stops offering it.

| Column | Type |
|---|---|
| `order_id` | → orders |
| `scheduled_at` | timestamptz |
| `location` | text |
| `status` | enum BOOKED \| COMPLETED \| CANCELLED \| NO_SHOW |
| `calendar_event_id` | text |

**`shipments`** — the table that makes phased dispatch possible. Many per order.

| Column | Type |
|---|---|
| `order_id` | → orders |
| `shipment_type` | enum TRAINING_ALIGNER \| ALIGNER_PHASE \| FULL_CASE |
| `phase_number` | int null |
| `aligner_range_from`, `aligner_range_to` | int |
| `carrier`, `tracking_number` | text |
| `tracking_url` | text |
| `address_id` | → addresses |
| `status` | enum PENDING \| SHIPPED \| DELIVERED |
| `shipped_at`, `delivered_at` | timestamptz |

**`fit_reviews`** — the doctor's verdict on the training aligner. Drives the branch at stage 11.

| Column | Type |
|---|---|
| `order_id` | → orders |
| `shipment_id` | → shipments |
| `outcome` | enum FITS \| ISSUE_REPORTED |
| `issue_notes` | text |
| `reported_by` | → users |

**`invoices`** — thin mirror of the Refrens record so the portal can list and link without an API call.

| Column | Type |
|---|---|
| `order_id` | → orders |
| `invoice_number` | text |
| `provider_invoice_id` | text |
| `amount` | numeric(12,2) |
| `pdf_url`, `share_url` | text |
| `status` | enum DRAFT \| ISSUED \| PAID \| VOID |
| `issued_at`, `paid_at` | timestamptz |

**`notifications`** — in-portal only. Written by the transition service, never by an endpoint.

| Column | Type |
|---|---|
| `user_id` | → users |
| `order_id` | → orders, nullable |
| `type` | text |
| `title`, `body` | text |
| `read_at` | timestamptz null |

---

## 4. Order lifecycle

Seventeen states, end to end. The actor on each stage is who has the ball — that is also exactly what the two dashboards filter on.

### 01 · `DRAFT` — Doctor

Doctor starts a case. Picks or creates the patient, sets arch and priority, writes the chief complaint, uploads records. Nothing is visible to staff yet. Saveable and resumable.

> Records checklist: intraoral and extraoral photographs, **OPG (mandatory)**, lateral ceph or CBCT if indicated. Submit stays disabled until the mandatory set is present.

### 02 · `SUBMITTED` — Doctor

Doctor submits. The order number is issued, the Drive folder is created, and the case lands in the staff intake queue. Files become read-only to the doctor from here.

### 03 · `UNDER_REVIEW` — Staff

A staff member claims the case and reviews the records for adequacy — image quality, OPG legibility, whether a CBCT is needed.

### 04 · `RECORDS_REQUESTED` — Doctor

Records were inadequate. Staff write exactly what is missing; the doctor's upload panel reopens for those categories only. Resubmitting returns the order to `UNDER_REVIEW`.

### 05 · `QUOTED` — Doctor

Staff build a quote: estimated aligner count per arch, line items, tax, total. Sending it creates version *n* and hands the ball to the doctor, who can show the price to the patient before committing.

- **Accept** → stage 06. Stamps `approved_at` and the accepting user. This is the hard gate: nothing below runs without it.
- **Revise** → staff issue version *n+1*; the previous becomes `SUPERSEDED`.
- **Decline** → `QUOTE_DECLINED`, terminal, with a reason captured for the sales report.

### 06 · `AWAITING_SCAN` — Doctor

Quote accepted. Now the lab needs the actual geometry. The doctor picks one of three routes:

- **Upload STL** — direct from the clinic's intraoral scanner. Validate the extension and magic bytes, not just the browser-reported MIME type.
- **Book a scan** — pick a slot; the lab sends a technician. Writes a `scan_appointments` row and a calendar event.
- **Courier a PVS impression** — portal shows the lab address and records the doctor's outbound tracking number.

### 07 · `IN_PLANNING` — Staff

Staff accept the scan and start treatment planning. The doctor's order page shows the 48-hour target for plan and simulation. A rejected scan sends the order back to `AWAITING_SCAN` with a note.

### 08 · `PLAN_SHARED` — Doctor

Staff publish plan version *n*: final aligner counts, IPR and attachment flags, the plan document and the simulation video. The doctor reviews it in the portal.

- **Approve** → stage 09.
- **Request revision** → back to `IN_PLANNING`; the plan is marked `REVISION_REQUESTED` and the doctor's notes attach to it.

### 09 · `TRAINING_ALIGNER_PRODUCTION` — Staff

The training aligner is fabricated. This is the fit test before the lab commits material to the whole case.

### 10 · `TRAINING_ALIGNER_SHIPPED` — Staff

Staff create a `TRAINING_ALIGNER` shipment with carrier and tracking number, against the shipping address already on the order. No address round-trip.

### 11 · `FIT_REVIEW` — Doctor

Marked delivered. The doctor fits the training aligner and answers one form: *does it fit*, and if so, *ship the rest in full or in phases*. Both answers in a single submission — the old system asked these as two separate exchanges.

- **Fits** → sets `dispatch_mode`, moves to stage 13.
- **Issue** → `FIT_ISSUE`.

### 12 · `FIT_ISSUE` — Staff

The doctor reported a fit problem with notes and photos. Staff triage it and route back to either `IN_PLANNING` (replan) or `TRAINING_ALIGNER_PRODUCTION` (refabricate from the existing plan).

### 13 · `ALIGNER_PRODUCTION` — Staff

The full aligner series goes into fabrication. `dispatch_mode` determines whether the lab plans one shipment or a schedule of them.

### 14 · `DISPATCHING` — Staff

Shipments go out. `FULL` means one `FULL_CASE` row. `PHASED` means an `ALIGNER_PHASE` row per batch, each carrying its aligner range — phase 1 covers aligners 1–8, phase 2 covers 9–16, and so on. The doctor sees every phase and its tracking separately.

### 15 · `COMPLETED` — System (terminal)

All shipments delivered. The invoice is generated from the accepted quote and attached; the doctor downloads the PDF from the order page.

> "Ready to invoice" is a *query* — all shipments delivered and no issued invoice — not a status. Statuses describe production, not billing.

### 16 · `QUOTE_DECLINED` — System (terminal)

The doctor rejected the price. Keeps the case and its reason for win/loss reporting.

### 17 · `CANCELLED` — System (terminal)

Reachable from any non-terminal state by staff, or by the doctor before production starts. Always requires a reason.

### Transition map

```
DRAFT                      --submit(doctor)-------------> SUBMITTED
SUBMITTED                  --claim(staff)---------------> UNDER_REVIEW
UNDER_REVIEW               --request records(staff)-----> RECORDS_REQUESTED
UNDER_REVIEW               --send quote(staff)----------> QUOTED
RECORDS_REQUESTED          --resubmit(doctor)-----------> UNDER_REVIEW
QUOTED                     --accept(doctor)-------------> AWAITING_SCAN
QUOTED                     --decline(doctor)------------> QUOTE_DECLINED       [terminal]
QUOTED                     --revise(staff)--------------> QUOTED               [new version]
AWAITING_SCAN              --scan accepted(staff)-------> IN_PLANNING
IN_PLANNING                --share plan(staff)----------> PLAN_SHARED
PLAN_SHARED                --approve(doctor)------------> TRAINING_ALIGNER_PRODUCTION
PLAN_SHARED                --request revision(doctor)---> IN_PLANNING
TRAINING_ALIGNER_PRODUCTION --ship(staff)---------------> TRAINING_ALIGNER_SHIPPED
TRAINING_ALIGNER_SHIPPED   --mark delivered(staff)------> FIT_REVIEW
FIT_REVIEW                 --fits + mode(doctor)--------> ALIGNER_PRODUCTION
FIT_REVIEW                 --issue(doctor)--------------> FIT_ISSUE
FIT_ISSUE                  --replan(staff)--------------> IN_PLANNING
FIT_ISSUE                  --refabricate(staff)---------> TRAINING_ALIGNER_PRODUCTION
ALIGNER_PRODUCTION         --first shipment(staff)------> DISPATCHING
DISPATCHING                --all delivered(staff)-------> COMPLETED            [terminal]
<any non-terminal>         --cancel(staff|doctor)-------> CANCELLED            [terminal]
```

---

## 5. Screens

### Doctor portal `/app`

- **Sign up** — email, password, name, council + registration number, clinic, address. Lands on a "verification pending" screen.
- **Dashboard** — two lists that matter: *Needs your action* (quote to review, plan to approve, fit to confirm) and *In progress*. Everything else is a filter.
- **New order** — a four-step wizard: patient → clinical details → records upload → shipping address, then a review screen. Draft autosaves at every step.
- **Order detail** — status header, timeline from `status_events`, files by category, and a single action panel that renders whatever this stage asks of the doctor. Shipments with tracking. Invoice download.
- **Patients** — list, with order history per patient.
- **Profile** — clinic details, saved addresses, password.

### Staff portal `/staff`

- **Queue board** — counts per work bucket: new submissions, awaiting quote, scans to verify, plans to share, in production, ready to ship, ready to invoice. Each is a saved filter, and each is the day's to-do list.
- **Order list** — filter by status, doctor, priority, assignee, date. Express cases flagged in the row itself, not buried in a detail page.
- **Order detail** — everything the doctor sees plus the staff action panel: claim, request records, build quote, accept or reject scan, publish plan, start production, create shipment, generate invoice, cancel.
- **Verification queue** — pending doctors with their automated council-registry check result side by side with what they typed. Approve or reject with a reason.
- **Doctors** — directory, order volume, addresses.

> **Build this component once.** The order detail page is the same component in both portals, with a role-aware action panel. One timeline, one file browser, one shipments table. If it forks into two pages, they will drift within a month.

---

## 6. API surface

Roughly forty endpoints. Doctor-scoped routes filter by the caller's `doctor_id` at the repository layer; `/staff/*` requires role STAFF or ADMIN.

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | Doctor self-signup. Creates user + doctor as PENDING. |
| POST | `/auth/login` | Sets the session cookie. |
| GET | `/auth/me` | Current user, role, verification status. |
| GET | `/me/addresses` | Saved addresses. POST / PATCH to manage. |
| GET | `/patients` | The doctor's patients. POST to create. |
| POST | `/orders` | Create a DRAFT. |
| PATCH | `/orders/{id}` | Edit while DRAFT only. |
| POST | `/orders/{id}/files/upload-url` | Returns a resumable Drive upload session for direct browser upload. |
| POST | `/orders/{id}/files` | Register a completed upload with its category. |
| POST | `/orders/{id}/submit` | DRAFT → SUBMITTED. Validates the mandatory records checklist. |
| POST | `/orders/{id}/quote/accept` | The gate. QUOTED → AWAITING_SCAN. |
| POST | `/orders/{id}/quote/decline` | QUOTED → QUOTE_DECLINED, reason required. |
| POST | `/orders/{id}/plan/respond` | Approve, or request revision with notes. |
| POST | `/orders/{id}/fit-review` | Fit verdict + dispatch mode in one call. |
| GET | `/notifications` | Unread count and list. POST `/{id}/read`. |
| GET | `/staff/queue` | Bucket counts for the queue board. |
| GET | `/staff/orders` | Filterable order list. |
| POST | `/staff/orders/{id}/claim` | Assign to the calling staff member. |
| POST | `/staff/orders/{id}/request-records` | Bounce back with the missing categories. |
| POST | `/staff/orders/{id}/quotes` | Create and send a quote version. |
| POST | `/staff/orders/{id}/scan/accept` | AWAITING_SCAN → IN_PLANNING. `/reject` sends it back. |
| POST | `/staff/orders/{id}/plans` | Publish a treatment plan version. |
| POST | `/staff/orders/{id}/shipments` | Create a shipment. PATCH for tracking and delivery. |
| POST | `/staff/orders/{id}/invoice` | Generate from the accepted quote via Refrens. |
| POST | `/staff/orders/{id}/cancel` | Cancel with reason. |
| GET | `/staff/doctors` | Directory. |
| POST | `/staff/doctors/{id}/verify` | Approve or reject onboarding. |

---

## 7. Drive and file handling

### Authentication

Use a **service account against a Shared Drive**, not the current OAuth-user flow with a `token.json` on disk. The existing setup breaks whenever the refresh token expires or the machine changes, and it ties every lab file to one person's Google account.

### Folder layout

Key the tree on `order_number`, which is unique and never changes. The old tree nested on doctor name then patient name and had to rename folders whenever a name was corrected.

```
3D Align / Orders / AL-2026-0417 /     Order root. Folder ID cached on the order row.
  ├── records /                        Photographs, OPG, lateral ceph, CBCT.
  ├── scans /                          STL files and impression photos.
  └── planning /                       Treatment plan documents, simulation videos.
```

### Upload path

- Browser asks the API for a **resumable upload session**; the file goes straight from browser to Drive. Intraoral STLs run to tens of megabytes and should never pass through the API container.
- On completion the browser calls back with the Drive file ID; the API writes the `order_files` row. A nightly reconciliation job catches uploads that finished but never registered.
- Downloads are proxied by the API after an authorization check, or served as a short-lived signed link. Never a permanent public URL.

> **Do not carry this bug forward.** The current portal makes each case-planning folder readable by *anyone with the link* before sending it out, which puts identifiable patient records on a permanently public URL. Grant access per-user through the API instead, and audit whatever was already shared this way.

---

## 8. Port versus drop

The old repo has a handful of genuinely useful pieces buried in it. Take these, adapt them, and leave the rest.

### Worth porting

| From | Becomes |
|---|---|
| `fire.py` — `search_dci_dentist`, `get_highest_name_match_score` | Council registry verification service. Runs on signup, result stored in `doctors.dci_check_result` for staff to eyeball. |
| `mainlogic.py` — `get_or_create_folder`, `upload_drive` | Drive service. Same logic, service-account credentials, order-number tree. |
| `mainlogic.py` — `book_calendar_appointment`, `check_calendar_availability` | Scan appointment service. Only if in-house scanning survives. |
| `invoice_client.py` | Billing adapter behind an interface. **Rotate the key first.** |
| `portal.py` — `get_state_code` | GST state code lookup for invoicing. |
| `server.py` — `get_address_from_pincode` | Address form autofill on the signup and address screens. |

### Drop entirely

| What | Why |
|---|---|
| `prompts.py`, all LangChain chains, both LLM clients | Every classification they performed becomes a form field. A dropdown cannot misread "phase dispatch". |
| `whatsapp_utils.py`, `server.py` webhook, message templates | No messaging channel in the new design. |
| Firebase Realtime Database | Replaced by Postgres. Migrate open cases by hand — there are few enough. |
| Cloud Tasks delayed-webhook | Was scheduling a feedback message. Not needed; drop with the messaging layer. |
| `what.py` | A Selenium courier scraper wired to nothing. |
| `portal.py` | 126k of Flask with HTML inline. This whole plan is its replacement. |

---

## 9. Build order

Each phase ends with something demonstrable. Phases 1–4 alone give the lab a working intake-and-quote system, which is already better than what exists.

| Phase | Scope | Ships |
|---|---|---|
| **P1** Foundation | Repo layout, Postgres schema, Alembic migrations, cookie sessions, the three roles, the transition service with its allowed-moves map, health check, CI running tests. | An API you can log into |
| **P2** Onboarding | Doctor signup, council registry check, staff verification queue with approve and reject, address book, profile. | Real doctors can get accounts |
| **P3** Orders and files | Patients, the order wizard, Drive service, resumable upload, the records checklist, submit, staff intake queue, order detail with timeline. | Cases arrive in the portal |
| **P4** Quote gate | Quote builder with line items, versioning and supersede, send, doctor accept and decline, request-records loop. | Priced, approved cases |
| **P5** Scan intake | Three scan routes, STL validation, staff accept and reject with notes. Calendar booking only if in-house scanning stays. | Geometry reaches the lab |
| **P6** Treatment planning | Plan versions, plan and simulation upload, publish to doctor, approve or request revision with notes. | The clinical loop closes |
| **P7** Production and dispatch | Training aligner production, shipments with tracking, fit review form, dispatch mode, phased shipment scheduling, delivery marking. | End-to-end aligner delivery |
| **P8** Billing | Refrens adapter, invoice generated from the accepted quote, PDF on the order page, ready-to-invoice queue. | The money side |
| **P9** Notifications and reporting | In-portal notification bell and unread counts, needs-your-action dashboard, staff throughput and turnaround views. | People stop asking "where is my case" |
| **P10** Hardening | Role and ownership tests on every route, a test per legal and illegal transition, rate limits on auth, backups and restore drill, staging environment, data retention policy. | Safe to run on real patients |

---

## 10. Open questions

None of these block starting P1, but each one needs an answer before the phase that depends on it.

| Blocks | Question | Why it matters |
|---|---|---|
| **now** | Rotate the Refrens private key | It is hardcoded in `portal.py` and committed to git history. Anyone with repo access can issue invoices as the business. Do this before anything else. |
| P4 | How is an aligner case priced? | Per aligner, per arch, flat per case, banded by count? The quote builder's shape follows the answer. Express surcharge too. |
| P5 | Does in-house scanning continue? | If not, the calendar integration and `scan_appointments` both disappear and P5 halves. |
| P7 | Who sets the phase batch size? | Lab default, or doctor's choice per case? Determines whether it is a config value or a form field. |
| P7 | Who marks a shipment delivered? | The current courier has no API. Staff mark it manually, or the doctor confirms receipt — pick one, because it gates the fit review. |
| P7 | How are refinements handled? | `parent_order_id` is in the schema for this. Is a refinement a new order at a reduced price, or included in the original? |
| P8 | GST treatment | Intra-state versus inter-state changes the tax lines. The state code lookup exists; the rules do not. |
| P10 | Patient data retention | How long are records and scans kept, who may see them, and what happens when a doctor closes their account. |
