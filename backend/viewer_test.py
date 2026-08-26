"""The 3D viewer's data path: STL in, browser-sized mesh out.

    .venv/bin/python viewer_test.py
"""

import os
import pathlib
import struct
import tempfile

TMP = tempfile.mkdtemp(prefix="align-viewer-")
# TEST_DATABASE_URL runs the same walk against Postgres, which is what a
# deployment uses. SQLite by default so the suite needs no server.
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", f"sqlite:///{TMP}/viewer.db"
)
os.environ["STORAGE_LOCAL_ROOT"] = f"{TMP}/storage"
os.environ["STAFF_EMAIL"] = "staff@3dalign.example.com"
os.environ["STAFF_PASSWORD"] = "staffpassword"
os.environ["DCI_CHECK_ENABLED"] = "false"
os.environ["GOOGLE_MAPS_API_KEY"] = ""

from app.services import meshes, simulation  # noqa: E402

failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"[  ok  ] {label}")
    else:
        failures.append(label)
        print(f"[ FAIL ] {label}" + (f"  — {detail}" if detail else ""))


# -- the lab's filenames carry the timeline -------------------------------
for name, expected in [
    ("0-S-3D_ALIGN_PA.stl", (0, "upper", "passive")),
    ("7-I-3D_ALIGN.stl", (7, "lower", "")),
    ("15-I-3D_ALIGN_C.stl", (15, "lower", "final")),
    ("10-S-3D_ALIGN_C.stl", (10, "upper", "final")),
]:
    check(f"reads step and arch from {name}", simulation.parse_name(name) == expected,
          str(simulation.parse_name(name)))

for name in ("UPPER JAW.stl", "notes.pdf", "Frontal View.mp4", "3D_ALIGN.log"):
    check(f"ignores {name}", simulation.parse_name(name) is None)


# -- a hand-built STL converts to the viewer's format ---------------------
def build_stl(triangles):
    out = bytearray(b"unit test" + b"\0" * 71)
    out += struct.pack("<I", len(triangles))
    for tri in triangles:
        out += struct.pack("<3f", 0.0, 0.0, 1.0)  # normal, discarded
        for point in tri:
            out += struct.pack("<3f", *point)
        out += b"\0\0"
    return bytes(out)


# Two triangles sharing an edge: 6 loose corners, 4 unique.
square = build_stl([
    [(0, 0, 0), (1, 0, 0), (1, 1, 0)],
    [(0, 0, 0), (1, 1, 0), (0, 1, 0)],
])
payload = meshes.convert(square)
magic, version, verts, tris = struct.unpack_from("<4sIII", payload, 0)
check(
    "the mesh is tagged and versioned",
    magic == b"A3DM" and version == meshes.VERSION,
    f"{magic} v{version}",
)
check("shared corners are welded", verts == 4, f"{verts} vertices from 6 corners")
check("every triangle survives", tris == 2, str(tris))

lo = struct.unpack_from("<3f", payload, 20)
hi = struct.unpack_from("<3f", payload, 32)
check("bounds describe the shape", lo == (0.0, 0.0, 0.0) and hi == (1.0, 1.0, 0.0), f"{lo} {hi}")
check(
    "the payload is exactly header plus positions plus indices",
    len(payload) == 56 + verts * 12 + tris * 3 * 4,
    str(len(payload)),
)

# Indices must point at real vertices, or the viewer draws nothing.
indices = struct.unpack_from(f"<{tris * 3}I", payload, 56 + verts * 12)
check("indices stay inside the vertex list", max(indices) < verts, str(max(indices)))

def refuses(data, why):
    try:
        meshes.convert(data)
    except meshes.MeshError:
        return True
    except Exception:
        return False
    return False


check("an ASCII STL is refused rather than mangled",
      refuses(b"solid x\nfacet normal 0 0 1\nendfacet\nendsolid", "ascii"))
check("a truncated file is refused", refuses(square[:-20], "truncated"))
check("a tiny file is refused", refuses(b"nope", "short"))


# -- the movement channel -------------------------------------------------
# Colouring by how far the surface has travelled is the one clinical read the
# fused arch meshes actually support; per-tooth figures would need segmentation.
shifted = build_stl([
    [(0, 0, 2), (1, 0, 2), (1, 1, 2)],
    [(0, 0, 2), (1, 1, 2), (0, 1, 2)],
])
base = meshes.convert(square)
reference = meshes.vertices_of(base)
check("positions can be read back out of a mesh", len(reference) == 4, str(len(reference)))

