/* The account: who the doctor is, where the clinics are, and how they sign in.
 *
 * Laid out as settings rather than a long form: a rail down the side with the
 * practitioner on it and a section for each part of the account, and one
 * section on the screen at a time. The first section is an overview — how
 * complete the account is, and exactly what is missing — because an account
 * with no pinned clinic or no default delivery address is the cause of the
 * wrong-door scan visits and the parcels sent to the wrong branch.
 *
 * A clinic is added in a drawer of its own: find the entrance on the map
 * first, then check the address it filled in. The map used to sit inside a
 * form field and its text ran out of the box.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";

import { api } from "../../api";
import type { Address } from "../../api";
import { useAuth } from "../../auth";
import LocationPicker from "../../components/LocationPicker";
import type { PickedLocation } from "../../components/LocationPicker";
import PushToggle from "../../components/PushToggle";
import { useToast } from "../../components/Toast";
import { ConfirmButton, ErrorText, Field, Loading } from "../../components/ui";

type Tab = "overview" | "details" | "clinics" | "security" | "alerts";

const Glyph = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const TABS: { key: Tab; label: string; hint: string; icon: ReactNode }[] = [
  {
    key: "overview",
    label: "Overview",
    hint: "How complete your account is",
    icon: (
      <Glyph>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </Glyph>
    ),
  },
  {
    key: "details",
    label: "Practitioner",
    hint: "Name, phone, clinic, registration",
    icon: (
      <Glyph>
        <circle cx="12" cy="8.5" r="3.6" />
        <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
      </Glyph>
    ),
  },
  {
    key: "clinics",
    label: "Clinics and delivery",
    hint: "Where aligners are sent",
    icon: (
      <Glyph>
        <path d="M4 20V9l8-5 8 5v11" />
        <path d="M10 20v-5h4v5" />
      </Glyph>
    ),
  },
  {
    key: "security",
    label: "Password",
    hint: "How you sign in",
    icon: (
      <Glyph>
        <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
        <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
      </Glyph>
    ),
  },
  {
    key: "alerts",
    label: "Notifications",
    hint: "Alerts on this device",
    icon: (
      <Glyph>
        <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
        <path d="M10 20a2 2 0 0 0 4 0" />
      </Glyph>
    ),
  },
];

const VERIFY: Record<string, [string, string]> = {
  VERIFIED: ["Verified practitioner", "ok"],
  PENDING: ["Verification pending", "wait"],
  REJECTED: ["Verification declined", "bad"],
};

function initials(name: string): string {
  const parts = name.replace(/^dr\.?\s+/i, "").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/** Where a clinic's pin came from, in the terms that matter to a doctor: can a
    technician find the door? */
function located(a: Address): [string, string] {
  if (a.geocode_source === "picked") return ["Pinned on the map", "ok"];
  if (a.latitude == null) return ["Not on the map", "bad"];
  if (a.geocode_source === "google-approximate") return ["Approximate location", "wait"];
  return ["Located from the address", "ok"];
}

