"""Case file upload and download, shared by both portals.

Uploads stream through the API to the configured storage backend. Downloads are
authorised per request — a doctor may only read files on their own orders, and
nothing is ever exposed by public link.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .. import schemas
from ..config import settings
from ..db import get_db
from ..deps import current_user
from ..enums import (
    AppointmentStatus,
    CATEGORY_FOLDER,
    FILE_GROUP,
    STAFF_ONLY_CATEGORIES,
    STAFF_UPLOAD_WINDOWS,
    STATUS_LABELS,
    FileCategory,
    OrderStatus,
    UserRole,
)
from ..models import Doctor, Order, OrderFile, User
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
    upload: UploadFile = File(...),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    order = _visible_order(order_id, db, user)
    is_staff = user.role == UserRole.STAFF

    if is_staff:
        # A treatment plan or simulation only exists once there is a verified
        # scan to plan from, so these are gated by status too.
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

    filename = (upload.filename or "upload").strip()
    if category == FileCategory.INTRAORAL_SCAN and not filename.lower().endswith(STL_EXTENSIONS):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Intraoral scans must be uploaded as .stl files."
        )

    mime_type = guess_mime(filename, upload.content_type)
    subfolder = CATEGORY_FOLDER[category]

    if not order.storage_folder_ref:
        order.storage_folder_ref = get_storage().ensure_order_folder(order.order_number)

    stored = get_storage().save(order.order_number, subfolder, filename, upload.file, mime_type)

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
        revision=order.revision_for(FILE_GROUP[category]),
    )
    db.add(record)

    # The scan file arriving IS the event that hands the case to the lab, and it
    # is the only thing that does. Whoever uploads it — the clinic from its own
    # scanner, or staff after an appointment or digitising an impression — the
    # case moves to review. Without this there is nothing to verify or plan from.
    if category == FileCategory.INTRAORAL_SCAN and order.status == OrderStatus.AWAITING_SCAN:
        if order.appointment and order.appointment.status == AppointmentStatus.BOOKED:
            order.appointment.status = AppointmentStatus.COMPLETED
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
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    order = _visible_order(order_id, db, user)
    record = db.get(OrderFile, file_id)
    if not record or record.order_id != order.id or record.is_deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")

    stream = get_storage().open(record.storage_ref)
    return StreamingResponse(
        stream,
        media_type=record.mime_type,
        headers={"Content-Disposition": f'attachment; filename="{record.filename}"'},
    )


@router.delete("/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_file(
    order_id: str,
    file_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    order = _visible_order(order_id, db, user)
    record = db.get(OrderFile, file_id)
    if not record or record.order_id != order.id or record.is_deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")

    if user.role == UserRole.DOCTOR:
        if order.status not in (OrderStatus.DRAFT, OrderStatus.RECORDS_REQUESTED):
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Files can only be removed before the case is reviewed."
            )
        if record.uploaded_by_id != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You did not upload this file.")

    record.is_deleted = True
    db.commit()
