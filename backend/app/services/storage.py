"""Case file storage.

Three backends behind one interface:

  local  — writes under STORAGE_LOCAL_ROOT. Default, so the portal runs with no
           Google setup at all.
  drive  — Google Drive via a *service account* on a Shared Drive.
  s3     — any S3-compatible bucket (Supabase Storage, Cloudflare R2, Backblaze
           B2). What a deployment uses when its filesystem is thrown away on
           every redeploy, which is the case on a free container host.

The Drive folder walk is ported from the old ``mainlogic.upload_drive``, with two
deliberate changes: credentials come from a service account instead of an
interactive OAuth token that expires, and nothing is ever made public. The old
code set ``{'type': 'anyone', 'role': 'reader'}`` on patient folders, which put
identifiable records on permanent public URLs.

The tree is keyed on the case reference. A case starts under its enquiry ref
and the folder is renamed once the case reaches planning and earns an AL number:

    <root>/Orders/EN-2026-0044/{records,scans,planning}/   before planning
    <root>/Orders/AL-2026-0417/{records,scans,planning}/   after
"""

from __future__ import annotations

from typing import Optional, Union

import logging
import mimetypes
import re
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
        safe = f"{uuid.uuid4().hex[:8]}-{safe_object_name(filename)}"
        target = self.root / "Orders" / order_number / subfolder / safe
        with target.open("wb") as out:
            shutil.copyfileobj(fileobj, out)
        return StoredFile(ref=str(target.relative_to(self.root)), size_bytes=target.stat().st_size)

    def rename_order_folder(self, old_name: str, new_name: str) -> Optional[str]:
        """Renames the case folder when a case is given its number. Local refs
        embed the folder name, so the caller has to rewrite them too."""
        source = self.root / "Orders" / old_name
        target = self.root / "Orders" / new_name
        if not source.is_dir():
            # Already renamed — a retry, or a second pass over the same case.
            # Saying so is better than reporting nothing happened, which left
            # the caller unable to tell success from a missing folder.
            return str(target) if target.is_dir() else None
        if target.exists():
            raise StorageError(f"Cannot rename to {new_name}: that folder already exists.")
        source.rename(target)
        return str(target)

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

    def rename_order_folder(self, old_name: str, new_name: str) -> Optional[str]:
        """Drive refs are file ids, so renaming the parent folder leaves every
        stored file reachable. Nothing else needs rewriting."""
        orders_id = self._get_or_create_folder("Orders", self.root_folder_id)
        found = (
            self.service.files()
            .list(
                q=(
                    f"name = '{old_name}' and '{orders_id}' in parents "
                    "and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
                ),
                fields="files(id)",
                pageSize=1,
            )
            .execute()
            .get("files", [])
        )
        if not found:
            return None
        folder_id = found[0]["id"]
        self.service.files().update(fileId=folder_id, body={"name": new_name}).execute()
        return folder_id

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
# S3-compatible object storage
# --------------------------------------------------------------------------


class _Body:
    """A readable, iterable view over an S3 object.

    Two callers want different things from ``open``: the download route hands it
    to StreamingResponse, which iterates it, while the mesh conversion calls
    ``.read()``. botocore's own StreamingBody iterates *by line*, which for a
    binary STL means one unbounded chunk, so the whole file lands in memory
    anyway. Iterating in fixed blocks is what keeps a 200 MB upload from being
    read all at once.
    """

    CHUNK = 1024 * 1024

    def __init__(self, body):
        self._body = body

    def read(self, size: int = -1) -> bytes:
        return self._body.read() if size is None or size < 0 else self._body.read(size)

    def __iter__(self):
        while True:
            block = self._body.read(self.CHUNK)
            if not block:
                return
            yield block

    def close(self) -> None:
        self._body.close()


