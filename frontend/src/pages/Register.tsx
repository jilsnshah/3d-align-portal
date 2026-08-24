import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../api";
import { useAuth } from "../auth";
import LocationPicker from "../components/LocationPicker";
import type { PickedLocation } from "../components/LocationPicker";
import { ErrorText, Field } from "../components/ui";

export default function Register() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const councils = useQuery({ queryKey: ["councils"], queryFn: api.councils });

  const [form, setForm] = useState({
    email: "",
    password: "",
    full_name: "",
    phone: "",
    clinic_name: "",
    dental_council: "",
    registration_number: "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    pincode: "",
  });
  const [pin, setPin] = useState<PickedLocation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.register({
        email: form.email,
        password: form.password,
        full_name: form.full_name,
        phone: form.phone,
        clinic_name: form.clinic_name,
        dental_council: form.dental_council,
        registration_number: form.registration_number,
        address: {
          label: "Clinic",
          line1: form.line1,
          line2: form.line2,
          city: form.city,
          state: form.state,
          pincode: form.pincode,
          latitude: pin?.lat,
          longitude: pin?.lng,
          is_default_shipping: true,
        },
      });
      await refresh();
      navigate("/pending");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card wide">
        <div className="auth-brand">
          <img className="brand-logo" src="/logo.png" alt="3D Aligners" />
          <span className="brand-sub">Clinic registration</span>
        </div>

        <form className="stack" onSubmit={handleSubmit}>
          <div className="card">
            <h4 style={{ marginBottom: 12 }}>Account</h4>
            <div className="grid-2">
              <Field label="Email">
                <input type="email" required value={form.email} onChange={set("email")} />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={form.password}
                  onChange={set("password")}
                />
              </Field>
            </div>
          </div>

          <div className="card">
            <h4 style={{ marginBottom: 12 }}>Practitioner</h4>
            <div className="grid-2">
              <Field label="Full name">
                <input required value={form.full_name} onChange={set("full_name")} />
              </Field>
              <Field label="Phone">
                <input value={form.phone} onChange={set("phone")} />
              </Field>
              <Field label="Clinic name">
                <input value={form.clinic_name} onChange={set("clinic_name")} />
              </Field>
              <Field label="Registration number">
                <input value={form.registration_number} onChange={set("registration_number")} />
              </Field>
            </div>
            <div style={{ marginTop: 14 }}>
              <Field label="Dental council">
                <select value={form.dental_council} onChange={set("dental_council")}>
                  <option value="">Select a council</option>
                  {councils.data?.map((council) => (
                    <option key={council} value={council}>
                      {council}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>

          <div className="card">
            <h4 style={{ marginBottom: 12 }}>Clinic address</h4>
            <div className="stack-sm" style={{ marginBottom: 16 }}>
              <h4>Mark your clinic on the map</h4>
              <p className="dim">
                Search for your practice or drop the pin on it — the address below fills itself in.
                A technician is routed to this pin, so it matters more than the typed address.
              </p>
              <LocationPicker
                value={pin}
                onChange={setPin}
                onResolved={(a) =>
                  setForm((prev) => ({
                    ...prev,
                    line1: a.line1 || prev.line1,
                    line2: a.line2 || prev.line2,
                    city: a.city || prev.city,
                    state: a.state || prev.state,
                    pincode: a.pincode || prev.pincode,
                  }))
                }
                query={[form.line1, form.line2, form.city, form.pincode].filter(Boolean).join(", ")}
              />
            </div>

            <p className="dim" style={{ marginBottom: 12 }}>
              Aligners ship here unless you add another address later.
            </p>
            <div className="stack-sm">
              <Field label="Address line 1">
                <input required value={form.line1} onChange={set("line1")} />
              </Field>
              <Field label="Address line 2">
                <input value={form.line2} onChange={set("line2")} />
              </Field>
              <div className="grid-2">
                <Field label="City">
                  <input required value={form.city} onChange={set("city")} />
                </Field>
                <Field label="State">
                  <input required value={form.state} onChange={set("state")} />
                </Field>
                <Field label="PIN code">
                  <input required value={form.pincode} onChange={set("pincode")} />
                </Field>
              </div>

            </div>
          </div>

          <ErrorText error={error} />
          <div className="row-between">
            <Link to="/login" className="auth-foot" style={{ margin: 0 }}>
              Already registered? Sign in
            </Link>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "Submitting…" : "Submit for verification"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
