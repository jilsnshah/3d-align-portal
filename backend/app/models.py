"""SQLAlchemy models.

Enums are stored as VARCHAR with a CHECK constraint (native_enum=False) so the
same schema runs on both SQLite (local dev) and Postgres (deployed).
"""

from __future__ import annotations

from typing import Optional

import uuid
from datetime import date as date_type, datetime, time as time_type, timezone
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    Time,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from . import enums
from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _enum(python_enum, name: str):
    return SAEnum(python_enum, name=name, native_enum=False, length=40, validate_strings=True)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


# --------------------------------------------------------------------------
# Identity
# --------------------------------------------------------------------------


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[enums.UserRole] = mapped_column(_enum(enums.UserRole, "user_role"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    doctor: Mapped[Optional[Doctor]] = relationship(
        back_populates="user", uselist=False, foreign_keys="Doctor.user_id"
    )


class Doctor(Base, TimestampMixin):
    __tablename__ = "doctors"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), unique=True)

    full_name: Mapped[str] = mapped_column(String(200))
    phone: Mapped[str] = mapped_column(String(40), default="")
    clinic_name: Mapped[str] = mapped_column(String(200), default="")
    dental_council: Mapped[str] = mapped_column(String(120), default="")
    registration_number: Mapped[str] = mapped_column(String(60), default="")

    verification_status: Mapped[enums.VerificationStatus] = mapped_column(
        _enum(enums.VerificationStatus, "verification_status"),
        default=enums.VerificationStatus.PENDING,
    )
    registry_check_result: Mapped[Optional[dict]] = mapped_column(JSON)
    verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    verified_by_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id"))
    rejection_reason: Mapped[str] = mapped_column(Text, default="")

    user: Mapped[User] = relationship(back_populates="doctor", foreign_keys=[user_id])
    addresses: Mapped[list[Address]] = relationship(
        back_populates="doctor", cascade="all, delete-orphan"
    )
    patients: Mapped[list[Patient]] = relationship(
        back_populates="doctor", cascade="all, delete-orphan"
    )


class Address(Base, TimestampMixin):
    __tablename__ = "addresses"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    doctor_id: Mapped[str] = mapped_column(ForeignKey("doctors.id"))

    label: Mapped[str] = mapped_column(String(80), default="Clinic")
    line1: Mapped[str] = mapped_column(String(255))
    line2: Mapped[str] = mapped_column(String(255), default="")
    city: Mapped[str] = mapped_column(String(120))
    state: Mapped[str] = mapped_column(String(120))
    pincode: Mapped[str] = mapped_column(String(20))
    country: Mapped[str] = mapped_column(String(80), default="India")
    is_default_shipping: Mapped[bool] = mapped_column(Boolean, default=False)

    doctor: Mapped[Doctor] = relationship(back_populates="addresses")


class Patient(Base, TimestampMixin):
    __tablename__ = "patients"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    doctor_id: Mapped[str] = mapped_column(ForeignKey("doctors.id"))

    full_name: Mapped[str] = mapped_column(String(200))
    date_of_birth: Mapped[str] = mapped_column(String(20), default="")
    sex: Mapped[str] = mapped_column(String(20), default="")
    external_ref: Mapped[str] = mapped_column(String(80), default="")

    doctor: Mapped[Doctor] = relationship(back_populates="patients")
    orders: Mapped[list[Order]] = relationship(back_populates="patient")


# --------------------------------------------------------------------------
# The order
# --------------------------------------------------------------------------


