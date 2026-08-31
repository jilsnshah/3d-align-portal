"""The only place `Order.status` is allowed to change.

Every move is checked against ALLOWED, recorded as a StatusEvent, and fanned out
as a notification — all inside the caller's transaction. Endpoints never assign
`order.status` directly.
"""

from __future__ import annotations

import logging

from typing import Optional

from fastapi import HTTPException, status as http_status
from sqlalchemy.orm import Session

from .enums import (
    LAB_ROLES,
    STATUS_LABELS,
    TERMINAL_STATUSES,
    OrderKind,
    OrderStatus,
    UserRole,
)
from .models import Notification, Order, StatusEvent, User, utcnow
from .services.numbering import (
    next_accessory_number,
    next_order_number,
    next_product_number,
)

log = logging.getLogger(__name__)

S = OrderStatus

ALLOWED: dict[OrderStatus, set[OrderStatus]] = {
    # Placing the order is the whole of the decision for anything sold at a
    # fixed catalogue price. A by-product goes straight to the scan it is made
    # from; an accessory goes straight to the shelf to be picked. Only an
    # aligner case is submitted for the lab to read and quote.
    S.DRAFT: {S.SUBMITTED, S.AWAITING_SCAN, S.PRODUCT_FABRICATION, S.CANCELLED},
    S.SUBMITTED: {S.UNDER_REVIEW, S.CANCELLED},
    S.UNDER_REVIEW: {S.RECORDS_REQUESTED, S.QUOTED, S.CANCELLED},
    S.RECORDS_REQUESTED: {S.UNDER_REVIEW, S.CANCELLED},
    # Re-sending a quote keeps the order in QUOTED with a new version.
    S.QUOTED: {S.QUOTED, S.AWAITING_SCAN, S.CANCELLED},
    # The scan is either still coming (AWAITING_SCAN) or with the lab to verify
    # (SCAN_SUBMITTED). Rejecting a scan sends it back for another attempt.
    S.AWAITING_SCAN: {S.SCAN_SUBMITTED, S.CANCELLED},
    # A refinement scan skips planning entirely: the plan is not being redrawn,
    # so the case goes straight to making a training aligner against the new
    # anatomy.
    S.SCAN_SUBMITTED: {
        S.IN_PLANNING,
        S.AWAITING_SCAN,
        S.TRAINING_ALIGNER_PRODUCTION,
        # A product order has nothing to plan: the appliance is made from the
        # scan as it stands, so an accepted scan goes straight to the bench.
        S.PRODUCT_FABRICATION,
        S.CANCELLED,
    },
    # A product that cannot be made from the scan given goes back for another,
    # the same way a rejected aligner scan does.
    S.PRODUCT_FABRICATION: {S.DISPATCHING, S.AWAITING_SCAN, S.CANCELLED},
    S.IN_PLANNING: {S.PLAN_SHARED, S.CANCELLED},
    S.PLAN_SHARED: {S.IN_PLANNING, S.TRAINING_ALIGNER_PRODUCTION, S.CANCELLED},
    S.TRAINING_ALIGNER_PRODUCTION: {S.TRAINING_ALIGNER_SHIPPED, S.CANCELLED},
    S.TRAINING_ALIGNER_SHIPPED: {S.FIT_REVIEW, S.CANCELLED},
    S.FIT_REVIEW: {S.ALIGNER_PRODUCTION, S.FIT_ISSUE, S.CANCELLED},
    S.FIT_ISSUE: {
        S.AWAITING_SCAN,
        S.IN_PLANNING,
        S.TRAINING_ALIGNER_PRODUCTION,
        # Remaking the phase, or handing it back to the clinic with comments.
        S.ALIGNER_PRODUCTION,
        S.DISPATCHING,
        S.CANCELLED,
    },
    S.ALIGNER_PRODUCTION: {S.DISPATCHING, S.CANCELLED},
    # A remade phase goes back to the bench before it can ship again. Accepting
    # a phase hands it to the lab as a phase review instead of shipping the next
    # batch straight away.
    S.DISPATCHING: {
        S.ALIGNER_PRODUCTION,
        S.PHASE_REVIEW,
        # An aligner inside the delivered phase does not fit.
        S.FIT_ISSUE,
        S.COMPLETED,
        S.CANCELLED,
    },
    # The lab either carries on, or stops to take a fresh scan mid-course. A fit
    # issue can also surface while the photographs are being looked at.
    S.PHASE_REVIEW: {
        S.ALIGNER_PRODUCTION,
        S.AWAITING_SCAN,
        S.FIT_ISSUE,
        S.CANCELLED,
    },
    S.COMPLETED: set(),
    S.CANCELLED: set(),
}