plain = meshes.convert(shifted)
flags_plain = struct.unpack_from("<I", plain, 16)[0]
check("a mesh with no reference carries no movement channel", flags_plain == 0, str(flags_plain))

mapped = meshes.convert(shifted, reference)
verts, tris = struct.unpack_from("<II", mapped, 8)
flags = struct.unpack_from("<I", mapped, 16)[0]
check("a referenced mesh flags its movement channel", flags & 1, str(flags))
check(
    "the channel is one byte per vertex",
    len(mapped) == 56 + verts * 12 + tris * 3 * 4 + verts,
    str(len(mapped)),
)
moved = mapped[56 + verts * 12 + tris * 12 :]
check(
    "a 2 mm shift reads as 2 mm of movement",
    all(abs(b / 10 - 2.0) < 0.05 for b in moved),
    str(list(moved)),
)

unmoved = meshes.convert(square, reference)
still = unmoved[56 + 4 * 12 + 2 * 12 :]
check("an unchanged arch reads as zero movement", set(still) == {0}, str(set(still)))

# -- the cache means the conversion happens once --------------------------
root = pathlib.Path(TMP) / "cache"
calls = {"n": 0}


def source():
    calls["n"] += 1
    return square


first = meshes.converted(root, "orders/x/0-S.stl", source)
second = meshes.converted(root, "orders/x/0-S.stl", source)
check("the converted mesh is cached on disk", calls["n"] == 1, f"{calls['n']} conversions")
check(
    "the cache is versioned, so a format change cannot serve a stale mesh",
    f"v{meshes.VERSION}" in meshes.cache_path(root, "orders/x/0-S.stl").name,
    meshes.cache_path(root, "orders/x/0-S.stl").name,
)
check("the cached mesh is identical", first == second)
check(
    "the cache is keyed per file",
    meshes.converted(root, "orders/x/1-S.stl", source) is not None and calls["n"] == 2,
    f"{calls['n']} conversions",
)

# -- the real export, if it is still on this machine ----------------------
sample = pathlib.Path(
    "/Users/jils/Projects/3d-align/demo-data/simulation/"
    "3D-Align Case-1176 (Nihar)/BioModels/3D_ALIGN/0-S-3D_ALIGN_PA.stl"
)
if sample.is_file():
    raw = sample.read_bytes()
    out = meshes.convert(raw)
    ratio = len(out) / len(raw)
    check(
        "a real 8 MB arch shrinks enough to ship to a browser",
        ratio < 0.45,
        f"{len(raw)/1e6:.1f} MB -> {len(out)/1e6:.1f} MB ({ratio:.0%})",
    )
    nv, nt = struct.unpack_from("<II", out, 8)
    check("welding removes most duplicate corners", nv < nt * 3 * 0.4, f"{nv} verts, {nt} triangles")
else:
    print("[ skip ] real export not on this machine")

# -- every category the serializer meets must have a group ----------------
# A new file category with no FileGroup entry raises when any case carrying one
# is serialised, which surfaces as "Case not found" rather than as an error.
# -- a new category must be wired into every lookup it touches ------------
# Each of these is a dict keyed by category. Missing an entry does not fail at
# import — it raises the first time a real case carries that file, which is how
# a new category turned into "Case not found" and a 500 on upload.
from app.enums import CATEGORY_FOLDER, FILE_GROUP, FileCategory  # noqa: E402
from app.serializers import CATEGORY_LABELS  # noqa: E402

for label, table in (
    ("a storage folder", CATEGORY_FOLDER),
    ("a revision group", FILE_GROUP),
    ("a human label", CATEGORY_LABELS),
):
    missing = [c.value for c in FileCategory if c not in table]
    check(f"every file category has {label}", not missing, str(missing))


# --------------------------------------------------------------------------
# Articulation: putting the arches into the patient's own bite
# --------------------------------------------------------------------------

SCANS = pathlib.Path(
    "../demo-data/simulation/3D-Align Case-1176 (Nihar)/Scan Files"
)
STAGED = pathlib.Path(
    "../demo-data/simulation/3D-Align Case-1176 (Nihar)/BioModels/3D_ALIGN"
)

