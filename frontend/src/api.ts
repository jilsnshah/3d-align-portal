export type Role = "DOCTOR" | "STAFF";
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
  created_at: string;
}

export interface QuoteLineItem {
  id: string;
  description: string;
  unit_price: string;
  quantity: number;
  amount: string;
}

export interface Quote {
  id: string;
  version: number;
  estimated_aligners_upper: number;
  estimated_aligners_lower: number;
  subtotal: string;
  tax: string;
  total: string;
  currency: string;
  notes: string;
  status: "SENT" | "ACCEPTED" | "SUPERSEDED";
  sent_at: string | null;
  responded_at: string | null;
  line_items: QuoteLineItem[];
}

export interface TreatmentPlan {
  id: string;
  version: number;
  aligners_upper: number;
  aligners_lower: number;
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
  aligner_range_from: number | null;
  aligner_range_to: number | null;
  carrier: string;
  tracking_number: string;
  tracking_url: string;
  status: "PENDING" | "SHIPPED" | "DELIVERED";
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
  appointment: { id: string; scheduled_at: string; location: string; status: string } | null;
  invoice: Invoice | null;
  events: StatusEvent[];
  missing_categories: FileCategory[];
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
  cancelDraft: (id: string, reason: string) => post<OrderDetail>(`/orders/${id}/cancel`, { reason }),

  // files
  uploadFile: (orderId: string, category: FileCategory, file: File) => {
    const form = new FormData();
    form.append("category", category);
    form.append("upload", file);
    return request<OrderFile>(`/orders/${orderId}/files`, { method: "POST", body: form });
  },
  deleteFile: (orderId: string, fileId: string) => del<void>(`/orders/${orderId}/files/${fileId}`),
  downloadUrl: (orderId: string, fileId: string) => `/api/orders/${orderId}/files/${fileId}/download`,

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
