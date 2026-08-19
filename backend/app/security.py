from __future__ import annotations

from typing import Optional

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError
from typing import Optional

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import settings

_hasher = PasswordHasher()
_serializer = URLSafeTimedSerializer(settings.secret_key, salt="align-session")


def hash_password(raw: str) -> str:
    return _hasher.hash(raw)


def verify_password(raw: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, raw)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def make_session_token(user_id: str) -> str:
    return _serializer.dumps({"uid": user_id})


def read_session_token(token: str) -> Optional[str]:
    try:
        data = _serializer.loads(token, max_age=settings.session_max_age_seconds)
    except (BadSignature, SignatureExpired):
        return None
    return data.get("uid")


# Sessions are scoped to a browser tab, not just a host.
#
# A cookie is shared by every tab on an origin, so one login replaces another
# and you cannot be a doctor and the lab at once. Each tab generates a short
# slot id, sends it as a header, and gets its own cookie — so tabs hold
# independent sessions on a single URL, and the cookie stays httpOnly.
SLOT_HEADER = "X-Session-Slot"
_SLOT_OK = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")


def cookie_name_for(slot: Optional[str]) -> str:
    """The cookie this tab reads and writes. Unslotted requests fall back to the
    base name, so anything already signed in keeps working."""
    if not slot:
        return settings.session_cookie_name
    clean = "".join(c for c in slot if c in _SLOT_OK)[:16]
    if not clean:
        return settings.session_cookie_name
    return f"{settings.session_cookie_name}_{clean}"