if SCANS.is_dir() and STAGED.is_dir():
    import numpy as np

    from app.services import articulation

    def rd(p):
        return p.read_bytes()

    result = articulation.solve(
        rd(SCANS / "UPPER JAW.stl"),
        rd(SCANS / "LOWER JAW.stl"),
        rd(SCANS / "BITE.stl"),
        rd(STAGED / "0-S-3D_ALIGN_PA.stl"),
        rd(STAGED / "0-I-3D_ALIGN_PA.stl"),
    )
    check(
        "the bite registration witnesses the scans as articulated",
        result.method == "bite-witnessed",
        result.method,
    )
    check(
        "both arches register onto their scans to well under a millimetre",
        result.rms_upper < 0.3 and result.rms_lower < 0.3,
        f"upper {result.rms_upper}, lower {result.rms_lower}",
    )
    check(
        "the bite scan lies on the arch surfaces",
        result.bite_median_mm is not None and result.bite_median_mm < 0.5,
        str(result.bite_median_mm),
    )
    check(
        "the bite scan touches both arches, not just one",
        0.2 < result.bite_touching_upper < 0.8,
        str(result.bite_touching_upper),
    )
    for tag, flat in (("upper", result.upper), ("lower", result.lower)):
        m = np.array(flat).reshape(4, 4)
        rot = m[:3, :3]
        # A reflection here would mirror the arch: left canine drawn as right.
        check(
            f"the {tag} transform is a rotation, never a mirror",
            abs(np.linalg.det(rot) - 1.0) < 1e-6,
            str(np.linalg.det(rot)),
        )
        check(
            f"the {tag} transform is rigid, so millimetres stay millimetres",
            np.abs(rot @ rot.T - np.eye(3)).max() < 1e-9,
            str(np.abs(rot @ rot.T - np.eye(3)).max()),
        )
        check(
            f"the {tag} transform does not translate absurdly",
            np.linalg.norm(m[:3, 3]) < 100,
            str(np.linalg.norm(m[:3, 3])),
        )

    # Applying the transforms must actually seat the arches: upper above lower,
    # meeting rather than floating apart or driven through each other.
    up = articulation._read_stl(rd(STAGED / "0-S-3D_ALIGN_PA.stl"))
    lo = articulation._read_stl(rd(STAGED / "0-I-3D_ALIGN_PA.stl"))
    mu = np.array(result.upper).reshape(4, 4)
    ml = np.array(result.lower).reshape(4, 4)
    up_t = up @ mu[:3, :3].T + mu[:3, 3]
    lo_t = lo @ ml[:3, :3].T + ml[:3, 3]
    check(
        "the upper ends up above the lower",
        up_t[:, 2].mean() > lo_t[:, 2].mean(),
        f"upper z {up_t[:, 2].mean():.1f} vs lower z {lo_t[:, 2].mean():.1f}",
    )

    from scipy.spatial import cKDTree

    gap = cKDTree(articulation._sample(up_t, 40000)).query(
        articulation._sample(lo_t, 20000), workers=-1
    )[0]
    check(
        "the arches occlude rather than float apart",
        gap.min() < 0.5,
        f"closest approach {gap.min():.2f} mm",
    )
    check(
        "teeth interdigitate over a real contact area",
        (gap < 1.0).mean() > 0.02,
        f"{(gap < 1.0).mean() * 100:.1f}% of the lower within 1 mm",
    )

    # A case with no bite registration must still be placeable, and must say so.
    no_bite = articulation.solve(
        rd(SCANS / "UPPER JAW.stl"),
        rd(SCANS / "LOWER JAW.stl"),
        None,
        rd(STAGED / "0-S-3D_ALIGN_PA.stl"),
        rd(STAGED / "0-I-3D_ALIGN_PA.stl"),
    )
    check(
        "without a bite registration the method says so",
        no_bite.method == "scan-pair" and no_bite.bite_median_mm is None,
        no_bite.method,
    )

    # Scans that are not the patient's must be refused, not fitted anyway.
    try:
        articulation.solve(
            rd(SCANS / "UPPER JAW.stl"),
            rd(SCANS / "LOWER JAW.stl"),
            None,
            rd(STAGED / "0-S-3D_ALIGN_PA.stl"),
            rd(SCANS / "BITE.stl"),  # a buccal patch is not a lower arch
        )
        check("a mismatched model is refused rather than fitted", False, "it was accepted")
    except ValueError:
        check("a mismatched model is refused rather than fitted", True, "")
else:
    check("articulation fixtures are present", False, f"missing {SCANS}")


print()
if failures:
    print(f"{len(failures)} check(s) failed:")
    for f in failures:
        print(f"  - {f}")
    raise SystemExit(1)
print("All checks passed.")
