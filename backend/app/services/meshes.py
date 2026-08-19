"""Turning lab STL exports into something a browser can actually open.

A staged treatment plan is ~34 binary STL files at roughly 8 MB each — about
270 MB for one case. STL stores every triangle as three loose vertices with a
normal nobody needs, so most of that is repetition: the same corner written out
once per triangle that touches it.

Welding those duplicates and dropping the normals gives an indexed mesh about a
third of the size, before gzip. The result is cached next to the upload, so the
cost is paid once per file rather than once per viewing.

Wire format (little-endian), read directly by the viewer:

    magic   4s   'A3DM'
    version u32  2
    verts   u32  vertex count
    tris    u32  triangle count
    flags   u32  bit 0: a per-vertex movement channel follows
    bounds  6f   minx miny minz maxx maxy maxz
    centre  3f   centroid, so the viewer can frame the arch without scanning
    pos     f32  verts * 3
    idx     u32  tris * 3
    move    u8   verts, only when bit 0 is set

The movement channel is how far each point has travelled from the starting
position, in tenths of a millimetre, clamped at 25.5 mm. One byte per vertex
colours the whole arch for about 90 KB.
"""

from __future__ import annotations

import hashlib
import logging
import struct
from pathlib import Path
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)

MAGIC = b"A3DM"
VERSION = 2
FLAG_MOVEMENT = 1

# Tenths of a millimetre per unit, so one byte covers 0-25.5 mm — far beyond
# any orthodontic movement.
MOVEMENT_SCALE = 10.0

# Vertices closer than this are the same corner. STL exports carry float noise,
# so an exact match welds far less than it should. 1 micron on a dental scan in
# millimetres is far below anything clinically meaningful.
WELD_DECIMALS = 3


class MeshError(RuntimeError):
    pass


def _read_binary_stl(data: bytes) -> np.ndarray:
    """Returns an (n, 3, 3) array of triangle corners."""
    if len(data) < 84:
        raise MeshError("Not an STL file.")
    count = struct.unpack_from("<I", data, 80)[0]
    expected = 84 + count * 50
    if expected != len(data):
        raise MeshError(
            f"STL says {count} triangles ({expected} bytes) but the file is {len(data)}."
        )

    # Each record is 12 floats (normal + 3 corners) then a 2-byte attribute.
    records = np.frombuffer(data, dtype=np.uint8, count=count * 50, offset=84)
    records = records.reshape(count, 50)
    floats = records[:, :48].copy().view(np.float32).reshape(count, 4, 3)
    return floats[:, 1:, :]  # drop the normal; it is recomputed on the GPU


def _is_ascii_stl(data: bytes) -> bool:
    return data[:5].lower() == b"solid" and b"facet normal" in data[:2048].lower()


def movement_against(positions: np.ndarray, reference: np.ndarray) -> np.ndarray:
    """How far each point has moved from the starting arch, in millimetres.

    The staged exports do not share a vertex ordering — they are not even the
    same vertex count — so there is no point-to-point correspondence to
    subtract. Distance to the nearest point on the starting surface is the
    honest approximation: it reads zero where nothing moved and grows with
    displacement, which is what a clinician is looking for.

    It understates pure sliding along a surface, so it is a movement map rather
    than a measurement.
    """
    from scipy.spatial import cKDTree

    tree = cKDTree(reference)
    distance, _ = tree.query(positions, k=1, workers=-1)
    return distance


def convert(data: bytes, reference: Optional[np.ndarray] = None) -> bytes:
    """STL bytes in, compact indexed mesh out.

    ``reference`` is the starting arch's vertices; when given, the mesh carries
    a per-vertex movement channel measured against it.
    """
    if _is_ascii_stl(data):
        raise MeshError("ASCII STL is not supported; export a binary STL.")

    corners = _read_binary_stl(data)
    flat = corners.reshape(-1, 3)

    # Weld: round to the tolerance, then map every corner onto its unique row.
    rounded = np.round(flat.astype(np.float64), WELD_DECIMALS)
    unique, inverse = np.unique(rounded, axis=0, return_inverse=True)

    positions = unique.astype(np.float32)
    indices = inverse.astype(np.uint32)

    lo = positions.min(axis=0)
    hi = positions.max(axis=0)
    centre = positions.mean(axis=0)

    movement = b""
    flags = 0
    if reference is not None and len(reference):
        distances = movement_against(positions, reference)
        scaled = np.clip(distances * MOVEMENT_SCALE, 0, 255).astype(np.uint8)
        movement = scaled.tobytes()
        flags |= FLAG_MOVEMENT

    header = struct.pack(
        "<4sIIII6f3f",
        MAGIC,
        VERSION,
        len(positions),
        len(indices) // 3,
        flags,
        *lo.tolist(),
        *hi.tolist(),
        *centre.tolist(),
    )
    return header + positions.tobytes() + indices.tobytes() + movement


def vertices_of(payload: bytes) -> np.ndarray:
    """Reads the positions back out of a converted mesh."""
    verts = struct.unpack_from("<I", payload, 8)[0]
    return np.frombuffer(payload, dtype=np.float32, count=verts * 3, offset=56).reshape(-1, 3)


def cache_path(root: Path, storage_ref: str) -> Path:
    """One cached mesh per stored file, keyed on its ref and the wire format.

    The version is in the name so a format change cannot serve a stale mesh the
    viewer no longer knows how to read.
    """
    digest = hashlib.sha1(storage_ref.encode()).hexdigest()[:20]
    return root / "meshes" / f"{digest}.v{VERSION}.a3dm"


def converted(root: Path, storage_ref: str, read_source, reference=None) -> bytes:
    """Cached conversion. ``read_source`` yields the original STL bytes.

    ``reference`` supplies the starting arch for the movement channel; it is
    only read when the mesh is not already cached.
    """
    target = cache_path(root, storage_ref)
    if target.is_file():
        return target.read_bytes()

    payload = convert(read_source(), reference() if callable(reference) else reference)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Write beside then move, so a crash mid-write cannot leave a half mesh.
    scratch = target.with_suffix(".part")
    scratch.write_bytes(payload)
    scratch.replace(target)
    return payload
