"""Case file upload and download, shared by both portals.

Uploads stream through the API to the configured storage backend. Downloads are
authorised per request — a doctor may only read files on their own orders, and
nothing is ever exposed by public link.
"""

from __future__ import annotations

from datetime import timedelta, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .. import schemas
from ..config import settings
from pathlib import Path
from ..services import meshes, simulation
from ..db import get_db
from ..deps import current_user
from ..enums import (
    AppointmentStatus,
    CATEGORY_FOLDER,
    FILE_GROUP,
    FileGroup,
    STAFF_ONLY_CATEGORIES,
    STAFF_UPLOAD_WINDOWS,
    SINGLE_FILE_CATEGORIES,
    STATUS_LABELS,
    FileCategory,
    Slot,
    slots_for,
    OrderStatus,
    LAB_ROLES,
    UserRole,
)
from ..models import Doctor, Order, OrderFile, User, utcnow
from ..serializers import binned_file_out, file_out
from ..services.storage import get_storage, guess_mime
from ..transitions import transition

router = APIRouter(prefix="/orders/{order_id}/files", tags=["files"])

# When a doctor is allowed to add each kind of file.
DOCTOR_UPLOAD_WINDOWS: dict[FileCategory, set[OrderStatus]] = {
    FileCategory.RECORD_PHOTO: {OrderStatus.DRAFT, OrderStatus.RECORDS_REQUESTED},
    FileCategory.OPG: {OrderStatus.DRAFT, OrderStatus.RECORDS_REQUESTED},
    FileCategory.LATERAL_CEPH: {OrderStatus.DRAFT, OrderStatus.RECORDS_REQUESTED},
    FileCategory.CBCT: {OrderStatus.DRAFT, OrderStatus.RECORDS_REQUESTED},
    FileCategory.INTRAORAL_SCAN: {OrderStatus.AWAITING_SCAN},
    FileCategory.FIT_ISSUE_PHOTO: {OrderStatus.FIT_REVIEW, OrderStatus.FIT_ISSUE},
    FileCategory.OTHER: {OrderStatus.DRAFT, OrderStatus.RECORDS_REQUESTED},
}

STL_EXTENSIONS = (".stl",)


def _destroy(db: Session, record: OrderFile) -> None:
    """Remove the bytes and the row. Storage failures must not strand the row."""
    try:
        get_storage().delete(record.storage_ref)
    except Exception:  # noqa: BLE001 — a missing object should still let the row go
        pass
    db.delete(record)


def purge_expired(db: Session) -> int:
    """Anything binned longer than the retention window goes for good. Called
    whenever a bin is listed, and once at startup, which is enough at this
    volume without introducing a scheduler."""
    cutoff = utcnow() - timedelta(days=settings.trash_retention_days)
    stale = (
        db.query(OrderFile)
        .filter(OrderFile.is_deleted.is_(True), OrderFile.deleted_at.isnot(None))
        .all()
    )
    removed = 0
    for record in stale:
        deleted_at = record.deleted_at
        if deleted_at and deleted_at.tzinfo is None:
            deleted_at = deleted_at.replace(tzinfo=timezone.utc)
        if deleted_at and deleted_at < cutoff:
            _destroy(db, record)
            removed += 1
    if removed:
        db.commit()
    return removed


def _visible_order(order_id: str, db: Session, user: User) -> Order:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
    if user.role == UserRole.DOCTOR:
        doctor = db.query(Doctor).filter(Doctor.user_id == user.id).one_or_none()
        if not doctor or order.doctor_id != doctor.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
    return order


