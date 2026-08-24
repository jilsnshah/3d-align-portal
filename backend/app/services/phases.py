"""The phases a case is delivered in, and where each one has got to.

A phased case is divided once, when the clinic says how many batches it wants,
and that division is permanent. Every phase then carries its own state, because
the two things that go wrong mid-treatment need it:

  * an aligner inside a phase does not fit, which makes a phase that had been
    delivered unfinished again; and
  * a mid-course rescan, after which delivery has to resume at the earliest
    unfinished phase and leave the finished ones alone.

Neither can be worked out from the last shipment, which is why the state is
written down rather than inferred.
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from ..enums import DispatchMode, PhaseStatus
from ..models import Order, OrderPhase, utcnow


def divide(db: Session, order: Order) -> list:
    """Fix the case's phases, once.

    Called when the clinic commits to a dispatch mode. Dividing a case that is
    already divided is a no-op: the boundaries a patient is part-way through are
    not something to recompute.
    """
    if order.phases:
        return order.phases

    spans = order.phase_plan  # the computed preview, before anything is stored
    if not spans and order.dispatch_mode == DispatchMode.FULL:
        # A full dispatch is one phase covering the whole series.
        steps = order.aligner_steps
        plan = order.approved_plan or order.current_plan
        if not steps or plan is None:
            return []
        spans = [
            {
                "phase": 1,
                "from_step": 1,
                "to_step": steps,
                "upper_from": 1 if plan.aligners_upper else None,
                "upper_to": plan.aligners_upper or None,
                "lower_from": 1 if plan.aligners_lower else None,
                "lower_to": plan.aligners_lower or None,
            }
        ]

    for span in spans:
        row = OrderPhase(
            order_id=order.id,
            phase_number=span["phase"],
            from_step=span["from_step"],
            to_step=span["to_step"],
            upper_from=span["upper_from"],
            upper_to=span["upper_to"],
            lower_from=span["lower_from"],
            lower_to=span["lower_to"],
            status=PhaseStatus.NOT_STARTED,
            round=1,
        )
        db.add(row)
        order.phases.append(row)
    return order.phases


def get(order: Order, number: int) -> Optional[OrderPhase]:
    return next((p for p in order.phases if p.phase_number == number), None)


def mark_shipped(order: Order, number: int) -> None:
    """The batch has gone out and is with the clinic."""
    phase = get(order, number)
    if phase is not None:
        phase.status = PhaseStatus.ACTIVE


def mark_completed(order: Order, number: int) -> None:
    """The clinic wore the batch through and sent its progress photographs.

    That is what finishes a phase. The lab's review of those photographs
    decides what happens next — carry on, or take a fresh scan — not whether
    this phase happened, which is why a rescan called at that point resumes at
    the phase *after* this one.
    """
    phase = get(order, number)
    if phase is not None:
        phase.status = PhaseStatus.COMPLETED
        phase.completed_at = utcnow()


def reopen(order: Order, number: int) -> None:
    """A fit issue puts a phase back to unfinished, even if it had been signed
    off. Delivery resumes here rather than moving on."""
    phase = get(order, number)
    if phase is not None:
        phase.status = PhaseStatus.ISSUE
        phase.completed_at = None


def remake(order: Order, number: int) -> None:
    """Make this phase again as its next round. The span does not change — the
    same aligners are being replaced, not different ones."""
    phase = get(order, number)
    if phase is not None:
        phase.status = PhaseStatus.NOT_STARTED
        phase.round += 1
        phase.completed_at = None


def resume_after_rescan(order: Order) -> Optional[OrderPhase]:
    """Put the earliest unfinished phase back in line to be made.

    A refinement rebuilds the aligners that have not been delivered yet, so the
    phase that was interrupted is made again from the new scan. Phases already
    completed are left exactly as they are.
    """
    phase = order.active_phase
    if phase is None:
        # Every phase has been worn through — which happens when the issue was
        # on the very last aligner of the last batch. There is no later phase to
        # resume at, so the refinement remakes the final one; otherwise the case
        # would come back from the scan with nothing left to deliver.
        phase = order.phases[-1] if order.phases else None
        if phase is None:
            return None
        phase.status = PhaseStatus.NOT_STARTED
        phase.round += 1
        phase.completed_at = None
        return phase
    # A phase that had already been made is being made again, so it advances a
    # round. One that was never started is simply next in line and keeps its
    # numbering.
    if phase.status in (PhaseStatus.ACTIVE, PhaseStatus.ISSUE):
        phase.round += 1
    phase.status = PhaseStatus.NOT_STARTED
    phase.completed_at = None
    return phase


def all_complete(order: Order) -> bool:
    return bool(order.phases) and all(
        p.status == PhaseStatus.COMPLETED for p in order.phases
    )


def phase_for_aligner(order: Order, step: int) -> Optional[OrderPhase]:
    """Which phase carries a given treatment step."""
    return next(
        (p for p in order.phases if p.from_step <= step <= p.to_step), None
    )
