"""Putting the two arches into the patient's real bite.

The staged models the planning software exports are not articulated. Each arch
comes out in its own local frame, both sitting near the origin, so a viewer that
just draws them together shows the upper inside the lower. The old viewer worked
around that by turning the upper over and floating it a fixed 1.2 mm above the
lower, which looks plausible and is clinically meaningless: it shows neither the
patient's overjet, nor the overbite, nor which cusps actually meet.

The intraoral scans do carry the real bite. The scanner records the upper and
lower with a buccal bite registration and exports all three in one articulated
frame, so the scan pair *is* the occlusion. This module uses that:

  1. The bite registration scan is the witness. Its surface should lie on both
     arches at once — that is what a buccal bite scan is. If it does, the
     scanner's articulation is trustworthy.
  2. Step 0 of each staged arch is the same anatomy as the scan of that arch, so
     it can be registered onto it. That gives one rigid transform per arch.
  3. Those transforms move every later step too, because the planning software
     keeps all steps of an arch in that arch's own consistent frame. The teeth
     still move within the arch; the arch as a whole lands in the real bite.

If the arches are not already articulated — some labs export each arch in its
own frame — the bite scan is used directly instead: each arch is registered onto
it, which puts both into the bite's frame and so into occlusion.

Everything here is a rigid transform. Nothing is scaled or distorted, so the
millimetres in the viewer stay the millimetres the scanner measured.
"""

from __future__ import annotations

import hashlib
import json
import logging
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import numpy as np
from scipy.spatial import cKDTree

log = logging.getLogger(__name__)

# Bumped when the maths changes, so stale cached transforms are recomputed.
VERSION = 1

# A registration worse than this is not a fit, it is a coincidence, and it is
# better to say so than to draw a confident but wrong bite.
MAX_RMS_MM = 0.60

# A buccal bite scan lies on the enamel of both arches. These say how close
# "on" is, and how much of it has to touch each arch before we believe the
# scanner articulated them rather than dumping them in one frame by accident.
BITE_NEAR_MM = 0.60
BITE_NEAR_SHARE = 0.70
BITE_ARCH_SHARE = 0.15

# Points used for registration. The scans run to a million vertices; matching
# every one of them buys no accuracy over a fair sample and costs minutes.
SRC_SAMPLE = 12000
DST_SAMPLE = 40000
BITE_SAMPLE = 20000


@dataclass
class Articulation:
    """Where each staged arch belongs, in the frame the scans were taken in."""

    upper: list  # 4x4, row-major
    lower: list
    method: str
    rms_upper: float
    rms_lower: float
    bite_median_mm: Optional[float] = None
    bite_touching_upper: Optional[float] = None
    notes: list = field(default_factory=list)


# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------


def _read_stl(data: bytes) -> np.ndarray:
    """Vertices of an STL, binary or ASCII, as an (n, 3) array of millimetres."""
    if data[:5].lower() == b"solid" and b"facet" in data[:2000]:
        out = []
        for line in data.decode("utf8", "ignore").splitlines():
            parts = line.strip().split()
            if parts and parts[0] == "vertex":
                out.append([float(parts[1]), float(parts[2]), float(parts[3])])
        return np.asarray(out, dtype=np.float64)
    count = struct.unpack_from("<I", data, 80)[0]
    raw = np.frombuffer(data, dtype=np.uint8, count=count * 50, offset=84).reshape(count, 50)
    tris = raw[:, 12:48].copy().view(np.float32).reshape(count, 3, 3)
    return tris.reshape(-1, 3).astype(np.float64)


def _sample(points: np.ndarray, n: int, seed: int = 0) -> np.ndarray:
    if len(points) <= n:
        return points
    rng = np.random.default_rng(seed)
    return points[rng.choice(len(points), n, replace=False)]


def _kabsch(src: np.ndarray, dst: np.ndarray):
    """The rigid transform taking src onto dst. Rotation only — no scaling, and
    forced right-handed so a mirrored arch can never be produced."""
    sc, dc = src.mean(0), dst.mean(0)
    cov = (src - sc).T @ (dst - dc)
    u, _, vt = np.linalg.svd(cov)
    flip = np.sign(np.linalg.det(vt.T @ u.T))
    rot = vt.T @ np.diag([1.0, 1.0, flip]) @ u.T
    return rot, dc - rot @ sc