class Order(Base, TimestampMixin):
    __tablename__ = "orders"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    order_number: Mapped[str] = mapped_column(String(30), unique=True, index=True)

    doctor_id: Mapped[str] = mapped_column(ForeignKey("doctors.id"), index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"))
    parent_order_id: Mapped[Optional[str]] = mapped_column(ForeignKey("orders.id"))

    status: Mapped[enums.OrderStatus] = mapped_column(
        _enum(enums.OrderStatus, "order_status"), default=enums.OrderStatus.DRAFT, index=True
    )
    arch: Mapped[enums.Arch] = mapped_column(_enum(enums.Arch, "arch"), default=enums.Arch.BOTH)
    priority: Mapped[enums.Priority] = mapped_column(
        _enum(enums.Priority, "priority"), default=enums.Priority.STANDARD
    )
    dispatch_mode: Mapped[Optional[enums.DispatchMode]] = mapped_column(
        _enum(enums.DispatchMode, "dispatch_mode")
    )
    scan_route: Mapped[Optional[enums.ScanRoute]] = mapped_column(_enum(enums.ScanRoute, "scan_route"))
    scan_courier_tracking: Mapped[str] = mapped_column(String(120), default="")

    chief_complaint: Mapped[str] = mapped_column(Text, default="")
    clinical_notes: Mapped[str] = mapped_column(Text, default="")
    records_request_note: Mapped[str] = mapped_column(Text, default="")
    cancel_reason: Mapped[str] = mapped_column(Text, default="")

    shipping_address_id: Mapped[Optional[str]] = mapped_column(ForeignKey("addresses.id"))
    storage_folder_ref: Mapped[str] = mapped_column(String(255), default="")

    # Bumped whenever the lab asks for that set again, so replacements are
    # distinguishable from the originals rather than piling up unlabelled.
    records_revision: Mapped[int] = mapped_column(Integer, default=1)
    scan_revision: Mapped[int] = mapped_column(Integer, default=1)
    planning_revision: Mapped[int] = mapped_column(Integer, default=1)
    fit_round: Mapped[int] = mapped_column(Integer, default=1)

    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    approved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    doctor: Mapped[Doctor] = relationship()
    patient: Mapped[Patient] = relationship(back_populates="orders")
    shipping_address: Mapped[Optional[Address]] = relationship()
    files: Mapped[list[OrderFile]] = relationship(
        back_populates="order", cascade="all, delete-orphan"
    )
    quotes: Mapped[list[Quote]] = relationship(
        back_populates="order", cascade="all, delete-orphan", order_by="Quote.version"
    )
    plans: Mapped[list[TreatmentPlan]] = relationship(
        back_populates="order", cascade="all, delete-orphan", order_by="TreatmentPlan.version"
    )
    shipments: Mapped[list[Shipment]] = relationship(
        back_populates="order", cascade="all, delete-orphan", order_by="Shipment.created_at"
    )
    events: Mapped[list[StatusEvent]] = relationship(
        back_populates="order", cascade="all, delete-orphan", order_by="StatusEvent.created_at"
    )
    fit_reviews: Mapped[list[FitReview]] = relationship(
        back_populates="order", cascade="all, delete-orphan"
    )
    appointments: Mapped[list[Appointment]] = relationship(
        back_populates="order", cascade="all, delete-orphan", order_by="Appointment.starts_at"
    )
    invoice: Mapped[Optional[Invoice]] = relationship(
        back_populates="order", uselist=False, cascade="all, delete-orphan"
    )

    @property
    def appointment(self) -> Optional["Appointment"]:
        """The booking that currently matters — the live one, else the latest."""
        live = [a for a in self.appointments if a.is_live]
        if live:
            return live[-1]
        return self.appointments[-1] if self.appointments else None

    def revision_for(self, group: "enums.FileGroup") -> int:
        return {
            enums.FileGroup.RECORDS: self.records_revision,
            enums.FileGroup.SCAN: self.scan_revision,
            enums.FileGroup.PLANNING: self.planning_revision,
            enums.FileGroup.FIT: self.fit_round,
        }[group]

    def bump_revision(self, group: "enums.FileGroup") -> int:
        if group == enums.FileGroup.RECORDS:
            self.records_revision += 1
        elif group == enums.FileGroup.SCAN:
            self.scan_revision += 1
        elif group == enums.FileGroup.PLANNING:
            self.planning_revision += 1
        else:
            self.fit_round += 1
        return self.revision_for(group)

    def filled_slots(self, category: str) -> set:
        """Slots filled at the current revision, ignoring anything in the bin."""
        revision = self.revision_for(enums.FILE_GROUP[category])
        return {
            f.slot
            for f in self.files
            if f.category == category and not f.is_deleted and f.revision == revision and f.slot
        }

    def missing_slots(self, category: str) -> list:
        filled = self.filled_slots(category)
        return [s for s in enums.required_slots(category) if s not in filled]

    @property
    def has_intraoral_scan(self) -> bool:
        """A scan is a set, not a file. The case cannot leave AWAITING_SCAN until
        the upper arch, lower arch and bite are all present at the current
        revision — a lone upper arch is not something anyone can plan from."""
        return not self.missing_slots(enums.FileCategory.INTRAORAL_SCAN)

    @property
    def has_photo_series(self) -> bool:
        return not self.missing_slots(enums.FileCategory.RECORD_PHOTO)

    @property
    def submit_blockers(self) -> list:
        """Everything still standing between this draft and the lab. Checked at
        slot level: a single photograph is not a records set, and the lab cannot
        quote from one view."""
        blockers = []
        for category in enums.REQUIRED_SUBMIT_CATEGORIES:
            spec = enums.slots_for(category)
            if spec:
                missing = self.missing_slots(category)
                if missing:
                    views = ", ".join(enums.SLOT_LABELS[m] for m in missing)
                    blockers.append(f"{enums.CATEGORY_TITLES[category]}: {views}")
            else:
                revision = self.revision_for(enums.FILE_GROUP[category])
                present = any(
                    f.category == category and not f.is_deleted and f.revision == revision
                    for f in self.files
                )
                if not present:
                    blockers.append(enums.CATEGORY_TITLES[category])
        return blockers

    @property
    def aligner_phases(self) -> list:
        """Phase shipments in the order they went out. SQLite hands back naive
        datetimes while a row created this session is aware, so normalise before
        sorting."""

        def when(shipment):
            value = shipment.created_at
            if value is None:
                return datetime.max.replace(tzinfo=timezone.utc)
            return value if value.tzinfo else value.replace(tzinfo=timezone.utc)

        return sorted(
            (s for s in self.shipments if s.shipment_type == enums.ShipmentType.ALIGNER_PHASE),
            key=when,
        )

    @property
    def last_phase(self):
        phases = self.aligner_phases
        return phases[-1] if phases else None

    @property
    def next_phase_range(self) -> tuple:
        """Where the next phase starts, and the furthest it may run to.

        Phase one begins at aligner 1; every later phase begins where the last
        accepted one ended, so the lab never picks a start. A remake repeats the
        same span rather than advancing.
        """
        total = self.total_aligners
        last = self.last_phase
        if last is None:
            return 1, total
        if last.phase_decision == enums.PhaseDecision.REPEAT:
            return (last.aligner_range_from or 1), (last.aligner_range_to or total)
        return (last.aligner_range_to or 0) + 1, total

    @property
    def next_phase_label(self) -> tuple:
        """(phase number, round) for the batch the lab would ship next."""
        last = self.last_phase
        if last is None:
            return 1, 1
        if last.phase_decision == enums.PhaseDecision.REPEAT:
            return (last.phase_number or 1), (last.phase_round or 1) + 1
        return (last.phase_number or 0) + 1, 1

    @property
    def phase_blocker(self) -> Optional[str]:
        """Why the next phase cannot ship yet, or None when it can."""
        if self.dispatch_mode != enums.DispatchMode.PHASED:
            return None
        last = self.last_phase
        if last is None:
            return None
        if last.status != enums.ShipmentStatus.DELIVERED:
            return f"Phase {last.phase_number} has not been received by the clinic yet."
        if last.phase_decision is None:
            return (
                f"The clinic has not said whether to continue after phase {last.phase_number}."
            )
        start, _ = self.next_phase_range
        if self.total_aligners and start > self.total_aligners:
            return "Every aligner in the plan has already been dispatched."
        return None

    @property
    def total_aligners(self) -> int:
        plan = self.approved_plan or self.current_plan
        return (plan.aligners_upper + plan.aligners_lower) if plan else 0

    @property
    def approved_plan(self) -> Optional["TreatmentPlan"]:
        return next(
            (p for p in self.plans if p.status == enums.PlanStatus.APPROVED), None
        )

    @property
    def billable(self):
        """What the case is actually invoiced at: the treatment plan's confirmed
        price once it exists, falling back to the accepted expected quote."""
        plan = self.approved_plan
        if plan is not None and plan.final_total:
            return plan
        return self.accepted_quote

    @property
    def accepted_quote(self) -> Optional[Quote]:
        return next((q for q in self.quotes if q.status == enums.QuoteStatus.ACCEPTED), None)

    @property
    def current_quote(self) -> Optional[Quote]:
        active = [q for q in self.quotes if q.status != enums.QuoteStatus.SUPERSEDED]
        return active[-1] if active else None

    @property
    def current_plan(self) -> Optional[TreatmentPlan]:
        active = [p for p in self.plans if p.status != enums.PlanStatus.SUPERSEDED]
        return active[-1] if active else None


class OrderFile(Base, TimestampMixin):
    __tablename__ = "order_files"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)

    category: Mapped[enums.FileCategory] = mapped_column(_enum(enums.FileCategory, "file_category"))
    filename: Mapped[str] = mapped_column(String(255))
    mime_type: Mapped[str] = mapped_column(String(160), default="application/octet-stream")
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)

    revision: Mapped[int] = mapped_column(Integer, default=1)
    # Which view within its set — upper arch, buccal right, and so on.
    slot: Mapped[str] = mapped_column(String(40), default="")

    storage_ref: Mapped[str] = mapped_column(String(512))
    external_link: Mapped[str] = mapped_column(String(512), default="")

    uploaded_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"))

    # Recycle bin. A deleted file keeps its bytes until it is purged, so a
    # clinic that deletes the wrong thing can get it back.
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    deleted_by_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id"))

    order: Mapped[Order] = relationship(back_populates="files")
    uploaded_by: Mapped[User] = relationship(foreign_keys=[uploaded_by_id])
    deleted_by: Mapped[Optional[User]] = relationship(foreign_keys=[deleted_by_id])

    @property
    def is_image(self) -> bool:
        return self.mime_type.startswith("image/")


