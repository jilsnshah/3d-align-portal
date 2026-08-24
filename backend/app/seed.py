from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from .config import settings
from .enums import UserRole
from .models import User
from .security import hash_password

log = logging.getLogger(__name__)


def ensure_staff_account(db: Session) -> User:
    """The portal runs with one lab account. Created on first boot from the
    STAFF_EMAIL / STAFF_PASSWORD settings; the password is never reset after that,
    so changing it in the portal sticks."""
    email = settings.staff_email.lower().strip()
    existing = db.query(User).filter(User.email == email).one_or_none()
    if existing:
        # Backfill for accounts created before lab-side names existed.
        if not existing.full_name:
            existing.full_name = settings.staff_full_name
            db.commit()
        return existing

    staff = User(
        email=email,
        password_hash=hash_password(settings.staff_password),
        full_name=settings.staff_full_name,
        role=UserRole.ADMIN,
    )
    db.add(staff)
    db.commit()
    db.refresh(staff)

    if settings.staff_password == "changeme":
        log.warning(
            "Staff account %s created with the default password. "
            "Set STAFF_PASSWORD before deploying.",
            email,
        )
    else:
        log.info("Staff account %s created.", email)
    return staff
