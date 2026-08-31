"""Doctor-owned reference data: addresses and patients."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import schemas
from ..config import settings as app_settings
from ..db import get_db
from ..deps import current_doctor, verified_doctor
from ..services.geo import locate_for
from ..models import Address, Doctor, Order, Patient

router = APIRouter(tags=["directory"])


# --------------------------------------------------------------------------
# Addresses
# --------------------------------------------------------------------------


@router.get("/config/map")
def map_config():
    """What the map picker needs before anyone has signed in.

    The browser key is meant to be in the page — it is restricted by HTTP
    referrer, which is what protects it. The server key never appears here.
    """
    from ..services import scheduling
    from ..db import SessionLocal

    with SessionLocal() as db:
        settings = scheduling.get_settings(db)
        centre = scheduling.lab_point(settings)
    return {
        "browser_key": app_settings.google_maps_browser_key,
        "centre": {"lat": centre[0], "lng": centre[1]} if centre else None,
        "service_city": settings.service_city,
    }


@router.get("/config/search")
def address_search(q: str):
    """Where is this typed address? Drives the pin following the form."""
    from ..services import scheduling
    from ..services.geo import search
    from ..db import SessionLocal

    with SessionLocal() as db:
        centre = scheduling.lab_point(scheduling.get_settings(db))
    return {"result": search(q, centre)}


@router.get("/config/suggest")
def address_suggest(q: str):
    """Autocomplete as the doctor types. Empty until Places is enabled."""
    from ..services import scheduling
    from ..services.geo import suggest
    from ..db import SessionLocal

    with SessionLocal() as db:
        centre = scheduling.lab_point(scheduling.get_settings(db))
    return {"suggestions": suggest(q, centre)}


@router.get("/config/reverse-geocode")
def reverse_geocode(lat: float, lng: float):
    """Turns a dropped pin into a readable address, using the server key."""
    from ..services.geo import describe

    found = describe((lat, lng))
    return {"address": (found or {}).get("formatted", ""), "parts": found or {}}


@router.get("/products", response_model=list[schemas.ProductOut])
def product_catalogue(db: Session = Depends(get_db)):
    """What the lab makes besides staged aligner series.

    One list, read by the clinic's order form and by the lab. The previous
    system kept the catalogue in two places and they drifted — three products
    were orderable but missing from the list its assistant classified against,
    so a doctor asking for a sports guard could not be routed.
    """
    from ..services import catalogue

    return [schemas.ProductOut.model_validate(p) for p in catalogue.catalogue(db)]


@router.get("/ordering-hold", response_model=schemas.OrderingHoldOut)
def ordering_hold(doctor: Doctor = Depends(verified_doctor), db: Session = Depends(get_db)):
    """Whether an unpaid appliance is holding up the next one.

    Accessories are never held: they are paid before they leave the building,
    so they cannot be both delivered and unpaid.
    """
    from ..enums import PaymentKind, PaymentStatus
    from ..services import payments

    outstanding = payments.unsettled_product_order(db, doctor.id)
    if outstanding is None:
        return schemas.OrderingHoldOut(can_order_products=True)

    row = next(
        (p for p in outstanding.payments if p.kind == PaymentKind.PRODUCT_ORDER), None
    )
    reason = (
        "the receipt is with 3D Align for checking"
        if row is not None and row.status == PaymentStatus.SUBMITTED
        else "it has not been paid for yet"
    )
    return schemas.OrderingHoldOut(
        can_order_products=False,
        reference=outstanding.reference,
        reason=reason,
    )


@router.get("/accessories", response_model=list[schemas.AccessoryOut])
def accessory_catalogue(db: Session = Depends(get_db)):
    """What the lab keeps on a shelf.

    Open to any signed-in clinic, the same as the product catalogue: a price
    list is not a secret, and the order it feeds is guarded on its own.
    """
    from ..services import accessories

    return accessories.catalogue(db)


@router.get("/stats", response_model=schemas.StatsOut)
def practice_stats(
    view: str = Query(default="year", pattern="^(year|month)$"),
    year: Optional[int] = Query(default=None, ge=2000, le=2100),
    month: Optional[int] = Query(default=None, ge=1, le=12),
    doctor: Doctor = Depends(verified_doctor),
    db: Session = Depends(get_db),
):
    """What this practice has sent the lab, and when.

    Scoped to the signed-in doctor and nothing else — the lab's own view of
    every clinic lives behind the staff router, and no parameter here can
    widen this one.
    """
    from datetime import datetime, timezone

    from ..services import stats

    now = datetime.now(timezone.utc)
    data = stats.collect(
        db, view, year or now.year, month or now.month, doctor_id=doctor.id
    )
    data["available_years"] = stats.available_years(db, doctor.id)
    # A practice cannot be broken down by doctor: it is one doctor.
    data["doctors"] = []
    return schemas.StatsOut.model_validate(data)


@router.get("/delivery-charge", response_model=schemas.DeliveryQuoteOut)
def delivery_charge(doctor: Doctor = Depends(current_doctor), db: Session = Depends(get_db)):
    """Delivery to where this clinic's orders go.

    An aligner case can be started without anyone naming a delivery cost,
    because none is charged until a production phase ships. A product cannot:
    it is one charge, raised the moment the order exists, and the clinic should
    not meet the delivery line for the first time on the payment screen. Same
    city rates and same fallback the charge itself uses, so what is shown here
    is what gets raised.
    """
    from ..services import payments, scheduling

    address = (
        db.query(Address)
        .filter(Address.doctor_id == doctor.id, Address.is_default_shipping.is_(True))
        .first()
    )
    city = (address.city or "").strip() if address is not None else ""
    settings = scheduling.get_settings(db)
    amount = payments.shipping_for(db, settings, city)
    priced = amount != payments.money(settings.default_shipping_fee) if city else False
    if city and not priced:
        # Equal to the default is not proof of a fallback — the lab may have
        # priced the city at the same figure. Ask the table directly.
        from ..models import ShippingRate

        priced = (
            db.query(ShippingRate)
            .filter(ShippingRate.city.ilike(city), ShippingRate.is_active.is_(True))
            .first()
            is not None
        )
    return schemas.DeliveryQuoteOut(
        city=city,
        amount=amount,
        is_city_rate=bool(city) and priced,
        has_address=address is not None,
    )


@router.get("/addresses", response_model=list[schemas.AddressOut])
def list_addresses(doctor: Doctor = Depends(current_doctor), db: Session = Depends(get_db)):
    return db.query(Address).filter(Address.doctor_id == doctor.id).order_by(Address.created_at).all()


@router.post("/addresses", response_model=schemas.AddressOut, status_code=status.HTTP_201_CREATED)
def create_address(
    payload: schemas.AddressIn,
    doctor: Doctor = Depends(current_doctor),
    db: Session = Depends(get_db),
):
    fields = payload.model_dump()
    picked = (fields.pop("latitude", None), fields.pop("longitude", None))
    address = Address(doctor_id=doctor.id, **fields)
    locate_for(db, address, picked if None not in picked else None)
    if payload.is_default_shipping:
        _clear_default(db, doctor)
    db.add(address)
    db.commit()
    db.refresh(address)
    return address


@router.patch("/addresses/{address_id}", response_model=schemas.AddressOut)
def update_address(
    address_id: str,
    payload: schemas.AddressIn,
    doctor: Doctor = Depends(current_doctor),
    db: Session = Depends(get_db),
):
    address = _owned_address(db, doctor, address_id)
    if payload.is_default_shipping:
        _clear_default(db, doctor)

    # A clinic that moves keeps its old coordinates unless they are refreshed,
    # and a technician sent to the previous building has no way to tell.
    before = (address.line1, address.line2, address.city, address.pincode)
    fields = payload.model_dump()
    picked = (fields.pop("latitude", None), fields.pop("longitude", None))
    for key, value in fields.items():
        setattr(address, key, value)
    moved = (address.line1, address.line2, address.city, address.pincode) != before
    if None not in picked:
        locate_for(db, address, picked)
    elif moved:
        locate_for(db, address)

    db.commit()
    db.refresh(address)
    return address


@router.delete("/addresses/{address_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_address(
    address_id: str,
    doctor: Doctor = Depends(current_doctor),
    db: Session = Depends(get_db),
):
    address = _owned_address(db, doctor, address_id)
    in_use = db.query(Order).filter(Order.shipping_address_id == address.id).count()
    if in_use:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"This address is on {in_use} order(s) and cannot be deleted.",
        )
    db.delete(address)
    db.commit()


def _owned_address(db: Session, doctor: Doctor, address_id: str) -> Address:
    address = db.get(Address, address_id)
    if not address or address.doctor_id != doctor.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Address not found.")
    return address


def _clear_default(db: Session, doctor: Doctor) -> None:
    db.query(Address).filter(
        Address.doctor_id == doctor.id, Address.is_default_shipping.is_(True)
    ).update({"is_default_shipping": False})


# --------------------------------------------------------------------------
# Patients
# --------------------------------------------------------------------------


@router.get("/patients", response_model=list[schemas.PatientOut])
def list_patients(
    search: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    doctor: Doctor = Depends(verified_doctor),
    db: Session = Depends(get_db),
):
    query = db.query(Patient).filter(Patient.doctor_id == doctor.id)
    if search and search.strip():
        query = query.filter(func.lower(Patient.full_name).like(f"%{search.strip().lower()}%"))
    return (
        query.order_by(Patient.full_name).offset(offset).limit(limit).all()
    )


@router.post("/patients", response_model=schemas.PatientOut, status_code=status.HTTP_201_CREATED)
def create_patient(
    payload: schemas.PatientIn,
    doctor: Doctor = Depends(verified_doctor),
    db: Session = Depends(get_db),
):
    patient = Patient(doctor_id=doctor.id, **payload.model_dump())
    db.add(patient)
    db.commit()
    db.refresh(patient)
    return patient
