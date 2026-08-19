"""Seeds ten Ahmedabad clinics and drives one full day through the scheduler.

Ten doctors, one clinic each — which is how the practice actually works. The
booking requests are deliberately awkward: clinics that sit almost on top of
each other, opposite corners of the city, several people asking for the same
moment, a technician on leave, and enough volume to run the day out of capacity.

Every travel figure is a real, billed, traffic-aware Routes call. The data is
left in place afterwards, so this doubles as the demo seed.

    .venv/bin/python simulate_day.py
"""

import os
from datetime import date, datetime, time, timedelta, timezone

import requests

from app.db import SessionLocal
from app.enums import OrderStatus, UserRole, VerificationStatus
from app.models import (
    Address,
    Appointment,
    AvailabilityRule,
    Doctor,
    Order,
    Patient,
    Technician,
    TimeOff,
    User,
)
from app.security import hash_password
from app.services import scheduling
from app.services.scheduling import lab_zone, local_day_bounds
from app.services.geo import locate
from app.services.numbering import next_enquiry_number

API = os.environ.get("API", "http://127.0.0.1:8000/api")
ADMIN = {"email": "staff@3dalign.com", "password": "changeme"}
DOCTOR_PASSWORD = "clinicdemo123"

# One doctor, one clinic. Two pairs sit close together on purpose (Bopal/Ghuma,
# Navrangpura/CG Road) so the cost of a short hop is visible against a long one.
CLINICS = [
    ("Dr. Rakesh Bhatt",  "Bopal Smile Studio",       "Aashray Complex, Bopal Cross Road",     "380058"),
    ("Dr. Priya Nair",    "Ghuma Dental",             "South Bopal Road, Ghuma",               "380058"),
    ("Dr. Sameer Joshi",  "Maninagar Orthodontics",   "Rambaug Road, Maninagar",               "380008"),
    ("Dr. Kavita Rana",   "Naroda Dental Care",       "Galaxy Arcade, Naroda Road, Naroda",    "382330"),
    ("Dr. Manish Doshi",  "Chandkheda Family Dental", "Vishwas City, New CG Road, Chandkheda", "382481"),
    ("Dr. Nisha Pandya",  "Navrangpura Dental",       "Swastik Cross Road, Navrangpura",       "380009"),
    ("Dr. Arjun Desai",   "CG Road Aligners",         "CG Road, Ellisbridge",                  "380006"),
    ("Dr. Falguni Shah",  "Vastrapur Dental",         "Vastrapur Lake Road, Vastrapur",        "380015"),
    ("Dr. Hiren Modi",    "Satellite Ortho",          "Prahladnagar Road, Satellite",          "380015"),
    ("Dr. Trupti Amin",   "Vatva Dental",             "GIDC Road, Vatva",                      "382445"),
]

TECHS = [
    ("Anil Rathod", "anil@3dalign.com"),
    ("Bhavna Shah", "bhavna@3dalign.com"),
    ("Chirag Patel", "chirag@3dalign.com"),
    ("Dhruv Mehta", "dhruv@3dalign.com"),
    ("Esha Vyas", "esha@3dalign.com"),
]


def log(msg=""):
    print(msg, flush=True)


db = SessionLocal()
settings = scheduling.get_settings(db)
settings.max_daily_jobs = 8
db.commit()

target = date.today() + timedelta(days=2)
while target.weekday() >= 5:
    target += timedelta(days=1)
log(f"Seeding and simulating {target:%A %d %B %Y} ({settings.timezone_name}, local times)\n")

# -- technicians -----------------------------------------------------------
for name, email in TECHS:
    tech = db.query(Technician).filter(Technician.full_name == name).first()
    if tech is None:
        user = db.query(User).filter(User.email == email).first()
        if user is None:
            user = User(email=email, password_hash=hash_password("technician1"), role=UserRole.TECHNICIAN)
            db.add(user)
            db.flush()
        tech = Technician(user_id=user.id, full_name=name, max_daily_jobs=8)
        db.add(tech)
        db.flush()
        for weekday in range(6):
            db.add(AvailabilityRule(technician_id=tech.id, weekday=weekday,
                                    start_time=time(9, 0), end_time=time(18, 0)))
    tech.max_daily_jobs = 8
    tech.is_active = True
db.commit()
technicians = {t.full_name: t for t in scheduling.active_technicians(db)}
log(f"Technicians: {', '.join(technicians)}")

# -- ten doctors, one clinic each ------------------------------------------
clinics = {}
for full_name, clinic_name, line1, pincode in CLINICS:
    email = clinic_name.lower().replace(" ", ".").replace("'", "") + "@clinic.example.com"
    doctor = db.query(Doctor).filter(Doctor.clinic_name == clinic_name).first()
    if doctor is None:
        user = db.query(User).filter(User.email == email).first()
        if user is None:
            user = User(email=email, password_hash=hash_password(DOCTOR_PASSWORD), role=UserRole.DOCTOR)
            db.add(user)
            db.flush()
        doctor = Doctor(
            user_id=user.id, full_name=full_name, clinic_name=clinic_name,
            phone="+919812345678", dental_council="Gujarat State Dental Council",
            registration_number=f"GSDC/{abs(hash(clinic_name)) % 90000 + 10000}",
            verification_status=VerificationStatus.VERIFIED,
        )
        db.add(doctor)
        db.flush()
    doctor.verification_status = VerificationStatus.VERIFIED

    address = db.query(Address).filter(Address.doctor_id == doctor.id).first()
    if address is None:
        address = Address(doctor_id=doctor.id, label="Clinic", line1=line1, city="Ahmedabad",
                          state="Gujarat", pincode=pincode, is_default_shipping=True)
        db.add(address)
        db.flush()
    if address.latitude is None:
        locate(address)                      # live Geocoding API
    clinics[clinic_name] = (doctor, address, email)
