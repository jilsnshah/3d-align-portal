from __future__ import annotations

from fastapi import Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from typing import Optional

from .enums import LAB_ROLES, OFFICE_ROLES, UserRole, VerificationStatus
from .models import Doctor, Order, User
from .security import (
    SLOT_HEADER,
    cookie_name_for,
    make_session_token,
    read_session_epoch,
    read_session_token,
    session_age_seconds,
)


def current_user(
    request: Request, response: Response, db: Session = Depends(get_db)
) -> User:
    # Headers cover fetch(); the query parameter covers <img src> and download
    # links, which cannot carry one.
    slot = request.headers.get(SLOT_HEADER) or request.query_params.get("slot")
    token = request.cookies.get(cookie_name_for(slot))
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in to continue.")
    user_id = read_session_token(token)
    if not user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Your session expired. Sign in again.")
    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account is not active.")
    if read_session_epoch(token) != (user.session_epoch or 0):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "That session was signed out. Sign in again."
        )

    # A session that is being used rolls forward, so someone who opens the app
    # every day is never signed out, while one left alone eventually expires.
    # Reissued only past a threshold rather than on every request, so a busy
    # screen does not rewrite the cookie a dozen times a second.
    age = session_age_seconds(token)
    if age is not None and age > settings.session_refresh_after_seconds:
        response.set_cookie(
            cookie_name_for(slot),
            make_session_token(user.id, user.session_epoch or 0),
            max_age=settings.session_max_age_seconds,
            httponly=True,
            secure=settings.cookie_secure,
            samesite="lax",
            path="/",
        )
    return user


def current_admin(user: User = Depends(current_user)) -> User:
    """The lab office: the admin and the orthodontists who plan for them.

    Both work the same tools. What separates them is which cases they can
    reach, which is enforced at the order lookup rather than here — an
    orthodontist has every screen, on their own cases only.
    """
    if user.role not in OFFICE_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Lab office access only.")
    return user


def current_owner(user: User = Depends(current_user)) -> User:
    """The lab's own account, and nobody else.

    For the few things that decide who does what: handing a case to an
    orthodontist, and creating or closing their accounts. An orthodontist
    cannot give themselves work or make a colleague.
    """
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


def any_order(order_id: str, db: Session, user: Optional[User] = None) -> Order:
    """Single choke point for lab-side order access.

    An orthodontist reaches only the cases assigned to them. A case they do not
    have reads as missing rather than forbidden: telling them it exists but is
    someone else's would leak the board they are not meant to see, and knowing
    an id would be enough to confirm a patient is a client.
    """
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
    if (
        user is not None
        and user.role == UserRole.ORTHODONTIST
        and order.assigned_to_id != user.id
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
    return order


def visible_orders(query, user: User):
    """Narrow a case query to what this account may see.

    The admin sees the whole board. An orthodontist sees their own assignments,
    and nothing else — searching, paging and filtering all run inside that.
    """
    if user.role == UserRole.ORTHODONTIST:
        return query.filter(Order.assigned_to_id == user.id)
    return query