# Who may drive each move. Anything not listed is staff-only.
DOCTOR_MOVES: set[tuple[OrderStatus, OrderStatus]] = {
    (S.DRAFT, S.SUBMITTED),
    # A fixed-price order needs nothing from the lab before it starts, so the
    # clinic places it and it begins. Which of the two edges a case may take is
    # decided by its kind, in the guard below.
    (S.DRAFT, S.AWAITING_SCAN),
    (S.DRAFT, S.PRODUCT_FABRICATION),
    (S.RECORDS_REQUESTED, S.UNDER_REVIEW),
    (S.QUOTED, S.AWAITING_SCAN),
    # Uploading an STL hands the scan to the lab. Accepting it is staff-only.
    (S.AWAITING_SCAN, S.SCAN_SUBMITTED),
    (S.PLAN_SHARED, S.TRAINING_ALIGNER_PRODUCTION),
    (S.PLAN_SHARED, S.IN_PLANNING),
    # The clinic receives the parcel, so it confirms delivery — and that is
    # exactly what opens the fit review it then has to answer.
    (S.TRAINING_ALIGNER_SHIPPED, S.FIT_REVIEW),
    (S.FIT_REVIEW, S.ALIGNER_PRODUCTION),
    (S.FIT_REVIEW, S.FIT_ISSUE),
    # Receiving the batch with the last aligner finishes the case, and it is the
    # clinic that confirms receipt.
    (S.DISPATCHING, S.COMPLETED),
    (S.DISPATCHING, S.ALIGNER_PRODUCTION),
    # Sending the phase's progress photographs is what hands it to the lab.
    (S.DISPATCHING, S.PHASE_REVIEW),
    # The clinic is the one who finds an aligner that does not fit.
    (S.DISPATCHING, S.FIT_ISSUE),
    (S.PHASE_REVIEW, S.FIT_ISSUE),
    (S.DRAFT, S.CANCELLED),
}

# What the other party sees in their notification bell.
NOTICE: dict[OrderStatus, str] = {
    S.SUBMITTED: "New case submitted",
    S.UNDER_REVIEW: "Case is under review",
    S.RECORDS_REQUESTED: "More records needed",
    S.QUOTED: "Quote ready for your approval",
    S.AWAITING_SCAN: "Quote accepted — scan required",
    S.SCAN_SUBMITTED: "Scan received, under review",
    S.IN_PLANNING: "Treatment planning started",
    # The plan fee comes before the approval, so the alert should not send the
    # clinic looking for an approve button they cannot use yet.
    S.PLAN_SHARED: "Treatment plan ready — unlock it to review",
    S.TRAINING_ALIGNER_PRODUCTION: "Training aligner in production",
    S.TRAINING_ALIGNER_SHIPPED: "Training aligner shipped",
    S.FIT_REVIEW: "Please confirm the training aligner fit",
    S.FIT_ISSUE: "Fit issue reported",
    S.ALIGNER_PRODUCTION: "Aligners in production",
    S.DISPATCHING: "Aligners dispatched",
    S.PHASE_REVIEW: "Progress photographs to review",
    S.COMPLETED: "Case completed",
    S.CANCELLED: "Case cancelled",
}


class TransitionError(HTTPException):
    def __init__(self, detail: str):
        super().__init__(status_code=http_status.HTTP_409_CONFLICT, detail=detail)


def can_transition(frm: OrderStatus, to: OrderStatus) -> bool:
    return to in ALLOWED.get(frm, set())


def assert_status(order: Order, *expected: OrderStatus) -> None:
    """Guard an action that is only valid from certain statuses."""
    if order.status not in expected:
        names = " or ".join(STATUS_LABELS[e] for e in expected)
        raise TransitionError(
            f"Order {order.reference} is {STATUS_LABELS[order.status]}; this action needs {names}."
        )


