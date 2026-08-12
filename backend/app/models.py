"""SQLAlchemy models.

Enums are stored as VARCHAR with a CHECK constraint (native_enum=False) so the
same schema runs on both SQLite (local dev) and Postgres (deployed).
"""

from __future__ import annotations

from typing import Optional

import uuid
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
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
    appointment: Mapped[Optional[ScanAppointment]] = relationship(
        back_populates="order", uselist=False, cascade="all, delete-orphan"
    )
    invoice: Mapped[Optional[Invoice]] = relationship(
        back_populates="order", uselist=False, cascade="all, delete-orphan"
    )

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

    @property
    def has_intraoral_scan(self) -> bool:
        """A case cannot leave AWAITING_SCAN without one. Whatever route the scan
        took — uploaded by the clinic, taken at an appointment, or digitised from
        a couriered impression — it ends up as an STL on the order."""
        return any(
            f.category == enums.FileCategory.INTRAORAL_SCAN
            and not f.is_deleted
            and f.revision == self.scan_revision
            for f in self.files
        )

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

    storage_ref: Mapped[str] = mapped_column(String(512))
    external_link: Mapped[str] = mapped_column(String(512), default="")

    uploaded_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)

    order: Mapped[Order] = relationship(back_populates="files")
    uploaded_by: Mapped[User] = relationship()


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

    estimated_aligners_upper: Mapped[int] = mapped_column(Integer, default=0)
    estimated_aligners_lower: Mapped[int] = mapped_column(Integer, default=0)

    subtotal: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    tax: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    total: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    currency: Mapped[str] = mapped_column(String(8), default="INR")
    notes: Mapped[str] = mapped_column(Text, default="")

    status: Mapped[enums.QuoteStatus] = mapped_column(
        _enum(enums.QuoteStatus, "quote_status"), default=enums.QuoteStatus.SENT
    )
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


class ScanAppointment(Base, TimestampMixin):
    __tablename__ = "scan_appointments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), unique=True)

    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    location: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[enums.AppointmentStatus] = mapped_column(
        _enum(enums.AppointmentStatus, "appointment_status"), default=enums.AppointmentStatus.BOOKED
    )
    notes: Mapped[str] = mapped_column(Text, default="")

    order: Mapped[Order] = relationship(back_populates="appointment")


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
    aligner_range_from: Mapped[Optional[int]] = mapped_column(Integer)
    aligner_range_to: Mapped[Optional[int]] = mapped_column(Integer)

    carrier: Mapped[str] = mapped_column(String(120), default="")
    tracking_number: Mapped[str] = mapped_column(String(120), default="")
    tracking_url: Mapped[str] = mapped_column(String(512), default="")

    status: Mapped[enums.ShipmentStatus] = mapped_column(
        _enum(enums.ShipmentStatus, "shipment_status"), default=enums.ShipmentStatus.SHIPPED
    )
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
