"""Bulk cases, to check the lists hold up at the scale the lab expects.

    .venv/bin/python seed_bulk.py [count]
"""

import random
import sys

from app.db import SessionLocal
from app.enums import OrderStatus
from app.models import Address, Doctor, Order, Patient
from app.services.numbering import next_enquiry_number, next_order_number

count = int(sys.argv[1]) if len(sys.argv) > 1 else 500
db = SessionLocal()
doctors = db.query(Doctor).all()
if not doctors:
    raise SystemExit("No doctors — run seed_demo.py first.")

FIRST = ["Aarav","Diya","Kabir","Meera","Rohan","Sana","Vivaan","Isha","Arjun","Priya",
         "Neel","Tanvi","Yash","Ridhi","Devang","Aarohi","Nikhil","Kavya","Manav","Sara"]
LAST = ["Shah","Patel","Desai","Mehta","Joshi","Trivedi","Parekh","Solanki","Rathod","Amin"]
SPREAD = [
    (OrderStatus.DRAFT, 6), (OrderStatus.SUBMITTED, 8), (OrderStatus.UNDER_REVIEW, 6),
    (OrderStatus.QUOTED, 10), (OrderStatus.AWAITING_SCAN, 14), (OrderStatus.IN_PLANNING, 12),
    (OrderStatus.PLAN_SHARED, 8), (OrderStatus.ALIGNER_PRODUCTION, 12),
    (OrderStatus.DISPATCHING, 8), (OrderStatus.COMPLETED, 12), (OrderStatus.CANCELLED, 4),
]
pool = [s for s, weight in SPREAD for _ in range(weight)]

made = 0
for i in range(count):
    doctor = random.choice(doctors)
    address = db.query(Address).filter(Address.doctor_id == doctor.id).first()
    patient = Patient(
        doctor_id=doctor.id,
        full_name=f"{random.choice(FIRST)} {random.choice(LAST)}",
        external_ref=f"CH-{random.randint(1000, 9999)}",
    )
    db.add(patient)
    db.flush()

    status = random.choice(pool)
    order = Order(
        enquiry_number=next_enquiry_number(db),
        doctor_id=doctor.id,
        patient_id=patient.id,
        status=status,
        shipping_address_id=address.id if address else None,
        chief_complaint=random.choice(
            ["Crowding, upper anteriors.", "Spacing.", "Deep bite.", "Rotated 12.", "Open bite."]
        ),
    )
    # Anything that reached planning carries a production number.
    if status in (
        OrderStatus.IN_PLANNING, OrderStatus.PLAN_SHARED, OrderStatus.ALIGNER_PRODUCTION,
        OrderStatus.DISPATCHING, OrderStatus.COMPLETED,
    ):
        order.order_number = next_order_number(db)
    db.add(order)
    made += 1
    if made % 100 == 0:
        db.commit()
        print(f"  {made}…", flush=True)

db.commit()
total = db.query(Order).count()
print(f"\n{made} case(s) added; {total} in the database")