def _rename_storage_folder(order: Order) -> None:
    """Moves the case folder from its enquiry ref to its new AL number.

    Never allowed to block the transition: a case that reached planning matters
    more than a tidy folder name, and the stored refs stay valid either way.
    """
    old_name = order.enquiry_number
    new_name = order.order_number
    if not order.files and order.storage_folder_ref is None:
        return
    try:
        from .services.storage import get_storage

        storage = get_storage()
        moved = storage.rename_order_folder(old_name, new_name)
        if moved is None:
            return
        order.storage_folder_ref = moved
        # Local refs embed the folder name; Drive refs are ids and need nothing.
        prefix = f"Orders/{old_name}/"
        for f in order.files:
            if f.storage_ref and f.storage_ref.startswith(prefix):
                f.storage_ref = f"Orders/{new_name}/" + f.storage_ref[len(prefix) :]
    except Exception:  # pragma: no cover - storage is best effort here
        log.exception("Could not rename case folder %s -> %s", old_name, new_name)


def transition(
    db: Session,
    order: Order,
    to: OrderStatus,
    actor: Optional[User],
    note: str = "",
    metadata: Optional[dict] = None,
) -> StatusEvent:
    frm = order.status

    if frm in TERMINAL_STATUSES:
        raise TransitionError(
            f"Order {order.reference} is {STATUS_LABELS[frm]} and cannot change."
        )
    if not can_transition(frm, to):
        raise TransitionError(
            f"Cannot move {order.reference} from {STATUS_LABELS[frm]} to {STATUS_LABELS[to]}."
        )
    # The two shortcuts out of DRAFT belong to one kind each. Enforced here
    # rather than only at the caller, so the permission cannot be widened by a
    # second route being added later that forgets to check.
    if (frm, to) == (S.DRAFT, S.AWAITING_SCAN) and order.kind != OrderKind.PRODUCT:
        raise TransitionError(
            f"{order.reference} has to be quoted and accepted before a scan is asked for."
        )
    if (frm, to) == (S.DRAFT, S.PRODUCT_FABRICATION) and order.kind != OrderKind.ACCESSORY:
        raise TransitionError(
            f"{order.reference} has to be reviewed before it reaches the bench."
        )
    if actor is not None and actor.role == UserRole.DOCTOR and (frm, to) not in DOCTOR_MOVES:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Only 3D Align staff can make this change.",
        )

    # Reaching planning is what spends an AL number. Every route into planning
    # comes through here, and the guard makes a second pass (a replan, a fit
    # issue sent back) a no-op.
    if to == S.IN_PLANNING and order.order_number is None:
        order.order_number = next_order_number(db)
        _rename_storage_folder(order)
    # A product order never reaches planning, so reaching the bench is what
    # earns it its number — and it takes one from its own product's series
    # rather than spending an aligner number on a bleaching tray.
    elif to == S.PRODUCT_FABRICATION and order.order_number is None:
        if order.product is not None:
            order.order_number = next_product_number(
                db, order.product.code, order.product_size.label if order.product_size else ""
            )
            _rename_storage_folder(order)
        elif order.kind == OrderKind.ACCESSORY:
            order.order_number = next_accessory_number(db)
            _rename_storage_folder(order)

    order.status = to
    now = utcnow()
    if to == S.SUBMITTED:
        order.submitted_at = now
    elif to == S.AWAITING_SCAN and order.approved_at is None:
        order.approved_at = now
    elif to == S.COMPLETED:
        order.completed_at = now
    elif to == S.CANCELLED:
        order.cancelled_at = now

    event = StatusEvent(
        order_id=order.id,
        from_status=frm,
        to_status=to,
        actor_id=actor.id if actor else None,
        note=note,
        event_metadata=metadata,
    )
    db.add(event)
    _notify(db, order, to, actor, note)
    return event


def _notify(
    db: Session, order: Order, to: OrderStatus, actor: Optional[User], note: str
) -> None:
    """Tell whoever did not make the change."""
    title = NOTICE.get(to, STATUS_LABELS[to])
    # A by-product was never quoted, so "quote accepted" is the wrong headline
    # for the alert that asks its clinic for a scan.
    if to == S.AWAITING_SCAN and order.kind != OrderKind.ALIGNER:
        title = "Scan required"
    body = f"{order.reference} — {order.patient.full_name}"
    if note:
        body = f"{body}\n{note}"

    recipients: list[str] = []
    actor_is_doctor = actor is not None and actor.role == UserRole.DOCTOR

    if not actor_is_doctor:
        recipients.append(order.doctor.user_id)
    if actor_is_doctor or actor is None:
        staff = db.query(User).filter(User.role.in_(LAB_ROLES), User.is_active.is_(True)).all()
        recipients.extend(u.id for u in staff)

    for user_id in dict.fromkeys(recipients):
        db.add(Notification(user_id=user_id, order_id=order.id, title=title, body=body))
