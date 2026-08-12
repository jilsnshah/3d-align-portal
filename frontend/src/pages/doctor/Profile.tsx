import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api";
import { useAuth } from "../../auth";
import { Banner, ConfirmButton, ErrorText, Field, Loading } from "../../components/ui";

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
  const [passwords, setPasswords] = useState({ current_password: "", new_password: "" });
  const [saved, setSaved] = useState("");

  const saveProfile = useMutation({
    mutationFn: () => api.updateProfile(profile),
    onSuccess: async () => {
      await refresh();
      setSaved("Profile saved.");
    },
  });

  const addAddress = useMutation({
    mutationFn: () => api.createAddress(address),
    onSuccess: () => {
      setAddress(BLANK_ADDRESS);
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
      setSaved("Password changed.");
    },
  });

  if (addresses.isLoading) return <Loading />;

  return (
    <main className="page page-narrow">
      <div className="page-head">
        <div>
          <h1>Profile</h1>
          <p className="sub">{me?.email}</p>
        </div>
      </div>

      {saved && <Banner tone="ok">{saved}</Banner>}

      <div className="stack" style={{ marginTop: saved ? 16 : 0 }}>
        <form
          className="card stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            saveProfile.mutate();
          }}
        >
          <h4>Practitioner</h4>
          <Field label="Full name">
            <input
              required
              value={profile.full_name}
              onChange={(e) => setProfile({ ...profile, full_name: e.target.value })}
            />
          </Field>
          <div className="grid-2">
            <Field label="Phone">
              <input
                value={profile.phone}
                onChange={(e) => setProfile({ ...profile, phone: e.target.value })}
              />
            </Field>
            <Field label="Clinic name">
              <input
                value={profile.clinic_name}
                onChange={(e) => setProfile({ ...profile, clinic_name: e.target.value })}
              />
            </Field>
          </div>
          <p className="dim">
            Council registration is set at signup and can only be changed by 3D Align:{" "}
            {me?.doctor?.dental_council || "—"} · {me?.doctor?.registration_number || "—"}
          </p>
          <ErrorText error={saveProfile.error} />
          <div>
            <button type="submit" className="btn-primary" disabled={saveProfile.isPending}>
              Save
            </button>
          </div>
        </form>

        <div className="card">
          <h4 style={{ marginBottom: 12 }}>Addresses</h4>
          {addresses.data?.map((item) => (
            <div key={item.id} className="file-row">
              <span className="name">
                <b>{item.label}</b> — {item.line1}
                {item.line2 ? `, ${item.line2}` : ""}, {item.city}, {item.state} {item.pincode}
              </span>
              {item.is_default_shipping ? (
                <span className="pill pill-gold">Default</span>
              ) : (
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => makeDefault.mutate(item.id)}
                >
                  Make default
                </button>
              )}
              <ConfirmButton
                label="Delete"
                confirmLabel="Confirm"
                className="btn-link"
                onConfirm={() => removeAddress.mutate(item.id)}
              />
            </div>
          ))}
          <ErrorText error={removeAddress.error} />

          <form
            className="stack-sm"
            style={{ marginTop: 16 }}
            onSubmit={(e) => {
              e.preventDefault();
              addAddress.mutate();
            }}
          >
            <h4>Add an address</h4>
            <div className="grid-2">
              <Field label="Label">
                <input
                  value={address.label}
                  onChange={(e) => setAddress({ ...address, label: e.target.value })}
                />
              </Field>
              <Field label="Address line 1">
                <input
                  required
                  value={address.line1}
                  onChange={(e) => setAddress({ ...address, line1: e.target.value })}
                />
              </Field>
              <Field label="City">
                <input
                  required
                  value={address.city}
                  onChange={(e) => setAddress({ ...address, city: e.target.value })}
                />
              </Field>
              <Field label="State">
                <input
                  required
                  value={address.state}
                  onChange={(e) => setAddress({ ...address, state: e.target.value })}
                />
              </Field>
              <Field label="PIN code">
                <input
                  required
                  value={address.pincode}
                  onChange={(e) => setAddress({ ...address, pincode: e.target.value })}
                />
              </Field>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={address.is_default_shipping}
                onChange={(e) =>
                  setAddress({ ...address, is_default_shipping: e.target.checked })
                }
              />
              Use as the default shipping address
            </label>
            <ErrorText error={addAddress.error} />
            <div>
              <button type="submit" className="btn-ghost" disabled={addAddress.isPending}>
                Add address
              </button>
            </div>
          </form>
        </div>

        <form
          className="card stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            changePassword.mutate();
          }}
        >
          <h4>Password</h4>
          <div className="grid-2">
            <Field label="Current password">
              <input
                type="password"
                required
                autoComplete="current-password"
                value={passwords.current_password}
                onChange={(e) =>
                  setPasswords({ ...passwords, current_password: e.target.value })
                }
              />
            </Field>
            <Field label="New password">
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={passwords.new_password}
                onChange={(e) => setPasswords({ ...passwords, new_password: e.target.value })}
              />
            </Field>
          </div>
          <ErrorText error={changePassword.error} />
          <div>
            <button type="submit" className="btn-ghost" disabled={changePassword.isPending}>
              Change password
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
