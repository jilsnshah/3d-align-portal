"""What a case owes, and what has been paid.

The lab collects by UPI. Nothing is charged through the portal — the clinic taps
"Pay now", their own UPI app opens with the payee and the amount already filled
in, they send the money, and they upload the screenshot. The lab checks it. Only
then does the thing being paid for unlock.

Three charges make up a case:

  * the treatment plan, once, before the plan is released to the clinic;
  * the training fit aligner, once, before it ships;
  * the production aligners, split across the phases the clinic chose, with
    delivery added to each batch after the first — the first delivery is on
    the lab.

The first two are one-time by construction: there is at most one payment row per
(case, kind, phase), so a plan revision, a mid-course rescan or a refabricated
training aligner reuses the row that is already there. The charge cannot be
raised twice because there is nowhere to put a second one.

Production money is what is left of the quoted price after those two fees, since
they were collected separately — never charged again inside the phases.
"""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from typing import Optional
from urllib.parse import quote

from sqlalchemy.orm import Session

from ..enums import DispatchMode, PaymentKind, PaymentStatus
from ..models import Order, Payment, ShippingRate

CENTS = Decimal("0.01")

# Delivery of the first production batch is not charged. A single-delivery case
# is one phase, so it is the first batch too and ships free of delivery.
FREE_DELIVERY_PHASE = 1


def money(value) -> Decimal:
    return Decimal(value or 0).quantize(CENTS, rounding=ROUND_HALF_UP)


# --------------------------------------------------------------------------
# The fee schedule
# --------------------------------------------------------------------------


def shipping_for(db: Session, settings, city: str) -> Decimal:
    """Delivery to a city, falling back to the default when the lab has not
    priced that city yet."""
    if city:
        row = (
            db.query(ShippingRate)
            .filter(ShippingRate.city.ilike(city.strip()), ShippingRate.is_active.is_(True))
            .first()
        )
        if row is not None:
            return money(row.amount)
    return money(settings.default_shipping_fee)


def delivery_city(order: Order) -> str:
    address = order.shipping_address
    return address.city if address is not None else ""


def quoted_total(order: Order) -> Decimal:
    """The figure the case is being sold at — the plan's confirmed price once it
    exists, otherwise the accepted estimate."""
    plan = order.approved_plan or order.current_plan
    if plan is not None and plan.final_total:
        return money(plan.final_total)
    quote_row = order.accepted_quote or order.current_quote
    return money(quote_row.total) if quote_row is not None else Decimal("0")


def production_total(order: Order, settings) -> Decimal:
    """What the production aligners are worth on their own.

    The plan fee and the training-fit fee were collected separately, so they come
    off the quoted price rather than being charged a second time inside the
    phases. A quote smaller than the two fees would otherwise produce a negative
    phase, so the floor is zero.
    """
    remaining = quoted_total(order) - money(settings.plan_fee) - money(settings.training_fit_fee)
    return remaining if remaining > 0 else Decimal("0")


def phase_split(order: Order, settings) -> list:
    """What each production phase costs, before delivery.

    Split equally, with any rounding remainder going to the last phase so the
    parts add back up to the whole. A single delivery is simply one phase.
    """
    count = phase_count(order)
    if count <= 0:
        return []
    total = production_total(order, settings)
    each = money(total / count)
    parts = [each] * count
    # Whatever rounding lost or gained lands on the final phase.
    parts[-1] = money(total - each * (count - 1))
    return parts


def phase_count(order: Order) -> int:
    """How many production payments this case has.

    A full-case dispatch is one phase; a phased one is however many the clinic
    asked for. Before the clinic has chosen, there are none to raise.
    """
    if order.dispatch_mode is None:
        return 0
    if order.dispatch_mode == DispatchMode.FULL:
        return 1
    return order.phase_count or 0


# --------------------------------------------------------------------------
# Raising the charges
# --------------------------------------------------------------------------


