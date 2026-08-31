export type Role = "DOCTOR" | "ADMIN" | "ORTHODONTIST" | "TECHNICIAN";
export type VerificationStatus = "PENDING" | "VERIFIED" | "REJECTED";

export type OrderStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "RECORDS_REQUESTED"
  | "QUOTED"
  | "AWAITING_SCAN"
  | "SCAN_SUBMITTED"
  | "IN_PLANNING"
  | "PLAN_SHARED"
  | "TRAINING_ALIGNER_PRODUCTION"
  | "TRAINING_ALIGNER_SHIPPED"
  | "FIT_REVIEW"
  | "FIT_ISSUE"
  | "ALIGNER_PRODUCTION"
  | "PRODUCT_FABRICATION"
  | "DISPATCHING"
  | "PHASE_REVIEW"
  | "COMPLETED"
  | "CANCELLED";

export type FileCategory =
  | "RECORD_PHOTO"
  | "OPG"
  | "LATERAL_CEPH"
  | "CBCT"
  | "INTRAORAL_SCAN"
  | "TREATMENT_PLAN"
  | "SIMULATION_MODEL"
  | "FIT_ISSUE_PHOTO"
  | "PROGRESS_PHOTO"
  | "PAYMENT_PROOF"
  | "PHASE_FIT_PHOTO"
  | "OTHER";

export type ShipmentType = "TRAINING_ALIGNER" | "PRODUCT" | "ALIGNER_PHASE" | "FULL_CASE";

export interface Doctor {
  id: string;
  full_name: string;
  phone: string;
  clinic_name: string;
  dental_council: string;
  registration_number: string;
  verification_status: VerificationStatus;
  rejection_reason: string;
}

export interface Me {
  id: string;
  email: string;
  role: Role;
  /** Lab-side accounts carry their own name. */
  full_name: string;
  doctor: Doctor | null;
}

export interface Address {
  latitude?: number | null;
  longitude?: number | null;
  geocode_source?: string;
  id: string;
  label: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
  is_default_shipping: boolean;
}

export interface Patient {
  id: string;
  full_name: string;
  date_of_birth: string;
  sex: string;
  external_ref: string;
  created_at: string;
}

export interface OrderFile {
  id: string;
  category: FileCategory;
  filename: string;
  mime_type: string;
  size_bytes: number;
  external_link: string;
  revision: number;
  is_current: boolean;
  slot: string;
  slot_label: string;
  is_image: boolean;
  uploaded_by: string;
  created_at: string;
}

export interface BinnedFile extends OrderFile {
  deleted_at: string | null;
  deleted_by: string;
  purges_in_days: number;
}

export interface SlotState {
  slot: string;
  label: string;
  required: boolean;
  file: OrderFile | null;
}

export interface RecordSet {
  category: FileCategory;
  label: string;
  revision: number;
  complete: boolean;
  required: boolean;
  editable: boolean;
  locked_reason: string;
  slots: SlotState[];
  extras: OrderFile[];
  missing: string[];
}

export interface QuoteLineItem {
  id: string;
  description: string;
  unit_price: string;
  quantity: number;
  amount: string;
}

export type AlignerCategory =
  | "ALIGN_6_12"
  | "ALIGN_12_16"
  | "ALIGN_16_20"
  | "ALIGN_20_30"
  | "ALIGN_30_40"
  | "ALIGN_40_70"
  | "ALIGN_70_PLUS";

export interface AlignerPrice {
  category: AlignerCategory;
  label: string;
  range_from: number;
  range_to: number | null;
  price_min: string;
  price_max: string;
  is_active: boolean;
}

export interface Quote {
  id: string;
  version: number;
  category: AlignerCategory | null;
  category_label: string;
  category_price: string;
  category_price_max: string;
  subtotal_max: string;
  total_max: string;
  subtotal: string;
  tax: string;
  total: string;
  currency: string;
  notes: string;
  status: "SENT" | "ACCEPTED" | "SUPERSEDED";
  is_final: boolean;
  sent_at: string | null;
  responded_at: string | null;
  line_items: QuoteLineItem[];
}

/** Enquiries carry an EN reference; cases that reached planning carry an AL one. */
export type CaseSeries = "enquiry" | "aligner" | "product" | "accessory";

export interface TreatmentPlan {
  id: string;
  version: number;
  aligners_upper: number;
  aligners_lower: number;
  total_aligners: number;
  final_category: AlignerCategory | null;
  final_category_label: string;
  final_price: string;
  final_discount: string;
  final_discount_reason: string;
  final_tax: string;
  final_total: string;
  ipr_required: boolean;
  attachments_required: boolean;
  summary: string;
  status: "SHARED" | "APPROVED" | "REVISION_REQUESTED" | "SUPERSEDED";
  revision_notes: string;
  shared_at: string | null;
  responded_at: string | null;
}

