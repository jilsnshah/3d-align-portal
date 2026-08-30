from __future__ import annotations

from typing import Literal, Optional

from datetime import date as date_type, datetime, time as time_type
from decimal import Decimal

from pydantic import AliasChoices, BaseModel, ConfigDict, EmailStr, Field, field_validator

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
    # Dropped by the doctor on a map. When present it is used as-is: they know
    # where their own front door is better than a geocoder does.
    latitude: Optional[float] = None
    longitude: Optional[float] = None



class AddressOut(ORMModel, AddressIn):
    id: str
    # How well the address resolved, so the lab can spot a clinic that will
    # route badly before a technician is sent to the wrong building.
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    geocode_source: str = ""


class DeliveryQuoteOut(BaseModel):
    """What delivery will cost on an order placed right now.

    A product is quoted, paid and made in one step, so the clinic has to see
    this before it commits — unlike an aligner case, where delivery is not
    raised until a production phase is dispatched.
    """

    city: str
    amount: Decimal
    # False when the lab has not priced this city and the default applies, which
    # is worth saying out loud rather than presenting a guess as a rate.
    is_city_rate: bool
    # No default address on file means nothing can be quoted yet.
    has_address: bool


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
    # Lab-side accounts carry their own name; a doctor's lives on their record.
    full_name: str = ""
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


class ProductSizeOut(ORMModel):
    id: str
    label: str
    price: Decimal


class ProductOut(ORMModel):
    id: str
    code: str
    name: str
    description: str
    per_tooth_price: Decimal
    included_teeth: int
    # Read from priced_sizes, not sizes: a retired size keeps its row so the
    # orders that used it still resolve, and reading the raw list would put it
    # back in front of the clinic as something orderable.
    sizes: list[ProductSizeOut] = Field(validation_alias=AliasChoices("priced_sizes", "sizes"))
    has_choice_of_size: bool


class ScanSourceOut(BaseModel):
    """An earlier case of this patient's whose scan could be reused."""

    order_id: str
    reference: str
    kind: enums.OrderKind
    status: enums.OrderStatus
    status_label: str
    taken_at: datetime


class PushKeysIn(BaseModel):
    p256dh: str
    auth: str


class PushSubscribeIn(BaseModel):
    """What the browser hands back after the person agrees to notifications."""

    endpoint: str = Field(min_length=1, max_length=512)
    keys: PushKeysIn


class ScanReuseIn(BaseModel):
    """Which earlier case of this patient's to take the scan from."""

    source_order_id: str


class OrderCreateIn(BaseModel):
    patient_id: Optional[str] = None
    new_patient: Optional[PatientIn] = None
    arch: enums.Arch = enums.Arch.BOTH
    priority: enums.Priority = enums.Priority.STANDARD
    chief_complaint: str = ""
    clinical_notes: str = ""
    shipping_address_id: Optional[str] = None

    # A product order names what it wants made. Left unset, this is an aligner
    # case and the rest of these are ignored.
    product_id: Optional[str] = None
    product_size_id: Optional[str] = None
    quantity: int = Field(default=1, ge=1, le=50)
    extra_teeth: int = Field(default=0, ge=0, le=32)


class OrderUpdateIn(BaseModel):
    product_size_id: Optional[str] = None
    quantity: Optional[int] = Field(default=None, ge=1, le=50)
    extra_teeth: Optional[int] = Field(default=None, ge=0, le=32)
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
    final_discount: Decimal = Field(default=Decimal("0"), ge=0)
    final_discount_reason: str = ""
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
    final_discount: Decimal = Decimal("0")
    final_discount_reason: str = ""
    final_tax: Decimal = Decimal("0")
    final_total: Decimal = Decimal("0")
    ipr_required: bool
    attachments_required: bool
    summary: str
    status: enums.PlanStatus
    revision_notes: str
    shared_at: Optional[datetime]
    responded_at: Optional[datetime]


class PaymentOut(BaseModel):
    id: str
    kind: enums.PaymentKind
    kind_label: str = ""
    phase_number: int = 0
    amount: Decimal = Decimal("0")
    shipping_amount: Decimal = Decimal("0")
    total: Decimal = Decimal("0")
    status: enums.PaymentStatus
    status_label: str = ""
    reference: str = ""
    proof_file_id: Optional[str] = None
    rejected_reason: str = ""
    submitted_at: Optional[datetime] = None
    verified_at: Optional[datetime] = None
    # A upi:// intent the clinic's phone can open, with the payee and amount
    # already filled in. Empty when the lab has not configured a UPI ID.
    upi_link: str = ""
    label: str = ""


