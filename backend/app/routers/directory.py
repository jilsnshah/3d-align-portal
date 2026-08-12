"""Doctor-owned reference data: addresses and patients."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import current_doctor, verified_doctor
from ..models import Address, Doctor, Order, Patient

router = APIRouter(tags=["directory"])


# --------------------------------------------------------------------------
# Addresses
# --------------------------------------------------------------------------


@router.get("/addresses", response_model=list[schemas.AddressOut])
def list_addresses(doctor: Doctor = Depends(current_doctor), db: Session = Depends(get_db)):
    return db.query(Address).filter(Address.doctor_id == doctor.id).order_by(Address.created_at).all()


@router.post("/addresses", response_model=schemas.AddressOut, status_code=status.HTTP_201_CREATED)
def create_address(
    payload: schemas.AddressIn,
    doctor: Doctor = Depends(current_doctor),
    db: Session = Depends(get_db),
):
    address = Address(doctor_id=doctor.id, **payload.model_dump())
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
    for key, value in payload.model_dump().items():
        setattr(address, key, value)
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
def list_patients(doctor: Doctor = Depends(verified_doctor), db: Session = Depends(get_db)):
    return (
        db.query(Patient)
        .filter(Patient.doctor_id == doctor.id)
        .order_by(Patient.full_name)
        .all()
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