def _find(order: Order, kind: str, phase: int = 0) -> Optional[Payment]:
    return next(
        (p for p in order.payments if p.kind == kind and (p.phase_number or 0) == phase),
        None,
    )


def _ensure(db: Session, order: Order, kind: str, phase: int, amount: Decimal, shipping: Decimal):
    """Create the charge if it is not there, and keep its amount current while
    it is still unpaid. A verified payment is never re-priced — the clinic paid
    what it was shown."""
    row = _find(order, kind, phase)
    if row is None:
        row = Payment(
            order_id=order.id,
            kind=kind,
            phase_number=phase,
            amount=amount,
            shipping_amount=shipping,
        )
        db.add(row)
        order.payments.append(row)
        return row
    if row.status in (PaymentStatus.DUE, PaymentStatus.REJECTED):
        row.amount = amount
        row.shipping_amount = shipping
    return row


def sync(db: Session, order: Order) -> list:
    """Make the case's charges match where it has got to.

    Called wherever the case moves, so the clinic sees a charge the moment it
    becomes payable and never before.
    """
    settings = _settings(db)

    # The plan fee becomes payable as soon as there is a plan to release.
    if order.plans:
        _ensure(
            db,
            order,
            PaymentKind.TREATMENT_PLAN,
            0,
            money(settings.plan_fee),
            Decimal("0"),
        )

    # The training-fit fee becomes payable once the clinic has approved a plan.
    if order.approved_plan is not None:
        _ensure(
            db,
            order,
            PaymentKind.TRAINING_FIT,
            0,
            money(settings.training_fit_fee),
            Decimal("0"),
        )

    # Production phases appear once the clinic has said how the series ships.
    parts = phase_split(order, settings)
    if parts:
        ship = shipping_for(db, settings, delivery_city(order))
        for index, amount in enumerate(parts, start=1):
            # The first delivery is on the lab. Every batch after it carries the
            # rate for the clinic's city.
            _ensure(
                db,
                order,
                PaymentKind.PRODUCTION_PHASE,
                index,
                amount,
                Decimal("0") if index == FREE_DELIVERY_PHASE else ship,
            )

    return order.payments


def _settings(db: Session):
    from . import scheduling

    return scheduling.get_settings(db)


# --------------------------------------------------------------------------
# Reading the state
# --------------------------------------------------------------------------


def is_settled(order: Order, kind: str, phase: int = 0) -> bool:
    row = _find(order, kind, phase)
    return row is not None and row.status == PaymentStatus.VERIFIED


def plan_unlocked(order: Order) -> bool:
    """Whether the clinic may see the treatment plan yet."""
    return is_settled(order, PaymentKind.TREATMENT_PLAN)


def blocker_for(order: Order, kind: str, phase: int = 0) -> Optional[str]:
    """Why this step cannot happen yet, or None when it can."""
    row = _find(order, kind, phase)
    if row is None:
        return None
    if row.status == PaymentStatus.VERIFIED:
        return None
    if row.status == PaymentStatus.SUBMITTED:
        return "The receipt is with 3D Align for checking."
    if row.status == PaymentStatus.REJECTED:
        return f"The last receipt was not accepted: {row.rejected_reason}"
    return "This is waiting on payment."


# --------------------------------------------------------------------------
# The UPI hand-off
# --------------------------------------------------------------------------


def upi_link(settings, amount: Decimal, note: str, reference: str = "") -> str:
    """A UPI intent the clinic's phone can open.

    Tapping it hands the payee, the amount and the note to whichever UPI app
    they use, so nothing is typed in by hand and the money cannot land in the
    wrong place or arrive short. Empty when the lab has not set a UPI ID.
    """
    if not settings.upi_vpa:
        return ""
    params = [
        f"pa={quote(settings.upi_vpa)}",
        f"pn={quote(settings.upi_payee_name or '3D Align')}",
        f"am={money(amount)}",
        "cu=INR",
        f"tn={quote(note[:50])}",
    ]
    if reference:
        params.append(f"tr={quote(reference[:35])}")
    return "upi://pay?" + "&".join(params)
