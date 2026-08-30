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
    TypeDecorator,
    JSON,
    Boolean,
    Date,
    DateTime,
    Enum as SAEnum,
    Float,
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


class UTCDateTime(TypeDecorator):
    """Timestamps that keep their zone.

    SQLite stores no offset, so a naive value read back is ambiguous — and
    serialised without one it reaches the browser as ``2026-08-24T04:58:26``,
    which JavaScript reads as *local* time. Everything is stored as UTC and
    handed back tz-aware, so the API always says which instant it means.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)



class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow, onupdate=utcnow
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
    # Lab-side accounts carry their own name. A doctor's lives on their Doctor
    # record and a technician's on theirs, so this is only filled for the
    # office: the admin and the orthodontists who plan for them.
    full_name: Mapped[str] = mapped_column(String(200), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Bumped when someone signs out, which invalidates every token issued
    # before it. A signed cookie is otherwise valid until it expires, and now
    # that sessions last two months, "sign out" has to mean something on a
    # shared clinic machine rather than only clearing the local cookie.
    session_epoch: Mapped[int] = mapped_column(Integer, default=0)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())

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
    verified_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
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

    # Where this clinic actually is. Scheduling needs it to work out travel time
    # between visits; None means the address was never resolved, and scheduling
    # falls back to a flat buffer for it.
    latitude: Mapped[Optional[float]] = mapped_column(Float)
    longitude: Mapped[Optional[float]] = mapped_column(Float)
    geocode_source: Mapped[str] = mapped_column(String(20), default="")
    geocoded_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())

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
    # Every case gets an enquiry ref the moment it is created. The AL number is
    # the lab's production series and is only spent once a case actually reaches
    # planning, so quotes that are never accepted do not consume one.
    enquiry_number: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    order_number: Mapped[Optional[str]] = mapped_column(String(30), unique=True, index=True)

    doctor_id: Mapped[str] = mapped_column(ForeignKey("doctors.id"), index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"))
    parent_order_id: Mapped[Optional[str]] = mapped_column(ForeignKey("orders.id"))

    # What the lab is making. Everything that differs between an aligner case
    # and a product order branches off this one field.
    kind: Mapped[enums.OrderKind] = mapped_column(
        _enum(enums.OrderKind, "order_kind"), default=enums.OrderKind.ALIGNER, index=True
    )
    # Only set on a product order.
    product_id: Mapped[Optional[str]] = mapped_column(ForeignKey("products.id"))
    product_size_id: Mapped[Optional[str]] = mapped_column(ForeignKey("product_sizes.id"))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    # Set when the clinic chose an existing scan rather than giving a new one.
    # The files are attached to this order too, so nothing here is load-bearing
    # for reading them — it records where they came from.
    scan_reused_from_id: Mapped[Optional[str]] = mapped_column(ForeignKey("orders.id"))
    scan_received_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    # Teeth beyond the number the base price covers, charged per tooth. The old
    # system announced this surcharge to the clinic and then never asked for the
    # count, so every multi-pontic retainer was billed short.
    extra_teeth: Mapped[int] = mapped_column(Integer, default=0)

    status: Mapped[enums.OrderStatus] = mapped_column(
        _enum(enums.OrderStatus, "order_status"), default=enums.OrderStatus.DRAFT, index=True
    )
    arch: Mapped[enums.Arch] = mapped_column(_enum(enums.Arch, "arch"), default=enums.Arch.BOTH)
    priority: Mapped[enums.Priority] = mapped_column(
        _enum(enums.Priority, "priority"), default=enums.Priority.STANDARD
    )
    # How many phases the clinic asked the remaining aligners to be split into.
    # Only meaningful when dispatch_mode is PHASED.
    phase_count: Mapped[Optional[int]] = mapped_column(Integer)
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
    # Which phase's progress photographs are being collected, so each phase
    # keeps its own set instead of overwriting the last.
    progress_round: Mapped[int] = mapped_column(Integer, default=1)
    # How many times this case has been sent back for a scan without the plan
    # being reopened — a training aligner that did not fit, or a phase that was
    # not tracking. Non-zero means a scan arriving now is a refinement: it
    # feeds a new training aligner, it does not restart treatment planning.
    refinement_round: Mapped[int] = mapped_column(Integer, default=0)
    # One photograph set per fit issue raised inside a phase.
    phase_fit_round: Mapped[int] = mapped_column(Integer, default=1)

    # Which orthodontist is planning this case. Null means it sits with the
    # lab office, which is where every case starts and where anything nobody
    # has picked up stays.
    assigned_to_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id"), index=True)

    submitted_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    approved_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    completed_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())

    doctor: Mapped[Doctor] = relationship()
    patient: Mapped[Patient] = relationship(back_populates="orders")
    product: Mapped[Optional[Product]] = relationship(foreign_keys=[product_id])
    product_size: Mapped[Optional[ProductSize]] = relationship(foreign_keys=[product_size_id])
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
    assigned_to: Mapped[Optional["User"]] = relationship(foreign_keys=[assigned_to_id])
    phases: Mapped[list["OrderPhase"]] = relationship(
        back_populates="order",
        cascade="all, delete-orphan",
        order_by="OrderPhase.phase_number",
    )
    phase_issues: Mapped[list["PhaseFitIssue"]] = relationship(
        back_populates="order",
        cascade="all, delete-orphan",
        order_by="PhaseFitIssue.created_at",
    )
    payments: Mapped[list["Payment"]] = relationship(
        back_populates="order",
        cascade="all, delete-orphan",
        order_by="(Payment.kind, Payment.phase_number)",
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
    def reference(self) -> str:
        """What a human calls this case. An enquiry ref until the case reaches
        planning, the AL number from then on."""
        return self.order_number or self.enquiry_number

    @property
    def in_production(self) -> bool:
        """True once the case has been given an AL number."""
        return self.order_number is not None

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
            enums.FileGroup.PROGRESS: self.progress_round,
            enums.FileGroup.PHASE_FIT: self.phase_fit_round,
        }[group]

    def bump_revision(self, group: "enums.FileGroup") -> int:
        if group == enums.FileGroup.RECORDS:
            self.records_revision += 1
        elif group == enums.FileGroup.SCAN:
            self.scan_revision += 1
        elif group == enums.FileGroup.PLANNING:
            self.planning_revision += 1
        elif group == enums.FileGroup.PROGRESS:
            self.progress_round += 1
        elif group == enums.FileGroup.PHASE_FIT:
            self.phase_fit_round += 1
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
        # Once divided, the next batch is simply the earliest unfinished phase.
        # Reading it off the last shipment cannot survive a rescan, which has to
        # resume mid-series without re-delivering what is already done.
        if self.phases:
            phase = self.active_phase
            if phase is None:
                return self.aligner_steps + 1, self.aligner_steps
            return phase.from_step, phase.to_step

        total = self.aligner_steps
        last = self.last_phase
        if last is None:
            return 1, total
        if last.phase_decision == enums.PhaseDecision.REPEAT:
            return (last.aligner_range_from or 1), (last.aligner_range_to or total)
        return (last.aligner_range_to or 0) + 1, total

    @property
    def next_phase_label(self) -> tuple:
        """(phase number, round) for the batch the lab would ship next."""
        if self.phases:
            phase = self.active_phase
            if phase is None:
                return len(self.phases), self.phases[-1].round
            return phase.phase_number, phase.round

        last = self.last_phase
        if last is None:
            return 1, 1
        if last.phase_decision == enums.PhaseDecision.REPEAT:
            return (last.phase_number or 1), (last.phase_round or 1) + 1
        return (last.phase_number or 0) + 1, 1

    def is_final_phase(self, shipment) -> bool:
        """Whether a batch carries the last of the series. Measured in steps —
        the two arches advance together, so the series ends at the last step,
        not at their aligner counts added together."""
        total = self.aligner_steps
        return bool(
            total and shipment.aligner_range_to and shipment.aligner_range_to >= total
        )

    @property
    def phase_blocker(self) -> Optional[str]:
        """Why the next phase cannot ship yet, or None when it can."""
        if self.dispatch_mode != enums.DispatchMode.PHASED:
            return None

        if self.phases:
            issue = self.open_phase_issue
            if issue is not None:
                return (
                    f"Phase {issue.phase_number} has an unanswered fit issue on "
                    f"{issue.arch.lower()} aligner {issue.aligner_number}."
                )
            phase = self.active_phase
            if phase is None:
                return "Every phase has been delivered and completed."
            if phase.status == enums.PhaseStatus.ACTIVE:
                return (
                    f"Phase {phase.phase_number} is with the clinic. It has to be "
                    f"received and reviewed before the next batch is made."
                )
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
        if self.aligner_steps and start > self.aligner_steps:
            return "Every aligner in the plan has already been dispatched."
        return None

    @property
    def total_aligners(self) -> int:
        plan = self.approved_plan or self.current_plan
        return (plan.aligners_upper + plan.aligners_lower) if plan else 0

    @property
    def aligner_steps(self) -> int:
        """How many steps the treatment runs.

        The arches advance together — step 7 means upper 7 with lower 7 — so the
        case is as long as its longer arch, not as long as both added together.
        The shorter arch simply finishes early and the patient carries on in the
        last aligner of that arch.
        """
        plan = self.approved_plan or self.current_plan
        return max(plan.aligners_upper, plan.aligners_lower) if plan else 0

    @property
    def max_phases(self) -> int:
        """The most phases this case can be split into.

        Five aligners is the working size of a phase, and the last one takes
        whatever is left over — so fourteen steps go out as 5, 5 and 4 rather
        than being capped at two phases of seven. That means rounding up.
        """
        steps = self.aligner_steps
        if not steps:
            return 0
        per = enums.MIN_STEPS_PER_PHASE
        return max(1, -(-steps // per))  # ceiling division

    @property
    def active_phase(self):
        """The earliest phase that is not finished — where delivery resumes.

        This is the whole point of holding phase state: after a mid-course
        rescan the case picks up here, and everything already completed stays
        completed.
        """
        return next(
            (p for p in self.phases if p.status != enums.PhaseStatus.COMPLETED), None
        )

    @property
    def open_phase_issue(self):
        return next((i for i in self.phase_issues if i.status == "OPEN"), None)

    @property
    def phases_divided(self) -> bool:
        return bool(self.phases)

    @property
    def phase_plan(self) -> list:
        """Which aligners each phase carries, once the clinic has chosen how
        many phases it wants.

        Phases are filled to the same size and the last one carries the
        remainder, so fourteen steps in three phases go 5, 5, 4. Rounding the
        size up rather than down is what keeps the short batch at the end,
        where the patient is finishing, instead of at the start.
        """
        # Once the case has been divided the spans are a matter of record, not
        # of arithmetic — recomputing them could move a boundary under a case
        # that is already part delivered.
        if self.phases:
            return [
                {
                    "phase": p.phase_number,
                    "from_step": p.from_step,
                    "to_step": p.to_step,
                    "upper_from": p.upper_from,
                    "upper_to": p.upper_to,
                    "lower_from": p.lower_from,
                    "lower_to": p.lower_to,
                    "status": p.status,
                    "status_label": enums.PHASE_STATUS_LABELS[p.status],
                    "round": p.round,
                }
                for p in self.phases
            ]
        count = self.phase_count
        steps = self.aligner_steps
        if not count or not steps:
            return []
        count = max(1, min(count, self.max_phases))
        plan = self.approved_plan or self.current_plan
        upper = plan.aligners_upper if plan else 0
        lower = plan.aligners_lower if plan else 0

        per = max(1, -(-steps // count))  # ceiling, so the short batch is last
        out = []
        start = 1
        for phase in range(1, count + 1):
            # The last phase takes whatever is left over.
            end = steps if phase == count else min(steps, start + per - 1)
            out.append(
                {
                    "phase": phase,
                    "from_step": start,
                    "to_step": end,
                    # An arch that has already run out contributes nothing more.
                    "upper_from": start if start <= upper else None,
                    "upper_to": min(end, upper) if start <= upper else None,
                    "lower_from": start if start <= lower else None,
                    "lower_to": min(end, lower) if start <= lower else None,
                    "status": enums.PhaseStatus.NOT_STARTED,
                    "status_label": enums.PHASE_STATUS_LABELS[enums.PhaseStatus.NOT_STARTED],
                    "round": 1,
                }
            )
            start = end + 1
        return out

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

    @property
    def aligner_category(self) -> Optional[str]:
        """The Align band this case sits in. The plan's confirmed band wins once
        it exists; before that it is the estimate the quote was priced off."""
        plan = self.current_plan
        if plan is not None and plan.final_category:
            return plan.final_category
        quote = self.current_quote
        return quote.category if quote is not None else None

    @property
    def quoted_category(self) -> Optional[str]:
        """The band the estimate was priced at, ignoring anything the treatment
        plan later confirmed. What the clinic saw before the plan existed."""
        quote = self.current_quote
        return quote.category if quote is not None else None

    @property
    def aligner_category_confirmed(self) -> bool:
        """False while the band is still the estimate read off photographs."""
        plan = self.current_plan
        return plan is not None and bool(plan.final_category)


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
    deleted_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
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
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

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
    sent_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    responded_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())

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
    # Goodwill or scheme discount taken off the list price. Held separately so
    # the clinic and the invoice both show what was given away, rather than a
    # quietly reduced price with no explanation.
    final_discount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    final_discount_reason: Mapped[str] = mapped_column(String(160), default="")
    final_tax: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    # final_price - final_discount + final_tax
    final_total: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))

    ipr_required: Mapped[bool] = mapped_column(Boolean, default=False)
    attachments_required: Mapped[bool] = mapped_column(Boolean, default=False)
    summary: Mapped[str] = mapped_column(Text, default="")

    status: Mapped[enums.PlanStatus] = mapped_column(
        _enum(enums.PlanStatus, "plan_status"), default=enums.PlanStatus.SHARED
    )
    revision_notes: Mapped[str] = mapped_column(Text, default="")
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    shared_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    responded_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())

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

    starts_at: Mapped[datetime] = mapped_column(UTCDateTime())
    ends_at: Mapped[datetime] = mapped_column(UTCDateTime())
    reason: Mapped[str] = mapped_column(String(200), default="")

    # Leave the lab enters is in force immediately; leave a technician asks for
    # waits for approval. Until then it must not close the diary, or a
    # technician could strand their own bookings just by asking.
    status: Mapped[str] = mapped_column(String(20), default=enums.LeaveStatus.APPROVED)
    requested_by_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id"))
    decided_by_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    decision_note: Mapped[str] = mapped_column(String(300), default="")

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
    # Working hours and rosters are wall-clock times in the city the lab serves.
    # Storing them without a zone made 09:00 mean 09:00 UTC — 14:30 in Ahmedabad.
    timezone_name: Mapped[str] = mapped_column(String(60), default="Asia/Kolkata")

    # Everyone starts and ends the day at the lab, so the first and last visit
    # of a day are costed against a real origin instead of being unconstrained.
    lab_address: Mapped[str] = mapped_column(String(255), default="")
    lab_latitude: Mapped[Optional[float]] = mapped_column(Float)
    lab_longitude: Mapped[Optional[float]] = mapped_column(Float)
    # Whether the point came from a dropped pin, a street-level lookup, or the
    # coarse pincode table. Every route starts and ends here, so how good it is
    # matters as much as what it is.
    lab_geocode_source: Mapped[str] = mapped_column(String(30), default="")

    # How long a scan visit actually takes, and how finely the doctor may pick a
    # start time inside a feasible window.
    visit_duration_minutes: Mapped[int] = mapped_column(Integer, default=45)
    booking_granularity_minutes: Mapped[int] = mapped_column(Integer, default=15)

    # Assignment scoring. Efficiency-first: the detour dominates, fairness only
    # breaks near-ties, and max_daily_jobs remains the hard backstop.
    travel_weight: Mapped[float] = mapped_column(Float, default=1.0)
    fairness_weight: Mapped[float] = mapped_column(Float, default=0.5)
    idle_weight: Mapped[float] = mapped_column(Float, default=0.5)
    max_travel_minutes: Mapped[int] = mapped_column(Integer, default=75)

    # Used when no routing provider is configured: straight-line distance times
    # a road factor, divided by this speed.
    fallback_speed_kmph: Mapped[float] = mapped_column(Float, default=22.0)

    # A clinic further than this from the lab cannot be served, so a geocode
    # that lands outside it is treated as a bad address rather than a long drive.
    service_radius_km: Mapped[float] = mapped_column(Float, default=120.0)

    # Beyond this, a visit is not a slot in somebody's day — it is the day. The
    # technician drives out, does the scan and drives back, and nothing else
    # fits around it.
    day_visit_over_km: Mapped[float] = mapped_column(Float, default=45.0)

    # ---- Payments -------------------------------------------------------
    # The lab collects by UPI. The clinic taps "Pay now", their app opens with
    # the payee and amount already filled in, and they send back a screenshot.
    upi_vpa: Mapped[str] = mapped_column(String(120), default="")
    upi_payee_name: Mapped[str] = mapped_column(String(120), default="3D Align")
    # Charged once per case, before the treatment plan is released.
    plan_fee: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("2000"))
    # Charged once per case, before the training aligner ships. A refit does not
    # charge it again.
    training_fit_fee: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("1500"))
    # Used when the delivery city has no rate of its own.
    default_shipping_fee: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))


class ShippingRate(Base, TimestampMixin):
    """What delivery costs to a given city. Held in the database so the lab can
    change a rate without a deploy, the same way aligner prices are."""

    __tablename__ = "shipping_rates"

    city: Mapped[str] = mapped_column(String(120), primary_key=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class OrderPhase(Base, TimestampMixin):
    """One phase of a phased dispatch, fixed at the moment the clinic chooses.

    The division is permanent. Spans were previously derived from the phase
    count on every read, which meant anything that touched the plan could shift
    the boundaries underneath a case that was already part-way delivered. They
    are written down once instead, and each phase carries its own completion
    state so a mid-course rescan can resume at the earliest unfinished one
    without disturbing the phases already behind it.
    """

    __tablename__ = "order_phases"
    __table_args__ = (
        UniqueConstraint("order_id", "phase_number", name="uq_phase_order_number"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    phase_number: Mapped[int] = mapped_column(Integer)

    # Treatment steps this phase covers, and what that means per arch. An arch
    # that has already finished contributes nothing more, so its bounds are null.
    from_step: Mapped[int] = mapped_column(Integer)
    to_step: Mapped[int] = mapped_column(Integer)
    upper_from: Mapped[Optional[int]] = mapped_column(Integer)
    upper_to: Mapped[Optional[int]] = mapped_column(Integer)
    lower_from: Mapped[Optional[int]] = mapped_column(Integer)
    lower_to: Mapped[Optional[int]] = mapped_column(Integer)

    status: Mapped[str] = mapped_column(String(20), default=enums.PhaseStatus.NOT_STARTED)
    # Advances when the batch is remade — phase 1 round 2, and so on.
    round: Mapped[int] = mapped_column(Integer, default=1)
    completed_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())

    order: Mapped["Order"] = relationship(back_populates="phases")


class PhaseFitIssue(Base, TimestampMixin):
    """An aligner inside a phase that does not fit.

    Distinct from the training-aligner fit review: that one asks whether the
    case can start at all, this one interrupts a phase already in the patient's
    mouth and hands the phase back to the lab to answer.
    """

    __tablename__ = "phase_fit_issues"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    phase_number: Mapped[int] = mapped_column(Integer)
    phase_round: Mapped[int] = mapped_column(Integer, default=1)

    arch: Mapped[str] = mapped_column(String(10))
    aligner_number: Mapped[int] = mapped_column(Integer)
    notes: Mapped[str] = mapped_column(Text, default="")
    # Which revision of the phase-fit photograph set belongs to this report.
    photo_revision: Mapped[int] = mapped_column(Integer, default=1)

    status: Mapped[str] = mapped_column(String(20), default="OPEN")
    # Only set once the issue actually ends. Advice from the lab does not end
    # it — the clinic has to say the aligner is wearing properly now.
    resolution: Mapped[Optional[str]] = mapped_column(String(20))
    # Whose turn it is while it is open: the lab has it after a report or a
    # reply from the clinic, the clinic has it after the lab sends advice.
    awaiting: Mapped[str] = mapped_column(String(10), default=enums.AWAITING_LAB)
    # The most recent thing the lab said, kept for records written before the
    # exchange became a thread.
    lab_comments: Mapped[str] = mapped_column(Text, default="")

    reported_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    resolved_by_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id"))
    resolved_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())

    order: Mapped["Order"] = relationship(back_populates="phase_issues")
    messages: Mapped[list["PhaseIssueMessage"]] = relationship(
        back_populates="issue",
        cascade="all, delete-orphan",
        order_by="PhaseIssueMessage.created_at",
    )


class PhaseIssueMessage(Base, TimestampMixin):
    """One turn in the exchange over a fit issue.

    Advice rarely settles a misfitting aligner first time, so this is a
    conversation rather than a single answer: the lab suggests something, the
    clinic tries it and says what happened, and it goes back and forth until
    either the clinic is satisfied or the lab decides to remake or rescan.
    """

    __tablename__ = "phase_issue_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    issue_id: Mapped[str] = mapped_column(ForeignKey("phase_fit_issues.id"), index=True)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    from_lab: Mapped[bool] = mapped_column(Boolean, default=False)
    body: Mapped[str] = mapped_column(Text, default="")

    issue: Mapped["PhaseFitIssue"] = relationship(back_populates="messages")


class Payment(Base, TimestampMixin):
    """One charge on a case.

    There is at most one row per (case, kind, phase), which is what makes the
    plan fee and the training-fit fee one-time: a revision, a rescan or a
    refabricated training aligner reuses the row that is already there rather
    than raising a second charge.
    """

    __tablename__ = "payments"
    __table_args__ = (
        UniqueConstraint("order_id", "kind", "phase_number", name="uq_payment_order_kind_phase"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    kind: Mapped[str] = mapped_column(String(30))
    # Only set for production phases. Kept as 0 rather than NULL for the rest,
    # because SQLite treats NULLs as distinct and the uniqueness above would
    # stop constraining anything.
    phase_number: Mapped[int] = mapped_column(Integer, default=0)

    # What the aligners themselves cost for this phase, and delivery on top.
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    shipping_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))

    status: Mapped[str] = mapped_column(String(20), default=enums.PaymentStatus.DUE)
    # The clinic's UPI reference, and the screenshot they sent.
    reference: Mapped[str] = mapped_column(String(80), default="")
    proof_file_id: Mapped[Optional[str]] = mapped_column(String(36))
    note: Mapped[str] = mapped_column(Text, default="")
    rejected_reason: Mapped[str] = mapped_column(Text, default="")

    submitted_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    verified_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    verified_by_id: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id"))

    order: Mapped["Order"] = relationship(back_populates="payments")

    @property
    def total(self) -> Decimal:
        return (self.amount or Decimal("0")) + (self.shipping_amount or Decimal("0"))


class ReassignmentRequest(Base, TimestampMixin):
    """A technician asking the lab to hand one of their visits to someone else.

    The handover itself reuses the ordinary reassignment path — this only
    records the ask, so the lab has a queue rather than a phone call.
    """

    __tablename__ = "reassignment_requests"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    appointment_id: Mapped[str] = mapped_column(ForeignKey("appointments.id"), index=True)
    technician_id: Mapped[str] = mapped_column(ForeignKey("technicians.id"), index=True)

    reason: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[enums.ReassignmentStatus] = mapped_column(
        _enum(enums.ReassignmentStatus, "reassignment_status"),
        default=enums.ReassignmentStatus.PENDING,
        index=True,
    )
    resolution: Mapped[str] = mapped_column(Text, default="")
    resolved_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())

    appointment: Mapped["Appointment"] = relationship()
    technician: Mapped["Technician"] = relationship()

    @property
    def is_open(self) -> bool:
        return self.status == enums.ReassignmentStatus.PENDING


class TravelEstimate(Base, TimestampMixin):
    """Cached travel time between two points.

    The same clinic pairs recur constantly in one service city, so this is what
    keeps a calendar render from turning into hundreds of routing calls. Keyed
    on rounded coordinates rather than raw addresses so it never stores where a
    named person lives.
    """

    __tablename__ = "travel_estimates"
    __table_args__ = (
        UniqueConstraint("origin_key", "destination_key", "bucket", name="uq_travel_pair"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    origin_key: Mapped[str] = mapped_column(String(40), index=True)
    destination_key: Mapped[str] = mapped_column(String(40), index=True)

    # A 09:00 Monday run and a 17:00 Friday run are different journeys, so the
    # departure time is part of the key: "1@09" is Tuesday 9am. Live lookups
    # for imminent visits are never cached at all.
    bucket: Mapped[str] = mapped_column(String(10), default="", index=True)

    minutes: Mapped[float] = mapped_column(Float)
    distance_km: Mapped[float] = mapped_column(Float, default=0.0)
    source: Mapped[str] = mapped_column(String(20), default="estimate")
    # Traffic patterns drift; an entry is refreshed once it is older than this.
    expires_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())


class Product(Base, TimestampMixin):
    """Something the lab makes that is not a staged aligner series.

    Retainers, splints, bleaching trays, bite plates and the rest. Kept in the
    database rather than a dictionary in the code, because the last system held
    the catalogue in two places — a products dict and the list the assistant was
    told about — and they drifted: three items were orderable but unlisted.
    """

    __tablename__ = "products"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    # Short lab code, used in the order reference: ER, TMJ, NG.
    code: Mapped[str] = mapped_column(String(12), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(400), default="")
    # Some products are priced per extra tooth on top of the base price — a
    # pediatric retainer includes one pontic and charges for the rest.
    per_tooth_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    included_teeth: Mapped[int] = mapped_column(Integer, default=0)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    sizes: Mapped[list[ProductSize]] = relationship(
        back_populates="product", cascade="all, delete-orphan", order_by="ProductSize.sort_order"
    )

    @property
    def priced_sizes(self) -> list:
        return [s for s in self.sizes if s.is_active]

    @property
    def has_choice_of_size(self) -> bool:
        """Whether the clinic is asked which one. A single size is not a choice
        worth putting in front of anyone."""
        return len(self.priced_sizes) > 1


class ProductSize(Base, TimestampMixin):
    """One thickness or variant of a product, with its price.

    Priced per size rather than per product because that is how the lab sells:
    a 0.8 mm Essix costs twice a 1.0 mm one.
    """

    __tablename__ = "product_sizes"
    __table_args__ = (UniqueConstraint("product_id", "label", name="uq_product_size"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    product_id: Mapped[str] = mapped_column(ForeignKey("products.id"), index=True)
    # "0.8 mm", "2 mm", or "standard" when the product has only one form.
    label: Mapped[str] = mapped_column(String(40))
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    product: Mapped[Product] = relationship(back_populates="sizes")


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

    starts_at: Mapped[datetime] = mapped_column(UTCDateTime(), index=True)
    ends_at: Mapped[datetime] = mapped_column(UTCDateTime())

    # A clinic outside the service city takes the technician for the whole day:
    # the drive there and back leaves no room for anything else, so the visit
    # spans the shift rather than a slot inside it.
    is_day_visit: Mapped[bool] = mapped_column(Boolean, default=False)

    status: Mapped[enums.AppointmentStatus] = mapped_column(
        _enum(enums.AppointmentStatus, "appointment_status"),
        default=enums.AppointmentStatus.ASSIGNED,
    )

    # Set when approved leave took the technician away and nobody else could
    # cover the visit. The booking still stands — it is the lab's to answer,
    # either by asking the clinic for another slot or by letting it be.
    needs_attention_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    attention_reason: Mapped[str] = mapped_column(String(300), default="")

    address_id: Mapped[Optional[str]] = mapped_column(ForeignKey("addresses.id"))
    contact_name: Mapped[str] = mapped_column(String(200), default="")
    contact_phone: Mapped[str] = mapped_column(String(40), default="")
    access_notes: Mapped[str] = mapped_column(Text, default="")
    assignment_reason: Mapped[str] = mapped_column(String(255), default="")

    started_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    completed_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
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

    shipped_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    delivered_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())

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
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

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
    issued_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    paid_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())

    order: Mapped[Order] = relationship(back_populates="invoice")


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    order_id: Mapped[Optional[str]] = mapped_column(ForeignKey("orders.id"))

    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    read_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    order: Mapped[Optional[Order]] = relationship()


class Counter(Base):
    """Backs human-readable order numbers (AL-2026-0001)."""

    __tablename__ = "counters"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[int] = mapped_column(Integer, default=0)