class StatusEvent(Base):
    __tablename__ = "status_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)

    from_status: Mapped[Optional[enums.OrderStatus]] = mapped_column(
        _enum(enums.OrderStatus, "order_status")
    )
    to_status: Mapped[enums.OrderStatus] = mapped_column(_enum(enums.OrderStatus, "order_status"))
    actor_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id"))
    note: Mapped[str] = mapped_column(Text, default="")
    event_metadata: Mapped[Optional[dict]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    order: Mapped[Order] = relationship(back_populates="events")
    actor: Mapped[Optional[User]] = relationship()


# --------------------------------------------------------------------------
# Commercial and clinical
# --------------------------------------------------------------------------


class Quote(Base, TimestampMixin):
    __tablename__ = "quotes"
    __table_args__ = (UniqueConstraint("order_id", "version", name="uq_quote_order_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)

    # The expected quote is a band picked from the photographs, not a count, and
    # it carries the band's range. Once the plan lands, both ends collapse to
    # the one real figure.
    category: Mapped[Optional[str]] = mapped_column(String(40))
    category_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    category_price_max: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))

    subtotal: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    subtotal_max: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    tax: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    # total is the low end of the range, total_max the high end. When the price
    # is final the two are equal, so display code never needs a special case.
    total: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    total_max: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    currency: Mapped[str] = mapped_column(String(8), default="INR")
    notes: Mapped[str] = mapped_column(Text, default="")

    status: Mapped[enums.QuoteStatus] = mapped_column(
        _enum(enums.QuoteStatus, "quote_status"), default=enums.QuoteStatus.SENT
    )
    # Set once the treatment plan supplies the real price, which overwrites the
    # estimate in place — the band was only ever a placeholder.
    is_final: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    responded_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    order: Mapped[Order] = relationship(back_populates="quotes")
    line_items: Mapped[list[QuoteLineItem]] = relationship(
        back_populates="quote", cascade="all, delete-orphan"
    )


class QuoteLineItem(Base):
    __tablename__ = "quote_line_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    quote_id: Mapped[str] = mapped_column(ForeignKey("quotes.id"), index=True)

    description: Mapped[str] = mapped_column(String(255))
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))

    quote: Mapped[Quote] = relationship(back_populates="line_items")


