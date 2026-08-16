from __future__ import annotations

from typing import Optional

from datetime import date as date_type, datetime, time as time_type
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

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
    slot: str = ""
    slot_label: str = ""
    is_image: bool = False
    uploaded_by: str = ""
    created_at: datetime

    @field_validator("uploaded_by", mode="before")
    @classmethod
    def _uploader_name(cls, value):
        """The ORM attribute is a User; the API sends a display name."""
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        doctor = getattr(value, "doctor", None)
        return doctor.full_name if doctor is not None else "3D Align"


class BinnedFileOut(FileOut):
    deleted_at: Optional[datetime] = None
    deleted_by: str = ""
    purges_in_days: int = 0

    @field_validator("deleted_by", mode="before")
    @classmethod
    def _deleter_name(cls, value):
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        doctor = getattr(value, "doctor", None)
        return doctor.full_name if doctor is not None else "3D Align"


class SlotState(BaseModel):
    """One named view in a records set — filled or waiting."""

    slot: str
    label: str
    required: bool
    file: Optional[FileOut] = None


class RecordSet(BaseModel):
    """A category rendered as the set it actually is."""

    category: enums.FileCategory
    label: str
    revision: int
    complete: bool
    slots: list[SlotState]
    extras: list[FileOut]
    missing: list[str]
    # Whether the caller may add or replace files here, decided by the same
    # windows the upload endpoint enforces — so a button never lies.
    required: bool = False
    editable: bool = False
    locked_reason: str = ""


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
    """The expected quote is a category, not a typed-in price."""

    category: enums.AlignerCategory
    extras: list[QuoteLineItemIn] = Field(default_factory=list)
    tax: Decimal = Decimal("0")
    currency: str = "INR"
    notes: str = ""


class QuoteOut(ORMModel):
    id: str
    version: int
    category: Optional[str] = None
    category_label: str = ""
    category_price: Decimal = Decimal("0")
    category_price_max: Decimal = Decimal("0")
    subtotal_max: Decimal = Decimal("0")
    total_max: Decimal = Decimal("0")
    subtotal: Decimal
    tax: Decimal
    total: Decimal
    currency: str
    notes: str
    status: enums.QuoteStatus
    is_final: bool = False
    sent_at: Optional[datetime]
    responded_at: Optional[datetime]
    line_items: list[QuoteLineItemOut]


class PlanIn(BaseModel):
    aligners_upper: int = Field(default=0, ge=0)
    aligners_lower: int = Field(default=0, ge=0)
    # The lab types the final figure once the plan gives an exact aligner
    # count. Bands only ever drove the expected quote.
    final_price: Decimal = Field(default=Decimal("0"), ge=0)
    final_tax: Decimal = Field(default=Decimal("0"), ge=0)
    ipr_required: bool = False
    attachments_required: bool = False
    summary: str = ""


class PlanOut(ORMModel):
    id: str
    version: int
    aligners_upper: int
    aligners_lower: int
    total_aligners: int = 0
    final_category: Optional[str] = None
    final_category_label: str = ""
    final_price: Decimal = Decimal("0")
    final_tax: Decimal = Decimal("0")
    final_total: Decimal = Decimal("0")
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
    # Phases chain: the start is derived from the previous phase, so the lab
    # only says how far this one runs.
    aligner_range_to: Optional[int] = Field(default=None, ge=1)
    carrier: str = ""
    tracking_number: str = ""
    tracking_url: str = ""


class PhaseDecisionIn(BaseModel):
    decision: enums.PhaseDecision
    notes: str = ""


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
    phase_round: Optional[int] = None
    phase_decision: Optional[str] = None
    decision_notes: str = ""
    is_final_phase: bool = False
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


class AppointmentOut(BaseModel):
    id: str
    starts_at: datetime
    ends_at: datetime
    status: enums.AppointmentStatus
    status_label: str
    technician_name: str
    technician_phone: str
    contact_name: str
    contact_phone: str
    access_notes: str
    assignment_reason: str
    cancel_reason: str
    outcome_notes: str
    location: str