@router.post("", response_model=schemas.FileOut, status_code=status.HTTP_201_CREATED)
async def upload_file(
    order_id: str,
    category: FileCategory = Form(...),
    slot: str = Form(default=""),
    upload: UploadFile = File(...),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    order = _visible_order(order_id, db, user)
    is_staff = user.role in LAB_ROLES

    if is_staff:
        # A treatment plan or simulation only exists once there is a verified
        # scan to plan from, so these are gated by status too. Records and scans
        # are not gated for lab staff — a technician captures both on the visit.
        window = STAFF_UPLOAD_WINDOWS.get(category)
        if window is not None and order.status not in window:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"A {category.replace('_', ' ').lower()} can only be added once the case is in "
                f"planning. This case is {STATUS_LABELS[order.status].lower()}.",
            )
    else:
        if category in STAFF_ONLY_CATEGORIES:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only 3D Align staff can add this file.")
        allowed = DOCTOR_UPLOAD_WINDOWS.get(category, set())
        if order.status not in allowed:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Files of this type cannot be added while the case is "
                f"{STATUS_LABELS[order.status].lower()}.",
            )

    # A revision is a round the lab formally re-requested, not "someone touched
    # a photo". A technician retaking one view replaces that view in the current
    # round — see the slot replacement below — so the rest of a complete set is
    # never invalidated by a single chairside retake.
    group = FILE_GROUP[category]

    # A folder upload arrives with its relative path in the name
    # ("3D_ALIGN/7-S-3D_ALIGN.stl"), and a path in a filename field breaks
    # anything that reads the name — the simulation timeline included.
    filename = (upload.filename or "upload").strip().replace("\\", "/").rsplit("/", 1)[-1]
    if category == FileCategory.INTRAORAL_SCAN and not filename.lower().endswith(STL_EXTENSIONS):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Intraoral scans must be uploaded as .stl files."
        )

    expected = [name for name, _ in slots_for(category)]
    if expected and slot not in expected:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Say which view this is. Expected one of: {', '.join(expected)}.",
        )
    if not expected:
        slot = Slot.OTHER if category not in SINGLE_FILE_CATEGORIES else ""

    mime_type = guess_mime(filename, upload.content_type)
    subfolder = CATEGORY_FOLDER[category]

    if not order.storage_folder_ref:
        order.storage_folder_ref = get_storage().ensure_order_folder(order.reference)

    stored = get_storage().save(order.reference, subfolder, filename, upload.file, mime_type)

    max_bytes = settings.max_upload_mb * 1024 * 1024
    if stored.size_bytes > max_bytes:
        get_storage().delete(stored.ref)
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"That file is larger than the {settings.max_upload_mb} MB limit.",
        )

    record = OrderFile(
        order_id=order.id,
        category=category,
        filename=filename,
        mime_type=mime_type,
        size_bytes=stored.size_bytes,
        storage_ref=stored.ref,
        external_link=stored.external_link,
        uploaded_by_id=user.id,
        revision=order.revision_for(group),
        slot=slot,
    )

    # One live file per view, and one per single-document category. Uploading
    # again replaces what is there rather than leaving two candidates for the
    # same thing — which is also why a current file is never deletable.
    replaces_current = (slot and slot != Slot.OTHER) or category in SINGLE_FILE_CATEGORIES
    if replaces_current:
        for existing in order.files:
            same_place = (
                existing.slot == slot
                if slot and slot != Slot.OTHER
                else category in SINGLE_FILE_CATEGORIES
            )
            if (
                existing.category == category
                and same_place
                and existing.revision == record.revision
                and not existing.is_deleted
            ):
                existing.is_deleted = True
                existing.deleted_at = utcnow()
                existing.deleted_by_id = user.id

    # Append rather than only setting the foreign key, so the completeness check
    # below sees this file without waiting for a refresh.
    order.files.append(record)
    db.add(record)
    db.flush()

    # The scan file arriving IS the event that hands the case to the lab, and it
    # is the only thing that does. Whoever uploads it — the clinic from its own
    # scanner, or staff after an appointment or digitising an impression — the
    # case moves to review. Without this there is nothing to verify or plan from.
    if (
        category == FileCategory.INTRAORAL_SCAN
        and order.status == OrderStatus.AWAITING_SCAN
        and order.has_intraoral_scan
    ):
        booking = order.appointment
        if booking is not None and booking.is_live:
            booking.status = AppointmentStatus.COMPLETED
            booking.completed_at = utcnow()
        transition(
            db, order, OrderStatus.SCAN_SUBMITTED, user, note=f"Intraoral scan uploaded: {filename}"
        )

    db.commit()
    db.refresh(record)
    return record


