from enum import Enum


class UserRole(str, Enum):
    DOCTOR = "DOCTOR"
    ADMIN = "ADMIN"
    TECHNICIAN = "TECHNICIAN"


# Both lab roles share the case tools; only ADMIN gets the admin furniture.
LAB_ROLES = {UserRole.ADMIN, UserRole.TECHNICIAN}


class VerificationStatus(str, Enum):
    PENDING = "PENDING"
    VERIFIED = "VERIFIED"
    REJECTED = "REJECTED"


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
    DISPATCHING = "DISPATCHING"
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
    OrderStatus.DISPATCHING: "Dispatching",
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
    SIMULATION_VIDEO = "SIMULATION_VIDEO"
    FIT_ISSUE_PHOTO = "FIT_ISSUE_PHOTO"
    OTHER = "OTHER"


# Enforced by /orders/{id}/submit.
REQUIRED_SUBMIT_CATEGORIES = [FileCategory.RECORD_PHOTO, FileCategory.OPG]


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

# Categories that are a single document rather than a set.
SINGLE_FILE_CATEGORIES = {
    FileCategory.OPG,
    FileCategory.LATERAL_CEPH,
    FileCategory.CBCT,
    FileCategory.TREATMENT_PLAN,
    FileCategory.SIMULATION_VIDEO,
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
    FileCategory.SIMULATION_VIDEO: "Simulation video",
    FileCategory.FIT_ISSUE_PHOTO: "Fit issue photographs",
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
    FileCategory.SIMULATION_VIDEO: "planning",
    FileCategory.FIT_ISSUE_PHOTO: "records",
    FileCategory.OTHER: "records",
}

STAFF_ONLY_CATEGORIES = {FileCategory.TREATMENT_PLAN, FileCategory.SIMULATION_VIDEO}


class FileGroup(str, Enum):
    """Files that get re-requested as a set share a revision counter, so a
    replacement scan reads as v2 rather than as a second, ambiguous v1."""

    RECORDS = "RECORDS"
    SCAN = "SCAN"
    PLANNING = "PLANNING"
    FIT = "FIT"


FILE_GROUP: dict[str, FileGroup] = {
    FileCategory.RECORD_PHOTO: FileGroup.RECORDS,
    FileCategory.OPG: FileGroup.RECORDS,
    FileCategory.LATERAL_CEPH: FileGroup.RECORDS,
    FileCategory.CBCT: FileGroup.RECORDS,
    FileCategory.OTHER: FileGroup.RECORDS,
    FileCategory.INTRAORAL_SCAN: FileGroup.SCAN,
    FileCategory.TREATMENT_PLAN: FileGroup.PLANNING,
    FileCategory.SIMULATION_VIDEO: FileGroup.PLANNING,
    FileCategory.FIT_ISSUE_PHOTO: FileGroup.FIT,
}

# Staff uploads are gated too. A treatment plan cannot exist before there is an
# accepted quote and a verified scan to plan from.
STAFF_UPLOAD_WINDOWS: dict[str, set] = {
    FileCategory.TREATMENT_PLAN: {OrderStatus.IN_PLANNING, OrderStatus.PLAN_SHARED},
    FileCategory.SIMULATION_VIDEO: {OrderStatus.IN_PLANNING, OrderStatus.PLAN_SHARED},
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

APPOINTMENT_LABELS: dict[str, str] = {
    AppointmentStatus.ASSIGNED: "Scheduled",
    AppointmentStatus.EN_ROUTE: "Technician on the way",
    AppointmentStatus.COMPLETED: "Scan taken",
    AppointmentStatus.CANCELLED: "Cancelled",
    AppointmentStatus.NO_SHOW: "Could not scan",
}


class ShipmentType(str, Enum):
    TRAINING_ALIGNER = "TRAINING_ALIGNER"
    ALIGNER_PHASE = "ALIGNER_PHASE"
    FULL_CASE = "FULL_CASE"


class ShipmentStatus(str, Enum):
    PENDING = "PENDING"
    SHIPPED = "SHIPPED"
    DELIVERED = "DELIVERED"


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
