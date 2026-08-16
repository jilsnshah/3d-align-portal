export type Role = "DOCTOR" | "ADMIN" | "TECHNICIAN";
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
  | "DISPATCHING"
  | "COMPLETED"
  | "CANCELLED";

export type FileCategory =
  | "RECORD_PHOTO"
  | "OPG"
  | "LATERAL_CEPH"
  | "CBCT"
  | "INTRAORAL_SCAN"
  | "TREATMENT_PLAN"
  | "SIMULATION_VIDEO"
  | "FIT_ISSUE_PHOTO"
  | "OTHER";

export type ShipmentType = "TRAINING_ALIGNER" | "ALIGNER_PHASE" | "FULL_CASE";

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
  doctor: Doctor | null;
}

export interface Address {
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

export interface TreatmentPlan {
  id: string;
  version: number;
  aligners_upper: number;
  aligners_lower: number;
  total_aligners: number;
  final_category: AlignerCategory | null;
  final_category_label: string;
  final_price: string;
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

export interface OrderSummary {
  id: string;
  order_number: string;
  status: OrderStatus;
  status_label: string;
  patient_name: string;
  doctor_name: string;
  clinic_name: string;
  arch: "UPPER" | "LOWER" | "BOTH";
  priority: "STANDARD" | "EXPRESS";
  needs_doctor_action: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrderDetail extends OrderSummary {
  dispatch_mode: "FULL" | "PHASED" | null;
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

export interface BookingSettings {
  slot_minutes: number;
  travel_buffer_minutes: number;
  booking_horizon_days: number;
  min_notice_hours: number;
  max_daily_jobs: number;
  working_hours: Record<string, [string, string] | null>;
  service_city: string;
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    ...init,
    headers:
      init.body instanceof FormData
        ? init.headers
        : { "Content-Type": "application/json", ...(init.headers ?? {}) },
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
  patients: () => get<Patient[]>("/patients"),
  createPatient: (body: unknown) => post<Patient>("/patients", body),

  // doctor orders
  orders: (needsAction = false) =>
    get<OrderSummary[]>(`/orders${needsAction ? "?needs_action=true" : ""}`),
  order: (id: string) => get<OrderDetail>(`/orders/${id}`),
  createOrder: (body: unknown) => post<OrderDetail>("/orders", body),
  updateOrder: (id: string, body: unknown) => patch<OrderDetail>(`/orders/${id}`, body),
  submitOrder: (id: string) => post<OrderDetail>(`/orders/${id}/submit`),
  resubmitRecords: (id: string) => post<OrderDetail>(`/orders/${id}/resubmit`),
  acceptQuote: (id: string) => post<OrderDetail>(`/orders/${id}/quote/accept`),
  chooseScanRoute: (id: string, body: unknown) => post<OrderDetail>(`/orders/${id}/scan-route`, body),
  respondToPlan: (id: string, body: unknown) => post<OrderDetail>(`/orders/${id}/plan/respond`, body),
  submitFitReview: (id: string, body: unknown) => post<OrderDetail>(`/orders/${id}/fit-review`, body),
  confirmDelivery: (orderId: string, shipmentId: string) =>
    post<OrderDetail>(`/orders/${orderId}/shipments/${shipmentId}/delivered`),
  decidePhase: (orderId: string, shipmentId: string, decision: "CONTINUE" | "REPEAT", notes = "") =>
    post<OrderDetail>(`/orders/${orderId}/shipments/${shipmentId}/phase-decision`, { decision, notes }),
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
  downloadUrl: (orderId: string, fileId: string) => `/api/orders/${orderId}/files/${fileId}/download`,
  previewUrl: (orderId: string, fileId: string) =>
    `/api/orders/${orderId}/files/${fileId}/download?inline=1`,

  // booking — doctor
  availability: (from: string, to: string) =>
    get<DayAvailability[]>(`/appointments/availability?from=${from}&to=${to}`),
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
  saveBookingSettings: (body: unknown) =>
    request<BookingSettings>("/admin/settings", { method: "PUT", body: JSON.stringify(body) }),

  // notifications
  notifications: () => get<Notification[]>("/notifications"),
  unreadCount: () => get<{ count: number }>("/notifications/unread-count"),
  markRead: (id: string) => post<void>(`/notifications/${id}/read`),
  markAllRead: () => post<void>("/notifications/read-all"),

  // staff
  queue: () => get<Queue>("/staff/queue"),
  staffOrders: (params: { status?: string; search?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.search) q.set("search", params.search);
    const qs = q.toString();
    return get<OrderSummary[]>(`/staff/orders${qs ? `?${qs}` : ""}`);
  },
  staffOrder: (id: string) => get<OrderDetail>(`/staff/orders/${id}`),
  startReview: (id: string) => post<OrderDetail>(`/staff/orders/${id}/start-review`),
  requestRecords: (id: string, note: string) =>
    post<OrderDetail>(`/staff/orders/${id}/request-records`, { note }),
  sendQuote: (id: string, body: unknown) => post<OrderDetail>(`/staff/orders/${id}/quotes`, body),
  acceptScan: (id: string, note: string) => post<OrderDetail>(`/staff/orders/${id}/scan/accept`, { note }),
  rejectScan: (id: string, note: string) => post<OrderDetail>(`/staff/orders/${id}/scan/reject`, { note }),
  sharePlan: (id: string, body: unknown) => post<OrderDetail>(`/staff/orders/${id}/plans`, body),
  resolveFitIssue: (id: string, resolution: "rescan" | "replan" | "refabricate") =>
    post<OrderDetail>(`/staff/orders/${id}/fit-issue/resolve?resolution=${resolution}`),
  createShipment: (id: string, body: unknown) => post<OrderDetail>(`/staff/orders/${id}/shipments`, body),
  updateShipment: (shipmentId: string, body: unknown) =>
    patch<OrderDetail>(`/staff/shipments/${shipmentId}`, body),
  completeOrder: (id: string) => post<OrderDetail>(`/staff/orders/${id}/complete`),
  cancelOrder: (id: string, reason: string) => post<OrderDetail>(`/staff/orders/${id}/cancel`, { reason }),
  generateInvoice: (id: string) => post<OrderDetail>(`/staff/orders/${id}/invoice`),
  staffDoctors: (pendingOnly = false) =>
    get<PendingDoctor[]>(`/staff/doctors${pendingOnly ? "?pending_only=true" : ""}`),
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
  SIMULATION_VIDEO: "Simulation video",
  FIT_ISSUE_PHOTO: "Fit issue photo",
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
