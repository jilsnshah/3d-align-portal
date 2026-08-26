"""The S3 storage backend, against a real S3 server.

Object storage is where every case file lives once the portal is deployed, so
these run against a server that speaks S3 rather than a mock — a mock would
happily agree with a wrong understanding of copy semantics or of what iterating
a response body does.

Point it at anything S3-compatible:

    # MinIO, throwaway
    docker run -d --name minio-test -p 9010:9000 \\
      -e MINIO_ROOT_USER=testkey -e MINIO_ROOT_PASSWORD=testsecret123 \\
      minio/minio server /data
    S3_TEST_ENDPOINT=http://127.0.0.1:9010 S3_TEST_KEY=testkey \\
      S3_TEST_SECRET=testsecret123 python storage_test.py

Skips with a note when no endpoint is configured, so the suite stays runnable
with nothing installed.
"""

import io
import os
import sys
import uuid

ENDPOINT = os.environ.get("S3_TEST_ENDPOINT", "")
KEY = os.environ.get("S3_TEST_KEY", "")
SECRET = os.environ.get("S3_TEST_SECRET", "")
REGION = os.environ.get("S3_TEST_REGION", "us-east-1")
BUCKET = os.environ.get("S3_TEST_BUCKET", "align-storage-test")

if not (ENDPOINT and KEY and SECRET):
    print("S3_TEST_ENDPOINT / S3_TEST_KEY / S3_TEST_SECRET not set — skipped.")
    raise SystemExit(0)

from app.services.storage import S3Storage, StorageError  # noqa: E402

passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {detail}")


def main() -> int:
    import boto3

    raw = boto3.client(
        "s3",
        endpoint_url=ENDPOINT,
        region_name=REGION,
        aws_access_key_id=KEY,
        aws_secret_access_key=SECRET,
    )
    try:
        raw.create_bucket(Bucket=BUCKET)
    except Exception:
        pass  # already there

    store = S3Storage(ENDPOINT, BUCKET, REGION, KEY, SECRET)
    # Unique per run, so a rerun never trips over the leftovers of the last one.
    tag = uuid.uuid4().hex[:6]
    enquiry, case, occupied = f"EN-T{tag}", f"AL-T{tag}", f"AL-X{tag}"

    # A binary blob with almost no newlines: the shape that catches a body
    # iterated by line, which would hand back one chunk the size of the file.
    blob = b"solid test\n" + bytes(range(256)) * 6000

    stored = store.save(enquiry, "scans", "upper arch.stl", io.BytesIO(blob), "model/stl")
    check(
        "save keys the file under the case",
        stored.ref.startswith(f"Orders/{enquiry}/scans/") and stored.ref.endswith("-upper arch.stl"),
        stored.ref,
    )
    check("save reports the stored size", stored.size_bytes == len(blob), stored.size_bytes)
    check("what was written reads back byte for byte", store.open(stored.ref).read() == blob)

    chunks = list(store.open(stored.ref))
    check(
        "the body iterates in bounded blocks",
        len(chunks) > 1 and max(len(c) for c in chunks) <= 1024 * 1024,
        f"{len(chunks)} chunks",
    )
    check("the blocks rejoin into the original", b"".join(chunks) == blob)

    # A case is renamed when it earns its AL number, and every file has to come
    # with it — S3 cannot rename, so this is a copy of each object.
    store.save(enquiry, "records", "front.jpg", io.BytesIO(b"jpeg"), "image/jpeg")
    check("renaming an untouched case says so", store.rename_order_folder(f"EN-Z{tag}", case) is None)
    check("rename reports the new prefix", store.rename_order_folder(enquiry, case) == f"Orders/{case}")
    moved_ref = stored.ref.replace(enquiry, case)
    check("the file survives the rename intact", store.open(moved_ref).read() == blob)
    check("every file moves, not just the first", len(list(store._keys_under(f"Orders/{case}/"))) == 2)
    check("nothing is left at the old prefix", not list(store._keys_under(f"Orders/{enquiry}/")))

    store.save(occupied, "scans", "x.stl", io.BytesIO(b"x"), "model/stl")
    try:
        store.rename_order_folder(case, occupied)
        check("renaming onto an occupied case is refused", False)
    except StorageError:
        check("renaming onto an occupied case is refused", True)
    check(
        "the refused rename moved nothing",
        len(list(store._keys_under(f"Orders/{case}/"))) == 2,
    )

    try:
        store.open(f"Orders/{case}/scans/never-uploaded.stl")
        check("a missing file raises rather than returning empty", False)
    except StorageError:
        check("a missing file raises rather than returning empty", True)

    store.delete(moved_ref)
    try:
        store.open(moved_ref)
        check("delete removes the object", False)
    except StorageError:
        check("delete removes the object", True)
    store.delete(moved_ref)
    check("deleting what is already gone stays quiet", True)

    for prefix in (f"Orders/{case}/", f"Orders/{occupied}/"):
        for key in list(store._keys_under(prefix)):
            store.delete(key)

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
