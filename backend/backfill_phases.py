"""Divide cases that were already part-way through when phases became a table.

Phases used to be worked out on the fly from the phase count. Cases opened
before that changed have no rows, so the tracker shows nothing and a fit issue
cannot be reported against them. This writes their division down and recovers
each phase's state from what has actually been shipped:

  * a phase whose batch was delivered and answered "carry on" is completed;
  * the batch currently with the clinic is active;
  * anything the lab has not made yet has not started.

Safe to run more than once — a case that already has phases is left alone.
"""

from __future__ import annotations

import sys

from app.db import SessionLocal
from app.enums import DispatchMode, PhaseDecision, PhaseStatus, ShipmentStatus, ShipmentType
from app.models import Order
from app.services import phases as phase_service

DRY_RUN = "--apply" not in sys.argv


def main() -> int:
    db = SessionLocal()
    divided = 0
    inspected = 0

    for order in db.query(Order).filter(Order.dispatch_mode.isnot(None)):
        if order.phases:
            continue
        inspected += 1
        spans = order.phase_plan
        if not spans:
            print(f"  {order.reference}: no plan to divide, skipped")
            continue

        if not DRY_RUN:
            phase_service.divide(db, order)

        # Recover state from the batches that have actually gone out.
        batches = [
            s
            for s in order.shipments
            if s.shipment_type == ShipmentType.ALIGNER_PHASE and s.phase_number
        ]
        states = {}
        for batch in batches:
            if batch.phase_decision == PhaseDecision.CONTINUE and (
                batch.status == ShipmentStatus.DELIVERED
            ):
                states[batch.phase_number] = PhaseStatus.COMPLETED
            elif batch.phase_decision == PhaseDecision.REPEAT:
                states[batch.phase_number] = PhaseStatus.NOT_STARTED
            else:
                states[batch.phase_number] = PhaseStatus.ACTIVE

        if not DRY_RUN:
            for phase in order.phases:
                phase.status = states.get(phase.phase_number, PhaseStatus.NOT_STARTED)
                rounds = [b.phase_round or 1 for b in batches if b.phase_number == phase.phase_number]
                phase.round = max(rounds) if rounds else 1

        mode = "FULL" if order.dispatch_mode == DispatchMode.FULL else f"{len(spans)} phases"
        print(
            f"  {order.reference}: {mode} -> "
            + ", ".join(
                f"{n}:{states.get(n, PhaseStatus.NOT_STARTED)}"
                for n in sorted(s["phase"] for s in spans)
            )
        )
        divided += 1

    if DRY_RUN:
        print(f"\n{divided} case(s) would be divided (of {inspected} undivided).")
        print("Re-run with --apply to write.")
        db.rollback()
    else:
        db.commit()
        print(f"\n{divided} case(s) divided.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