export interface Shipment {
  id: string;
  shipment_type: ShipmentType;
  fit_round: number | null;
  phase_number: number | null;
  phase_round: number | null;
  aligner_range_from: number | null;
  aligner_range_to: number | null;
  carrier: string;
  tracking_number: string;
  tracking_url: string;
  status: "PENDING" | "SHIPPED" | "DELIVERED";
  phase_decision: "CONTINUE" | "REPEAT" | null;
  decision_notes: string;
  is_final_phase: boolean;
  shipped_at: string | null;
  delivered_at: string | null;
}

export interface Invoice {
  id: string;
  invoice_number: string;
  amount: string;
  currency: string;
  pdf_url: string;
  share_url: string;
  status: string;
  issued_at: string | null;
}

export interface StatusEvent {
  id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  note: string;
  actor_name: string;
  created_at: string;
}

export interface Product {
  id: string;
  code: string;
  name: string;
  description: string;
  per_tooth_price: string;
  included_teeth: number;
  sizes: ProductSize[];
  /** False when there is only one form of it, which is not a choice worth asking. */
  has_choice_of_size: boolean;
}

/** What delivery will cost on a product order placed right now.

    A product is one charge, raised as soon as the order exists, so the clinic
    has to see this before it commits — unlike an aligner case, where nothing
    is charged for delivery until a production phase ships. */
export interface DeliveryCharge {
  city: string;
  amount: string;
  /** False when the lab has not priced this city and the default applies. */
  is_city_rate: boolean;
  has_address: boolean;
}

export interface Accessory {
  id: string;
  code: string;
  name: string;
  description: string;
  price: string;
}

/** One accessory on an order, priced as it was when it was ordered. */
export interface AccessoryLine {
  accessory_id: string;
  code: string;
  name: string;
  quantity: number;
  unit_price: string;
  line_total: string;
}

export interface StatsSlice {
  key: string;
  label: string;
  note: string;
  orders: number;
  units: number;
}

export interface StatsBucket {
  key: string;
  label: string;
  aligners: number;
  products: number;
  accessories: number;
  paid: string;
}

export interface Stats {
  view: "year" | "month";
  year: number;
  month: number | null;
  period_label: string;
  available_years: number[];
  totals: {
    orders: number;
    aligners: number;
    products: number;
    accessories: number;
    cancelled: number;
    patients: number;
    paid: string;
  };
  series: StatsBucket[];
  products: StatsSlice[];
  /** Shelf items, counted wherever they rode. */
  accessories: StatsSlice[];
  categories: StatsSlice[];
  /** Lab-side only. A doctor is never shown another practice's volumes. */
  doctors: StatsSlice[];
  /** Doctor-side only, and only useful to a practice with several clinics. */
  branches: StatsSlice[];
}

export interface ProductSize {
  id: string;
  label: string;
  price: string;
}

/** An earlier case of this patient's whose scan could be used again. */
export interface ScanSource {
  order_id: string;
  reference: string;
  kind: OrderKind;
  status: OrderStatus;
  status_label: string;
  taken_at: string;
}

export type OrderKind = "ALIGNER" | "PRODUCT" | "ACCESSORY";