def _principal(points: np.ndarray) -> np.ndarray:
    """Principal axes as a proper rotation.

    SVD is free to return a left-handed basis. Left uncorrected, every starting
    orientation built from it has determinant -1, gets rejected as a reflection,
    and the arch fails to register at all.
    """
    centred = points - points.mean(0)
    _, _, vt = np.linalg.svd(_sample(centred, 20000), full_matrices=False)
    if np.linalg.det(vt) < 0:
        vt[2] = -vt[2]
    return vt


def _icp(src, dst_tree, rot, off, iters: int, keep: float):
    """Trimmed iterative closest point.

    The staged model and the scan do not cover the same tissue — the scan has
    palate and loose gingiva the staged model never had. Trimming the worst
    correspondences each round keeps that surplus from dragging the arch out of
    position.
    """
    rms = float("inf")
    for _ in range(iters):
        moved = src @ rot.T + off
        if not np.isfinite(moved).all():
            return rot, off, float("inf")
        dist, idx = dst_tree.query(moved, workers=-1)
        limit = np.quantile(dist, keep)
        take = dist <= limit
        if take.sum() < 50:
            return rot, off, float("inf")
        rot, off = _kabsch(src[take], dst_tree.data[idx[take]])
        rms = float(np.sqrt((dist[take] ** 2).mean()))
    return rot, off, rms


def register(src: np.ndarray, dst: np.ndarray, seed: int = 0):
    """Best rigid fit of src onto dst.

    PCA fixes the axes but not which way along them the arch points, so all four
    right-handed sign combinations are tried and the closest fit kept. Without
    this the upper arch, which the planner stores upside down relative to the
    scan, settles into the wrong orientation.
    """
    s = _sample(src, SRC_SAMPLE, seed)
    d = _sample(dst, DST_SAMPLE, seed)
    tree = cKDTree(d)
    vs, vd = _principal(s), _principal(d)

    best = None
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        for sx in (1.0, -1.0):
            for sy in (1.0, -1.0):
                guess = vd.T @ np.diag([sx, sy, sx * sy]) @ vs
                if not np.isfinite(guess).all() or np.linalg.det(guess) < 0:
                    continue
                rot, off, rms = _icp(
                    s, tree, guess, d.mean(0) - guess @ s.mean(0), iters=25, keep=0.7
                )
                if not np.isfinite(rms):
                    continue
                if best is None or rms < best[2]:
                    best = (rot, off, rms)
        if best is None:
            raise ValueError("no starting orientation produced a usable fit")
        rot, off, _ = best
        rot, off, rms = _icp(s, tree, rot, off, iters=60, keep=0.7)
    return rot, off, rms


def _matrix(rot: np.ndarray, off: np.ndarray) -> list:
    m = np.eye(4)
    m[:3, :3] = rot
    m[:3, 3] = off
    return [float(x) for x in m.reshape(-1)]


# --------------------------------------------------------------------------
# Reading the bite
# --------------------------------------------------------------------------


def witness(bite: np.ndarray, upper: np.ndarray, lower: np.ndarray):
    """How well the bite registration agrees with where the arches sit.

    A buccal bite scan is one surface spanning both arches in occlusion. If the
    arches are articulated correctly it lies on both of them; if they are not,
    it lies on at most one. Returns (median distance, share of the bite nearer
    the upper, share lying on either arch).
    """
    pts = _sample(bite, BITE_SAMPLE)
    to_upper = cKDTree(_sample(upper, DST_SAMPLE)).query(pts, workers=-1)[0]
    to_lower = cKDTree(_sample(lower, DST_SAMPLE)).query(pts, workers=-1)[0]
    nearer = np.minimum(to_upper, to_lower)
    return (
        float(np.median(nearer)),
        float((to_upper < to_lower).mean()),
        float((nearer < BITE_NEAR_MM).mean()),
    )


def _articulated(bite, upper, lower):
    """True when the bite scan confirms the two arch scans are already in
    occlusion in one shared frame."""
    median, share_upper, on_surface = witness(bite, upper, lower)
    ok = (
        on_surface >= BITE_NEAR_SHARE
        and BITE_ARCH_SHARE <= share_upper <= 1.0 - BITE_ARCH_SHARE
    )
    return ok, median, share_upper, on_surface


# --------------------------------------------------------------------------
# Solving a case
# --------------------------------------------------------------------------