db.commit()

log("\nClinics (street-level coordinates from the live Geocoding API):")
for clinic_name, (doctor, address, _) in clinics.items():
    log(f"   {clinic_name:<26} {doctor.full_name:<18} {address.latitude:9.5f}, {address.longitude:9.5f}")

# -- clear the day ---------------------------------------------------------
day_start, day_end = local_day_bounds(target, settings)
wiped = 0
for appointment in db.query(Appointment).all():
    starts = appointment.starts_at
    starts = starts if starts.tzinfo else starts.replace(tzinfo=timezone.utc)
    if day_start <= starts < day_end:
        db.delete(appointment)
        wiped += 1
db.query(TimeOff).delete()
db.commit()

on_leave = technicians["Esha Vyas"]
db.add(TimeOff(technician_id=on_leave.id, starts_at=day_start, ends_at=day_end, reason="Annual leave"))
db.commit()
log(f"\nCleared {wiped} visit(s) from that day; {on_leave.full_name} is on leave\n")

# -- the request book ------------------------------------------------------
REQUESTS = [
    ("Bopal Smile Studio", "09:30"), ("Naroda Dental Care", "09:30"),
    ("Maninagar Orthodontics", "09:45"), ("Chandkheda Family Dental", "10:00"),
    ("Ghuma Dental", "10:30"), ("Bopal Smile Studio", "11:00"),
    ("Navrangpura Dental", "10:15"), ("CG Road Aligners", "10:45"),
    ("Vatva Dental", "10:30"), ("Naroda Dental Care", "11:30"),
    ("Vastrapur Dental", "11:00"), ("Satellite Ortho", "11:45"),
    ("Maninagar Orthodontics", "12:00"), ("Chandkheda Family Dental", "12:15"),
    ("Bopal Smile Studio", "12:30"), ("Navrangpura Dental", "13:00"),
    ("Vatva Dental", "13:15"), ("Ghuma Dental", "13:30"),
    ("CG Road Aligners", "14:00"), ("Vastrapur Dental", "14:15"),
    ("Naroda Dental Care", "14:30"), ("Satellite Ortho", "15:00"),
    ("Maninagar Orthodontics", "15:15"), ("Chandkheda Family Dental", "15:30"),
    ("Bopal Smile Studio", "16:00"), ("Navrangpura Dental", "16:15"),
    ("Vatva Dental", "16:30"), ("Naroda Dental Care", "16:45"),
    ("Ghuma Dental", "17:00"), ("Vastrapur Dental", "17:15"),
]

sessions = {}
headers = {"X-Session-Slot": "sim"}
for clinic_name, (doctor, address, email) in clinics.items():
    s = requests.Session()
    s.post(f"{API}/auth/login", json={"email": email, "password": DOCTOR_PASSWORD}, headers=headers)
    sessions[clinic_name] = s

orders = []
for clinic_name, at in REQUESTS:
    doctor, address, _ = clinics[clinic_name]
    patient = Patient(doctor_id=doctor.id, full_name=f"Patient {len(orders) + 1:02d}")
    db.add(patient)
    db.flush()
    order = Order(enquiry_number=next_enquiry_number(db), doctor_id=doctor.id,
                  patient_id=patient.id, status=OrderStatus.AWAITING_SCAN,
                  shipping_address_id=address.id)
    db.add(order)
    db.flush()
    orders.append((order, clinic_name, at, address))
db.commit()

log(f"{len(orders)} scan requests, booked through the live scheduler:")
log(f"   {'#':<3} {'clinic':<26} {'asked':<7} outcome")
accepted, refused = [], []
for index, (order, clinic_name, at, address) in enumerate(orders, start=1):
    hh, mm = at.split(":")
    # Clinics ask in their own wall clock, not UTC.
    starts = datetime.combine(target, time(int(hh), int(mm)), tzinfo=lab_zone(settings))
    response = sessions[clinic_name].post(
        f"{API}/orders/{order.id}/appointment",
        json={"starts_at": starts.isoformat().replace("+00:00", "Z"),
              "address_id": address.id,
              "contact_name": "Front desk", "contact_phone": "+919812345678"},
        headers=headers,
    )
    if response.status_code == 200:
        appointment = response.json()["appointment"]
        accepted.append(appointment)
        log(f"   {index:<3} {clinic_name:<26} {at:<7} -> {appointment['technician_name']}")
        log(f"       {appointment['assignment_reason']}")
    else:
        detail = response.json().get("detail", response.text)[:80]
        refused.append((clinic_name, at, detail))
        log(f"   {index:<3} {clinic_name:<26} {at:<7} -> refused: {detail}")

log(f"\n{len(accepted)} booked, {len(refused)} refused")
log(f"\nDoctor logins: <clinic>@clinic.example.com / {DOCTOR_PASSWORD}")
log(f"Seeded day: {target:%Y-%m-%d}")