export interface OrderSummary {
  id: string;
  order_number: string;
  /** An aligner case, or one of the other things the lab makes. */
  kind: OrderKind;
  /** Already spelled out: "Essix Retainer · 0.8 mm · x3". Empty for aligners. */
  product_label: string;
  status: OrderStatus;
  status_label: string;
  category: AlignerCategory | null;
  category_label: string;
  /** False while the band is still the estimate read off the photographs. */
  category_confirmed: boolean;
  /** Which orthodontist is planning it. Lab-side only. */
  assigned_to_id: string | null;
  assigned_to_name: string;
  /** How far through its phases a case in delivery has got. */
  phases_done: number;
  phases_total: number;
  patient_name: string;
  doctor_name: string;
  clinic_name: string;
  /** Which branch this case ships to. Empty when the practice has one clinic. */
  branch_id: string;
  branch_label: string;
  arch: "UPPER" | "LOWER" | "BOTH";
  priority: "STANDARD" | "EXPRESS";
  needs_doctor_action: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrderDetail extends OrderSummary {
  /** Shelf items on this order, priced as they were ordered. */
  accessories: AccessoryLine[];
  patient_id: string;
  enquiry_number: string;
  has_simulation: boolean;
  dispatch_mode: "FULL" | "PHASED" | null;
  phase_count: number | null;
  /** Non-zero once the case has been rescanned without the plan being redrawn. */
  refinement_round: number;
  /** Which progress views are still missing for the phase just received. */
  progress_missing: string[];
  progress_round: number;
  payments: Payment[];
  charges: ChargeLine[];
  /** True while the clinic has not paid the plan fee — plans arrive empty. */
  plan_locked: boolean;
  phase_issues: PhaseFitIssue[];
  open_phase_issue: string | null;
  phases_divided: boolean;
  /** Steps the treatment runs — the longer arch, not both added together. */
  aligner_steps: number;
  /** Most phases this case can be split into at 5 aligners a phase. */
  max_phases: number;
  phase_plan: PhaseSpan[];
  scan_route: "UPLOAD" | "APPOINTMENT" | "COURIER" | null;
  scan_courier_tracking: string;
  chief_complaint: string;
  clinical_notes: string;
  records_request_note: string;
  cancel_reason: string;
  records_revision: number;
  scan_revision: number;
  fit_round: number;
  submitted_at: string | null;
  approved_at: string | null;
  completed_at: string | null;
  shipping_address: Address | null;
  files: OrderFile[];
  quotes: Quote[];
  plans: TreatmentPlan[];
  shipments: Shipment[];
  appointment: Appointment | null;
  invoice: Invoice | null;
  events: StatusEvent[];
  missing_categories: FileCategory[];
  submit_blockers: string[];
  record_sets: RecordSet[];
  binned_count: number;
  scan_complete: boolean;
  total_aligners: number;
  next_phase_from: number;
  next_phase_max: number;
  next_phase_number: number;
  next_phase_round: number;
  phase_blocker: string | null;
  awaiting_phase_decision: string | null;
}

export type AppointmentStatus = "ASSIGNED" | "EN_ROUTE" | "COMPLETED" | "CANCELLED" | "NO_SHOW";

export interface Appointment {
  is_day_visit: boolean;
  id: string;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  status_label: string;
  technician_name: string;
  technician_phone: string;
  contact_name: string;
  contact_phone: string;
  access_notes: string;
  assignment_reason: string;
  cancel_reason: string;
  outcome_notes: string;
  location: string;
  /** Approved leave took the technician away and nobody could cover it. */
  needs_attention: boolean;
  attention_reason: string;
}

export interface JobOrder {
  id: string;
  order_number: string;
  patient_name: string;
  doctor_name: string;
  clinic_name: string;
  arch: "UPPER" | "LOWER" | "BOTH";
  clinical_notes: string;
  status: OrderStatus;
}

export interface Job extends Appointment {
  order: JobOrder;
}

export interface Booking extends Job {
  address: Address | null;
}

export interface Slot {
  starts_at: string;
  ends_at: string;
  available: boolean;
  reason: string;
}

export interface DayAvailability {
  technicians_free: number;
  date: string;
  closed: boolean;
  free_count: number;
  slots: Slot[];
}

export interface AvailabilityRule {
  id?: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

export interface TimeOff {
  id: string;
  starts_at: string;
  ends_at: string;
  reason: string;
}

export interface Technician {
  id: string;
  full_name: string;
  phone: string;
  employee_code: string;
  max_daily_jobs: number;
  is_active: boolean;
  email: string;
  availability: AvailabilityRule[];
  time_off: TimeOff[];
  upcoming_jobs: number;
}

export interface RouteStop {
  kind: "lab" | "visit";
  label: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  arrives_at: string | null;
  departs_at: string | null;
  leg_minutes: number;
  leg_km: number;
  appointment_id: string;
  order_reference: string;
  patient_name: string;
  booked_for: string | null;
  late_by_minutes: number;
}

export interface ResolvedAddress {
  formatted?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

export interface StageModel {
  file_id: string;
  filename: string;
  arch: "upper" | "lower";
  step: number;
  kind: string;
  size_bytes: number;
}

export interface Stage {
  step: number;
  upper: StageModel | null;
  lower: StageModel | null;
  is_passive: boolean;
}

/** Where each staged arch sits in the bite the scanner recorded. Both matrices
 *  are 4x4 rigid transforms in row-major order, in millimetres. */
export interface Articulation {
  upper: number[];
  lower: number[];
  method: "bite-witnessed" | "bite-registered" | "scan-pair";
  rms_upper: number;
  rms_lower: number;
  bite_median_mm: number | null;
  bite_touching_upper: number | null;
  notes: string[];
}

export type PaymentKind =
  | "TREATMENT_PLAN"
  | "TRAINING_FIT"
  | "PRODUCTION_PHASE"
  | "PRODUCT_ORDER";
export type PaymentStatus = "DUE" | "SUBMITTED" | "VERIFIED" | "REJECTED";

export interface Payment {
  id: string;
  kind: PaymentKind;
  kind_label: string;
  phase_number: number;
  amount: string;
  shipping_amount: string;
  total: string;
  status: PaymentStatus;
  status_label: string;
  reference: string;
  proof_file_id: string | null;
  rejected_reason: string;
  submitted_at: string | null;
  verified_at: string | null;
  /** upi:// intent with the payee and amount already filled in. */
  upi_link: string;
  label: string;
}

export interface ChargeLine {
  label: string;
  amount: string;
  note: string;
}

export interface ShippingRate {
  city: string;
  amount: string;
  is_active: boolean;
  /** How many clinics this rate actually reaches. Zero means it matches none. */
  clinics: number;
}

export interface DeliveryCity {
  city: string;
  clinics: number;
  amount: string | null;
  is_active: boolean;
}

export type PhaseStatus = "NOT_STARTED" | "ACTIVE" | "ISSUE" | "COMPLETED";

export interface StaffUser {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
}

export interface Leave {
  id: string;
  technician_id: string;
  technician_name: string;
  starts_at: string;
  ends_at: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "DECLINED";
  status_label: string;
  decision_note: string;
  decided_at: string | null;
  affected_visits: number;
}

export interface LeaveDecision {
  leave: Leave;
  covered: { appointment_id: string; order_reference: string; starts_at: string; technician_name: string; reason: string }[];
  stranded: { appointment_id: string; order_reference: string; starts_at: string; reason: string }[];
}

export interface PhaseSpan {
  phase: number;
  from_step: number;
  to_step: number;
  upper_from: number | null;
  upper_to: number | null;
  lower_from: number | null;
  lower_to: number | null;
  status: PhaseStatus;
  status_label: string;
  round: number;
}

export interface PhaseIssueMessage {
  id: string;
  from_lab: boolean;
  body: string;
  created_at: string;
}

export interface PhaseFitIssue {
  id: string;
  phase_number: number;
  phase_round: number;
  arch: "UPPER" | "LOWER";
  aligner_number: number;
  notes: string;
  photo_revision: number;
  status: "OPEN" | "RESOLVED";
  resolution: "REMAKE" | "RESCAN" | "CLINIC_CONFIRMED" | null;
  lab_comments: string;
  /** Whose turn it is while the issue is open. */
  awaiting: "LAB" | "CLINIC";
  messages: PhaseIssueMessage[];
  created_at: string;
  resolved_at: string | null;
}

export interface Simulation {
  order_reference: string;
  patient_name: string;
  stages: Stage[];
  total_aligners: number;
  /** Null when the scans cannot place the arches — the viewer then shows a
   *  nominal bite and says so. */
  articulation: Articulation | null;
  /** Why there is no articulation, when there is none. */
  articulation_note: string;
}

export interface MapConfig {
  browser_key: string;
  centre: { lat: number; lng: number } | null;
  service_city: string;
}

export interface Reassignment {
  id: string;
  status: "PENDING" | "RESOLVED" | "DECLINED";
  reason: string;
  resolution: string;
  created_at: string;
  resolved_at: string | null;
  requested_by: string;
  appointment_id: string;
  order_reference: string;
  patient_name: string;
  clinic_name: string;
  starts_at: string;
  current_technician: string;
}

export interface DayRoute {
  technician_id: string;
  technician_name: string;
  date: string;
  stops: RouteStop[];
  total_km: number;
  drive_minutes: number;
  onsite_minutes: number;
  warnings: string[];
  at_risk: boolean;
  maps_url: string;
  polyline: string;
  browser_map_key: string;
}

export interface BookingSettings {
  slot_minutes: number;
  visit_duration_minutes: number;
  booking_granularity_minutes: number;
  travel_buffer_minutes: number;
  booking_horizon_days: number;
  min_notice_hours: number;
  max_daily_jobs: number;
  max_travel_minutes: number;
  travel_weight: number;
  fairness_weight: number;
  idle_weight: number;
  fallback_speed_kmph: number;
  lab_address: string;
  lab_latitude: number | null;
  lab_longitude: number | null;
  /** "picked", a street-level lookup, or the coarse pincode table. */
  lab_geocode_source: string;
  working_hours: Record<string, [string, string] | null>;
  service_city: string;
  timezone_name: string;
  upi_vpa: string;
  upi_payee_name: string;
  plan_fee: string;
  training_fit_fee: string;
  default_shipping_fee: string;
}

export interface Notification {
  id: string;
  order_id: string | null;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

export interface Queue {
  new_submissions: number;
  awaiting_quote: number;
  awaiting_scan_review: number;
  in_planning: number;
  in_production: number;
  ready_to_ship: number;
  dispatching: number;
  ready_to_invoice: number;
  pending_doctors: number;
}

export interface PendingDoctor extends Doctor {
  registry_check_result: Record<string, unknown> | null;
  created_at: string;
  email: string;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/* Sessions are scoped to a browser tab.
   A cookie is shared by every tab on an origin, so signing in as the lab would
   replace a doctor session in the next tab. Each tab claims a short slot id
   held in sessionStorage — which browsers keep per tab — and sends it with
   every request; the server gives that slot its own httpOnly cookie. One URL,
   as many simultaneous accounts as you have tabs. */
const SLOT_KEY = "align.session.slot";
const NEW_SESSION_FLAG = "newsession";

function newSlot(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function sessionSlot(): string {
  // A tab opened with window.open inherits a *copy* of the opener's
  // sessionStorage, so "open another account" would silently reuse the same
  // slot. The flag in the URL forces a fresh one, then cleans itself up.
  if (new URLSearchParams(window.location.search).has(NEW_SESSION_FLAG)) {
    sessionStorage.setItem(SLOT_KEY, newSlot());
    const url = new URL(window.location.href);
    url.searchParams.delete(NEW_SESSION_FLAG);
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }
  let slot = sessionStorage.getItem(SLOT_KEY);
  if (!slot) {
    slot = newSlot();
    sessionStorage.setItem(SLOT_KEY, slot);
  }
  return slot;
}

/** Opens a tab that deliberately starts signed out, so another account can be
    used alongside this one on the same URL. */
export function openFreshTab(): void {
  window.open(`${window.location.origin}/login?${NEW_SESSION_FLAG}=1`, "_blank")?.focus();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const slotHeader = { "X-Session-Slot": sessionSlot() };
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    ...init,
    headers:
      init.body instanceof FormData
        ? { ...slotHeader, ...(init.headers ?? {}) }
        : { "Content-Type": "application/json", ...slotHeader, ...(init.headers ?? {}) },
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      if (typeof data.detail === "string") message = data.detail;
      else if (Array.isArray(data.detail) && data.detail[0]?.msg) message = data.detail[0].msg;
    } catch {
      /* keep the fallback message */
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const get = <T,>(path: string) => request<T>(path);
const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const del = <T,>(path: string) => request<T>(path, { method: "DELETE" });

export interface Page {
  limit?: number;
  offset?: number;
}

/** Lists are paged so a busy practice does not ship hundreds of rows at once.
    One extra row is asked for beyond the page size: if it comes back, there is
    more to load, which avoids a second count query. */
export const PAGE_SIZE = 25;

function pageQuery(page: Page, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams();
  q.set("limit", String(page.limit ?? PAGE_SIZE));
  if (page.offset) q.set("offset", String(page.offset));
  Object.entries(extra).forEach(([k, v]) => {
    if (v) q.set(k, v);
  });
  return q.toString();
}

export const api = {
  // auth
  me: () => get<Me>("/auth/me"),
  councils: () => get<string[]>("/auth/councils"),
  login: (email: string, password: string) => post<Me>("/auth/login", { email, password }),
  logout: () => post<void>("/auth/logout"),
  register: (body: unknown) => post<Me>("/auth/register", body),
  updateProfile: (body: unknown) => patch<Doctor>("/auth/profile", body),
  changePassword: (current_password: string, new_password: string) =>
    post<void>("/auth/password", { current_password, new_password }),

  // directory
  addresses: () => get<Address[]>("/addresses"),
  createAddress: (body: unknown) => post<Address>("/addresses", body),
  updateAddress: (id: string, body: unknown) => patch<Address>(`/addresses/${id}`, body),
  deleteAddress: (id: string) => del<void>(`/addresses/${id}`),
  patients: (page: Page = {}, search = "") =>
    get<Patient[]>(`/patients?${pageQuery(page, { search })}`),
  createPatient: (body: unknown) => post<Patient>("/patients", body),

  // doctor orders
  orders: (
    needsAction = false,
    page: Page = {},
    filters: {
      search?: string;
      patientId?: string;
      series?: CaseSeries;
      /** One branch of a multi-clinic practice, by its delivery address. */
      addressId?: string;
    } = {},
  ) =>
    get<OrderSummary[]>(
      `/orders?${pageQuery(page, {
        needs_action: needsAction ? "true" : "",
        search: filters.search ?? "",
        patient_id: filters.patientId ?? "",
        series: filters.series ?? "",
        address_id: filters.addressId ?? "",
      })}`,
    ),
  order: (id: string) => get<OrderDetail>(`/orders/${id}`),
  createOrder: (body: unknown) => post<OrderDetail>("/orders", body),
  updateOrder: (id: string, body: unknown) => patch<OrderDetail>(`/orders/${id}`, body),
  submitOrder: (id: string) => post<OrderDetail>(`/orders/${id}/submit`),
  resubmitRecords: (id: string) => post<OrderDetail>(`/orders/${id}/resubmit`),
  acceptQuote: (id: string) => post<OrderDetail>(`/orders/${id}/quote/accept`),
  chooseScanRoute: (id: string, body: unknown) => post<OrderDetail>(`/orders/${id}/scan-route`, body),
  products: () => get<Product[]>("/products"),
  deliveryCharge: () => get<DeliveryCharge>("/delivery-charge"),
  accessories: () => get<Accessory[]>("/accessories"),
  practiceStats: (q: { view: string; year: number; month: number }) =>
    get<Stats>(`/stats?view=${q.view}&year=${q.year}&month=${q.month}`),
  labStats: (q: { view: string; year: number; month?: number; doctorId?: string }) =>
    get<Stats>(
      `/staff/stats?view=${q.view}&year=${q.year}` +
        (q.month ? `&month=${q.month}` : "") +
        (q.doctorId ? `&doctor_id=${encodeURIComponent(q.doctorId)}` : ""),
    ),
  pushKey: () => get<{ enabled: boolean; public_key: string }>("/notifications/push/key"),
  pushSubscribe: (body: unknown) => post<void>("/notifications/push/subscribe", body),
  pushUnsubscribe: (endpoint: string) =>
    del<void>(`/notifications/push/subscribe?endpoint=${encodeURIComponent(endpoint)}`),
  scanSources: (id: string) => get<ScanSource[]>(`/orders/${id}/scan-sources`),
  reuseScan: (id: string, sourceOrderId: string) =>
    post<OrderDetail>(`/orders/${id}/scan-reuse`, { source_order_id: sourceOrderId }),
  respondToPlan: (id: string, body: unknown) => post<OrderDetail>(`/orders/${id}/plan/respond`, body),
  submitFitReview: (id: string, body: unknown) => post<OrderDetail>(`/orders/${id}/fit-review`, body),
  confirmDelivery: (orderId: string, shipmentId: string) =>
    post<OrderDetail>(`/orders/${orderId}/shipments/${shipmentId}/delivered`),
  decidePhase: (
    orderId: string,
    shipmentId: string,
    decision: "CONTINUE" | "REPEAT",
    notes = "",
    shippingAddressId: string | null = null,
  ) =>
    post<OrderDetail>(`/orders/${orderId}/shipments/${shipmentId}/phase-decision`, {
      decision,
      notes,
      shipping_address_id: shippingAddressId,
    }),
  cancelDraft: (id: string, reason: string) => post<OrderDetail>(`/orders/${id}/cancel`, { reason }),

  // files
  uploadFile: (orderId: string, category: FileCategory, file: File, slot = "") => {
    const form = new FormData();
    form.append("category", category);
    form.append("slot", slot);
    form.append("upload", file);
    return request<OrderFile>(`/orders/${orderId}/files`, { method: "POST", body: form });
  },
  deleteFile: (orderId: string, fileId: string) => del<void>(`/orders/${orderId}/files/${fileId}`),
  listBin: (orderId: string) => get<BinnedFile[]>(`/orders/${orderId}/files/bin/list`),
  restoreFile: (orderId: string, fileId: string) =>
    post<OrderFile>(`/orders/${orderId}/files/${fileId}/restore`),
  purgeFile: (orderId: string, fileId: string) =>
    del<void>(`/orders/${orderId}/files/${fileId}/purge`),
  // Browsers cannot attach a header to <img src> or a download link, so the
  // slot rides as a query parameter for these two.
  downloadUrl: (orderId: string, fileId: string) =>
    `/api/orders/${orderId}/files/${fileId}/download?slot=${sessionSlot()}`,
  previewUrl: (orderId: string, fileId: string) =>
    `/api/orders/${orderId}/files/${fileId}/download?inline=1&slot=${sessionSlot()}`,

  // booking — doctor
  // Month view: which days are worth clicking. No travel lookups server-side.
  availability: (from: string, to: string, addressId?: string) =>
    get<DayAvailability[]>(
      `/appointments/availability?from=${from}&to=${to}` +
        (addressId ? `&address_id=${addressId}` : ""),
    ),
  // Exact times for one day, computed against real travel.
  dayAvailability: (date: string, addressId?: string) =>
    get<DayAvailability[]>(
      `/appointments/availability?from=${date}&to=${date}&detail=true` +
        (addressId ? `&address_id=${addressId}` : ""),
    ).then((days) => days[0]),
  bookAppointment: (orderId: string, body: unknown) =>
    post<OrderDetail>(`/orders/${orderId}/appointment`, body),
  cancelAppointment: (appointmentId: string, reason: string) =>
    post<OrderDetail>(`/appointments/${appointmentId}/cancel`, { reason }),

  // booking — technician
  mySchedule: (scope: "today" | "upcoming" | "past") =>
    get<Job[]>(`/tech/schedule?scope=${scope}`),
  technicianCase: (orderId: string) => get<OrderDetail>(`/tech/cases/${orderId}`),
  markEnRoute: (jobId: string) => post<Job>(`/tech/jobs/${jobId}/en-route`),
  markNoShow: (jobId: string, note: string) => post<Job>(`/tech/jobs/${jobId}/no-show`, { note }),

  // booking — admin
  bookings: (params: { from?: string; to?: string; technician_id?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v && q.set(k, v));
    const qs = q.toString();
    return get<Booking[]>(`/admin/bookings${qs ? `?${qs}` : ""}`);
  },
  reassignBooking: (id: string, technician_id: string, force = false) =>
    post<Booking>(`/admin/bookings/${id}/reassign`, { technician_id, force }),
  technicians: () => get<Technician[]>("/admin/technicians"),
  createTechnician: (body: unknown) => post<Technician>("/admin/technicians", body),
  updateTechnician: (id: string, body: unknown) => patch<Technician>(`/admin/technicians/${id}`, body),
  setAvailability: (id: string, rules: AvailabilityRule[]) =>
    request<Technician>(`/admin/technicians/${id}/availability`, {
      method: "PUT",
      body: JSON.stringify({ rules }),
    }),
  addTimeOff: (id: string, body: unknown) => post<Technician>(`/admin/technicians/${id}/time-off`, body),
  removeTimeOff: (id: string) => del<void>(`/admin/time-off/${id}`),
  pricing: () => get<AlignerPrice[]>("/staff/pricing"),
  savePricing: (prices: { category: string; price_min: string; price_max: string; is_active: boolean }[]) =>
    request<AlignerPrice[]>("/staff/pricing", { method: "PUT", body: JSON.stringify({ prices }) }),
  bookingSettings: () => get<BookingSettings>("/admin/settings"),
  technicianRoute: (technicianId: string, day: string) =>
    get<DayRoute>(`/admin/technicians/${technicianId}/route?day=${day}`),
  myRoute: (day: string) => get<DayRoute>(`/tech/route?day=${day}`),
  requestReassignment: (appointmentId: string, reason: string) =>
    request<Reassignment>(`/tech/jobs/${appointmentId}/reassign-request`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  mapConfig: () => get<MapConfig>("/config/map"),
  simulation: (orderId: string) => get<Simulation>(`/orders/${orderId}/files/simulation`),
  meshUrl: (orderId: string, fileId: string) =>
    `/api/orders/${orderId}/files/simulation/${fileId}/mesh?slot=${sessionSlot()}`,
  searchAddress: (q: string) =>
    get<{ result: { lat: number; lng: number; address: string; approximate: boolean } | null }>(
      `/config/search?q=${encodeURIComponent(q)}`,
    ),
  suggestAddress: (q: string) =>
    get<{ suggestions: { text: string }[] }>(`/config/suggest?q=${encodeURIComponent(q)}`),
  reverseGeocode: (lat: number, lng: number) =>
    get<{ address: string; parts: ResolvedAddress }>(
      `/config/reverse-geocode?lat=${lat}&lng=${lng}`,
    ),
  reassignments: (pendingOnly = true) =>
    get<Reassignment[]>(`/admin/reassignments?pending_only=${pendingOnly}`),
  resolveReassignment: (
    id: string,
    body: { action: "TECHNICIAN" | "ANY" | "DECLINE"; technician_id?: string; note?: string; force?: boolean },
  ) =>
    request<Reassignment>(`/admin/reassignments/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  saveBookingSettings: (body: unknown) =>
    request<BookingSettings>("/admin/settings", { method: "PUT", body: JSON.stringify(body) }),

  // notifications
  notifications: () => get<Notification[]>("/notifications"),
  unreadCount: () => get<{ count: number }>("/notifications/unread-count"),
  markRead: (id: string) => post<void>(`/notifications/${id}/read`),
  markAllRead: () => post<void>("/notifications/read-all"),

  // staff
  queue: () => get<Queue>("/staff/queue"),
  staffOrders: (
    params: { status?: string; search?: string; series?: CaseSeries } = {},
    page: Page = {},
  ) =>
    get<OrderSummary[]>(
      `/staff/orders?${pageQuery(page, {
        status: params.status ?? "",
        search: params.search ?? "",
        series: params.series ?? "",
      })}`,
    ),
  staffOrder: (id: string) => get<OrderDetail>(`/staff/orders/${id}`),
  startReview: (id: string) => post<OrderDetail>(`/staff/orders/${id}/start-review`),
  requestRecords: (id: string, note: string) =>
    post<OrderDetail>(`/staff/orders/${id}/request-records`, { note }),
  sendQuote: (id: string, body: unknown) => post<OrderDetail>(`/staff/orders/${id}/quotes`, body),
  acceptScan: (id: string, note: string) => post<OrderDetail>(`/staff/orders/${id}/scan/accept`, { note }),
  rejectScan: (id: string, note: string) => post<OrderDetail>(`/staff/orders/${id}/scan/reject`, { note }),
  sharePlan: (id: string, body: unknown) => post<OrderDetail>(`/staff/orders/${id}/plans`, body),
  payProof: (orderId: string, paymentId: string, file: File, reference: string) => {
    const body = new FormData();
    body.append("upload", file);
    body.append("reference", reference);
    return request<OrderDetail>(`/orders/${orderId}/payments/${paymentId}/proof`, {
      method: "POST",
      body,
    });
  },
  verifyPayment: (orderId: string, paymentId: string, approve: boolean, reason = "") =>
    post<OrderDetail>(`/staff/orders/${orderId}/payments/${paymentId}/verify`, {
      approve,
      reason,
    }),
  shippingRates: () => get<ShippingRate[]>("/staff/shipping-rates"),
  deliveryCities: () => get<DeliveryCity[]>("/staff/delivery-cities"),
  saveShippingRates: (rows: ShippingRate[]) =>
    request<ShippingRate[]>("/staff/shipping-rates", {
      method: "PUT",
      body: JSON.stringify(rows),
    }),
  reportPhaseFitIssue: (
    id: string,
    body: { arch: "UPPER" | "LOWER"; aligner_number: number; notes: string },
  ) => post<OrderDetail>(`/orders/${id}/phase-fit-issue`, body),
  resolvePhaseFitIssue: (
    id: string,
    resolution: "COMMENTS" | "REMAKE" | "RESCAN",
    comments: string,
  ) =>
    post<OrderDetail>(`/staff/orders/${id}/phase-fit-issue/resolve`, {
      resolution,
      comments,
    }),
  replyToPhaseFitIssue: (id: string, message: string) =>
    post<OrderDetail>(`/orders/${id}/phase-fit-issue/reply`, { message }),
  closePhaseFitIssue: (id: string) =>
    post<OrderDetail>(`/orders/${id}/phase-fit-issue/resolve`, {}),
  orthodontists: () => get<StaffUser[]>("/staff/orthodontists"),
  createOrthodontist: (body: { email: string; password: string; full_name: string }) =>
    post<StaffUser>("/staff/orthodontists", body),
  updateOrthodontist: (
    id: string,
    body: { full_name?: string; is_active?: boolean; password?: string },
  ) => patch<StaffUser>(`/staff/orthodontists/${id}`, body),
  assignCase: (orderId: string, userId: string | null) =>
    post<OrderDetail>(`/staff/orders/${orderId}/assign`, { user_id: userId }),
  requestLeave: (body: { starts_at: string; ends_at: string; reason: string }) =>
    post<Leave>("/tech/leave", body),
  myLeave: () => get<Leave[]>("/tech/leave"),
  leaveQueue: (pendingOnly = false) =>
    get<Leave[]>(`/admin/leave${pendingOnly ? "?pending_only=true" : ""}`),
  decideLeave: (id: string, approve: boolean, note = "") =>
    post<LeaveDecision>(`/admin/leave/${id}/decide`, { approve, note }),
  bookingsNeedingAttention: () => get<Booking[]>("/admin/bookings/attention"),
  settleAttention: (id: string, action: "RESCHEDULE" | "IGNORE", note = "") =>
    post<Booking>(`/admin/bookings/${id}/attention`, { action, note }),
  reviewPhase: (id: string, outcome: "CONTINUE" | "RESCAN", note: string) =>
    post<OrderDetail>(`/staff/orders/${id}/phase-review`, { outcome, note }),
  resolveFitIssue: (id: string, resolution: "rescan" | "replan" | "refabricate") =>
    post<OrderDetail>(`/staff/orders/${id}/fit-issue/resolve?resolution=${resolution}`),
  createShipment: (id: string, body: unknown) => post<OrderDetail>(`/staff/orders/${id}/shipments`, body),
  updateShipment: (shipmentId: string, body: unknown) =>
    patch<OrderDetail>(`/staff/shipments/${shipmentId}`, body),
  completeOrder: (id: string) => post<OrderDetail>(`/staff/orders/${id}/complete`),
  cancelOrder: (id: string, reason: string) => post<OrderDetail>(`/staff/orders/${id}/cancel`, { reason }),
  generateInvoice: (id: string) => post<OrderDetail>(`/staff/orders/${id}/invoice`),
  staffDoctors: (pendingOnly = false, page: Page = {}, search = "") =>
    get<PendingDoctor[]>(
      `/staff/doctors?${pageQuery(page, { pending_only: pendingOnly ? "true" : "", search })}`,
    ),
  verifyDoctor: (id: string, approve: boolean, reason = "") =>
    post<PendingDoctor>(`/staff/doctors/${id}/verify`, { approve, reason }),
};

// ---------------------------------------------------------------- helpers

export const CATEGORY_LABEL: Record<FileCategory, string> = {
  RECORD_PHOTO: "Clinical photographs",
  OPG: "OPG",
  LATERAL_CEPH: "Lateral cephalogram",
  CBCT: "CBCT",
  INTRAORAL_SCAN: "Intraoral scan (STL)",
  TREATMENT_PLAN: "Treatment plan",
  SIMULATION_MODEL: "Simulation files (STL)",
  FIT_ISSUE_PHOTO: "Fit issue photo",
  PROGRESS_PHOTO: "Progress photographs",
  PAYMENT_PROOF: "Payment receipts",
  PHASE_FIT_PHOTO: "Phase fit issue photographs",
  OTHER: "Other",
};

export function formatMoney(amount: string | number, currency = "INR"): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  if (Number.isNaN(value)) return String(amount);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Mirrors SLOT_SPEC on the server so uploads can name their view. */
export const SLOT_OPTIONS: Partial<Record<FileCategory, { slot: string; label: string; required: boolean }[]>> = {
  INTRAORAL_SCAN: [
    { slot: "UPPER_ARCH", label: "Upper arch", required: true },
    { slot: "LOWER_ARCH", label: "Lower arch", required: true },
    { slot: "BITE", label: "Bite registration", required: true },
  ],
  RECORD_PHOTO: [
    { slot: "INTRAORAL_FRONTAL", label: "Frontal, in occlusion", required: true },
    { slot: "BUCCAL_RIGHT", label: "Buccal right", required: true },
    { slot: "BUCCAL_LEFT", label: "Buccal left", required: true },
    { slot: "OCCLUSAL_UPPER", label: "Occlusal upper", required: true },
    { slot: "OCCLUSAL_LOWER", label: "Occlusal lower", required: true },
    { slot: "FACE_REST", label: "Face at rest", required: false },
    { slot: "FACE_SMILE", label: "Face smiling", required: false },
    { slot: "PROFILE", label: "Profile", required: false },
  ],
};

/** A band quotes a range; a settled price has both ends equal. */
export function formatRange(low: string | number, high: string | number, currency = "INR"): string {
  const a = Number(low);
  const b = Number(high);
  if (!b || a === b) return formatMoney(a, currency);
  return `${formatMoney(a, currency)} – ${formatMoney(b, currency)}`;
}
