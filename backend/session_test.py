"""Does the app stay signed in when it is closed and opened again?"""
import os, tempfile
TMP = tempfile.mkdtemp(prefix="align-session-")
os.environ["DATABASE_URL"] = f"sqlite:///{TMP}/s.db"
os.environ["STORAGE_LOCAL_ROOT"] = f"{TMP}/storage"
os.environ["STAFF_EMAIL"] = "lab@example.com"
os.environ["STAFF_PASSWORD"] = "labpassword"
os.environ["DCI_CHECK_ENABLED"] = "false"
os.environ["GOOGLE_MAPS_API_KEY"] = ""
os.environ["GOOGLE_MAPS_BROWSER_KEY"] = ""

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402
from app.config import settings  # noqa: E402

ok = fail = 0
def check(label, cond, detail=""):
    global ok, fail
    print(f"[{'  ok  ' if cond else ' FAIL '}] {label}" + (f"  — {detail}" if detail and not cond else ""))
    if cond: ok += 1
    else: fail += 1

with TestClient(app) as boot:
    c = TestClient(app, base_url="http://phone")
    r = c.post("/api/auth/login", json={"email": "lab@example.com", "password": "labpassword"})
    check("signing in works", r.status_code == 200, r.text)

    raw = r.headers.get("set-cookie", "")
    check("the cookie is persistent, not per-session",
          "Max-Age=" in raw or "Expires=" in raw, raw[:90])
    check("it outlives a working day by a long way",
          settings.session_max_age_seconds >= 60 * 60 * 24 * 30,
          f"{settings.session_max_age_seconds / 86400:.0f} days")
    check("it is httpOnly", "HttpOnly" in raw, raw[:90])

    jar = dict(c.cookies)
    check("a cookie was stored", len(jar) == 1, str(list(jar)))

    # Quitting the app and opening it again: a brand new client process, with
    # only what the cookie jar kept from last time.
    reopened = TestClient(app, base_url="http://phone", cookies=jar)
    r = reopened.get("/api/auth/me")
    check("reopening the app is still signed in", r.status_code == 200, r.text[:90])
    check("and it is the same account", r.status_code == 200 and r.json()["email"] == "lab@example.com")

    # Signing out clears the cookie on this device. Sessions are per tab by
    # design — you can be a clinic in one and the lab in another — so it is
    # deliberately not a global sign-out.
    r = c.post("/api/auth/logout")
    check("signing out clears the cookie", not dict(c.cookies), str(dict(c.cookies)))
    check("and this client is signed out", c.get("/api/auth/me").status_code == 401)

    # What does end every session everywhere is changing the password, which is
    # what someone does when they think it is known. A cookie copied elsewhere
    # would otherwise keep working for the full two months.
    still = TestClient(app, base_url="http://phone")
    still.post("/api/auth/login", json={"email": "lab@example.com", "password": "labpassword"})
    check("a second device is signed in", still.get("/api/auth/me").status_code == 200)

    owner = TestClient(app, base_url="http://owner")
    owner.post("/api/auth/login", json={"email": "lab@example.com", "password": "labpassword"})
    r = owner.post("/api/auth/password", json={
        "current_password": "labpassword", "new_password": "a-much-better-one",
    })
    check("the password can be changed", r.status_code in (200, 204), r.text[:90])
    check("which signs the other device out",
          still.get("/api/auth/me").status_code == 401,
          "the old cookie still works")

print(f"\n{ok} passed, {fail} failed")
raise SystemExit(1 if fail else 0)