class PaymentProofIn(BaseModel):
    reference: str = ""
    note: str = ""


class PaymentVerifyIn(BaseModel):
    approve: bool
    reason: str = ""


class ChargeLine(BaseModel):
    """One line of the money breakdown shown against a case."""

    label: str
    amount: Decimal
    note: str = ""


class ShippingRateOut(ORMModel):
    city: str
    amount: Decimal
    is_active: bool = True
    # How many clinics this rate actually reaches. Zero means it matches
    # nothing — almost always a spelling that does not exist.
    clinics: int = 0


class DeliveryCityOut(BaseModel):
    """A city clinics are actually in, and what delivery there costs."""

    city: str
    clinics: int
    amount: Optional[Decimal] = None
    is_active: bool = True


class ShippingRateIn(BaseModel):
    city: str
    amount: Decimal = Field(default=Decimal("0"), ge=0)
    is_active: bool = True


class StaffUserIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    full_name: str = ""


class StaffUserPatch(BaseModel):
    full_name: Optional[str] = None
    is_active: Optional[bool] = None
    password: Optional[str] = Field(default=None, min_length=8)


class StaffUserOut(BaseModel):
    id: str
    email: str
    full_name: str = ""
    role: enums.UserRole
    is_active: bool = True


class AssignIn(BaseModel):
    """Null hands the case back to the lab office."""

    user_id: Optional[str] = None


class LeaveRequestIn(BaseModel):
    starts_at: datetime
    ends_at: datetime
    reason: str = ""


class LeaveDecisionIn(BaseModel):
    approve: bool
    note: str = ""


class LeaveOut(BaseModel):
    id: str
    technician_id: str
    technician_name: str = ""
    starts_at: datetime
    ends_at: datetime
    reason: str
    status: str
    status_label: str = ""
    decision_note: str = ""
    decided_at: Optional[datetime] = None
    # Visits that fall inside the window, so the lab sees the cost of approving
    # before it approves.
    affected_visits: int = 0


class LeaveDecisionOut(BaseModel):
    leave: LeaveOut
    # What happened to the visits the leave took away.
    covered: list = []
    stranded: list = []


class AttentionIn(BaseModel):
    action: enums.AttentionAction
    note: str = ""


class PhaseFitIssueIn(BaseModel):
    """An aligner inside a delivered phase that does not fit."""

    arch: enums.Arch
    aligner_number: int = Field(ge=1)
    notes: str = ""


class PhaseFitIssueResolveIn(BaseModel):
    resolution: enums.PhaseIssueAnswer
    comments: str = ""


class PhaseIssueReplyIn(BaseModel):
    message: str = Field(min_length=1)


class PhaseIssueMessageOut(BaseModel):
    id: str
    from_lab: bool
    body: str
    created_at: datetime


class PhaseFitIssueOut(ORMModel):
    id: str
    phase_number: int
    phase_round: int
    arch: str
    aligner_number: int
    notes: str
    photo_revision: int
    status: str
    resolution: Optional[str] = None
    lab_comments: str
    awaiting: str = "LAB"
    messages: list = []
    created_at: datetime
    resolved_at: Optional[datetime] = None


class PhaseOut(BaseModel):
    phase: int
    from_step: int
    to_step: int
    upper_from: Optional[int] = None
    upper_to: Optional[int] = None
    lower_from: Optional[int] = None
    lower_to: Optional[int] = None
    status: str = "NOT_STARTED"
    status_label: str = ""
    round: int = 1


class PhaseReviewIn(BaseModel):
    """The lab's verdict on a phase's progress photographs."""

    outcome: enums.PhaseReviewOutcome
    note: str = ""


