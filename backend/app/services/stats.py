"""What the practice and the lab have actually been doing.

Both sides ask the same questions of the same rows — how many cases, of what,
when, and worth how much — so one module answers them and the two routers
differ only in what they are allowed to scope to. A doctor sees their own
practice broken down by branch; the lab sees every clinic broken down by
doctor. Neither can reach the other's cut.

Aggregated in Python rather than in SQL. The band a case sits in is derived
from its plan and its quote, not stored on the order, so a SQL rollup would
have to reimplement that rule and would drift from what every other screen
shows. At this lab's volume — hundreds of cases a year, not millions — reading
the window and counting it is both faster to trust and impossible to disagree
with the case list.
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session, selectinload

from ..enums import OrderKind, OrderStatus, PaymentStatus, category_label
from ..models import Order, Payment

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def window(view: str, year: int, month: Optional[int]) -> tuple:
    """The half-open range a view covers, [start, end).

    Half-open because a case created at 23:59:59.7 on the last day of December
    belongs to that December, and a closed range built from date arithmetic
    drops it.
    """
    if view == "month":
        month = month or 1
        start = datetime(year, month, 1, tzinfo=timezone.utc)
        end = (
            datetime(year + 1, 1, 1, tzinfo=timezone.utc)
            if month == 12
            else datetime(year, month + 1, 1, tzinfo=timezone.utc)
        )
        return start, end
    return (
        datetime(year, 1, 1, tzinfo=timezone.utc),
        datetime(year + 1, 1, 1, tzinfo=timezone.utc),
    )


def buckets(view: str, year: int, month: Optional[int]) -> list:
    """The empty shape of the chart, before anything is counted.

    Built from the calendar rather than from the rows, so a month with no work
    is a gap in the line instead of vanishing and making the year look busier
    than it was.
    """
    if view == "month":
        days = calendar.monthrange(year, month or 1)[1]
        return [(f"{year}-{month:02d}-{d:02d}", str(d)) for d in range(1, days + 1)]
    return [(f"{year}-{i + 1:02d}", MONTHS[i]) for i in range(12)]


def _bucket_key(when: datetime, view: str) -> str:
    return when.strftime("%Y-%m-%d") if view == "month" else when.strftime("%Y-%m")


def _local(when: datetime) -> datetime:
    """Naive timestamps come out of SQLite; treat them as UTC rather than
    letting the comparison below raise."""
    return when if when.tzinfo is not None else when.replace(tzinfo=timezone.utc)


def available_years(db: Session, doctor_id: Optional[str]) -> list:
    """The years that actually hold work, newest first.

    A year picker offering years the practice did not exist in is a picker that
    mostly leads to empty pages.
    """
    query = db.query(Order.created_at)
    if doctor_id:
        query = query.filter(Order.doctor_id == doctor_id)
    years = {_local(row[0]).year for row in query.all() if row[0] is not None}
    years.add(datetime.now(timezone.utc).year)
    return sorted(years, reverse=True)


def collect(
    db: Session,
    view: str,
    year: int,
    month: Optional[int],
    doctor_id: Optional[str] = None,
) -> dict:
    view = "month" if view == "month" else "year"
    start, end = window(view, year, month)

    orders_query = (
        db.query(Order)
        .filter(Order.created_at >= start, Order.created_at < end)
        .options(
            selectinload(Order.product),
            selectinload(Order.quotes),
            selectinload(Order.plans),
            selectinload(Order.doctor),
            selectinload(Order.shipping_address),
        )
    )
    if doctor_id:
        orders_query = orders_query.filter(Order.doctor_id == doctor_id)
    orders = orders_query.all()

    shape = buckets(view, year, month)
    by_bucket = {key: {"aligners": 0, "products": 0} for key, _ in shape}

    totals = {"orders": 0, "aligners": 0, "products": 0, "cancelled": 0}
    patients = set()
    products: dict = defaultdict(lambda: {"orders": 0, "units": 0, "label": ""})
    categories: dict = defaultdict(int)
    doctors: dict = defaultdict(lambda: {"orders": 0, "label": "", "note": ""})
    branches: dict = defaultdict(lambda: {"orders": 0, "label": ""})

    for order in orders:
        # A cancelled case is counted so the number is honest, then kept out of
        # the breakdowns: it says what was asked for, not what was made.
        if order.status == OrderStatus.CANCELLED:
            totals["cancelled"] += 1
            continue

        totals["orders"] += 1
        patients.add(order.patient_id)
        key = _bucket_key(_local(order.created_at), view)

        if order.kind == OrderKind.PRODUCT:
            totals["products"] += 1
            if key in by_bucket:
                by_bucket[key]["products"] += 1
            if order.product is not None:
                slot = products[order.product.code]
                slot["label"] = order.product.name
                slot["orders"] += 1
                slot["units"] += max(order.quantity or 1, 1)
        else:
            totals["aligners"] += 1
            if key in by_bucket:
                by_bucket[key]["aligners"] += 1
            # Only bands that have been decided. Counting "not set yet" as a
            # band of its own would make the commonest band a non-answer.
            if order.aligner_category:
                categories[order.aligner_category] += 1

        if doctor_id is None and order.doctor is not None:
            slot = doctors[order.doctor_id]
            slot["label"] = order.doctor.full_name
            slot["note"] = order.doctor.clinic_name or ""
            slot["orders"] += 1
        if doctor_id is not None and order.shipping_address is not None:
            slot = branches[order.shipping_address_id]
            slot["label"] = (
                order.shipping_address.label or order.shipping_address.city or "Clinic"
            )
            slot["orders"] += 1

    # Money is counted on the day it was verified, not the day the case was
    # opened — a case raised in March and paid in May is May's cash. Mixing the
    # two into one figure is how a report disagrees with the bank.
    paid_query = (
        db.query(Payment)
        .join(Payment.order)
        .filter(
            Payment.status == PaymentStatus.VERIFIED,
            Payment.verified_at >= start,
            Payment.verified_at < end,
        )
    )
    if doctor_id:
        paid_query = paid_query.filter(Order.doctor_id == doctor_id)

    paid_total = Decimal("0")
    paid_bucket = {key: Decimal("0") for key, _ in shape}
    for payment in paid_query.all():
        amount = Decimal(payment.total or 0)
        paid_total += amount
        key = _bucket_key(_local(payment.verified_at), view)
        if key in paid_bucket:
            paid_bucket[key] += amount

    def ranked(rows: dict, value_key: str = "orders") -> list:
        return sorted(
            (
                {
                    "key": key,
                    "label": data["label"],
                    "note": data.get("note", ""),
                    "orders": data["orders"],
                    "units": data.get("units", data["orders"]),
                }
                for key, data in rows.items()
            ),
            key=lambda row: (-row[value_key], row["label"]),
        )

    return {
        "view": view,
        "year": year,
        "month": month if view == "month" else None,
        "period_label": (
            f"{calendar.month_name[month or 1]} {year}" if view == "month" else str(year)
        ),
        "totals": {
            **totals,
            "patients": len(patients),
            "paid": paid_total,
        },
        "series": [
            {
                "key": key,
                "label": label,
                "aligners": by_bucket[key]["aligners"],
                "products": by_bucket[key]["products"],
                "paid": paid_bucket[key],
            }
            for key, label in shape
        ],
        "products": ranked(products),
        "categories": [
            {
                "key": key,
                "label": category_label(key),
                "note": "",
                "orders": count,
                "units": count,
            }
            for key, count in sorted(categories.items(), key=lambda kv: -kv[1])
        ],
        "doctors": ranked(doctors),
        "branches": ranked(branches),
    }