export default function Profile() {
  const { me } = useAuth();
  const addresses = useQuery({ queryKey: ["addresses"], queryFn: api.addresses });
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "overview") as Tab;
  const [adding, setAdding] = useState(false);

  function go(next: Tab) {
    const q = new URLSearchParams(params);
    if (next === "overview") q.delete("tab");
    else q.set("tab", next);
    setParams(q, { replace: true });
  }

  if (addresses.isLoading) return <Loading />;

  const doctor = me?.doctor;
  const clinics = addresses.data ?? [];
  const [verifyLabel, verifyTone] = VERIFY[doctor?.verification_status ?? ""] ?? ["", "wait"];

  /* What a complete account has. Each missing piece names the section that
     fixes it. */
  const checks: { label: string; done: boolean; tab: Tab; why: string }[] = [
    { label: "Registration verified", done: doctor?.verification_status === "VERIFIED", tab: "details", why: "3D Align checks your council registration before cases can be sent." },
    { label: "Phone number", done: Boolean(doctor?.phone), tab: "details", why: "So the lab and technicians can reach the clinic." },
    { label: "Clinic name", done: Boolean(doctor?.clinic_name), tab: "details", why: "Printed on delivery labels and invoices." },
    { label: "A clinic address", done: clinics.length > 0, tab: "clinics", why: "Where aligners are delivered." },
    { label: "Every clinic on the map", done: clinics.length > 0 && clinics.every((a) => a.latitude != null), tab: "clinics", why: "So a scan technician arrives at the right door." },
    { label: "A default delivery clinic", done: clinics.some((a) => a.is_default_shipping), tab: "clinics", why: "Where a parcel goes when nothing else is chosen." },
  ];
  const done = checks.filter((c) => c.done).length;

  return (
    <main className="page page-wide pr">
      <aside className="pr-rail">
        <div className="pr-me">
          <span className="pr-avatar" aria-hidden="true">
            {initials(doctor?.full_name ?? me?.email ?? "")}
          </span>
          <div>
            <b>{doctor?.full_name || "Your account"}</b>
            <span>{doctor?.clinic_name || me?.email}</span>
            {verifyLabel && <em className={`pr-badge ${verifyTone}`}>{verifyLabel}</em>}
          </div>
        </div>
        <nav className="pr-tabs" aria-label="Account sections">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={tab === t.key ? "on" : ""}
              aria-current={tab === t.key ? "page" : undefined}
              onClick={() => go(t.key)}
            >
              <span className="pr-tab-icon">{t.icon}</span>
              <span className="pr-tab-say">
                <b>{t.label}</b>
                <small>{t.hint}</small>
              </span>
              {t.key === "overview" && done < checks.length && <i className="pr-tab-dot" aria-label="Something to finish" />}
            </button>
          ))}
        </nav>
      </aside>

      <div className="pr-pane" key={tab}>
        {tab === "overview" && (
          <Overview doctorName={doctor?.full_name ?? ""} email={me?.email ?? ""} clinics={clinics} checks={checks} done={done} go={go} verify={[verifyLabel, verifyTone]} />
        )}
        {tab === "details" && <Details />}
        {tab === "clinics" && <Clinics clinics={clinics} onAdd={() => setAdding(true)} />}
        {tab === "security" && <Security />}
        {tab === "alerts" && <Alerts />}
      </div>

      {adding && <AddClinic onClose={() => setAdding(false)} />}
    </main>
  );
}

function PaneHead({ kicker, title, sub }: { kicker: string; title: string; sub: string }) {
  return (
    <header className="pr-head">
      <span className="pr-kicker">{kicker}</span>
      <h1>{title}</h1>
      <p>{sub}</p>
    </header>
  );
}

