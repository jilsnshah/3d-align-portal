"""Removes the throwaway accounts left behind by geocoding experiments.

Registering test clinics to check how addresses resolve left real-looking
doctors in the database — "Dr. Probe" at "nonsense address" — and the bulk case
seeder then spread cases across them. Their cases are handed to real clinics
rather than deleted, so nothing that was seeded for the demo disappears.

    .venv/bin/python cleanup_probes.py
"""

import itertools

from app.db import SessionLocal
from app.enums import VerificationStatus
from app.models import Address, Doctor, Order, Patient, User

JUNK_NAMES = {"Dr. Probe", "Dr. Pin", "Dr. Far", "Dr. Test Registrant"}

db = SessionLocal()

junk = [d for d in db.query(Doctor).all() if d.full_name in JUNK_NAMES]
real = [
    d
    for d in db.query(Doctor).all()
    if d not in junk
    and d.verification_status == VerificationStatus.VERIFIED
    and db.query(Address).filter(Address.doctor_id == d.id).first() is not None
]
if not real:
    raise SystemExit("No verified clinic to hand the cases to.")

print(f"{len(junk)} throwaway account(s); handing their cases to {len(real)} real clinic(s)\n")

wheel = itertools.cycle(real)
moved_orders = moved_patients = 0

for doctor in junk:
    target = next(wheel)
    address = db.query(Address).filter(Address.doctor_id == target.id).first()

    for patient in db.query(Patient).filter(Patient.doctor_id == doctor.id).all():
        patient.doctor_id = target.id
        moved_patients += 1

    orders = db.query(Order).filter(Order.doctor_id == doctor.id).all()
    for order in orders:
        order.doctor_id = target.id
        # The old address is about to go, so point the case at the new clinic.
        order.shipping_address_id = address.id if address else None
        moved_orders += 1

    print(f"  {doctor.clinic_name[:28]:<30} {len(orders):>3} case(s) -> {target.clinic_name}")

db.flush()

for doctor in junk:
    for address in db.query(Address).filter(Address.doctor_id == doctor.id).all():
        db.delete(address)
    user = db.get(User, doctor.user_id)
    db.delete(doctor)
    if user:
        db.delete(user)

db.commit()
print(f"\n{moved_orders} case(s) and {moved_patients} patient(s) rehomed; {len(junk)} account(s) removed")
print(f"{db.query(Doctor).count()} clinic(s) remain")
