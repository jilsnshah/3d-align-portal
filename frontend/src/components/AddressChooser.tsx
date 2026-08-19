/* Where should this go?

   A practice can run several clinics, so the delivery address is confirmed at
   the moment of dispatch rather than inherited from whenever the case was
   opened. New addresses can be added without leaving the decision — the same
   shape as choosing a delivery address at checkout. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api } from "../api";
import LocationPicker from "./LocationPicker";
import type { PickedLocation } from "./LocationPicker";
import { ErrorText, Field } from "./ui";

const BLANK = {
  label: "Clinic",
  line1: "",
  line2: "",
  city: "",
  state: "",
  pincode: "",
  country: "India",
  is_default_shipping: false,
};

export default function AddressChooser({
  value,
  onChange,
  title = "Deliver to",
}: {
  value: string | null;
  onChange: (id: string) => void;
  title?: string;
}) {
  const queryClient = useQueryClient();
  const addresses = useQuery({ queryKey: ["addresses"], queryFn: api.addresses });
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(BLANK);
  const [pin, setPin] = useState<PickedLocation | null>(null);

  // Default to the clinic's usual address so the common case is one click.
  useEffect(() => {
    if (value || !addresses.data?.length) return;
    const preferred =
      addresses.data.find((a) => a.is_default_shipping) ?? addresses.data[0];
    onChange(preferred.id);
    // onChange is stable enough here; re-running on every render would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses.data, value]);

  const create = useMutation({
    mutationFn: () =>
      api.createAddress({ ...draft, latitude: pin?.lat, longitude: pin?.lng }),
    onSuccess: (created) => {
      setDraft(BLANK);
      setPin(null);
      setAdding(false);
      onChange(created.id);
      void queryClient.invalidateQueries({ queryKey: ["addresses"] });
    },
  });

  return (
    <div className="stack-sm">
      <h4>{title}</h4>

      {addresses.data?.map((address) => (
        <label className="addr-option" key={address.id}>
          <input
            type="radio"
            name="delivery-address"
            checked={value === address.id}
            onChange={() => onChange(address.id)}
          />
          <span>
            <b>{address.label}</b>
            {address.is_default_shipping && <span className="pill pill-gold">Default</span>}
            <span className="addr-line">
              {address.line1}
              {address.line2 ? `, ${address.line2}` : ""}, {address.city}, {address.state}{" "}
              {address.pincode}
            </span>
          </span>
        </label>
      ))}

      {!adding ? (
        <button type="button" className="btn-link" onClick={() => setAdding(true)}>
          + Deliver somewhere else
        </button>
      ) : (
        <div className="card stack-sm">
          <h4>New delivery address</h4>
          <LocationPicker
            value={pin}
            onChange={setPin}
            onResolved={(a) =>
              setDraft((prev) => ({
                ...prev,
                line1: a.line1 || prev.line1,
                line2: a.line2 || prev.line2,
                city: a.city || prev.city,
                state: a.state || prev.state,
                pincode: a.pincode || prev.pincode,
              }))
            }
            query={[draft.line1, draft.line2, draft.city, draft.pincode].filter(Boolean).join(", ")}
          />
          <div className="grid-2">
            <Field label="Label">
              <input
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
            </Field>
            <Field label="Address line 1">
              <input
                value={draft.line1}
                onChange={(e) => setDraft({ ...draft, line1: e.target.value })}
              />
            </Field>
            <Field label="City">
              <input
                value={draft.city}
                onChange={(e) => setDraft({ ...draft, city: e.target.value })}
              />
            </Field>
            <Field label="State">
              <input
                value={draft.state}
                onChange={(e) => setDraft({ ...draft, state: e.target.value })}
              />
            </Field>
            <Field label="PIN code">
              <input
                value={draft.pincode}
                onChange={(e) => setDraft({ ...draft, pincode: e.target.value })}
              />
            </Field>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.is_default_shipping}
              onChange={(e) => setDraft({ ...draft, is_default_shipping: e.target.checked })}
            />
            Make this my default
          </label>
          <ErrorText error={create.error} />
          <div className="row">
            <button
              type="button"
              className="btn-ghost"
              disabled={!draft.line1.trim() || !draft.city.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              Save and deliver here
            </button>
            <button type="button" className="btn-link" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
