/* The practice's own details: who the doctor is, where the clinics are, and
 * how they sign in.
 *
 * It was three stacked cards on a narrow column, and one of them was broken:
 * the map for pinning a new clinic sat inside the Label field, squeezed into a
 * single cell of the form. Now the page opens on the practitioner as the lab
 * sees them — name, clinic, council registration, whether they are verified —
 * and below it each part of the account has its own section: the details
 * that can be edited, the clinics as cards with the one deliveries go to
 * marked, a new clinic added with the map beside the address rather than
 * inside it, and the password.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { api } from "../../api";
import type { Address } from "../../api";
import { useAuth } from "../../auth";
import LocationPicker from "../../components/LocationPicker";
import type { PickedLocation } from "../../components/LocationPicker";
import { ConfirmButton, ErrorText, Field, Loading } from "../../components/ui";

const BLANK_ADDRESS = {
  label: "Clinic",
  line1: "",
  line2: "",
  city: "",
  state: "",
  pincode: "",
  country: "India",
  is_default_shipping: false,
};

const VERIFY: Record<string, [string, string]> = {
  VERIFIED: ["Verified practitioner", "ok"],
  PENDING: ["Verification pending", "wait"],
  REJECTED: ["Verification declined", "bad"],
};

function initials(name: string): string {
  const parts = name.replace(/^dr\.?\s+/i, "").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/** Where a clinic's pin came from, in the terms that matter to a doctor: can
    the lab's technicians find the door? */
function located(a: Address): [string, string] | null {
  if (a.geocode_source === "picked") return ["Pinned on the map", "ok"];
  if (a.latitude == null) return ["Not on the map", "bad"];
  if (a.geocode_source === "google-approximate") return ["Approximate location", "wait"];
  return null;
}

const Glyph = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const SECTIONS = [
  { id: "pf-details", label: "Practitioner" },
  { id: "pf-clinics", label: "Clinics and delivery" },
  { id: "pf-security", label: "Password" },
];

