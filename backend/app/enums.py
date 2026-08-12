from enum import Enum


class UserRole(str, Enum):
    DOCTOR = "DOCTOR"
    STAFF = "STAFF"


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
    BOOKED = "BOOKED"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"
    NO_SHOW = "NO_SHOW"


class ShipmentType(str, Enum):
    TRAINING_ALIGNER = "TRAINING_ALIGNER"
    ALIGNER_PHASE = "ALIGNER_PHASE"
    FULL_CASE = "FULL_CASE"


class ShipmentStatus(str, Enum):
    PENDING = "PENDING"
    SHIPPED = "SHIPPED"
    DELIVERED = "DELIVERED"


class FitOutcome(str, Enum):
    FITS = "FITS"
    ISSUE_REPORTED = "ISSUE_REPORTED"


class InvoiceStatus(str, Enum):
    ISSUED = "ISSUED"
    PAID = "PAID"
    VOID = "VOID"
