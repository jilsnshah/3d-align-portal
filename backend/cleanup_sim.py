"""Undoes the multi-branch modelling mistake.

A doctor runs one clinic. Branches were seeded under a single practice, which
made every stop on a route read as the same name and misrepresented how the
scheduler actually sees the city.

Removes the invented addresses and the simulation cases, and puts the original
demo visits back on the practice's real address.
"""

from app.db import SessionLocal
from app.models import Address, Appointment, Doctor, Order, Patient

db = SessionLocal()
doctor = db.query(Doctor).order_by(Doctor.created_at).first()

addresses = db.query(Address).filter(Address.doctor_id == doctor.id).all()
keep = next((a for a in addresses if a.label == "Clinic"), addresses[0])
drop = [a for a in addresses if a.id != keep.id]
print(f"Keeping {keep.label} ({keep.pincode}); removing {len(drop)} invented address(es)")

# Simulation cases were created with patients named "Sim ...".
sim_patients = db.query(Patient).filter(Patient.full_name.like("Sim %")).all()
sim_ids = {p.id for p in sim_patients}
sim_orders = [o for o in db.query(Order).all() if o.patient_id in sim_ids]
removed_appointments = 0
for order in sim_orders:
    for appointment in list(order.appointments):
        db.delete(appointment)
        removed_appointments += 1
    db.delete(order)
for patient in sim_patients:
    db.delete(patient)
db.flush()
print(f"Removed {len(sim_orders)} simulation case(s) and {removed_appointments} visit(s)")

# Any surviving visit that pointed at an invented address goes back to the real one.
drop_ids = {a.id for a in drop}
moved = 0
for appointment in db.query(Appointment).all():
    if appointment.address_id in drop_ids:
        appointment.address_id = keep.id
        moved += 1
for order in db.query(Order).all():
    if order.shipping_address_id in drop_ids:
        order.shipping_address_id = keep.id
db.flush()
print(f"Moved {moved} remaining visit(s) back to {keep.label}")

for address in drop:
    db.delete(address)
db.commit()

left = db.query(Address).filter(Address.doctor_id == doctor.id).count()
print(f"{doctor.clinic_name} now has {left} address(es)")