class PlanRespondIn(BaseModel):
    approve: bool
    revision_notes: str = ""
    # Where this batch should go. A practice can have several clinics, so the
    # delivery address is confirmed at the point of dispatch rather than being
    # whatever was set when the case was opened.
    shipping_address_id: Optional[str] = None


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
    # Where this batch should go. A practice can have several clinics, so the
    # delivery address is confirmed at the point of dispatch rather than being
    # whatever was set when the case was opened.
    shipping_address_id: Optional[str] = None


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
    # Out-of-city visits take the technician's whole day.
    is_day_visit: bool = False
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
    # Set when approved leave took the technician away and nobody could cover.
    needs_attention: bool = False
    attention_reason: str = ""


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
    # Month view only: how many technicians still have room that day. Exact
    # times need travel lookups, so they are fetched per day on demand.
    technicians_free: int = 0


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
    # Payments
    upi_vpa: Optional[str] = Field(default=None, max_length=120)
    upi_payee_name: Optional[str] = Field(default=None, max_length=120)
    plan_fee: Optional[Decimal] = Field(default=None, ge=0)
    training_fit_fee: Optional[Decimal] = Field(default=None, ge=0)
    default_shipping_fee: Optional[Decimal] = Field(default=None, ge=0)

    slot_minutes: Optional[int] = Field(default=None, ge=15, le=240)
    visit_duration_minutes: Optional[int] = Field(default=None, ge=15, le=240)
    booking_granularity_minutes: Optional[int] = Field(default=None, ge=5, le=60)
    travel_buffer_minutes: Optional[int] = Field(default=None, ge=0, le=180)
    booking_horizon_days: Optional[int] = Field(default=None, ge=1, le=180)
    min_notice_hours: Optional[int] = Field(default=None, ge=0, le=336)
    max_daily_jobs: Optional[int] = Field(default=None, ge=1, le=20)
    max_travel_minutes: Optional[int] = Field(default=None, ge=5, le=240)
    travel_weight: Optional[float] = Field(default=None, ge=0, le=10)
    fairness_weight: Optional[float] = Field(default=None, ge=0, le=10)
    idle_weight: Optional[float] = Field(default=None, ge=0, le=10)
    fallback_speed_kmph: Optional[float] = Field(default=None, ge=5, le=120)
    service_radius_km: Optional[float] = Field(default=None, ge=5, le=500)
    day_visit_over_km: Optional[float] = Field(default=None, ge=0, le=500)
    working_hours: Optional[dict] = None
    service_city: Optional[str] = None
    timezone_name: Optional[str] = None
    lab_address: Optional[str] = None
    # Sent when the lab drops the pin itself. A placement beats a lookup, so
    # these win over geocoding the typed address.
    lab_latitude: Optional[float] = Field(default=None, ge=-90, le=90)
    lab_longitude: Optional[float] = Field(default=None, ge=-180, le=180)


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


class RouteStopOut(BaseModel):
    kind: str
    label: str
    address: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    arrives_at: Optional[datetime] = None
    departs_at: Optional[datetime] = None
    leg_minutes: float = 0.0
    leg_km: float = 0.0
    appointment_id: str = ""
    order_reference: str = ""
    patient_name: str = ""
    booked_for: Optional[datetime] = None
    late_by_minutes: float = 0.0


class DayRouteOut(BaseModel):
    technician_id: str
    technician_name: str
    date: date_type
    stops: list[RouteStopOut]
    total_km: float
    drive_minutes: float
    onsite_minutes: float
    warnings: list[str]
    at_risk: bool
    maps_url: str
    polyline: str = ""
    browser_map_key: str = ""


