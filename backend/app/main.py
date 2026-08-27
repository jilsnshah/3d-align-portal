from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware

from .config import BACKEND_ROOT, check_deployment, settings
from .db import Base, SessionLocal, engine
from .routers import auth, bookings, directory, files, notifications, orders, staff
from .seed import ensure_staff_account

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("align")


@asynccontextmanager
async def lifespan(app: FastAPI):
    problems = check_deployment(settings)
    if problems:
        raise RuntimeError(
            "Refusing to start with a development configuration:\n  - "
            + "\n  - ".join(problems)
            + "\nSet these in the environment, or ENVIRONMENT=development to run locally."
        )

    Base.metadata.create_all(bind=engine)

    from .services.travel import configure_from_settings

    configure_from_settings()

    with SessionLocal() as db:
        ensure_staff_account(db)
        from .services.catalogue import ensure_products

        ensure_products(db)
        from .routers.files import purge_expired

        removed = purge_expired(db)
        if removed:
            log.info("Purged %s file(s) past the recycle-bin retention window.", removed)
    log.info("Storage backend: %s", settings.storage_backend)
    yield


app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api")
app.include_router(directory.router, prefix="/api")
app.include_router(orders.router, prefix="/api")
app.include_router(files.router, prefix="/api")
app.include_router(notifications.router, prefix="/api")
app.include_router(staff.router, prefix="/api")
app.include_router(bookings.router, prefix="/api")


# --------------------------------------------------------------------------
# Serving the built frontend
# --------------------------------------------------------------------------
# One origin for the app and the API. The frontend calls relative /api paths,
# so same-origin means no CORS to configure and the session cookie — which is
# httpOnly and host-scoped — simply works. Two origins would need both, and the
# per-tab session slots would be the first thing to break.


def _mount_frontend(app: FastAPI) -> None:
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    dist = Path(settings.frontend_dist or (BACKEND_ROOT.parent / "frontend" / "dist"))
    index = dist / "index.html"
    if not index.is_file():
        log.info("No frontend build at %s; serving the API only.", dist)
        return

    app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    # Not a catch-all route: one of those matches the path before the method is
    # considered, so an unknown API endpoint would answer 405 instead of 404 and
    # a bad GET would return the app's HTML instead of JSON. Falling back only
    # once routing has already failed keeps the API honest.
    @app.exception_handler(404)
    async def spa_fallback(request, exc):
        from fastapi.responses import JSONResponse

        path = request.url.path.lstrip("/")
        if path.startswith("api/") or path == "api":
            return JSONResponse({"detail": getattr(exc, "detail", "Not found.")}, status_code=404)
        if request.method not in ("GET", "HEAD"):
            return JSONResponse({"detail": "Not found."}, status_code=404)

        candidate = (dist / path).resolve()
        if path and candidate.is_file() and dist.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(index)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "app": settings.app_name}


# Registered last: the catch-all must not shadow the API routers.
_mount_frontend(app)
