"""Case file storage.

Two backends behind one interface:

  local  — writes under STORAGE_LOCAL_ROOT. Default, so the portal runs with no
           Google setup at all.
  drive  — Google Drive via a *service account* on a Shared Drive.

The Drive folder walk is ported from the old ``mainlogic.upload_drive``, with two
deliberate changes: credentials come from a service account instead of an
interactive OAuth token that expires, and nothing is ever made public. The old
code set ``{'type': 'anyone', 'role': 'reader'}`` on patient folders, which put
identifiable records on permanent public URLs.

The tree is keyed on order_number, which never changes:

    <root>/Orders/AL-2026-0417/{records,scans,planning}/
"""

from __future__ import annotations

from typing import Optional, Union

import logging
import mimetypes
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from ..config import settings

log = logging.getLogger(__name__)

SUBFOLDERS = ("records", "scans", "planning")


@dataclass
class StoredFile:
    ref: str
    external_link: str = ""
    size_bytes: int = 0


class StorageError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Local
# --------------------------------------------------------------------------


class LocalStorage:
    backend = "local"

    def __init__(self, root: str):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def ensure_order_folder(self, order_number: str) -> str:
        base = self.root / "Orders" / order_number
        for sub in SUBFOLDERS:
            (base / sub).mkdir(parents=True, exist_ok=True)
        return str(base)

    def save(
        self, order_number: str, subfolder: str, filename: str, fileobj: BinaryIO, mime_type: str
    ) -> StoredFile:
        self.ensure_order_folder(order_number)
        safe = f"{uuid.uuid4().hex[:8]}-{Path(filename).name}"
        target = self.root / "Orders" / order_number / subfolder / safe
        with target.open("wb") as out:
            shutil.copyfileobj(fileobj, out)
        return StoredFile(ref=str(target.relative_to(self.root)), size_bytes=target.stat().st_size)

    def open(self, ref: str) -> BinaryIO:
        path = self.root / ref
        if not path.is_file():
            raise StorageError(f"File missing from storage: {ref}")
        return path.open("rb")

    def delete(self, ref: str) -> None:
        path = self.root / ref
        if path.is_file():
            path.unlink()


# --------------------------------------------------------------------------
# Google Drive
# --------------------------------------------------------------------------


class DriveStorage:
    backend = "drive"

    def __init__(self, service_account_file: str, root_folder_id: str):
        if not service_account_file or not root_folder_id:
            raise StorageError(
                "STORAGE_BACKEND=drive needs DRIVE_SERVICE_ACCOUNT_FILE and DRIVE_ROOT_FOLDER_ID."
            )
        self.root_folder_id = root_folder_id
        self._service_account_file = service_account_file
        self._service = None

    @property
    def service(self):
        if self._service is None:
            from google.oauth2 import service_account
            from googleapiclient.discovery import build

            creds = service_account.Credentials.from_service_account_file(
                self._service_account_file,
                scopes=["https://www.googleapis.com/auth/drive"],
            )
            self._service = build("drive", "v3", credentials=creds, cache_discovery=False)
        return self._service

    def _get_or_create_folder(self, name: str, parent_id: str) -> str:
        escaped = name.replace("'", "\\'")
        query = (
            f"name = '{escaped}' and mimeType = 'application/vnd.google-apps.folder' "
            f"and '{parent_id}' in parents and trashed = false"
        )
        found = (
            self.service.files()
            .list(
                q=query,
                fields="files(id, name)",
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            )
            .execute()
        )
        items = found.get("files", [])
        if items:
            return items[0]["id"]

        folder = (
            self.service.files()
            .create(
                body={
                    "name": name,
                    "mimeType": "application/vnd.google-apps.folder",
                    "parents": [parent_id],
                },
                fields="id",
                supportsAllDrives=True,
            )
            .execute()
        )
        return folder["id"]

    def ensure_order_folder(self, order_number: str) -> str:
        orders_id = self._get_or_create_folder("Orders", self.root_folder_id)
        order_id = self._get_or_create_folder(order_number, orders_id)
        for sub in SUBFOLDERS:
            self._get_or_create_folder(sub, order_id)
        return order_id

    def save(
        self, order_number: str, subfolder: str, filename: str, fileobj: BinaryIO, mime_type: str
    ) -> StoredFile:
        from googleapiclient.http import MediaIoBaseUpload

        order_folder_id = self.ensure_order_folder(order_number)
        target_id = self._get_or_create_folder(subfolder, order_folder_id)

        media = MediaIoBaseUpload(fileobj, mimetype=mime_type, resumable=True, chunksize=5 * 1024 * 1024)
        created = (
            self.service.files()
            .create(
                body={"name": filename, "parents": [target_id]},
                media_body=media,
                fields="id, size, webViewLink",
                supportsAllDrives=True,
            )
            .execute()
        )
        # No permissions call. Access is granted per request by the API, never by link.
        return StoredFile(
            ref=created["id"],
            external_link=created.get("webViewLink", ""),
            size_bytes=int(created.get("size") or 0),
        )

    def open(self, ref: str) -> BinaryIO:
        import io

        from googleapiclient.http import MediaIoBaseDownload

        request = self.service.files().get_media(fileId=ref, supportsAllDrives=True)
        buffer = io.BytesIO()
        downloader = MediaIoBaseDownload(buffer, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
        buffer.seek(0)
        return buffer

    def delete(self, ref: str) -> None:
        try:
            self.service.files().delete(fileId=ref, supportsAllDrives=True).execute()
        except Exception as exc:  # noqa: BLE001 — a missing remote file must not block the request
            log.warning("Could not delete Drive file %s: %s", ref, exc)


# --------------------------------------------------------------------------


_storage: Optional[Union[LocalStorage, DriveStorage]] = None


def get_storage() -> Union[LocalStorage, DriveStorage]:
    global _storage
    if _storage is None:
        if settings.storage_backend == "drive":
            _storage = DriveStorage(
                settings.drive_service_account_file, settings.drive_root_folder_id
            )
        else:
            _storage = LocalStorage(settings.storage_local_root)
    return _storage


def guess_mime(filename: str, provided: Optional[str]) -> str:
    if provided and provided != "application/octet-stream":
        return provided
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"