# ---- booking -------------------------------------------------------------


class SlotOut(BaseModel):
    starts_at: datetime
    ends_at: datetime
    available: bool
    reason: str = ""


class DayAvailability(BaseModel):
    date: date_type
    closed: bool
    free_count: int
    slots: list[SlotOut]


class BookAppointmentIn(BaseModel):
    starts_at: datetime
    address_id: Optional[str] = None
    contact_name: str = ""
    contact_phone: str = ""
    access_notes: str = ""


class JobOrderOut(BaseModel):
    id: str
    order_number: str
    patient_name: str
    doctor_name: str
    clinic_name: str
    arch: enums.Arch
    clinical_notes: str
    status: enums.OrderStatus


class JobOut(AppointmentOut):
    order: JobOrderOut


class BookingOut(JobOut):
    address: Optional[AddressOut] = None


class ReassignIn(BaseModel):
    technician_id: str
    force: bool = False


class AvailabilityRuleIn(BaseModel):
    weekday: int = Field(ge=0, le=6)
    start_time: time_type
    end_time: time_type


class AvailabilityRuleOut(ORMModel, AvailabilityRuleIn):
    id: str


class AvailabilityIn(BaseModel):
    rules: list[AvailabilityRuleIn]


class TimeOffIn(BaseModel):
    starts_at: datetime
    ends_at: datetime
    reason: str = ""


class TimeOffOut(ORMModel, TimeOffIn):
    id: str


class TechnicianIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    full_name: str = Field(min_length=1, max_length=200)
    phone: str = ""
    employee_code: str = ""
    max_daily_jobs: int = Field(default=4, ge=1, le=20)


class TechnicianUpdateIn(BaseModel):
    full_name: Optional[str] = None
    phone: Optional[str] = None
    employee_code: Optional[str] = None
    max_daily_jobs: Optional[int] = Field(default=None, ge=1, le=20)
    is_active: Optional[bool] = None


class TechnicianOut(BaseModel):
    id: str
    full_name: str
    phone: str
    employee_code: str
    max_daily_jobs: int
    is_active: bool
    email: str
    availability: list[AvailabilityRuleOut]
    time_off: list[TimeOffOut]
    upcoming_jobs: int


class BookingSettingsIn(BaseModel):
    slot_minutes: Optional[int] = Field(default=None, ge=15, le=240)
    travel_buffer_minutes: Optional[int] = Field(default=None, ge=0, le=180)
    booking_horizon_days: Optional[int] = Field(default=None, ge=1, le=180)
    min_notice_hours: Optional[int] = Field(default=None, ge=0, le=336)
    max_daily_jobs: Optional[int] = Field(default=None, ge=1, le=20)
    working_hours: Optional[dict] = None
    service_city: Optional[str] = None


class AlignerPriceOut(ORMModel):
    category: str
    label: str = ""
    range_from: int = 0
    range_to: Optional[int] = None
    price_min: Decimal
    price_max: Decimal
    is_active: bool


class AlignerPriceIn(BaseModel):
    category: enums.AlignerCategory
    price_min: Decimal = Field(ge=0)
    price_max: Decimal = Field(ge=0)
    is_active: bool = True


class PricingIn(BaseModel):
    prices: list[AlignerPriceIn]


class BookingSettingsOut(ORMModel):
    slot_minutes: int
    travel_buffer_minutes: int
    booking_horizon_days: int
    min_notice_hours: int
    max_daily_jobs: int
    working_hours: dict
    service_city: str


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
    submit_blockers: list[str]
    record_sets: list[RecordSet]
    binned_count: int
    scan_complete: bool
    total_aligners: int = 0
    next_phase_from: int = 0
    next_phase_max: int = 0
    next_phase_number: int = 1
    next_phase_round: int = 1
    phase_blocker: Optional[str] = None
    awaiting_phase_decision: Optional[str] = None


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
