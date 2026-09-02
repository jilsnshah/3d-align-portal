"""Shipment delivery.

Both the lab and the clinic can confirm a parcel arrived — the clinic usually
knows first. One function so the two paths cannot drift: the same side effects
fire whoever presses the button.
"""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from ..enums import OrderKind, OrderStatus, ShipmentStatus, ShipmentType, UserRole
from ..models import Notification, Shipment, User, utcnow
from ..transitions import transition


def mark_delivered(db: Session, shipment: Shipment, actor: User) -> None:
    if shipment.status == ShipmentStatus.DELIVERED:
        raise HTTPException(status.HTTP_409_CONFLICT, "That shipment is already marked delivered.")

    shipment.status = ShipmentStatus.DELIVERED
    shipment.delivered_at = utcnow()
    order = shipment.order

    # Delivery of the training aligner is what opens the fit review — the case
    # cannot ask about fit before the appliance is in the clinic's hands.
    if (
        shipment.shipment_type == ShipmentType.TRAINING_ALIGNER
        and order.status == OrderStatus.TRAINING_ALIGNER_SHIPPED
    ):
        transition(
            db,
            order,
            OrderStatus.FIT_REVIEW,
            actor,
            note="Training aligner delivered — fit confirmation requested.",
        )
        return

    # A by-product and a box of accessories go out in one parcel. Once it has
    # arrived there is nothing left to make, ship or review, so the order is
    # finished — asking someone to press "complete" afterwards is asking them
    # to confirm something the delivery already said.
    #
    # An aligner case is not finished by a delivery: the clinic wears the batch,
    # sends its photographs, and the lab decides what ships next.
    if (
        order.kind in (OrderKind.PRODUCT, OrderKind.ACCESSORY)
        and order.status == OrderStatus.DISPATCHING
        and all(s.status == ShipmentStatus.DELIVERED for s in order.shipments)
    ):
        transition(
            db,
            order,
            OrderStatus.COMPLETED,
            actor,
            note="Delivered — nothing further on this order.",
        )
        return

    # Everything else is bookkeeping, so tell the other party rather than
    # moving the case.
    label = (
        f"Phase {shipment.phase_number}"
        if shipment.phase_number
        else shipment.shipment_type.replace("_", " ").lower()
    )
    recipient = (
        order.doctor.user_id
        if actor.role != UserRole.DOCTOR
        else None  # staff are notified below
    )
    if recipient:
        db.add(
            Notification(
                user_id=recipient,
                order_id=order.id,
                title="Shipment delivered",
                body=f"{order.reference} — {label} marked delivered.",
            )
        )
    else:
        staff = db.query(User).filter(User.role == UserRole.ADMIN, User.is_active.is_(True)).all()
        for member in staff:
            db.add(
                Notification(
                    user_id=member.id,
                    order_id=order.id,
                    title="Delivery confirmed by the clinic",
                    body=f"{order.reference} — {label} received.",
                )
            )
