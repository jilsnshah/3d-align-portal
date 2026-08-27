from enum import Enum


class UserRole(str, Enum):
    DOCTOR = "DOCTOR"
    ADMIN = "ADMIN"
    # Plans cases for the lab. Works the same tools as the admin — settings,
    # bookings, technicians — but only on the cases assigned to them.
    ORTHODONTIST = "ORTHODONTIST"
    TECHNICIAN = "TECHNICIAN"


# Everyone on the lab's side of the case. Drives what the clinic is not shown.
LAB_ROLES = {UserRole.ADMIN, UserRole.ORTHODONTIST, UserRole.TECHNICIAN}

# The lab office: the case board, the diary, the settings. A technician is on
# the lab's side but does not plan, so they are not here.
OFFICE_ROLES = {UserRole.ADMIN, UserRole.ORTHODONTIST}


class VerificationStatus(str, Enum):
    PENDING = "PENDING"
    VERIFIED = "VERIFIED"
    REJECTED = "REJECTED"


class OrderKind(str, Enum):
    """What the lab is being asked to make.

    An aligner case is planned: scans become a treatment plan, a simulation, a
    training fit and then a staged series delivered in phases. A product is
    fabricated: scans become the appliance. They share a doctor, a patient, a
    scan, an address, a shipment and an invoice — everything except the middle.
    """

    ALIGNER = "ALIGNER"
    PRODUCT = "PRODUCT"


