from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import current_user
from ..models import Notification, User, utcnow

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=list[schemas.NotificationOut])
def list_notifications(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return (
        db.query(Notification)
        .filter(Notification.user_id == user.id)
        .order_by(Notification.created_at.desc())
        .limit(60)
        .all()
    )


@router.get("/unread-count")
def unread_count(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    count = (
        db.query(Notification)
        .filter(Notification.user_id == user.id, Notification.read_at.is_(None))
        .count()
    )
    return {"count": count}


@router.post("/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT)
def mark_read(
    notification_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
):
    note = db.get(Notification, notification_id)
    if not note or note.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification not found.")
    note.read_at = note.read_at or utcnow()
    db.commit()


@router.post("/read-all", status_code=status.HTTP_204_NO_CONTENT)
def mark_all_read(user: User = Depends(current_user), db: Session = Depends(get_db)):
    db.query(Notification).filter(
        Notification.user_id == user.id, Notification.read_at.is_(None)
    ).update({"read_at": utcnow()})
    db.commit()


# --------------------------------------------------------------------------
# Device notifications
# --------------------------------------------------------------------------


@router.get("/push/key")
def push_key():
    """The public half of the server's push key, and whether push is on at all.

    The browser needs this before it can subscribe. Public by design — it is
    what identifies this server to the push services, not a secret.
    """
    from ..config import settings
    from ..services import push

    return {
        "enabled": push.configured(),
        "public_key": settings.vapid_public_key if push.configured() else "",
    }


@router.post("/push/subscribe", status_code=status.HTTP_204_NO_CONTENT)
def subscribe(
    payload: schemas.PushSubscribeIn,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Register this device to receive alerts.

    The endpoint identifies the device, so re-subscribing on one that is
    already known moves it to whoever is signed in now rather than creating a
    duplicate — which is what happens when a clinic and the lab share a tablet.
    """
    from ..models import PushSubscription

    row = (
        db.query(PushSubscription)
        .filter(PushSubscription.endpoint == payload.endpoint)
        .one_or_none()
    )
    if row is None:
        row = PushSubscription(endpoint=payload.endpoint)
        db.add(row)
    row.user_id = user.id
    row.p256dh = payload.keys.p256dh
    row.auth = payload.keys.auth
    # A device coming back is a working device again.
    row.failed_at = None
    db.commit()


@router.delete("/push/subscribe", status_code=status.HTTP_204_NO_CONTENT)
def unsubscribe(
    endpoint: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    from ..models import PushSubscription

    db.query(PushSubscription).filter(
        PushSubscription.endpoint == endpoint, PushSubscription.user_id == user.id
    ).delete()
    db.commit()