function Overview({
  doctorName,
  email,
  clinics,
  checks,
  done,
  go,
  verify,
}: {
  doctorName: string;
  email: string;
  clinics: Address[];
  checks: { label: string; done: boolean; tab: Tab; why: string }[];
  done: number;
  go: (t: Tab) => void;
  verify: [string, string];
}) {
  const { me } = useAuth();
  const doctor = me?.doctor;
  const pct = checks.length ? done / checks.length : 0;
  const r = 44;
  const c = 2 * Math.PI * r;
  const home = clinics.find((a) => a.is_default_shipping);
  return (
    <>
      <section className="pr-id">
        <span className="pr-avatar lg" aria-hidden="true">
          {initials(doctorName || email)}
        </span>
        <div className="pr-id-say">
          <span className="pr-kicker light">Your account</span>
          <h1>{doctorName || "Your account"}</h1>
          <p>
            {doctor?.clinic_name}
            {doctor?.clinic_name ? " · " : ""}
            {email}
          </p>
          <div className="pr-chips">
            {verify[0] && <span className={`pr-badge ${verify[1]}`}>{verify[0]}</span>}
            {doctor?.dental_council && <span className="pr-chip">{doctor.dental_council}</span>}
            {doctor?.registration_number && <span className="pr-chip mono">Reg. {doctor.registration_number}</span>}
          </div>
          {doctor?.verification_status === "REJECTED" && doctor.rejection_reason && (
            <p className="pr-reject">{doctor.rejection_reason}</p>
          )}
        </div>
      </section>

      <div className="pr-overview">
        <section className="pr-card pr-strength" aria-labelledby="pr-strength-title">
          <div className="pr-strength-ring">
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle cx="50" cy="50" r={r} fill="none" stroke="var(--paper-2)" strokeWidth="9" />
              <circle
                cx="50"
                cy="50"
                r={r}
                fill="none"
                stroke={pct === 1 ? "var(--ok)" : "var(--gold)"}
                strokeWidth="9"
                strokeLinecap="round"
                strokeDasharray={`${pct * c} ${c}`}
                transform="rotate(-90 50 50)"
              />
            </svg>
            <b>{Math.round(pct * 100)}%</b>
          </div>
          <div className="pr-strength-say">
            <h2 id="pr-strength-title">{pct === 1 ? "Your account is complete" : "Finish setting up"}</h2>
            <p>
              {pct === 1
                ? "Everything the lab needs to deliver to the right door is in place."
                : `${checks.length - done} thing${checks.length - done === 1 ? "" : "s"} left — each one saves a wrong delivery or a wasted visit.`}
            </p>
          </div>
          <ul className="pr-checks">
            {checks.map((ch) => (
              <li key={ch.label} className={ch.done ? "done" : ""}>
                <i aria-hidden="true">
                  {ch.done ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m6 12.5 4 4L18 8" />
                    </svg>
                  ) : null}
                </i>
                <span>
                  <b>{ch.label}</b>
                  <small>{ch.why}</small>
                </span>
                {!ch.done && ch.label !== "Registration verified" && (
                  <button type="button" className="btn-link" onClick={() => go(ch.tab)}>
                    Fix
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <div className="pr-tiles">
          <button type="button" className="pr-tile" onClick={() => go("clinics")}>
            <small>Clinics</small>
            <b>{clinics.length}</b>
            <span>{clinics.filter((a) => a.latitude != null).length} on the map</span>
          </button>
          <button type="button" className="pr-tile" onClick={() => go("clinics")}>
            <small>Deliveries go to</small>
            <b>{home ? home.label : "Not chosen"}</b>
            <span>{home ? `${home.city}, ${home.state}` : "Choose a default clinic"}</span>
          </button>
          <button type="button" className="pr-tile" onClick={() => go("details")}>
            <small>Phone</small>
            <b>{doctor?.phone || "Not given"}</b>
            <span>For the lab and technicians</span>
          </button>
          <button type="button" className="pr-tile" onClick={() => go("security")}>
            <small>Signed in as</small>
            <b className="small">{email}</b>
            <span>Change your password</span>
          </button>
        </div>
      </div>
    </>
  );
}

function Details() {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const doctor = me?.doctor;
  const [profile, setProfile] = useState({
    full_name: doctor?.full_name ?? "",
    phone: doctor?.phone ?? "",
    clinic_name: doctor?.clinic_name ?? "",
  });
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api.updateProfile(profile),
    onSuccess: async () => {
      await refresh();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2600);
      toast({ title: "Details saved", body: "Cases, invoices and delivery labels use these." });
    },
  });
  const dirty =
    profile.full_name !== (doctor?.full_name ?? "") ||
    profile.phone !== (doctor?.phone ?? "") ||
    profile.clinic_name !== (doctor?.clinic_name ?? "");

  return (
    <>
      <PaneHead kicker="Practitioner" title="Your details" sub="How you and your clinic appear on cases, invoices and delivery labels." />
      <form
        className="pr-card"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="pr-form">
          <Field label="Full name">
            <input required value={profile.full_name} onChange={(e) => setProfile({ ...profile, full_name: e.target.value })} />
          </Field>
          <Field label="Phone">
            <input value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
          </Field>
          <Field label="Clinic name">
            <input value={profile.clinic_name} onChange={(e) => setProfile({ ...profile, clinic_name: e.target.value })} />
          </Field>
        </div>
        <ErrorText error={save.error} />
        <div className="pr-actions">
          <button type="submit" className="btn-primary" disabled={save.isPending || !dirty}>
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
          {saved ? <span className="pr-saved">Saved</span> : !dirty && <span className="dim">No changes to save.</span>}
        </div>
      </form>

      <section className="pr-card pr-locked">
        <span className="pr-locked-icon">
          <Glyph>
            <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
            <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
          </Glyph>
        </span>
        <div>
          <b>Council registration</b>
          <dl>
            <div>
              <dt>Council</dt>
              <dd>{doctor?.dental_council || "—"}</dd>
            </div>
            <div>
              <dt>Registration number</dt>
              <dd className="mono">{doctor?.registration_number || "—"}</dd>
            </div>
          </dl>
          <p>Set when you signed up and checked by 3D Align. To change it, contact the lab.</p>
        </div>
      </section>
    </>
  );
}

function Clinics({ clinics, onAdd }: { clinics: Address[]; onAdd: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAddress(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["addresses"] });
      toast({ title: "Clinic removed", tone: "warn" });
    },
  });
  const makeDefault = useMutation({
    mutationFn: (id: string) => {
      const target = clinics.find((a) => a.id === id)!;
      return api.updateAddress(id, { ...target, is_default_shipping: true });
    },
    onSuccess: (address) => {
      void queryClient.invalidateQueries({ queryKey: ["addresses"] });
      toast({ title: "Default delivery changed", body: `Parcels go to ${address.label} unless another is chosen.` });
    },
  });

  return (
    <>
      <PaneHead
        kicker="Clinics and delivery"
        title="Your clinics"
        sub="Where aligners are delivered and where a technician comes to scan. One clinic is the default for deliveries."
      />
      <div className="pr-clinics">
        {clinics.map((a) => {
          const [where, tone] = located(a);
          return (
            <article key={a.id} className={`pr-clinic${a.is_default_shipping ? " home" : ""}`}>
              <div className="pr-clinic-top">
                <span className="pr-clinic-icon">
                  <Glyph>
                    <path d="M12 21s-6.5-5.4-6.5-11a6.5 6.5 0 0 1 13 0c0 5.6-6.5 11-6.5 11z" />
                    <circle cx="12" cy="10" r="2.4" />
                  </Glyph>
                </span>
                <b>{a.label}</b>
                {a.is_default_shipping && <span className="pr-badge gold">Default delivery</span>}
              </div>
              <p>
                {a.line1}
                {a.line2 ? `, ${a.line2}` : ""}
                <br />
                {a.city}, {a.state} {a.pincode}
              </p>
              <span className={`pr-pin ${tone}`}>
                <i aria-hidden="true" />
                {where}
              </span>
              <div className="pr-clinic-do">
                {!a.is_default_shipping && (
                  <button type="button" className="btn-link" onClick={() => makeDefault.mutate(a.id)}>
                    Make default
                  </button>
                )}
                <ConfirmButton label="Remove" confirmLabel="Remove this clinic" className="btn-link" onConfirm={() => remove.mutate(a.id)} />
              </div>
            </article>
          );
        })}
        <button type="button" className="pr-clinic add" onClick={onAdd}>
          <span aria-hidden="true">+</span>
          <b>Add a clinic</b>
          <small>Find the entrance on the map; the address fills itself in.</small>
        </button>
      </div>
      <ErrorText error={remove.error ?? makeDefault.error} />
    </>
  );
}

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