@router.get("/{file_id}/download")
def download_file(
    order_id: str,
    file_id: str,
    inline: bool = False,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """`inline=1` renders in the browser instead of downloading, which is how
    the file explorer previews photographs without anyone saving them first.
    Binned files stay readable so they can be checked before restoring."""
    order = _visible_order(order_id, db, user)
    record = db.get(OrderFile, file_id)
    if not record or record.order_id != order.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")

    disposition = "inline" if inline else "attachment"
    stream = get_storage().open(record.storage_ref)
    return StreamingResponse(
        stream,
        media_type=record.mime_type,
        headers={
            "Content-Disposition": f'{disposition}; filename="{record.filename}"',
            "Cache-Control": "private, max-age=300",
        },
    )


@router.delete("/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def move_to_bin(
    order_id: str,
    file_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Deleting puts a file in the recycle bin. It keeps its bytes until the
    retention window passes, so a mistaken delete is recoverable."""
    order = _visible_order(order_id, db, user)
    record = db.get(OrderFile, file_id)
    if not record or record.order_id != order.id or record.is_deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")

    if user.role == UserRole.DOCTOR and record.uploaded_by_id != user.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only 3D Align can remove a file the lab added."
        )

    # Only superseded files can be removed. Deleting something the case is
    # currently relying on would silently break a complete records set — to
    # change it, upload a replacement, which retires the old one automatically.
    if record.revision == order.revision_for(FILE_GROUP[record.category]):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This is the current file for that view. Upload a replacement instead — "
            "the one it replaces moves to the bin on its own.",
        )

    record.is_deleted = True
    record.deleted_at = utcnow()
    record.deleted_by_id = user.id
    db.commit()


@router.get("/bin/list", response_model=list[schemas.BinnedFileOut])
def list_bin(
    order_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    order = _visible_order(order_id, db, user)
    purge_expired(db)
    return [binned_file_out(f) for f in order.files if f.is_deleted]


@router.post("/{file_id}/restore", response_model=schemas.FileOut)
def restore_file(
    order_id: str,
    file_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    order = _visible_order(order_id, db, user)
    record = db.get(OrderFile, file_id)
    if not record or record.order_id != order.id or not record.is_deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found in the bin.")

    # Restoring into an occupied slot would leave two files claiming one view.
    if record.slot and record.slot != Slot.OTHER:
        clash = any(
            f.category == record.category
            and f.slot == record.slot
            and f.revision == record.revision
            and not f.is_deleted
            for f in order.files
        )
        if clash:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Something already occupies that view. Remove it first, then restore this.",
            )

    record.is_deleted = False
    record.deleted_at = None
    record.deleted_by_id = None
    db.commit()
    db.refresh(record)
    return file_out(order, record)


@router.delete("/{file_id}/purge", status_code=status.HTTP_204_NO_CONTENT)
def purge_now(
    order_id: str,
    file_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Delete for good, before the retention window is up."""
    order = _visible_order(order_id, db, user)
    record = db.get(OrderFile, file_id)
    if not record or record.order_id != order.id or not record.is_deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found in the bin.")
    _destroy(db, record)
    db.commit()


# --------------------------------------------------------------------------
# The 3D viewer
# --------------------------------------------------------------------------


@router.get("/simulation", response_model=schemas.SimulationOut)
def simulation_manifest(
    order_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """The timeline the viewer draws: which steps exist and which meshes to fetch."""
    order = _visible_order(order_id, db, user)
    stages = simulation.stages_for(order)
    return schemas.SimulationOut(
        order_reference=order.reference,
        patient_name=order.patient.full_name if order.patient else "",
        total_aligners=order.total_aligners or 0,
        stages=[
            schemas.StageOut(
                step=stage.step,
                is_passive=stage.is_passive,
                upper=schemas.StageModelOut(**vars(stage.upper)) if stage.upper else None,
                lower=schemas.StageModelOut(**vars(stage.lower)) if stage.lower else None,
            )
            for stage in stages
        ],
    )


@router.get("/simulation/{file_id}/mesh")
def simulation_mesh(
    order_id: str,
    file_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """One arch at one step, converted for the browser.

    The lab's STL is ~8 MB of loose triangles; this hands back an indexed mesh
    about a third of that, cached so the conversion happens once per file.
    """
    order = _visible_order(order_id, db, user)
    record = next((f for f in order.files if f.id == file_id and not f.is_deleted), None)
    if record is None or record.category != FileCategory.SIMULATION_MODEL:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Model not found.")

    storage = get_storage()

    def starting_arch():
        """Step 0 of the same arch, so the mesh can carry how far it has moved."""
        parsed = simulation.parse_name(record.filename)
        if parsed is None:
            return None
        _, arch, _ = parsed
        first = next(
            (
                s.upper if arch == "upper" else s.lower
                for s in simulation.stages_for(order)
                if (s.upper if arch == "upper" else s.lower)
            ),
            None,
        )
        if first is None or first.file_id == record.id:
            return None
        origin = next((f for f in order.files if f.id == first.file_id), None)
        if origin is None:
            return None
        base = meshes.converted(
            Path(settings.storage_local_root),
            origin.storage_ref,
            lambda: storage.open(origin.storage_ref).read(),
        )
        return meshes.vertices_of(base)

    try:
        payload = meshes.converted(
            Path(settings.storage_local_root),
            record.storage_ref,
            lambda: storage.open(record.storage_ref).read(),
            reference=starting_arch,
        )
    except meshes.MeshError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={
            # Meshes never change once uploaded, so let the browser keep them.
            "Cache-Control": "private, max-age=86400, immutable",
            "Content-Disposition": f'inline; filename="{record.filename}.a3dm"',
        },
    )