class ReassignRequestIn(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class ResolveReassignmentIn(BaseModel):
    # TECHNICIAN hands it to a named person, ANY re-runs the assignment engine,
    # DECLINE leaves the visit where it is.
    action: Literal["TECHNICIAN", "ANY", "DECLINE"]
    technician_id: Optional[str] = None
    note: str = ""
    force: bool = False


class ReassignmentOut(BaseModel):
    id: str
    status: str
    reason: str
    resolution: str
    created_at: datetime
    resolved_at: Optional[datetime] = None
    requested_by: str
    appointment_id: str
    order_reference: str
    patient_name: str
    clinic_name: str
    starts_at: datetime
    current_technician: str


class StageModelOut(BaseModel):
    file_id: str
    filename: str
    arch: str
    step: int
    kind: str = ""
    size_bytes: int = 0


class StageOut(BaseModel):
    step: int
    upper: Optional[StageModelOut] = None
    lower: Optional[StageModelOut] = None
    is_passive: bool = False


class ArticulationOut(BaseModel):
    """Where each staged arch sits in the bite the scanner recorded. Both are
    4x4 rigid transforms, row-major, in millimetres."""

    upper: list
    lower: list
    method: str
    rms_upper: float
    rms_lower: float
    bite_median_mm: Optional[float] = None
    bite_touching_upper: Optional[float] = None
    notes: list = []


class SimulationOut(BaseModel):
    order_reference: str
    patient_name: str
    stages: list[StageOut]
    total_aligners: int = 0
    # None when the scans cannot place the arches; the viewer then shows a
    # nominal bite and says so rather than implying a measured one.
    articulation: Optional[ArticulationOut] = None
    # Why there is no articulation, when there is none.
    articulation_note: str = ""


class BookingSettingsOut(ORMModel):
    lab_latitude: Optional[float] = None
    lab_longitude: Optional[float] = None
    # How the lab's point was arrived at, so a coarse one is visible as coarse.
    lab_geocode_source: str = ""
    upi_vpa: str = ""
    upi_payee_name: str = ""
    plan_fee: Decimal = Decimal("0")
    training_fit_fee: Decimal = Decimal("0")
    default_shipping_fee: Decimal = Decimal("0")
    slot_minutes: int
    visit_duration_minutes: int
    booking_granularity_minutes: int
    travel_buffer_minutes: int
    booking_horizon_days: int
    min_notice_hours: int
    max_daily_jobs: int
    max_travel_minutes: int
    travel_weight: float
    fairness_weight: float
    idle_weight: float
    fallback_speed_kmph: float
    service_radius_km: float
    day_visit_over_km: float
    working_hours: dict
    service_city: str
    timezone_name: str
    lab_address: str


class PhaseSpan(BaseModel):
    """One phase of a phased dispatch, in treatment steps and per-arch aligners."""

    phase: int
    from_step: int
    to_step: int
    upper_from: Optional[int] = None
    upper_to: Optional[int] = None
    lower_from: Optional[int] = None
    lower_to: Optional[int] = None


class FitReviewIn(BaseModel):
    fits: bool
    dispatch_mode: Optional[enums.DispatchMode] = None
    # How many phases to split the remaining aligners into. Required when the
    # clinic chooses a phased dispatch.
    phase_count: Optional[int] = Field(default=None, ge=1)
    issue_notes: str = ""
    # Where this batch should go. A practice can have several clinics, so the
    # delivery address is confirmed at the point of dispatch rather than being
    # whatever was set when the case was opened.
    shipping_address_id: Optional[str] = None


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
    # Aligner case or product order. Boards list them apart.
    kind: enums.OrderKind = enums.OrderKind.ALIGNER
    # What was ordered, already spelled out: "Essix Retainer · 0.8 mm · x3".
    product_label: str = ""
    status: enums.OrderStatus
    status_label: str
    # The Align band, so a list can be read without opening every case.
    category: Optional[str] = None
    category_label: str = ""
    category_confirmed: bool = False
    # Who is planning it. Lab-side only — the clinic deals with 3D Align, not
    # with which of its people is holding the file.
    assigned_to_id: Optional[str] = None
    assigned_to_name: str = ""
    # How far through its phases a case in delivery has got, so a board can
    # show progress rather than only which stage a case is sitting in.
    phases_done: int = 0
    phases_total: int = 0
    patient_name: str
    doctor_name: str
    clinic_name: str
    arch: enums.Arch
    priority: enums.Priority
    needs_doctor_action: bool
    created_at: datetime
    updated_at: datetime


class OrderDetail(OrderSummary):
    # So a repeat order for the same patient can be raised, and the scans they
    # have already given offered back instead of asked for again.
    patient_id: str = ""
    # Whether the lab has uploaded staged models to view in 3D.
    has_simulation: bool = False
    # The ref the case carried before it reached planning. Kept visible so a
    # doctor quoting the old number can still be matched to the case.
    enquiry_number: str
    dispatch_mode: Optional[enums.DispatchMode]
    phase_count: Optional[int] = None
    # Non-zero once the case has been through a mid-course rescan.
    refinement_round: int = 0
    # Which progress views are still missing for the phase just received.
    progress_missing: list = []
    progress_round: int = 1
    # Every charge on the case, and the breakdown behind them.
    payments: list = []
    charges: list = []
    plan_locked: bool = False
    # Every fit issue raised inside a phase, newest last, and the one still open.
    phase_issues: list = []
    open_phase_issue: Optional[str] = None
    phases_divided: bool = False
    # Steps the treatment runs (the longer arch), the most phases it can be
    # split into, and what each phase would carry once that is chosen.
    aligner_steps: int = 0
    max_phases: int = 0
    phase_plan: list = []
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
