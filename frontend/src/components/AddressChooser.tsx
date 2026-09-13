/* Where should this go?

   A practice can run several clinics, so the delivery address is confirmed at
   the moment of dispatch rather than inherited from whenever the case was
   opened.

   It used to print every clinic as a radio button. That reads well at three
   and falls apart at thirty: the question — and the button that answers it —
   ends up a screen below the list. So the chosen clinic is stated in one line
   and the rest sit behind it, searchable by name, city or pincode. New
   addresses can still be added without leaving the decision. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../api";
import type { Address } from "../api";
import LocationPicker from "./LocationPicker";
import Reveal from "./Reveal";
import { useToast } from "./Toast";
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

/** The one line a clinic reads as. */
function oneLine(a: Address): string {
  return [a.line1, a.line2, a.city, a.pincode].filter(Boolean).join(", ");
}

function matches(a: Address, q: string): boolean {
  if (!q) return true;
  return [a.label, a.line1, a.line2, a.city, a.state, a.pincode]
    .filter(Boolean)
    .some((v) => v.toLowerCase().includes(q));
}

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
  const toast = useToast();
  const addresses = useQuery({ queryKey: ["addresses"], queryFn: api.addresses });
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState(BLANK);
  const [pin, setPin] = useState<PickedLocation | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  // Default to the clinic's usual address so the common case is one click.
  useEffect(() => {
    if (value || !addresses.data?.length) return;
    const preferred =
      addresses.data.find((a) => a.is_default_shipping) ?? addresses.data[0];
    onChange(preferred.id);
    // onChange is stable enough here; re-running on every render would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses.data, value]);

  // A menu left open after the eye has moved on is a menu in the way.
  useEffect(() => {
    if (!open) return;
    function away(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    }
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.createAddress({ ...draft, latitude: pin?.lat, longitude: pin?.lng }),
    onSuccess: (created) => {
      setDraft(BLANK);
      setPin(null);
      setAdding(false);
      onChange(created.id);
      void queryClient.invalidateQueries({ queryKey: ["addresses"] });
      toast({ title: "Address added", body: `Delivering to ${created.label}.` });
    },
  });

  const all = useMemo(() => addresses.data ?? [], [addresses.data]);
  const chosen = all.find((a) => a.id === value) ?? null;
  const q = search.trim().toLowerCase();
  const found = useMemo(() => all.filter((a) => matches(a, q)), [all, q]);
  // One clinic is not a choice; it is a fact, and it reads as a line.
  const only = all.length === 1 ? all[0] : null;

  return (
    <div className="ac">
      <span className="ac-title">{title}</span>

      <div className="ac-box" ref={box}>
        {only ? (
          <div className="ac-one">
            <b>{only.label}</b>
            <span>{oneLine(only)}</span>
          </div>
        ) : (
          <>
            <button
              type="button"
              className={`ac-trigger${open ? " open" : ""}`}
              aria-haspopup="listbox"
              aria-expanded={open}
              onClick={() => {
                setSearch("");
                setOpen((v) => !v);
              }}
            >
              <span className="ac-chosen">
                {chosen ? (
                  <>
                    <b>
                      {chosen.label}
                      {chosen.is_default_shipping && <em>Default</em>}
                    </b>
                    <span>{oneLine(chosen)}</span>
                  </>
                ) : (
                  <b className="ac-none">Choose a clinic</b>
                )}
              </span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>

            {open && (
              <div className="ac-menu" role="listbox" aria-label={title}>
                {/* Searching a handful of clinics is slower than reading them,
                    so the box only appears once there are enough to hunt. */}
                {all.length > 6 && (
                  <span className="search ac-search">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <circle cx="11" cy="11" r="7" />
                      <path d="m20 20-3.5-3.5" strokeLinecap="round" />
                    </svg>
                    <input
                      autoFocus
                      value={search}
                      placeholder="Name, city or PIN code"
                      aria-label="Search clinics"
                      onChange={(e) => setSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && found[0]) {
                          onChange(found[0].id);
                          setOpen(false);
                        }
                      }}
                    />
                  </span>
                )}

                <ul className="ac-list">
                  {found.length === 0 ? (
                    <li className="ac-empty">No clinic matches “{search}”.</li>
                  ) : (
                    found.map((a) => (
                      <li key={a.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={value === a.id}
                          className={value === a.id ? "on" : ""}
                          onClick={() => {
                            onChange(a.id);
                            setOpen(false);
                          }}
                        >
                          <span className="ac-opt">
                            <b>
                              {a.label}
                              {a.is_default_shipping && <em>Default</em>}
                            </b>
                            <span>{oneLine(a)}</span>
                          </span>
                          {value === a.id && (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="m5 12.5 4.5 4.5L19 7.5" />
                            </svg>
                          )}
                        </button>
                      </li>
                    ))
                  )}
                </ul>

                <button
                  type="button"
                  className="ac-add"
                  onClick={() => {
                    setOpen(false);
                    setAdding(true);
                  }}
                >
                  + Deliver somewhere else
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {only && !adding && (
        <button type="button" className="btn-link" onClick={() => setAdding(true)}>
          + Deliver somewhere else
        </button>
      )}

      {adding && (
        /* The form used to mount below the fold on a long panel, so the
           "somewhere else" link appeared to do nothing. */
        <Reveal className="card stack-sm">
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
        </Reveal>
      )}
    </div>
  );
}