/** Adding a clinic in two steps, in a drawer of its own: find the entrance on
    the map, then check the address it filled in. One column, so nothing in it
    — a long address, a place name from the search — can run out of the box. */
function AddClinic({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [address, setAddress] = useState(BLANK_ADDRESS);
  const [pin, setPin] = useState<PickedLocation | null>(null);
  const add = useMutation({
    mutationFn: () => api.createAddress({ ...address, latitude: pin?.lat, longitude: pin?.lng }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["addresses"] });
      onClose();
      toast({ title: "Clinic added", body: `${created.label} · ${created.city}` });
    },
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const ready = address.line1.trim() && address.city.trim() && address.state.trim() && address.pincode.trim();

  return createPortal(
    <div
      className="pt-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="pr-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Add a clinic"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <header className="pr-drawer-head">
          <div>
            <span className="pr-kicker light">New clinic</span>
            <h2>Add a clinic</h2>
            <p>Mark the entrance on the map and the address fills itself in. Check it, then save.</p>
          </div>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className="pr-drawer-body">
          <section className="pr-step">
            <span className="pr-step-n">1</span>
            <div className="pr-step-body">
              <b>Find the clinic entrance</b>
              <small>Search, drag the pin or tap the map.</small>
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
          </section>

          <section className="pr-step">
            <span className="pr-step-n">2</span>
            <div className="pr-step-body">
              <b>Check the address</b>
              <small>Filled in from the pin — correct anything that is off.</small>
              <div className="pr-form">
                <Field label="Name for this clinic">
                  <input value={address.label} onChange={(e) => setAddress({ ...address, label: e.target.value })} />
                </Field>
                <Field label="Address line 1">
                  <input required value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value })} />
                </Field>
                <Field label="Address line 2">
                  <input value={address.line2} onChange={(e) => setAddress({ ...address, line2: e.target.value })} />
                </Field>
                <div className="pr-form-row">
                  <Field label="City">
                    <input required value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} />
                  </Field>
                  <Field label="State">
                    <input required value={address.state} onChange={(e) => setAddress({ ...address, state: e.target.value })} />
                  </Field>
                  <Field label="PIN code">
                    <input required value={address.pincode} onChange={(e) => setAddress({ ...address, pincode: e.target.value })} />
                  </Field>
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={address.is_default_shipping}
                    onChange={(e) => setAddress({ ...address, is_default_shipping: e.target.checked })}
                  />
                  Deliver here by default
                </label>
              </div>
            </div>
          </section>
        </div>

        <footer className="pr-drawer-foot">
          <ErrorText error={add.error} />
          <span className="dim">{ready ? (pin ? "Pinned and ready to save." : "No pin yet — the typed address will be used.") : "Line 1, city, state and PIN are needed."}</span>
          <div className="pr-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={add.isPending || !ready}>
              {add.isPending ? "Adding…" : "Add clinic"}
            </button>
          </div>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function Security() {
  const { me } = useAuth();
  const toast = useToast();
  const [passwords, setPasswords] = useState({ current_password: "", new_password: "" });
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);
  const change = useMutation({
    mutationFn: () => api.changePassword(passwords.current_password, passwords.new_password),
    onSuccess: () => {
      setPasswords({ current_password: "", new_password: "" });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2600);
      toast({ title: "Password changed", body: "Use the new one next time you sign in." });
    },
  });
  return (
    <>
      <PaneHead kicker="Password" title="How you sign in" sub={`You sign in as ${me?.email ?? ""}. A new password needs at least 8 characters.`} />
      <form
        className="pr-card"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate();
        }}
      >
        <div className="pr-form two">
          <Field label="Current password">
            <input
              type={show ? "text" : "password"}
              required
              autoComplete="current-password"
              value={passwords.current_password}
              onChange={(e) => setPasswords({ ...passwords, current_password: e.target.value })}
            />
          </Field>
          <Field label="New password">
            <input
              type={show ? "text" : "password"}
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
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
          Show the passwords as I type
        </label>
        <ErrorText error={change.error} />
        <div className="pr-actions">
          <button type="submit" className="btn-dark" disabled={change.isPending}>
            {change.isPending ? "Changing…" : "Change password"}
          </button>
          {saved && <span className="pr-saved">Password changed</span>}
        </div>
      </form>
    </>
  );
}

function Alerts() {
  return (
    <>
      <PaneHead kicker="Notifications" title="Alerts" sub="Hear about a case the moment it needs you." />
      <section className="pr-card">
        <PushToggle />
        <p className="pr-note">
          Every alert also appears in the portal under <b>Alerts</b>, whether or not this device is set up.
          Notifications are set per device — turn them on separately on the clinic computer and on your
          phone.
        </p>
      </section>
    </>
  );
}

/** A plain reading of the new password as it is typed. Advice, not a gate —
    the server holds the only rule (8 characters). */
function PasswordMeter({ value }: { value: string }) {
  if (!value) return null;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(value)).length;
  const score = value.length < 8 ? 0 : Math.min(3, (value.length >= 12 ? 1 : 0) + (kinds >= 3 ? 2 : kinds >= 2 ? 1 : 0));
  const words = ["Too short — at least 8 characters", "Acceptable", "Good", "Strong"];
  return (
    <div className={`pr-meter s${score}`} aria-live="polite">
      <span className="pr-meter-bar">
        {[0, 1, 2].map((i) => (
          <i key={i} style={{ "--on": i < score ? 1 : 0 } as CSSProperties} />
        ))}
      </span>
      <span>{words[score]}</span>
    </div>
  );
}