def _cache_file(root: Path, key: str) -> Path:
    path = root / "mesh-cache" / "articulation" / f"v{VERSION}-{key}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def solve(
    scan_upper: bytes,
    scan_lower: bytes,
    scan_bite: Optional[bytes],
    stage_upper: bytes,
    stage_lower: bytes,
) -> Articulation:
    """Work out where each staged arch belongs, in the scans' frame."""
    su, sl = _read_stl(scan_upper), _read_stl(scan_lower)
    mu, ml = _read_stl(stage_upper), _read_stl(stage_lower)

    notes = []
    median = share_upper = None
    target_upper, target_lower = su, sl
    method = "scan-pair"

    if scan_bite is not None:
        bite = _read_stl(scan_bite)
        ok, median, share_upper, on_surface = _articulated(bite, su, sl)
        if ok:
            method = "bite-witnessed"
            notes.append(
                f"The bite registration sits {median:.2f} mm from the arches and "
                f"touches both, so the scans are in occlusion."
            )
        else:
            # The scans are not articulated with each other. The bite is then
            # the only thing that knows the occlusion, so both arches are put
            # into its frame instead.
            method = "bite-registered"
            notes.append(
                "The arch scans are not in a shared bite, so each was registered "
                "onto the bite registration instead."
            )
            rot_u, off_u, rms_bu = register(su, bite, seed=1)
            rot_l, off_l, rms_bl = register(sl, bite, seed=2)
            target_upper = su @ rot_u.T + off_u
            target_lower = sl @ rot_l.T + off_l
            notes.append(
                f"Arch-to-bite fit: upper {rms_bu:.2f} mm, lower {rms_bl:.2f} mm."
            )
    else:
        notes.append("No bite registration was uploaded; the arch scans were taken as given.")

    rot_u, off_u, rms_u = register(mu, target_upper, seed=3)
    rot_l, off_l, rms_l = register(ml, target_lower, seed=4)

    if rms_u > MAX_RMS_MM or rms_l > MAX_RMS_MM:
        raise ValueError(
            f"The staged models do not match the intraoral scans on this case "
            f"(fit was {rms_u:.2f} mm upper, {rms_l:.2f} mm lower, against a "
            f"{MAX_RMS_MM:.2f} mm limit). Check that the scans uploaded are this "
            f"patient's, and are the full arches rather than placeholders."
        )

    return Articulation(
        upper=_matrix(rot_u, off_u),
        lower=_matrix(rot_l, off_l),
        method=method,
        rms_upper=round(rms_u, 3),
        rms_lower=round(rms_l, 3),
        bite_median_mm=None if median is None else round(median, 3),
        bite_touching_upper=None if share_upper is None else round(share_upper, 3),
        notes=notes,
    )


def solve_cached(root: Path, key_parts, load: Callable[[], tuple]) -> Optional[Articulation]:
    """Registration costs a few seconds, and the answer only changes when the
    files do, so it is worked out once per set of scans and staged models."""
    key = hashlib.sha1("|".join(str(p) for p in key_parts).encode()).hexdigest()[:20]
    path = _cache_file(root, key)
    if path.exists():
        try:
            cached = json.loads(path.read_text())
            # A case whose scans cannot be registered is remembered as such, so
            # the failure is not re-attempted on every view.
            if cached is None or (isinstance(cached, dict) and "__error__" in cached):
                return None
            return Articulation(**cached)
        except Exception:
            path.unlink(missing_ok=True)

    try:
        result = solve(*load())
    except Exception as exc:  # a bad fit is not a reason to break the viewer
        # Remember *why* as well as that it failed. "No bite" and "those scans
        # are not this patient" need different things done about them, and the
        # lab cannot tell which from a silent fallback.
        log.warning("articulation failed (%s); the viewer will fall back", exc)
        path.write_text(json.dumps({"__error__": str(exc)}))
        return None

    path.write_text(json.dumps(result.__dict__))
    return result


def failure_reason(root: Path, key_parts) -> str:
    """Why the last attempt at articulating this case did not work."""
    key = hashlib.sha1("|".join(str(p) for p in key_parts).encode()).hexdigest()[:20]
    path = _cache_file(root, key)
    if not path.exists():
        return ""
    try:
        cached = json.loads(path.read_text())
    except Exception:
        return ""
    if isinstance(cached, dict) and "__error__" in cached:
        return cached["__error__"]
    return ""