class TreatmentPlan(Base, TimestampMixin):
    __tablename__ = "treatment_plans"
    __table_args__ = (UniqueConstraint("order_id", "version", name="uq_plan_order_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)

    aligners_upper: Mapped[int] = mapped_column(Integer, default=0)
    aligners_lower: Mapped[int] = mapped_column(Integer, default=0)

    # Confirmed once the plan gives an exact count. This, not the expected
    # quote, is what the case is finally invoiced at.
    final_category: Mapped[Optional[str]] = mapped_column(String(40))
    final_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    final_tax: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    final_total: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))

    ipr_required: Mapped[bool] = mapped_column(Boolean, default=False)
    attachments_required: Mapped[bool] = mapped_column(Boolean, default=False)
    summary: Mapped[str] = mapped_column(Text, default="")

    status: Mapped[enums.PlanStatus] = mapped_column(
        _enum(enums.PlanStatus, "plan_status"), default=enums.PlanStatus.SHARED
    )
    revision_notes: Mapped[str] = mapped_column(Text, default="")
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    shared_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    responded_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    order: Mapped[Order] = relationship(back_populates="plans")


class Technician(Base, TimestampMixin):
    """A scan technician who travels to clinics. Lab staff, so they share the
    case tools with admin — what they do not get is the admin furniture."""

    __tablename__ = "technicians"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), unique=True)

    full_name: Mapped[str] = mapped_column(String(200))
    phone: Mapped[str] = mapped_column(String(40), default="")
    employee_code: Mapped[str] = mapped_column(String(40), default="")
    max_daily_jobs: Mapped[int] = mapped_column(Integer, default=4)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    user: Mapped[User] = relationship()
    availability: Mapped[list[AvailabilityRule]] = relationship(
        back_populates="technician", cascade="all, delete-orphan"
    )
    time_off: Mapped[list[TimeOff]] = relationship(
        back_populates="technician", cascade="all, delete-orphan"
    )
    appointments: Mapped[list[Appointment]] = relationship(back_populates="technician")


