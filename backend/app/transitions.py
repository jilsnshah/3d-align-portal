"""The only place `Order.status` is allowed to change.

Every move is checked against ALLOWED, recorded as a StatusEvent, and fanned out
as a notification — all inside the caller's transaction. Endpoints never assign
`order.status` directly.
"""

from __future__ import annotations

from typing import Optional

from fastapi import HTTPException, status as http_status
from sqlalchemy.orm import Session

from .enums import STATUS_LABELS, TERMINAL_STATUSES, OrderStatus, UserRole
from .models import Notification, Order, StatusEvent, User, utcnow

S = OrderStatus

ALLOWED: dict[OrderStatus, set[OrderStatus]] = {
    S.DRAFT: {S.SUBMITTED, S.CANCELLED},
    S.SUBMITTED: {S.UNDER_REVIEW, S.CANCELLED},
    S.UNDER_REVIEW: {S.RECORDS_REQUESTED, S.QUOTED, S.CANCELLED},
    S.RECORDS_REQUESTED: {S.UNDER_REVIEW, S.CANCELLED},
    # Re-sending a quote keeps the order in QUOTED with a new version.
    S.QUOTED: {S.QUOTED, S.AWAITING_SCAN, S.CANCELLED},
    # The scan is either still coming (AWAITING_SCAN) or with the lab to verify
    # (SCAN_SUBMITTED). Rejecting a scan sends it back for another attempt.
    S.AWAITING_SCAN: {S.SCAN_SUBMITTED, S.CANCELLED},
    S.SCAN_SUBMITTED: {S.IN_PLANNING, S.AWAITING_SCAN, S.CANCELLED},
    S.IN_PLANNING: {S.PLAN_SHARED, S.CANCELLED},
    S.PLAN_SHARED: {S.IN_PLANNING, S.TRAINING_ALIGNER_PRODUCTION, S.CANCELLED},
    S.TRAINING_ALIGNER_PRODUCTION: {S.TRAINING_ALIGNER_SHIPPED, S.CANCELLED},
    S.TRAINING_ALIGNER_SHIPPED: {S.FIT_REVIEW, S.CANCELLED},
    S.FIT_REVIEW: {S.ALIGNER_PRODUCTION, S.FIT_ISSUE, S.CANCELLED},
    S.FIT_ISSUE: {S.AWAITING_SCAN, S.IN_PLANNING, S.TRAINING_ALIGNER_PRODUCTION, S.CANCELLED},
    S.ALIGNER_PRODUCTION: {S.DISPATCHING, S.CANCELLED},
    S.DISPATCHING: {S.COMPLETED, S.CANCELLED},
    S.COMPLETED: set(),
    S.CANCELLED: set(),
}

# Who may drive each move. Anything not listed is staff-only.
DOCTOR_MOVES: set[tuple[OrderStatus, OrderStatus]] = {
    (S.DRAFT, S.SUBMITTED),
    (S.RECORDS_REQUESTED, S.UNDER_REVIEW),
    (S.QUOTED, S.AWAITING_SCAN),
    # Uploading an STL hands the scan to the lab. Accepting it is staff-only.
    (S.AWAITING_SCAN, S.SCAN_SUBMITTED),
    (S.PLAN_SHARED, S.TRAINING_ALIGNER_PRODUCTION),
    (S.PLAN_SHARED, S.IN_PLANNING),
    (S.FIT_REVIEW, S.ALIGNER_PRODUCTION),
    (S.FIT_REVIEW, S.FIT_ISSUE),
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
    S.PLAN_SHARED: "Treatment plan ready for your approval",
    S.TRAINING_ALIGNER_PRODUCTION: "Training aligner in production",
    S.TRAINING_ALIGNER_SHIPPED: "Training aligner shipped",
    S.FIT_REVIEW: "Please confirm the training aligner fit",
    S.FIT_ISSUE: "Fit issue reported",
    S.ALIGNER_PRODUCTION: "Aligners in production",
    S.DISPATCHING: "Aligners dispatched",
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
            f"Order {order.order_number} is {STATUS_LABELS[order.status]}; this action needs {names}."
        )


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
            f"Order {order.order_number} is {STATUS_LABELS[frm]} and cannot change."
        )
    if not can_transition(frm, to):
        raise TransitionError(
            f"Cannot move {order.order_number} from {STATUS_LABELS[frm]} to {STATUS_LABELS[to]}."
        )
    if actor is not None and actor.role == UserRole.DOCTOR and (frm, to) not in DOCTOR_MOVES:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Only 3D Align staff can make this change.",
        )

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
    body = f"{order.order_number} — {order.patient.full_name}"
    if note:
        body = f"{body}\n{note}"

    recipients: list[str] = []
    actor_is_doctor = actor is not None and actor.role == UserRole.DOCTOR

    if not actor_is_doctor:
        recipients.append(order.doctor.user_id)
    if actor_is_doctor or actor is None:
        staff = db.query(User).filter(User.role == UserRole.STAFF, User.is_active.is_(True)).all()
        recipients.extend(u.id for u in staff)

    for user_id in dict.fromkeys(recipients):
        db.add(Notification(user_id=user_id, order_id=order.id, title=title, body=body))
