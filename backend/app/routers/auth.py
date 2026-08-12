from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from .. import schemas
from ..config import settings
from ..db import get_db
from ..deps import current_doctor, current_user
from ..enums import UserRole, VerificationStatus
from ..models import Address, Doctor, User, utcnow
from ..security import hash_password, make_session_token, verify_password
from ..services.registry import DENTAL_COUNCILS, check_registration

router = APIRouter(prefix="/auth", tags=["auth"])


def _set_session(response: Response, user: User) -> None:
    response.set_cookie(
        settings.session_cookie_name,
        make_session_token(user.id),
        max_age=settings.session_max_age_seconds,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


def _me(user: User) -> schemas.MeOut:
    return schemas.MeOut(
        id=user.id,
        email=user.email,
        role=user.role,
        doctor=schemas.DoctorOut.model_validate(user.doctor) if user.doctor else None,
    )


@router.get("/councils")
def councils() -> list[str]:
    return sorted(DENTAL_COUNCILS.values())


@router.post("/register", response_model=schemas.MeOut, status_code=status.HTTP_201_CREATED)
def register(payload: schemas.RegisterIn, response: Response, db: Session = Depends(get_db)):
    email = payload.email.lower().strip()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with that email already exists.")

    user = User(email=email, password_hash=hash_password(payload.password), role=UserRole.DOCTOR)
    db.add(user)
    db.flush()

    doctor = Doctor(
        user_id=user.id,
        full_name=payload.full_name.strip(),
        phone=payload.phone.strip(),
        clinic_name=payload.clinic_name.strip(),
        dental_council=payload.dental_council.strip(),
        registration_number=payload.registration_number.strip(),
        verification_status=VerificationStatus.PENDING,
    )
    doctor.registry_check_result = check_registration(
        doctor.full_name, doctor.registration_number, doctor.dental_council
    )
    db.add(doctor)
    db.flush()

    address = Address(doctor_id=doctor.id, **payload.address.model_dump())
    address.is_default_shipping = True
    db.add(address)

    db.commit()
    db.refresh(user)
    _set_session(response, user)
    return _me(user)


@router.post("/login", response_model=schemas.MeOut)
def login(payload: schemas.LoginIn, response: Response, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == payload.email.lower().strip()).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Email or password is incorrect.")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account has been deactivated.")

    user.last_login_at = utcnow()
    db.commit()
    db.refresh(user)
    _set_session(response, user)
    return _me(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(response: Response):
    response.delete_cookie(settings.session_cookie_name, path="/")


@router.get("/me", response_model=schemas.MeOut)
def me(user: User = Depends(current_user)):
    return _me(user)


@router.patch("/profile", response_model=schemas.DoctorOut)
def update_profile(
    payload: schemas.DoctorProfileIn,
    doctor: Doctor = Depends(current_doctor),
    db: Session = Depends(get_db),
):
    doctor.full_name = payload.full_name.strip()
    doctor.phone = payload.phone.strip()
    doctor.clinic_name = payload.clinic_name.strip()
    db.commit()
    db.refresh(doctor)
    return doctor


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: schemas.PasswordChangeIn,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect.")
    user.password_hash = hash_password(payload.new_password)
    db.commit()