class OrderStatus(str, Enum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    UNDER_REVIEW = "UNDER_REVIEW"
    RECORDS_REQUESTED = "RECORDS_REQUESTED"
    QUOTED = "QUOTED"
    AWAITING_SCAN = "AWAITING_SCAN"
    SCAN_SUBMITTED = "SCAN_SUBMITTED"
    IN_PLANNING = "IN_PLANNING"
    PLAN_SHARED = "PLAN_SHARED"
    TRAINING_ALIGNER_PRODUCTION = "TRAINING_ALIGNER_PRODUCTION"
    TRAINING_ALIGNER_SHIPPED = "TRAINING_ALIGNER_SHIPPED"
    FIT_REVIEW = "FIT_REVIEW"
    FIT_ISSUE = "FIT_ISSUE"
    ALIGNER_PRODUCTION = "ALIGNER_PRODUCTION"
    # A product order skips planning entirely: there is nothing to stage and
    # nothing to simulate, so an accepted scan goes straight to the bench.
    PRODUCT_FABRICATION = "PRODUCT_FABRICATION"
    DISPATCHING = "DISPATCHING"
    # The clinic has sent progress photographs for the phase it just received
    # and the lab is deciding whether treatment is tracking well enough to ship
    # the next one, or whether the case needs a fresh scan first.
    PHASE_REVIEW = "PHASE_REVIEW"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


TERMINAL_STATUSES = {OrderStatus.COMPLETED, OrderStatus.CANCELLED}

# Whose queue the order sits in. Drives both dashboards.
DOCTOR_ACTION_STATUSES = {
    OrderStatus.DRAFT,
    OrderStatus.RECORDS_REQUESTED,
    OrderStatus.QUOTED,
    OrderStatus.AWAITING_SCAN,
    OrderStatus.PLAN_SHARED,
    OrderStatus.FIT_REVIEW,
}

STATUS_LABELS: dict[str, str] = {
    OrderStatus.DRAFT: "Draft",
    OrderStatus.SUBMITTED: "Submitted",
    OrderStatus.UNDER_REVIEW: "Under review",
    OrderStatus.RECORDS_REQUESTED: "Records requested",
    OrderStatus.QUOTED: "Quote sent",
    OrderStatus.AWAITING_SCAN: "Awaiting scan",
    OrderStatus.SCAN_SUBMITTED: "Scan under review",
    OrderStatus.IN_PLANNING: "In planning",
    OrderStatus.PLAN_SHARED: "Plan shared",
    OrderStatus.TRAINING_ALIGNER_PRODUCTION: "Training aligner in production",
    OrderStatus.TRAINING_ALIGNER_SHIPPED: "Training aligner shipped",
    OrderStatus.FIT_REVIEW: "Fit review",
    OrderStatus.FIT_ISSUE: "Fit issue reported",
    OrderStatus.ALIGNER_PRODUCTION: "Aligners in production",
    OrderStatus.PRODUCT_FABRICATION: "In fabrication",
    OrderStatus.DISPATCHING: "Dispatching",
    OrderStatus.PHASE_REVIEW: "Phase review",
    OrderStatus.COMPLETED: "Completed",
    OrderStatus.CANCELLED: "Cancelled",
}


class Arch(str, Enum):
    UPPER = "UPPER"
    LOWER = "LOWER"
    BOTH = "BOTH"


class Priority(str, Enum):
    STANDARD = "STANDARD"
    EXPRESS = "EXPRESS"


class DispatchMode(str, Enum):
    FULL = "FULL"
    PHASED = "PHASED"


class FileCategory(str, Enum):
    RECORD_PHOTO = "RECORD_PHOTO"
    OPG = "OPG"
    LATERAL_CEPH = "LATERAL_CEPH"
    CBCT = "CBCT"
    INTRAORAL_SCAN = "INTRAORAL_SCAN"
    TREATMENT_PLAN = "TREATMENT_PLAN"
    # Staged arch models exported by the planning software, one pair per step.
    # These are the simulation: the clinic steps through them in the 3D viewer.
    SIMULATION_MODEL = "SIMULATION_MODEL"
    FIT_ISSUE_PHOTO = "FIT_ISSUE_PHOTO"
    # Photographs taken at the end of each phase, with the aligners in and out,
    # so the lab can see whether the teeth are where the plan expected.
    PROGRESS_PHOTO = "PROGRESS_PHOTO"
    # Screenshot of a completed UPI transfer, uploaded by the clinic as proof.
    PAYMENT_PROOF = "PAYMENT_PROOF"
    # The six views sent when an aligner inside a phase does not fit. Kept apart
    # from the phase's progress set so neither overwrites the other.
    PHASE_FIT_PHOTO = "PHASE_FIT_PHOTO"
    OTHER = "OTHER"


# Enforced by /orders/{id}/submit.
REQUIRED_SUBMIT_CATEGORIES = [FileCategory.RECORD_PHOTO, FileCategory.OPG]

# A product is made from the scan, not planned from the records. Asking a clinic
# for a panoramic radiograph before it will quote a bleaching tray is a barrier
# with nothing behind it, so the photographs stand on their own — they are what
# the lab looks at to see the case is what it says it is.
REQUIRED_SUBMIT_CATEGORIES_PRODUCT = [FileCategory.RECORD_PHOTO]


def required_submit_categories(kind) -> list:
    if kind == OrderKind.PRODUCT:
        return REQUIRED_SUBMIT_CATEGORIES_PRODUCT
    return REQUIRED_SUBMIT_CATEGORIES


class Slot(str, Enum):
    """A named place in a records set.

    A scan is not one file — it is an upper arch, a lower arch and a bite. A
    photo set is the standard orthodontic series. Modelling each as a slot means
    the portal can say *which* view is missing instead of counting files.
    """

    # Intraoral scan (STL)
    UPPER_ARCH = "UPPER_ARCH"
    LOWER_ARCH = "LOWER_ARCH"
    BITE = "BITE"

    # Intraoral photographs
    INTRAORAL_FRONTAL = "INTRAORAL_FRONTAL"
    BUCCAL_RIGHT = "BUCCAL_RIGHT"
    BUCCAL_LEFT = "BUCCAL_LEFT"
    OCCLUSAL_UPPER = "OCCLUSAL_UPPER"
    OCCLUSAL_LOWER = "OCCLUSAL_LOWER"

    # Progress photographs, taken at the end of a phase. The same three views
    # are shot twice — wearing the aligners and without them — because a tooth
    # can look corrected while the tray is holding it there.
    PROGRESS_UPPER_IN = "PROGRESS_UPPER_IN"
    PROGRESS_LOWER_IN = "PROGRESS_LOWER_IN"
    PROGRESS_FRONTAL_IN = "PROGRESS_FRONTAL_IN"
    PROGRESS_UPPER_OUT = "PROGRESS_UPPER_OUT"
    PROGRESS_LOWER_OUT = "PROGRESS_LOWER_OUT"
    PROGRESS_FRONTAL_OUT = "PROGRESS_FRONTAL_OUT"

    # Extraoral photographs
    FACE_REST = "FACE_REST"
    FACE_SMILE = "FACE_SMILE"
    PROFILE = "PROFILE"

    OTHER = "OTHER"


SLOT_LABELS: dict[str, str] = {
    Slot.UPPER_ARCH: "Upper arch",
    Slot.LOWER_ARCH: "Lower arch",
    Slot.BITE: "Bite registration",
    Slot.INTRAORAL_FRONTAL: "Frontal, in occlusion",
    Slot.BUCCAL_RIGHT: "Buccal right",
    Slot.BUCCAL_LEFT: "Buccal left",
    Slot.OCCLUSAL_UPPER: "Occlusal upper",
    Slot.OCCLUSAL_LOWER: "Occlusal lower",
    Slot.PROGRESS_UPPER_IN: "Upper, aligner in",
    Slot.PROGRESS_LOWER_IN: "Lower, aligner in",
    Slot.PROGRESS_FRONTAL_IN: "Frontal, aligner in",
    Slot.PROGRESS_UPPER_OUT: "Upper, aligner out",
    Slot.PROGRESS_LOWER_OUT: "Lower, aligner out",
    Slot.PROGRESS_FRONTAL_OUT: "Frontal, aligner out",
    Slot.FACE_REST: "Face at rest",
    Slot.FACE_SMILE: "Face smiling",
    Slot.PROFILE: "Profile",
    Slot.OTHER: "Other",
}

# Which slots each category expects, and whether the set is incomplete without
# them. Ordered as a clinician would shoot them.
SLOT_SPEC: dict[str, list[tuple]] = {
    FileCategory.INTRAORAL_SCAN: [
        (Slot.UPPER_ARCH, True),
        (Slot.LOWER_ARCH, True),
        (Slot.BITE, True),
    ],
    # All six are required: the lab is comparing the arch against the step it
    # should have reached, and three views is the minimum that shows it.
    FileCategory.PROGRESS_PHOTO: [
        (Slot.PROGRESS_UPPER_IN, True),
        (Slot.PROGRESS_LOWER_IN, True),
        (Slot.PROGRESS_FRONTAL_IN, True),
        (Slot.PROGRESS_UPPER_OUT, True),
        (Slot.PROGRESS_LOWER_OUT, True),
        (Slot.PROGRESS_FRONTAL_OUT, True),
    ],
    # A fit issue inside a phase is judged from the same six views as progress.
    FileCategory.PHASE_FIT_PHOTO: [
        (Slot.PROGRESS_UPPER_IN, True),
        (Slot.PROGRESS_LOWER_IN, True),
        (Slot.PROGRESS_FRONTAL_IN, True),
        (Slot.PROGRESS_UPPER_OUT, True),
        (Slot.PROGRESS_LOWER_OUT, True),
        (Slot.PROGRESS_FRONTAL_OUT, True),
    ],
    FileCategory.RECORD_PHOTO: [
        (Slot.INTRAORAL_FRONTAL, True),
        (Slot.BUCCAL_RIGHT, True),
        (Slot.BUCCAL_LEFT, True),
        (Slot.OCCLUSAL_UPPER, True),
        (Slot.OCCLUSAL_LOWER, True),
        (Slot.FACE_REST, False),
        (Slot.FACE_SMILE, False),
        (Slot.PROFILE, False),
    ],
}

# Categories that are a single document rather than a set: uploading again
# replaces what is there. A treatment plan is deliberately not one of these —
# a plan is a folder of exports, not one PDF.
SINGLE_FILE_CATEGORIES = {
    FileCategory.OPG,
    FileCategory.LATERAL_CEPH,
    FileCategory.CBCT,
    FileCategory.FIT_ISSUE_PHOTO,
    FileCategory.OTHER,
}


CATEGORY_TITLES: dict[str, str] = {
    FileCategory.RECORD_PHOTO: "Clinical photographs",
    FileCategory.OPG: "OPG",
    FileCategory.LATERAL_CEPH: "Lateral cephalogram",
    FileCategory.CBCT: "CBCT",
    FileCategory.INTRAORAL_SCAN: "Intraoral scan",
    FileCategory.TREATMENT_PLAN: "Treatment plan",
    FileCategory.FIT_ISSUE_PHOTO: "Fit issue photographs",
    FileCategory.PROGRESS_PHOTO: "Progress photographs",
    FileCategory.PAYMENT_PROOF: "Payment receipts",
    FileCategory.PHASE_FIT_PHOTO: "Phase fit issue photographs",
    FileCategory.OTHER: "Other",
}


def slots_for(category: str) -> list[tuple]:
    return SLOT_SPEC.get(category, [])


def required_slots(category: str) -> list:
    return [slot for slot, needed in slots_for(category) if needed]

# Which Drive/local subfolder each category lands in.
CATEGORY_FOLDER: dict[str, str] = {
    FileCategory.RECORD_PHOTO: "records",
    FileCategory.OPG: "records",
    FileCategory.LATERAL_CEPH: "records",
    FileCategory.CBCT: "records",
    FileCategory.INTRAORAL_SCAN: "scans",
    FileCategory.TREATMENT_PLAN: "planning",
    FileCategory.SIMULATION_MODEL: "planning",
    FileCategory.FIT_ISSUE_PHOTO: "records",
    FileCategory.PROGRESS_PHOTO: "records",
    FileCategory.PAYMENT_PROOF: "records",
    FileCategory.PHASE_FIT_PHOTO: "records",
    FileCategory.OTHER: "records",
}

# The plan document is the lab's working paper; the staged models it produces
# are shared, because the clinic is asked to approve what they show.
STAFF_ONLY_CATEGORIES = {FileCategory.TREATMENT_PLAN}

# The staged models are the lab's working geometry. The clinic reviews the
# movement they describe in the 3D simulation, which is generated from them and
# open to everyone; the STL files themselves are not handed over.
DOCTOR_HIDDEN_CATEGORIES = {FileCategory.SIMULATION_MODEL}

# Held back from the clinic until the treatment plan fee is settled. The plan
# document and the staged models *are* the plan — releasing either before it is
# paid for gives away the thing the fee is for.
PLAN_GATED_CATEGORIES = {FileCategory.TREATMENT_PLAN, FileCategory.SIMULATION_MODEL}

# A phase shorter than this is not worth dispatching on its own. The last phase
# is exempt, because the treatment length rarely divides exactly.
MIN_STEPS_PER_PHASE = 5


class FileGroup(str, Enum):
    """Files that get re-requested as a set share a revision counter, so a
    replacement scan reads as v2 rather than as a second, ambiguous v1."""

    RECORDS = "RECORDS"
    SCAN = "SCAN"
    PLANNING = "PLANNING"
    FIT = "FIT"
    # One set per phase, so phase two's photographs do not overwrite phase one's.
    PROGRESS = "PROGRESS"
    # One set per fit issue raised inside a phase.
    PHASE_FIT = "PHASE_FIT"


FILE_GROUP: dict[str, FileGroup] = {
    FileCategory.RECORD_PHOTO: FileGroup.RECORDS,
    FileCategory.OPG: FileGroup.RECORDS,
    FileCategory.LATERAL_CEPH: FileGroup.RECORDS,
    FileCategory.CBCT: FileGroup.RECORDS,
    FileCategory.OTHER: FileGroup.RECORDS,
    FileCategory.INTRAORAL_SCAN: FileGroup.SCAN,
    FileCategory.TREATMENT_PLAN: FileGroup.PLANNING,
    # Staged arch models are planning output: they are revisioned with the plan
    # and superseded together when it is replanned.
    FileCategory.SIMULATION_MODEL: FileGroup.PLANNING,
    FileCategory.FIT_ISSUE_PHOTO: FileGroup.FIT,
    FileCategory.PROGRESS_PHOTO: FileGroup.PROGRESS,
    # Receipts accumulate over the life of the case and are never re-requested
    # as a set, so they sit with the records rather than carrying their own
    # revision counter.
    FileCategory.PAYMENT_PROOF: FileGroup.RECORDS,
    FileCategory.PHASE_FIT_PHOTO: FileGroup.PHASE_FIT,
}

# Staff uploads are gated too. A treatment plan cannot exist before there is an
# accepted quote and a verified scan to plan from.
STAFF_UPLOAD_WINDOWS: dict[str, set] = {
    FileCategory.TREATMENT_PLAN: {OrderStatus.IN_PLANNING, OrderStatus.PLAN_SHARED},
    # The staged models the 3D viewer runs on, uploaded alongside the plan.
    FileCategory.SIMULATION_MODEL: {OrderStatus.IN_PLANNING, OrderStatus.PLAN_SHARED},
}


class AlignerCategory(str, Enum):
    """3D Align prices by total aligner count, not per arch. The lab picks a
    band from the clinical photographs for the expected quote, then confirms the
    real band once the treatment plan gives an exact count."""

    ALIGN_6_12 = "ALIGN_6_12"
    ALIGN_12_16 = "ALIGN_12_16"
    ALIGN_16_20 = "ALIGN_16_20"
    ALIGN_20_30 = "ALIGN_20_30"
    ALIGN_30_40 = "ALIGN_30_40"
    ALIGN_40_70 = "ALIGN_40_70"
    ALIGN_70_PLUS = "ALIGN_70_PLUS"


# (label, lower bound, upper bound or None for open-ended)
ALIGNER_CATEGORIES: dict[str, tuple] = {
    AlignerCategory.ALIGN_6_12: ("Align 6–12", 6, 12),
    AlignerCategory.ALIGN_12_16: ("Align 12–16", 12, 16),
    AlignerCategory.ALIGN_16_20: ("Align 16–20", 16, 20),
    AlignerCategory.ALIGN_20_30: ("Align 20–30", 20, 30),
    AlignerCategory.ALIGN_30_40: ("Align 30–40", 30, 40),
    AlignerCategory.ALIGN_40_70: ("Align 40–70", 40, 70),
    AlignerCategory.ALIGN_70_PLUS: ("Align 70+", 70, None),
}

# Placeholder pricing, seeded into the editable price list on first boot.
# Each band quotes a range — the exact figure is only known once the treatment
# plan gives a real aligner count. Replace from Admin → Settings.
DEFAULT_CATEGORY_PRICES: dict[str, tuple] = {
    AlignerCategory.ALIGN_6_12: (20000, 30000),
    AlignerCategory.ALIGN_12_16: (30000, 40000),
    AlignerCategory.ALIGN_16_20: (40000, 50000),
    AlignerCategory.ALIGN_20_30: (50000, 70000),
    AlignerCategory.ALIGN_30_40: (70000, 90000),
    AlignerCategory.ALIGN_40_70: (90000, 110000),
    AlignerCategory.ALIGN_70_PLUS: (110000, 140000),
}


def category_label(category: str) -> str:
    entry = ALIGNER_CATEGORIES.get(category)
    return entry[0] if entry else category


def category_for_count(total: int):
    """Suggests the band an actual aligner count falls into. Advisory — the lab
    confirms it, because a count can sit on a boundary."""
    for name, (_, low, high) in ALIGNER_CATEGORIES.items():
        if high is None:
            if total >= low:
                return name
        elif low <= total <= high:
            return name
    return None


class QuoteStatus(str, Enum):
    SENT = "SENT"
    ACCEPTED = "ACCEPTED"
    SUPERSEDED = "SUPERSEDED"


class PlanStatus(str, Enum):
    SHARED = "SHARED"
    APPROVED = "APPROVED"
    REVISION_REQUESTED = "REVISION_REQUESTED"
    SUPERSEDED = "SUPERSEDED"


class ScanRoute(str, Enum):
    UPLOAD = "UPLOAD"
    APPOINTMENT = "APPOINTMENT"
    COURIER = "COURIER"


class AppointmentStatus(str, Enum):
    ASSIGNED = "ASSIGNED"
    EN_ROUTE = "EN_ROUTE"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"
    NO_SHOW = "NO_SHOW"


# Statuses that still occupy a technician's calendar.
LIVE_APPOINTMENT_STATUSES = {AppointmentStatus.ASSIGNED, AppointmentStatus.EN_ROUTE}

class ReassignmentStatus(str, Enum):
    PENDING = "PENDING"
    RESOLVED = "RESOLVED"
    DECLINED = "DECLINED"


APPOINTMENT_LABELS: dict[str, str] = {
    AppointmentStatus.ASSIGNED: "Scheduled",
    AppointmentStatus.EN_ROUTE: "Technician on the way",
    AppointmentStatus.COMPLETED: "Scan taken",
    AppointmentStatus.CANCELLED: "Cancelled",
    AppointmentStatus.NO_SHOW: "Could not scan",
}


class ShipmentType(str, Enum):
    TRAINING_ALIGNER = "TRAINING_ALIGNER"
    PRODUCT = "PRODUCT"
    ALIGNER_PHASE = "ALIGNER_PHASE"
    FULL_CASE = "FULL_CASE"


class ShipmentStatus(str, Enum):
    PENDING = "PENDING"
    SHIPPED = "SHIPPED"
    DELIVERED = "DELIVERED"


class LeaveStatus(str, Enum):
    """A technician's request to be off.

    Leave only takes effect once the lab has approved it — a request on its own
    must not quietly close the diary, or a technician could strand their own
    bookings simply by asking.
    """

    PENDING = "PENDING"
    APPROVED = "APPROVED"
    DECLINED = "DECLINED"


LEAVE_STATUS_LABELS: dict[str, str] = {
    LeaveStatus.PENDING: "Awaiting approval",
    LeaveStatus.APPROVED: "Approved",
    LeaveStatus.DECLINED: "Declined",
}


class AttentionAction(str, Enum):
    """What the lab does with a visit nobody could cover."""

    # Cancel it and ask the clinic to pick another slot.
    RESCHEDULE = "RESCHEDULE"
    # Leave it standing — the lab will sort it out off-system.
    IGNORE = "IGNORE"


class PhaseStatus(str, Enum):
    """Where one phase of a phased dispatch has got to.

    Held per phase rather than inferred from the last shipment, because a
    mid-course rescan has to resume at the earliest phase that is *not* finished
    while leaving the finished ones alone.
    """

    NOT_STARTED = "NOT_STARTED"
    # Made and sent; the patient is wearing it.
    ACTIVE = "ACTIVE"
    # An aligner inside it did not fit, so the phase is unfinished again.
    ISSUE = "ISSUE"
    COMPLETED = "COMPLETED"


PHASE_STATUS_LABELS: dict[str, str] = {
    PhaseStatus.NOT_STARTED: "Not started",
    PhaseStatus.ACTIVE: "With the clinic",
    PhaseStatus.ISSUE: "Fit issue reported",
    PhaseStatus.COMPLETED: "Completed",
}


class PhaseIssueResolution(str, Enum):
    """How a fit issue raised inside a phase ends.

    Instructions are deliberately absent: answering with advice does not close
    the issue. The clinic is the one wearing the aligner, so only they can say
    whether the advice worked, and until they do the issue stays open and the
    two sides can keep talking.
    """

    REMAKE = "REMAKE"
    RESCAN = "RESCAN"
    # The clinic tried what the lab suggested and it is fine now.
    CLINIC_CONFIRMED = "CLINIC_CONFIRMED"


class PhaseIssueAnswer(str, Enum):
    """What the lab does with a fit issue that is in front of it."""

    COMMENTS = "COMMENTS"
    REMAKE = "REMAKE"
    RESCAN = "RESCAN"


# Whose turn it is on an open fit issue.
AWAITING_LAB = "LAB"
AWAITING_CLINIC = "CLINIC"


class PaymentKind(str, Enum):
    """What a payment is for. One row per kind per case, so a revision, a
    rescan or a refit never charges the clinic a second time."""

    TREATMENT_PLAN = "TREATMENT_PLAN"
    TRAINING_FIT = "TRAINING_FIT"
    PRODUCTION_PHASE = "PRODUCTION_PHASE"
    # A product is one charge: its price times the quantity, plus delivery.
    # There is no plan to unlock and no training fit to make, so neither of
    # those fees is ever raised against a product order.
    PRODUCT_ORDER = "PRODUCT_ORDER"


PAYMENT_KIND_LABELS: dict[str, str] = {
    PaymentKind.TREATMENT_PLAN: "Treatment plan",
    PaymentKind.TRAINING_FIT: "Training fit aligner",
    PaymentKind.PRODUCTION_PHASE: "Production aligners",
    PaymentKind.PRODUCT_ORDER: "Product order",
}


class PaymentStatus(str, Enum):
    DUE = "DUE"
    # The clinic has paid and sent a screenshot; the lab has not checked it yet.
    SUBMITTED = "SUBMITTED"
    VERIFIED = "VERIFIED"
    REJECTED = "REJECTED"


PAYMENT_STATUS_LABELS: dict[str, str] = {
    PaymentStatus.DUE: "Awaiting payment",
    PaymentStatus.SUBMITTED: "Receipt under review",
    PaymentStatus.VERIFIED: "Paid",
    PaymentStatus.REJECTED: "Receipt not accepted",
}


class PhaseReviewOutcome(str, Enum):
    """What the lab concludes from a phase's progress photographs."""

    CONTINUE = "CONTINUE"
    RESCAN = "RESCAN"


class PhaseDecision(str, Enum):
    """What the clinic wants after receiving a phase — the same shape as the
    training-aligner fit review, one step down."""

    CONTINUE = "CONTINUE"
    REPEAT = "REPEAT"


PHASE_DECISION_LABELS: dict[str, str] = {
    PhaseDecision.CONTINUE: "Move on to the next phase",
    PhaseDecision.REPEAT: "Remake this phase",
}


class FitOutcome(str, Enum):
    FITS = "FITS"
    ISSUE_REPORTED = "ISSUE_REPORTED"


class InvoiceStatus(str, Enum):
    ISSUED = "ISSUED"
    PAID = "PAID"
    VOID = "VOID"
