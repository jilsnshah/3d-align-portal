"""The staged models behind the 3D viewer.

Planning software exports one mesh per arch per step:

    0-S-3D_ALIGN_PA.stl     step 0, superior (upper), passive
    7-I-3D_ALIGN.stl        step 7, inferior (lower)
    15-I-3D_ALIGN_C.stl     step 15, lower, final

The step and arch live in the filename, so the viewer's timeline is derived
from what the lab uploaded rather than from anything typed in twice.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from ..enums import FileCategory

# 0-S-3D_ALIGN_PA.stl — step, arch, optional suffix.
STAGE_PATTERN = re.compile(r"^(\d+)\s*-\s*([SI])\s*-\s*(.+?)(?:_(PA|C))?\.stl$", re.IGNORECASE)

ARCH_NAMES = {"S": "upper", "I": "lower"}

# The lab's own shorthand, spelled out for the clinic.
SUFFIX_NAMES = {
    "PA": "passive",  # this arch is holding while the other one moves
    "C": "final",
}


@dataclass
class StageModel:
    file_id: str
    filename: str
    arch: str
    step: int
    kind: str = ""
    size_bytes: int = 0


@dataclass
class Stage:
    step: int
    upper: Optional[StageModel] = None
    lower: Optional[StageModel] = None

    @property
    def is_passive(self) -> bool:
        return any(m and m.kind == "passive" for m in (self.upper, self.lower))


def parse_name(filename: str) -> Optional[tuple]:
    """(step, arch, kind) from a staged export, or None if it is not one.

    Tolerates a directory prefix: a folder upload names files by their relative
    path, and a timeline that silently reads as empty is worse than one that
    ignores a stray folder name.
    """
    bare = filename.strip().replace("\\", "/").rsplit("/", 1)[-1]
    match = STAGE_PATTERN.match(bare)
    if not match:
        return None
    step = int(match.group(1))
    arch = ARCH_NAMES.get(match.group(2).upper())
    kind = SUFFIX_NAMES.get((match.group(4) or "").upper(), "")
    if arch is None:
        return None
    return step, arch, kind


def stages_for(order) -> list:
    """Every step the lab has uploaded models for, in order.

    Later revisions win: a re-uploaded step replaces the earlier one rather than
    showing twice on the timeline.
    """
    best: dict = {}
    for f in order.files:
        if f.is_deleted or f.category != FileCategory.SIMULATION_MODEL:
            continue
        parsed = parse_name(f.filename)
        if parsed is None:
            continue
        step, arch, kind = parsed
        key = (step, arch)
        current = best.get(key)
        if current is None or f.revision >= current[0].revision:
            best[key] = (f, StageModel(
                file_id=f.id,
                filename=f.filename,
                arch=arch,
                step=step,
                kind=kind,
                size_bytes=f.size_bytes,
            ))

    stages: dict = {}
    for (step, arch), (_, model) in best.items():
        stage = stages.setdefault(step, Stage(step=step))
        setattr(stage, arch, model)
    return [stages[k] for k in sorted(stages)]
