from __future__ import annotations

from typing import Optional

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from . import enums


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------
# Auth and profile
# --------------------------------------------------------------------------


class AddressIn(BaseModel):
    label: str = "Clinic"
    line1: str = Field(min_length=1, max_length=255)
    line2: str = ""
    city: str = Field(min_length=1, max_length=120)
    state: str = Field(min_length=1, max_length=120)
    pincode: str = Field(min_length=1, max_length=20)
    country: str = "India"
    is_default_shipping: bool = False


class AddressOut(ORMModel, AddressIn):
    id: str


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    full_name: str = Field(min_length=1, max_length=200)
    phone: str = ""
    clinic_name: str = ""
    dental_council: str = ""
    registration_number: str = ""
    address: AddressIn


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class DoctorOut(ORMModel):
    id: str
    full_name: str
    phone: str
    clinic_name: str
    dental_council: str
    registration_number: str
    verification_status: enums.VerificationStatus
    rejection_reason: str


class MeOut(BaseModel):
    id: str
    email: str
    role: enums.UserRole
    doctor: Optional[DoctorOut] = None


class DoctorProfileIn(BaseModel):
    full_name: str = Field(min_length=1, max_length=200)
    phone: str = ""
    clinic_name: str = ""


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


# --------------------------------------------------------------------------
# Patients
# --------------------------------------------------------------------------


class PatientIn(BaseModel):
    full_name: str = Field(min_length=1, max_length=200)
    date_of_birth: str = ""
    sex: str = ""
    external_ref: str = ""


class PatientOut(ORMModel, PatientIn):
    id: str
    created_at: datetime


# --------------------------------------------------------------------------
# Orders
# --------------------------------------------------------------------------


class OrderCreateIn(BaseModel):
    patient_id: Optional[str] = None
    new_patient: Optional[PatientIn] = None
    arch: enums.Arch = enums.Arch.BOTH
    priority: enums.Priority = enums.Priority.STANDARD
    chief_complaint: str = ""
    clinical_notes: str = ""
    shipping_address_id: Optional[str] = None


class OrderUpdateIn(BaseModel):
    arch: Optional[enums.Arch] = None
    priority: Optional[enums.Priority] = None
    chief_complaint: Optional[str] = None
    clinical_notes: Optional[str] = None
    shipping_address_id: Optional[str] = None


class FileOut(ORMModel):
    id: str
    category: enums.FileCategory
    filename: str
    mime_type: str
    size_bytes: int
    external_link: str
    revision: int
    is_current: bool = True
    created_at: datetime


class QuoteLineItemIn(BaseModel):
    description: str = Field(min_length=1, max_length=255)
    unit_price: Decimal = Decimal("0")
    quantity: int = Field(default=1, ge=1)


class QuoteLineItemOut(ORMModel):
    id: str
    description: str
    unit_price: Decimal
    quantity: int
    amount: Decimal


class QuoteIn(BaseModel):
    estimated_aligners_upper: int = Field(default=0, ge=0)
    estimated_aligners_lower: int = Field(default=0, ge=0)
    line_items: list[QuoteLineItemIn] = Field(min_length=1)
    tax: Decimal = Decimal("0")
    currency: str = "INR"
    notes: str = ""


class QuoteOut(ORMModel):
    id: str
    version: int
    estimated_aligners_upper: int
    estimated_aligners_lower: int
    subtotal: Decimal
    tax: Decimal
    total: Decimal
    currency: str
    notes: str
    status: enums.QuoteStatus
    sent_at: Optional[datetime]
    responded_at: Optional[datetime]
    line_items: list[QuoteLineItemOut]


class PlanIn(BaseModel):
    aligners_upper: int = Field(default=0, ge=0)
    aligners_lower: int = Field(default=0, ge=0)
    ipr_required: bool = False
    attachments_required: bool = False
    summary: str = ""


class PlanOut(ORMModel):
    id: str
    version: int
    aligners_upper: int
    aligners_lower: int
    ipr_required: bool
    attachments_required: bool
    summary: str
    status: enums.PlanStatus
    revision_notes: str
    shared_at: Optional[datetime]
    responded_at: Optional[datetime]


