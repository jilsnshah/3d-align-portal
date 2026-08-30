"""Device notifications for the alerts the portal already raises.

Every alert is written to the notifications table and shown in the portal's own
drawer. That is only useful to someone already looking at the portal — a clinic
waiting to hear that a plan is ready, or a lab waiting on a scan, is not. This
carries the same alerts to the device.

Deliberately best-effort. A push that fails must never fail the request that
caused it: the alert is already recorded and will be read in the portal
regardless, so a push service being slow or a device having been wiped is not a
reason for a doctor's approval to error.
"""

from __future__ import annotations

import json
import logging
from typing import Optional

from sqlalchemy.orm import Session

from ..config import settings
from ..models import Notification, PushSubscription, utcnow

log = logging.getLogger(__name__)

# Long enough for a push service on a bad day, short enough that a request is
# not held open behind it.
TIMEOUT_SECONDS = 6


def configured() -> bool:
    return bool(settings.vapid_private_key and settings.vapid_public_key)


def send_to_user(db: Session, user_id: str, title: str, body: str, url: str = "/") -> int:
    """Push one alert to every device this person has registered.

    Returns how many were delivered. Endpoints the push service rejects as gone
    are marked so they are not tried again.
    """
    if not configured():
        return 0

    try:
        from pywebpush import WebPushException, webpush
    except ImportError:  # pragma: no cover - push simply stays off
        log.warning("pywebpush is not installed; device notifications are off.")
        return 0

    rows = (
        db.query(PushSubscription)
        .filter(PushSubscription.user_id == user_id, PushSubscription.failed_at.is_(None))
        .all()
    )
    if not rows:
        return 0

    payload = json.dumps({"title": title, "body": body, "url": url})
    sent = 0
    for row in rows:
        try:
            webpush(
                subscription_info={
                    "endpoint": row.endpoint,
                    "keys": {"p256dh": row.p256dh, "auth": row.auth},
                },
                data=payload,
                vapid_private_key=settings.vapid_private_key,
                vapid_claims={"sub": settings.vapid_contact},
                timeout=TIMEOUT_SECONDS,
            )
            sent += 1
        except WebPushException as exc:
            status = getattr(exc.response, "status_code", None)
            # 404 and 410 are the push service saying this device is gone for
            # good — uninstalled, or permission withdrawn.
            if status in (404, 410):
                row.failed_at = utcnow()
                log.info("Push endpoint gone, retiring it: %s", row.endpoint[:60])
            else:
                log.warning("Push failed (%s): %s", status, exc)
        except Exception as exc:  # network, DNS, anything
            log.warning("Push failed: %s", exc)
    return sent


def send_for(db: Session, note: Notification) -> int:
    """Push a notification row that has just been written."""
    url = f"/orders/{note.order_id}" if note.order_id else "/"
    return send_to_user(db, note.user_id, note.title, note.body or "", url)


# --------------------------------------------------------------------------
# Catching every alert, wherever it is raised
# --------------------------------------------------------------------------


def _deliver(rows: list) -> None:
    """Send in the background, on a session of its own.

    Pushing inside the request would hold a doctor's approval open behind
    however long a push service takes to answer, on top of the request that
    already did the real work.
    """
    from ..db import SessionLocal

    with SessionLocal() as db:
        for user_id, title, body, url in rows:
            try:
                send_to_user(db, user_id, title, body, url)
            except Exception as exc:  # a background thread must not die loudly
                log.warning("Push delivery failed: %s", exc)
        db.commit()


def install(session_factory) -> None:
    """Push every notification the portal writes, wherever it is written.

    There are a dozen places that raise one, and more will be added. Listening
    for the insert means none of them has to remember to push, and none of them
    can forget.
    """
    import threading

    from sqlalchemy import event

    pending: dict = {}

    @event.listens_for(session_factory, "after_flush")
    def _collect(db, _context):
        fresh = [o for o in db.new if isinstance(o, Notification)]
        if fresh:
            pending.setdefault(id(db), []).extend(
                (n.user_id, n.title, n.body or "",
                 f"/orders/{n.order_id}" if n.order_id else "/")
                for n in fresh
            )

    @event.listens_for(session_factory, "after_commit")
    def _dispatch(db):
        rows = pending.pop(id(db), None)
        if not rows or not configured():
            return
        threading.Thread(target=_deliver, args=(rows,), daemon=True).start()

    @event.listens_for(session_factory, "after_rollback")
    def _discard(db):
        # An alert that was rolled back never happened.
        pending.pop(id(db), None)