class AvailabilityRule(Base):
    """Recurring weekly working window. Several rows per technician per day is
    fine — a lunch break is simply two rows."""

    __tablename__ = "availability_rules"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    technician_id: Mapped[str] = mapped_column(ForeignKey("technicians.id"), index=True)

    weekday: Mapped[int] = mapped_column(Integer)  # 0 = Monday
    start_time: Mapped[time_type] = mapped_column(Time)
    end_time: Mapped[time_type] = mapped_column(Time)

    technician: Mapped[Technician] = relationship(back_populates="availability")


class TimeOff(Base):
    __tablename__ = "time_off"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    technician_id: Mapped[str] = mapped_column(ForeignKey("technicians.id"), index=True)

    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    reason: Mapped[str] = mapped_column(String(200), default="")

    technician: Mapped[Technician] = relationship(back_populates="time_off")


class BookingSettings(Base, TimestampMixin):
    """Single row. Every scheduling knob, editable from the admin panel rather
    than baked into the environment."""

    __tablename__ = "booking_settings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)

    slot_minutes: Mapped[int] = mapped_column(Integer, default=60)
    travel_buffer_minutes: Mapped[int] = mapped_column(Integer, default=30)
    booking_horizon_days: Mapped[int] = mapped_column(Integer, default=30)
    min_notice_hours: Mapped[int] = mapped_column(Integer, default=24)
    max_daily_jobs: Mapped[int] = mapped_column(Integer, default=4)

    # {"0": ["09:00", "18:00"], ..., "6": null}  — null means closed.
    working_hours: Mapped[dict] = mapped_column(JSON, default=dict)
    service_city: Mapped[str] = mapped_column(String(120), default="Ahmedabad")