class PlanRespondIn(BaseModel):
    approve: bool
    revision_notes: str = ""


class ShipmentIn(BaseModel):
    shipment_type: enums.ShipmentType
    phase_number: Optional[int] = None
    aligner_range_from: Optional[int] = None
    aligner_range_to: Optional[int] = None
    carrier: str = ""
    tracking_number: str = ""
    tracking_url: str = ""


class ShipmentUpdateIn(BaseModel):
    carrier: Optional[str] = None
    tracking_number: Optional[str] = None
    tracking_url: Optional[str] = None
    mark_delivered: bool = False


class ShipmentOut(ORMModel):
    id: str
    shipment_type: enums.ShipmentType
    fit_round: Optional[int]
    phase_number: Optional[int]
    aligner_range_from: Optional[int]
    aligner_range_to: Optional[int]
    carrier: str
    tracking_number: str
    tracking_url: str
    status: enums.ShipmentStatus
    shipped_at: Optional[datetime]
    delivered_at: Optional[datetime]


class ScanRouteIn(BaseModel):
    route: enums.ScanRoute
    courier_tracking: str = ""
    scheduled_at: Optional[datetime] = None
    location: str = ""


class AppointmentOut(ORMModel):
    id: str
    scheduled_at: datetime
    location: str
    status: enums.AppointmentStatus
    notes: str


class FitReviewIn(BaseModel):
    fits: bool
    dispatch_mode: Optional[enums.DispatchMode] = None
    issue_notes: str = ""


class InvoiceOut(ORMModel):
    id: str
    invoice_number: str
    amount: Decimal
    currency: str
    pdf_url: str
    share_url: str
    status: enums.InvoiceStatus
    issued_at: Optional[datetime]


class EventOut(BaseModel):
    id: str
    from_status: Optional[enums.OrderStatus]
    to_status: enums.OrderStatus
    note: str
    actor_name: str
    created_at: datetime


class OrderSummary(BaseModel):
    id: str
    order_number: str
    status: enums.OrderStatus
    status_label: str
    patient_name: str
    doctor_name: str
    clinic_name: str
    arch: enums.Arch
    priority: enums.Priority
    needs_doctor_action: bool
    created_at: datetime
    updated_at: datetime


class OrderDetail(OrderSummary):
    dispatch_mode: Optional[enums.DispatchMode]
    scan_route: Optional[enums.ScanRoute]
    scan_courier_tracking: str
    chief_complaint: str
    clinical_notes: str
    records_request_note: str
    cancel_reason: str
    records_revision: int
    scan_revision: int
    fit_round: int
    submitted_at: Optional[datetime]
    approved_at: Optional[datetime]
    completed_at: Optional[datetime]
    shipping_address: Optional[AddressOut]
    files: list[FileOut]
    quotes: list[QuoteOut]
    plans: list[PlanOut]
    shipments: list[ShipmentOut]
    appointment: Optional[AppointmentOut]
    invoice: Optional[InvoiceOut]
    events: list[EventOut]
    missing_categories: list[enums.FileCategory]


class NoteIn(BaseModel):
    note: str = ""


class RecordsRequestIn(BaseModel):
    note: str = Field(min_length=1)


class CancelIn(BaseModel):
    reason: str = Field(min_length=1)


class NotificationOut(ORMModel):
    id: str
    order_id: Optional[str]
    title: str
    body: str
    read_at: Optional[datetime]
    created_at: datetime


# --------------------------------------------------------------------------
# Staff
# --------------------------------------------------------------------------


class PendingDoctorOut(ORMModel):
    id: str
    full_name: str
    phone: str
    clinic_name: str
    dental_council: str
    registration_number: str
    verification_status: enums.VerificationStatus
    registry_check_result: Optional[dict]
    created_at: datetime
    email: str = ""


class VerifyDoctorIn(BaseModel):
    approve: bool
    reason: str = ""


class QueueOut(BaseModel):
    new_submissions: int
    awaiting_quote: int
    awaiting_scan_review: int
    in_planning: int
    in_production: int
    ready_to_ship: int
    dispatching: int
    ready_to_invoice: int
    pending_doctors: int