class S3Storage:
    """Any S3-compatible bucket: Supabase Storage, Cloudflare R2, Backblaze B2.

    Refs are object keys laid out exactly like the local tree, so the two
    backends stay swappable and a ref reads the same in the database either way:

        Orders/AL-2026-0417/scans/9f2c1ab4-upper-arch.stl

    S3 has no directories — a key containing slashes is still one flat object.
    That makes ``ensure_order_folder`` nothing to do, and makes renaming a case
    folder a copy of every object beneath the prefix rather than a metadata
    change.
    """

    backend = "s3"

    def __init__(
        self,
        endpoint_url: str,
        bucket: str,
        region: str,
        key_id: str,
        secret: str,
        session_token: str = "",
    ):
        if not (endpoint_url and bucket and key_id and secret):
            raise StorageError(
                "STORAGE_BACKEND=s3 needs S3_ENDPOINT_URL, S3_BUCKET, "
                "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY."
            )
        self.bucket = bucket
        self._endpoint = endpoint_url
        self._region = region or "us-east-1"
        self._key_id = key_id
        self._secret = secret
        self._session_token = session_token
        self._client = None

    @property
    def client(self):
        if self._client is None:
            import boto3
            from botocore.config import Config

            self._client = boto3.client(
                "s3",
                endpoint_url=self._endpoint,
                region_name=self._region,
                aws_access_key_id=self._key_id,
                aws_secret_access_key=self._secret,
                # Empty for a bucket reached with ordinary S3 access keys.
                aws_session_token=self._session_token or None,
                # Supabase and B2 serve the bucket in the path, not as a
                # subdomain of the endpoint; R2 accepts either.
                config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
            )
            self._check_bucket(self._client)
        return self._client

    def _check_bucket(self, client) -> None:
        """Fail loudly, once, on a bucket that is not reachable.

        Without this the first symptom of a mistyped bucket or a bad key is a
        raw NoSuchBucket surfacing as a 500 the moment a clinic uploads a scan.
        Checked once per process, when the client is first built.
        """
        try:
            client.head_bucket(Bucket=self.bucket)
        except Exception as exc:
            raise StorageError(
                f"Cannot reach the storage bucket {self.bucket!r} at {self._endpoint}. "
                "Check S3_BUCKET, the endpoint and the access keys."
            ) from exc

    def ensure_order_folder(self, order_number: str) -> str:
        # Nothing to create: the prefix exists the moment a key uses it.
        return f"Orders/{order_number}"

    def save(
        self, order_number: str, subfolder: str, filename: str, fileobj: BinaryIO, mime_type: str
    ) -> StoredFile:
        safe = f"{uuid.uuid4().hex[:8]}-{safe_object_name(filename)}"
        key = f"Orders/{order_number}/{subfolder}/{safe}"
        self.client.upload_fileobj(
            fileobj, self.bucket, key, ExtraArgs={"ContentType": mime_type}
        )
        return StoredFile(ref=key, size_bytes=self._size(key))

    def _size(self, key: str) -> int:
        try:
            return int(self.client.head_object(Bucket=self.bucket, Key=key)["ContentLength"])
        except Exception as exc:  # size is for display only, never worth a 500
            log.warning("Could not size %s: %s", key, exc)
            return 0

    def _keys_under(self, prefix: str):
        token = None
        while True:
            kwargs = {"Bucket": self.bucket, "Prefix": prefix}
            if token:
                kwargs["ContinuationToken"] = token
            page = self.client.list_objects_v2(**kwargs)
            for item in page.get("Contents", []):
                yield item["Key"]
            if not page.get("IsTruncated"):
                return
            token = page.get("NextContinuationToken")

    def rename_order_folder(self, old_name: str, new_name: str) -> Optional[str]:
        """Move every object from one case prefix to another.

        A copy-then-delete per object, because S3 cannot rename. Copies happen
        first and deletes only after all of them land, so a failure part-way
        leaves the originals intact rather than a half-moved case.
        """
        old_prefix = f"Orders/{old_name}/"
        new_prefix = f"Orders/{new_name}/"
        if any(self._keys_under(new_prefix)):
            raise StorageError(f"Cannot rename to {new_name}: that folder already exists.")

        moved = []
        for key in self._keys_under(old_prefix):
            self.client.copy_object(
                Bucket=self.bucket,
                Key=new_prefix + key[len(old_prefix):],
                CopySource={"Bucket": self.bucket, "Key": key},
            )
            moved.append(key)
        if not moved:
            return None
        for key in moved:
            self.client.delete_object(Bucket=self.bucket, Key=key)
        return new_prefix.rstrip("/")

    def open(self, ref: str) -> BinaryIO:
        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=ref)
        except Exception as exc:
            raise StorageError(f"File missing from storage: {ref}") from exc
        return _Body(obj["Body"])

    def delete(self, ref: str) -> None:
        try:
            self.client.delete_object(Bucket=self.bucket, Key=ref)
        except Exception as exc:
            log.warning("Could not delete %s: %s", ref, exc)


# --------------------------------------------------------------------------


_storage: Optional[Union[LocalStorage, DriveStorage, S3Storage]] = None


def get_storage() -> Union[LocalStorage, DriveStorage, S3Storage]:
    global _storage
    if _storage is None:
        if settings.storage_backend == "drive":
            _storage = DriveStorage(
                settings.drive_service_account_file, settings.drive_root_folder_id
            )
        elif settings.storage_backend == "s3":
            _storage = S3Storage(
                settings.s3_endpoint_url,
                settings.s3_bucket,
                settings.s3_region,
                settings.s3_access_key_id,
                settings.s3_secret_access_key,
                settings.s3_session_token,
            )
        else:
            _storage = LocalStorage(settings.storage_local_root)
    return _storage


def safe_object_name(filename: str) -> str:
    """A stored name that every backend can actually address.

    Scanners emit files called "UPPER JAW.stl", and the space in that is not a
    cosmetic problem: Supabase's S3 API refuses CopyObject on any key that
    contains one, which is how a case ended up half-renamed with its files
    stranded under the old reference. The clinic's original name is kept on the
    file record and shown in the portal; this is only what the object is
    addressed by.

    Everything outside the ASCII word characters, dot and dash becomes an
    underscore, runs collapse, and the extension is preserved.
    """
    stem = Path(filename).name.strip()
    ext = Path(stem).suffix[:12]
    base = stem[: len(stem) - len(ext)] if ext else stem

    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._-")
    ext = re.sub(r"[^A-Za-z0-9.]+", "", ext)
    # A name made entirely of characters we strip still has to be addressable.
    base = base[:120] or "file"
    return f"{base}{ext}"


def guess_mime(filename: str, provided: Optional[str]) -> str:
    if provided and provided != "application/octet-stream":
        return provided
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"
