"""Refrens invoicing.

Ported from the old ``invoice_client.py``. One substantive change: credentials
come from the environment. The previous version had the EC private key as a
string literal in the source and it is in the repository's git history — rotate
that key in the Refrens dashboard before using this.

If credentials are absent the portal still works; invoice generation returns a
clear error instead of failing obscurely.
"""

from __future__ import annotations

import datetime
import logging
from decimal import Decimal

import requests

from ..config import settings

log = logging.getLogger(__name__)

AUTH_URL = "https://api.refrens.com/authentication"
API_BASE = "https://api.refrens.com/businesses"

# GST state codes, needed on the billedTo block.
STATE_CODES = {
    "jammu and kashmir": "01", "himachal pradesh": "02", "punjab": "03",
    "chandigarh": "04", "uttarakhand": "05", "haryana": "06", "delhi": "07",
    "rajasthan": "08", "uttar pradesh": "09", "bihar": "10", "sikkim": "11",
    "arunachal pradesh": "12", "nagaland": "13", "manipur": "14",
    "mizoram": "15", "tripura": "16", "meghalaya": "17", "assam": "18",
    "west bengal": "19", "jharkhand": "20", "odisha": "21", "orissa": "21",
    "chhattisgarh": "22", "madhya pradesh": "23", "gujarat": "24",
    "daman and diu": "25", "dadra and nagar haveli": "26", "maharashtra": "27",
    "karnataka": "29", "goa": "30", "lakshadweep": "31", "kerala": "32",
    "tamil nadu": "33", "puducherry": "34", "andaman and nicobar islands": "35",
    "telangana": "36", "andhra pradesh": "37", "ladakh": "38",
}


def get_state_code(state_name: str) -> str:
    return STATE_CODES.get((state_name or "").strip().lower(), "")


class BillingNotConfigured(RuntimeError):
    pass


def is_configured() -> bool:
    return bool(
        settings.refrens_app_id and settings.refrens_private_key and settings.refrens_business_key
    )


def _access_token() -> str:
    import jwt

    payload = {
        "iss": settings.refrens_app_id,
        "aud": "serana",
        "sub": settings.refrens_app_id,
        "auth": {"entity": "app", "strategy": "app-iss-app-token"},
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
    }
    signed = jwt.encode(payload, settings.refrens_private_key, algorithm="ES256")

    response = requests.post(
        AUTH_URL,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {signed}"},
        json={"strategy": "app-iss-app-token"},
        timeout=30,
    )
    data = response.json() if response.content else {}
    token = data.get("accessToken")
    if response.status_code != 201 or not token:
        raise RuntimeError(f"Refrens rejected the app token ({response.status_code}).")
    return token


def build_invoice_payload(order, quote, doctor, address, plan=None) -> dict:
    """Line items come from the accepted quote — nothing is hardcoded here except
    the model print fee, which is a configurable setting."""
    if plan is not None and plan.final_total:
        # The plan knows the real aligner count, so bill that band.
        from ..enums import category_label

        # Refrens totals its own line items, so the discount is folded into the
        # rate rather than sent as a negative line, and named so the clinic can
        # see what came off.
        discount = Decimal(plan.final_discount or 0)
        net = Decimal(plan.final_price or 0) - discount
        name = (
            f"{category_label(plan.final_category)} — clear aligner treatment "
            f"({plan.aligners_upper + plan.aligners_lower} aligners)"
        )
        if discount > 0:
            name += f" — incl. discount of {discount:,.2f}"
            if plan.final_discount_reason:
                name += f" ({plan.final_discount_reason})"
        items = [{"name": name, "rate": float(net), "quantity": 1}]
        items += [
            {"name": i.description, "rate": float(i.unit_price), "quantity": int(i.quantity)}
            for i in quote.line_items[1:]
        ]
    else:
        items = [
            {
                "name": item.description,
                "rate": float(item.unit_price),
                "quantity": int(item.quantity),
            }
            for item in quote.line_items
        ]
    if settings.invoice_model_print_fee:
        items.append(
            {
                "name": "3D model print",
                "rate": float(settings.invoice_model_print_fee),
                "quantity": 1,
            }
        )

    today = datetime.date.today()
    return {
        "invoiceTitle": "Invoice",
        "invoiceSubTitle": (
            f"Clear aligner treatment — {order.patient.full_name}"
            if order.patient is not None
            else "3D Align order"
        ),
        "invoiceNumber": order.order_number,
        "invoiceDate": today.isoformat(),
        "dueDate": (today + datetime.timedelta(days=30)).isoformat(),
        "invoiceType": "INVOICE",
        "currency": quote.currency,
        "billedTo": {
            "name": doctor.clinic_name or doctor.full_name,
            "street": address.line1 if address else "",
            "pincode": address.pincode if address else "",
            "gstState": get_state_code(address.state if address else ""),
            "country": "IN",
            "phone": doctor.phone,
        },
        "items": items,
    }


def create_invoice(payload: dict) -> dict:
    if not is_configured():
        raise BillingNotConfigured(
            "Invoicing is not set up. Add REFRENS_APP_ID, REFRENS_PRIVATE_KEY and "
            "REFRENS_BUSINESS_KEY to the environment."
        )

    token = _access_token()
    response = requests.post(
        f"{API_BASE}/{settings.refrens_business_key}/invoices",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        json=payload,
        timeout=60,
    )
    if response.status_code not in (200, 201):
        detail = response.text[:400]
        raise RuntimeError(f"Refrens could not create the invoice ({response.status_code}): {detail}")

    data = response.json()
    share = data.get("share") or {}
    return {
        "provider_invoice_id": data.get("_id", ""),
        "pdf_url": share.get("pdf", ""),
        "share_url": share.get("link", ""),
    }


def quote_total(quote) -> Decimal:
    return Decimal(quote.total or 0)