class AlignerPrice(Base, TimestampMixin):
    """One row per aligner category. Kept in the database rather than the code
    so the lab can reprice without a deploy."""

    __tablename__ = "aligner_prices"

    category: Mapped[str] = mapped_column(String(40), primary_key=True)
    # A band quotes a range; the exact figure comes from the treatment plan.
    price_min: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    price_max: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Appointment(Base, TimestampMixin):
    __tablename__ = "appointments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    # Not unique: a cancelled booking can be replaced by a new one.
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    technician_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("technicians.id"), index=True
    )

    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    status: Mapped[enums.AppointmentStatus] = mapped_column(
        _enum(enums.AppointmentStatus, "appointment_status"),
        default=enums.AppointmentStatus.ASSIGNED,
    )

    address_id: Mapped[Optional[str]] = mapped_column(ForeignKey("addresses.id"))
    contact_name: Mapped[str] = mapped_column(String(200), default="")
    contact_phone: Mapped[str] = mapped_column(String(40), default="")
    access_notes: Mapped[str] = mapped_column(Text, default="")
    assignment_reason: Mapped[str] = mapped_column(String(255), default="")

    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    cancel_reason: Mapped[str] = mapped_column(Text, default="")
    outcome_notes: Mapped[str] = mapped_column(Text, default="")

    order: Mapped[Order] = relationship(back_populates="appointments")
    technician: Mapped[Optional[Technician]] = relationship(back_populates="appointments")
    address: Mapped[Optional[Address]] = relationship()

    @property
    def is_live(self) -> bool:
        return self.status in enums.LIVE_APPOINTMENT_STATUSES


class Shipment(Base, TimestampMixin):
    __tablename__ = "shipments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)

    shipment_type: Mapped[enums.ShipmentType] = mapped_column(
        _enum(enums.ShipmentType, "shipment_type")
    )
    # Which training-aligner attempt this belongs to. A fit issue produces a
    # second training aligner, and the two must not read as duplicates.
    fit_round: Mapped[Optional[int]] = mapped_column(Integer)
    phase_number: Mapped[Optional[int]] = mapped_column(Integer)
    # A remade phase keeps its number and advances its round, so "phase 3
    # round 2" is distinguishable from the batch that did not work.
    phase_round: Mapped[Optional[int]] = mapped_column(Integer)
    aligner_range_from: Mapped[Optional[int]] = mapped_column(Integer)
    aligner_range_to: Mapped[Optional[int]] = mapped_column(Integer)

    carrier: Mapped[str] = mapped_column(String(120), default="")
    tracking_number: Mapped[str] = mapped_column(String(120), default="")
    tracking_url: Mapped[str] = mapped_column(String(512), default="")

    status: Mapped[enums.ShipmentStatus] = mapped_column(
        _enum(enums.ShipmentStatus, "shipment_status"), default=enums.ShipmentStatus.SHIPPED
    )
    # After receiving a phase the clinic says whether to carry on or remake it.
    # Until that is answered, the next phase cannot ship.
    phase_decision: Mapped[Optional[str]] = mapped_column(String(20))
    decision_notes: Mapped[str] = mapped_column(Text, default="")

    shipped_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    delivered_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    order: Mapped[Order] = relationship(back_populates="shipments")


class FitReview(Base):
    __tablename__ = "fit_reviews"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    shipment_id: Mapped[Optional[str]] = mapped_column(ForeignKey("shipments.id"))

    fit_round: Mapped[int] = mapped_column(Integer, default=1)
    outcome: Mapped[enums.FitOutcome] = mapped_column(_enum(enums.FitOutcome, "fit_outcome"))
    issue_notes: Mapped[str] = mapped_column(Text, default="")
    reported_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    order: Mapped[Order] = relationship(back_populates="fit_reviews")


class Invoice(Base, TimestampMixin):
    __tablename__ = "invoices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), unique=True)

    invoice_number: Mapped[str] = mapped_column(String(60))
    provider_invoice_id: Mapped[str] = mapped_column(String(120), default="")
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    currency: Mapped[str] = mapped_column(String(8), default="INR")
    pdf_url: Mapped[str] = mapped_column(String(512), default="")
    share_url: Mapped[str] = mapped_column(String(512), default="")

    status: Mapped[enums.InvoiceStatus] = mapped_column(
        _enum(enums.InvoiceStatus, "invoice_status"), default=enums.InvoiceStatus.ISSUED
    )
    issued_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    paid_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    order: Mapped[Order] = relationship(back_populates="invoice")


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    order_id: Mapped[Optional[str]] = mapped_column(ForeignKey("orders.id"))

    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    read_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    order: Mapped[Optional[Order]] = relationship()


class Counter(Base):
    """Backs human-readable order numbers (AL-2026-0001)."""

    __tablename__ = "counters"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[int] = mapped_column(Integer, default=0)
