from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .enums import LAB_ROLES, UserRole, VerificationStatus
from .models import Doctor, Order, User
from .security import read_session_token


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in to continue.")
    user_id = read_session_token(token)
    if not user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Your session expired. Sign in again.")
    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account is not active.")
    return user


def current_admin(user: User = Depends(current_user)) -> User:
    """The lab's own account. Bookings, technicians, settings, verification."""
    if user.role != UserRole.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access only.")
    return user


def current_lab(user: User = Depends(current_user)) -> User:
    """Admin or technician. Case tools both roles share."""
    if user.role not in LAB_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Lab access only.")
    return user


def current_technician(user: User = Depends(current_user), db: Session = Depends(get_db)):
    from .models import Technician

    if user.role != UserRole.TECHNICIAN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Technician access only.")
    tech = db.query(Technician).filter(Technician.user_id == user.id).one_or_none()
    if not tech:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No technician profile on this account.")
    return tech


def current_doctor(
    user: User = Depends(current_user), db: Session = Depends(get_db)
) -> Doctor:
    if user.role != UserRole.DOCTOR:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Doctor access only.")
    doctor = db.query(Doctor).filter(Doctor.user_id == user.id).one_or_none()
    if not doctor:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No doctor profile on this account.")
    return doctor


def verified_doctor(doctor: Doctor = Depends(current_doctor)) -> Doctor:
    """Gate for anything beyond viewing your own profile."""
    if doctor.verification_status != VerificationStatus.VERIFIED:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Your account is awaiting verification by 3D Align.",
        )
    return doctor


def owned_order(order_id: str, db: Session, doctor: Doctor) -> Order:
    """Single choke point for doctor-scoped order access."""
    order = db.get(Order, order_id)
    if not order or order.doctor_id != doctor.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
    return order


def any_order(order_id: str, db: Session) -> Order:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
    return order