export default function Profile() {
  const { me, refresh } = useAuth();
  const queryClient = useQueryClient();
  const addresses = useQuery({ queryKey: ["addresses"], queryFn: api.addresses });

  const [profile, setProfile] = useState({
    full_name: me?.doctor?.full_name ?? "",
    phone: me?.doctor?.phone ?? "",
    clinic_name: me?.doctor?.clinic_name ?? "",
  });
  const [address, setAddress] = useState(BLANK_ADDRESS);
  const [pin, setPin] = useState<PickedLocation | null>(null);
  const [adding, setAdding] = useState(false);
  const [passwords, setPasswords] = useState({ current_password: "", new_password: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [saved, setSaved] = useState<"" | "details" | "password" | "clinic">("");

  function flash(which: typeof saved) {
    setSaved(which);
    window.setTimeout(() => setSaved((now) => (now === which ? "" : now)), 2600);
  }

  const saveProfile = useMutation({
    mutationFn: () => api.updateProfile(profile),
    onSuccess: async () => {
      await refresh();
      flash("details");
    },
  });

  const addAddress = useMutation({
    mutationFn: () => api.createAddress({ ...address, latitude: pin?.lat, longitude: pin?.lng }),
    onSuccess: () => {
      setAddress(BLANK_ADDRESS);
      setPin(null);
      setAdding(false);
      flash("clinic");
      void queryClient.invalidateQueries({ queryKey: ["addresses"] });
    },
  });

  const removeAddress = useMutation({
    mutationFn: (id: string) => api.deleteAddress(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["addresses"] }),
  });

  const makeDefault = useMutation({
    mutationFn: (id: string) => {
      const target = addresses.data?.find((a) => a.id === id)!;
      return api.updateAddress(id, { ...target, is_default_shipping: true });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["addresses"] }),
  });

  const changePassword = useMutation({
    mutationFn: () => api.changePassword(passwords.current_password, passwords.new_password),
    onSuccess: () => {
      setPasswords({ current_password: "", new_password: "" });
      flash("password");
    },
  });

  if (addresses.isLoading) return <Loading />;

  const doctor = me?.doctor;
  const clinics = addresses.data ?? [];
  const home = clinics.find((a) => a.is_default_shipping) ?? null;
  const [verifyLabel, verifyTone] = VERIFY[doctor?.verification_status ?? ""] ?? [doctor?.verification_status ?? "", "wait"];
  const dirty =
    profile.full_name !== (doctor?.full_name ?? "") ||
    profile.phone !== (doctor?.phone ?? "") ||
    profile.clinic_name !== (doctor?.clinic_name ?? "");

  return (
    <main className="page pf">
      {/* The practitioner as the lab sees them. */}
      <section className="pf-hero">
        <span className="pf-avatar" aria-hidden="true">
          {initials(doctor?.full_name ?? me?.email ?? "")}
        </span>
        <div className="pf-who">
          <span className="pf-eyebrow">Your account</span>
          <h1>{doctor?.full_name || "Your profile"}</h1>
          <p>
            {doctor?.clinic_name}
            {doctor?.clinic_name && me?.email ? " · " : ""}
            {me?.email}
          </p>
          <div className="pf-badges">
            {verifyLabel && (
              <span className={`pf-badge ${verifyTone}`}>
                <i aria-hidden="true" />
                {verifyLabel}
              </span>
            )}
            {doctor?.dental_council && <span className="pf-badge plain">{doctor.dental_council}</span>}
            {doctor?.registration_number && (
              <span className="pf-badge plain mono">Reg. {doctor.registration_number}</span>
            )}
          </div>
          {doctor?.verification_status === "REJECTED" && doctor.rejection_reason && (
            <p className="pf-reject">{doctor.rejection_reason}</p>
          )}
        </div>
        <dl className="pf-facts">
          <div>
            <dt>Clinics</dt>
            <dd>{clinics.length}</dd>
          </div>
          <div>
            <dt>Deliveries go to</dt>
            <dd>{home ? `${home.label} · ${home.city}` : "Not chosen"}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{doctor?.phone || "Not given"}</dd>
          </div>
        </dl>
      </section>

      <div className="pf-body">
        <nav className="pf-nav" aria-label="Profile sections">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.label}
            </a>
          ))}
        </nav>

        <div className="pf-sections">
          <form
            id="pf-details"
            className="pf-card"
            onSubmit={(e) => {
              e.preventDefault();
              saveProfile.mutate();
            }}
          >
            <header className="pf-card-head">
              <span className="pf-icon">
                <Glyph>
                  <circle cx="12" cy="8.5" r="3.6" />
                  <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
                </Glyph>
              </span>
              <div>
                <h2>Practitioner</h2>
                <p>How you and your clinic appear on cases, invoices and delivery labels.</p>
              </div>
              {saved === "details" && <span className="pf-saved">Saved</span>}
            </header>
            <Field label="Full name">
              <input required value={profile.full_name} onChange={(e) => setProfile({ ...profile, full_name: e.target.value })} />
            </Field>
            <div className="grid-2">
              <Field label="Phone">
                <input value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
              </Field>
              <Field label="Clinic name">
                <input value={profile.clinic_name} onChange={(e) => setProfile({ ...profile, clinic_name: e.target.value })} />
              </Field>
            </div>
            <div className="pf-locked">
              <Glyph>
                <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
                <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
              </Glyph>
              <span>
                <b>Council registration</b> — {doctor?.dental_council || "—"} · {doctor?.registration_number || "—"}.
                Set when you signed up; only 3D Align can change it.
              </span>
            </div>
            <ErrorText error={saveProfile.error} />
            <div className="pf-actions">
              <button type="submit" className="btn-primary" disabled={saveProfile.isPending || !dirty}>
                {saveProfile.isPending ? "Saving…" : "Save changes"}
              </button>
              {!dirty && <span className="dim">No changes to save.</span>}
            </div>
          </form>

          <section id="pf-clinics" className="pf-card" aria-labelledby="pf-clinics-title">
            <header className="pf-card-head">
              <span className="pf-icon">
                <Glyph>
                  <path d="M4 20V9l8-5 8 5v11" />
                  <path d="M10 20v-5h4v5" />
                </Glyph>
              </span>
              <div>
                <h2 id="pf-clinics-title">Clinics and delivery</h2>
                <p>Where aligners are delivered and where a technician comes to scan. One is the default for deliveries.</p>
              </div>
              {saved === "clinic" && <span className="pf-saved">Clinic added</span>}
            </header>

            <div className="pf-clinics">
              {clinics.map((a) => {
                const pinState = located(a);
                return (
                  <article key={a.id} className={`pf-clinic${a.is_default_shipping ? " home" : ""}`}>
                    <div className="pf-clinic-top">
                      <b>{a.label}</b>
                      {a.is_default_shipping && <span className="pf-badge gold">Deliveries go here</span>}
                    </div>
                    <p>
                      {a.line1}
                      {a.line2 ? `, ${a.line2}` : ""}
                      <br />
                      {a.city}, {a.state} {a.pincode}
                    </p>
                    {pinState && (
                      <span className={`pf-pin ${pinState[1]}`}>
                        <i aria-hidden="true" />
                        {pinState[0]}
                      </span>
                    )}
                    <div className="pf-clinic-do">
                      {!a.is_default_shipping && (
                        <button type="button" className="btn-link" onClick={() => makeDefault.mutate(a.id)}>
                          Deliver here by default
                        </button>
                      )}
                      <ConfirmButton
                        label="Remove"
                        confirmLabel="Remove this clinic"
                        className="btn-link"
                        onConfirm={() => removeAddress.mutate(a.id)}
                      />
                    </div>
                  </article>
                );
              })}
              {!adding && (
                <button type="button" className="pf-clinic add" onClick={() => setAdding(true)}>
                  <span aria-hidden="true">+</span>
                  <b>Add a clinic</b>
                  <small>Pin it on the map and the address fills itself in.</small>
                </button>
              )}
            </div>
            <ErrorText error={removeAddress.error ?? makeDefault.error} />

            {adding && (
              /* The map beside the address, not inside one of its fields. */
              <form
                className="pf-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  addAddress.mutate();
                }}
              >
                <div className="pf-add-map">
                  <b>Mark the clinic entrance</b>
                  <p className="dim">Search, drag the pin or tap the map — the address fills itself in.</p>
                  <LocationPicker
                    value={pin}
                    onChange={setPin}
                    onResolved={(r) =>
                      setAddress((prev) => ({
                        ...prev,
                        line1: r.line1 || prev.line1,
                        line2: r.line2 || prev.line2,
                        city: r.city || prev.city,
                        state: r.state || prev.state,
                        pincode: r.pincode || prev.pincode,
                      }))
                    }
                    query={[address.line1, address.line2, address.city, address.pincode].filter(Boolean).join(", ")}
                  />
                </div>
                <div className="pf-add-fields">
                  <Field label="Name for this clinic">
                    <input value={address.label} onChange={(e) => setAddress({ ...address, label: e.target.value })} />
                  </Field>
                  <Field label="Address line 1">
                    <input required value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value })} />
                  </Field>
                  <Field label="Address line 2">
                    <input value={address.line2} onChange={(e) => setAddress({ ...address, line2: e.target.value })} />
                  </Field>
                  <div className="grid-2">
                    <Field label="City">
                      <input required value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} />
                    </Field>
                    <Field label="State">
                      <input required value={address.state} onChange={(e) => setAddress({ ...address, state: e.target.value })} />
                    </Field>
                  </div>
                  <Field label="PIN code">
                    <input required value={address.pincode} onChange={(e) => setAddress({ ...address, pincode: e.target.value })} />
                  </Field>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={address.is_default_shipping}
                      onChange={(e) => setAddress({ ...address, is_default_shipping: e.target.checked })}
                    />
                    Deliver here by default
                  </label>
                  <ErrorText error={addAddress.error} />
                  <div className="pf-actions">
                    <button type="submit" className="btn-primary" disabled={addAddress.isPending}>
                      {addAddress.isPending ? "Adding…" : "Add clinic"}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        setAdding(false);
                        setAddress(BLANK_ADDRESS);
                        setPin(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </form>
            )}
          </section>

          <form
            id="pf-security"
            className="pf-card"
            onSubmit={(e) => {
              e.preventDefault();
              changePassword.mutate();
            }}
          >
            <header className="pf-card-head">
              <span className="pf-icon">
                <Glyph>
                  <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
                  <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
                </Glyph>
              </span>
              <div>
                <h2>Password</h2>
                <p>You sign in as {me?.email}. A new password needs at least 8 characters.</p>
              </div>
              {saved === "password" && <span className="pf-saved">Password changed</span>}
            </header>
            <div className="grid-2">
              <Field label="Current password">
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete="current-password"
                  value={passwords.current_password}
                  onChange={(e) => setPasswords({ ...passwords, current_password: e.target.value })}
                />
              </Field>
              <Field label="New password">
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={passwords.new_password}
                  onChange={(e) => setPasswords({ ...passwords, new_password: e.target.value })}
                />
              </Field>
            </div>
            <PasswordMeter value={passwords.new_password} />
            <label className="check">
              <input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} />
              Show the passwords as I type
            </label>
            <ErrorText error={changePassword.error} />
            <div className="pf-actions">
              <button type="submit" className="btn-dark" disabled={changePassword.isPending}>
                {changePassword.isPending ? "Changing…" : "Change password"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}

/** A plain reading of the new password as it is typed: long enough, and how
    varied. Advice, not a gate — the server holds the only rule (8 characters). */
function PasswordMeter({ value }: { value: string }) {
  if (!value) return null;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(value)).length;
  const score = value.length < 8 ? 0 : Math.min(3, (value.length >= 12 ? 1 : 0) + (kinds >= 3 ? 2 : kinds >= 2 ? 1 : 0));
  const words = ["Too short — at least 8 characters", "Acceptable", "Good", "Strong"];
  return (
    <div className={`pf-meter s${score}`} aria-live="polite">
      <span className="pf-meter-bar">
        {[0, 1, 2].map((i) => (
          <i key={i} style={{ "--on": i < score ? 1 : 0 } as CSSProperties} />
        ))}
      </span>
      <span>{words[score]}</span>
    </div>
  );
}
