import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { WEEKDAYS, api, formatMoney } from "../../api";
import type { AlignerPrice, BookingSettings, ShippingRate } from "../../api";
import { Banner, ErrorText, Field, Loading } from "../../components/ui";
import OrthodontistRoster from "../../components/OrthodontistRoster";
import { useAuth } from "../../auth";

type Knob = { key: keyof BookingSettings; label: string; hint: string; min: number; max: number; step?: number };

const NUMBERS: Knob[] = [
  { key: "visit_duration_minutes", label: "Visit length (minutes)", hint: "How long a scan visit takes at the clinic.", min: 15, max: 240 },
  { key: "booking_granularity_minutes", label: "Booking granularity (minutes)", hint: "How finely a clinic may pick a start time inside a free window.", min: 5, max: 60 },
  { key: "travel_buffer_minutes", label: "Safety margin (minutes)", hint: "Held either side of a visit, on top of the calculated travel time.", min: 0, max: 180 },
  { key: "booking_horizon_days", label: "Booking horizon (days)", hint: "How far ahead a clinic may book.", min: 1, max: 180 },
  { key: "min_notice_hours", label: "Minimum notice (hours)", hint: "Nothing may be booked or cancelled inside this.", min: 0, max: 336 },
  { key: "max_daily_jobs", label: "Visits per technician per day", hint: "Default cap; can be overridden per person.", min: 1, max: 20 },
];

const ROUTING: Knob[] = [
  { key: "max_travel_minutes", label: "Maximum travel (minutes)", hint: "Never send a technician further than this for one visit.", min: 5, max: 240 },
  { key: "travel_weight", label: "Travel weight", hint: "How much the detour a visit adds to the route counts.", min: 0, max: 10, step: 0.1 },
  { key: "fairness_weight", label: "Fairness weight", hint: "Raise this to spread work more evenly, at the cost of longer drives.", min: 0, max: 10, step: 0.1 },
  { key: "idle_weight", label: "Idle weight", hint: "Penalty for stranding a gap too small to hold another visit.", min: 0, max: 10, step: 0.1 },
  { key: "fallback_speed_kmph", label: "Fallback speed (km/h)", hint: "Average city speed used when no routing provider is configured.", min: 5, max: 120, step: 0.5 },
];

export default function AdminSettings() {
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["booking-settings"], queryFn: api.bookingSettings });
  const pricing = useQuery({ queryKey: ["pricing"], queryFn: api.pricing });
  const [prices, setPrices] = useState<AlignerPrice[] | null>(null);
  const [pricesSaved, setPricesSaved] = useState(false);
  const [draft, setDraft] = useState<BookingSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const rates = useQuery({ queryKey: ["shipping-rates"], queryFn: api.shippingRates });
  const [shipping, setShipping] = useState<ShippingRate[] | null>(null);
  const [shippingSaved, setShippingSaved] = useState(false);

  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  useEffect(() => {
    if (pricing.data) setPrices(pricing.data);
  }, [pricing.data]);

  useEffect(() => {
    if (rates.data) setShipping(rates.data);
  }, [rates.data]);

  const saveShipping = useMutation({
    mutationFn: () => api.saveShippingRates(shipping ?? []),
    onSuccess: () => {
      setShippingSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["shipping-rates"] });
    },
  });

  const savePrices = useMutation({
    mutationFn: () =>
      api.savePricing(
        (prices ?? []).map((p) => ({
          category: p.category,
          price_min: String(p.price_min),
          price_max: String(p.price_max),
          is_active: p.is_active,
        })),
      ),
    onSuccess: () => {
      setPricesSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["pricing"] });
    },
  });

  const save = useMutation({
    mutationFn: () => api.saveBookingSettings(draft),
    onSuccess: () => {
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["booking-settings"] });
      void queryClient.invalidateQueries({ queryKey: ["availability"] });
    },
  });

  if (settings.isLoading || !draft) return <Loading what="settings" />;

  const hours = draft.working_hours ?? {};

  return (
    <main className="page page-narrow">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">Aligner pricing and the scan booking calendar.</p>
        </div>
      </div>

      {me?.role === "ADMIN" && (
        <>
          <h2 style={{ marginBottom: 12 }}>People</h2>
          <OrthodontistRoster />
        </>
      )}

      <h2 style={{ marginBottom: 12 }}>Payments</h2>
      <div className="card stack-sm" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h4>UPI and fees</h4>
          <span className="dim">
            Clinics pay by UPI and send a screenshot. These details fill in their payment
            app, so nothing is typed by hand.
          </span>
        </div>
        <div className="grid-2">
          <Field label="UPI ID">
            <input
              value={draft.upi_vpa ?? ""}
              placeholder="3dalign@okhdfcbank"
              onChange={(e) => setDraft({ ...draft, upi_vpa: e.target.value })}
            />
          </Field>
          <Field label="Payee name">
            <input
              value={draft.upi_payee_name ?? ""}
              onChange={(e) => setDraft({ ...draft, upi_payee_name: e.target.value })}
            />
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Treatment plan fee">
            <input
              type="number"
              min={0}
              value={draft.plan_fee ?? ""}
              onChange={(e) => setDraft({ ...draft, plan_fee: e.target.value })}
            />
          </Field>
          <Field label="Training fit aligner fee">
            <input
              type="number"
              min={0}
              value={draft.training_fit_fee ?? ""}
              onChange={(e) => setDraft({ ...draft, training_fit_fee: e.target.value })}
            />
          </Field>
        </div>
        <p className="dim">
          Both are charged once per case and are deducted from the quote, so production
          phases never carry them again. Together they come to{" "}
          {formatMoney(Number(draft.plan_fee ?? 0) + Number(draft.training_fit_fee ?? 0))}.
        </p>
      </div>

      <div className="card stack-sm" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h4>Delivery charges</h4>
          <span className="dim">Added to every production phase, by the clinic's city.</span>
        </div>
        {shippingSaved && <Banner tone="ok">Delivery charges saved.</Banner>}
        <Field label="Default, for a city with no rate below">
          <input
            type="number"
            min={0}
            value={draft.default_shipping_fee ?? ""}
            onChange={(e) => setDraft({ ...draft, default_shipping_fee: e.target.value })}
          />
        </Field>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>City</th>
                <th>Charge</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {(shipping ?? []).map((row, index) => (
                <tr key={row.city}>
                  <td>{row.city}</td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      value={row.amount}
                      onChange={(e) => {
                        const next = [...(shipping ?? [])];
                        next[index] = { ...row, amount: e.target.value };
                        setShipping(next);
                      }}
                      style={{ maxWidth: 130 }}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={row.is_active}
                      onChange={(e) => {
                        const next = [...(shipping ?? [])];
                        next[index] = { ...row, is_active: e.target.checked };
                        setShipping(next);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <NewCityRow
          onAdd={(city) =>
            setShipping([...(shipping ?? []), { city, amount: "0", is_active: true }])
          }
        />
        <div className="row">
          <button
            type="button"
            className="btn-dark"
            disabled={saveShipping.isPending}
            onClick={() => saveShipping.mutate()}
          >
            {saveShipping.isPending ? "Saving…" : "Save delivery charges"}
          </button>
        </div>
      </div>

      <h2 style={{ marginBottom: 12 }}>Aligner pricing</h2>
      <div className="card stack-sm" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h4>Aligner pricing</h4>
          <span className="dim">Each band quotes a range. The exact figure is set on the treatment plan.</span>
        </div>
        {pricesSaved && <Banner tone="ok">Pricing saved.</Banner>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Aligners</th>
                <th style={{ textAlign: "right" }}>From</th>
                <th style={{ textAlign: "right" }}>To</th>
                <th>Offered</th>
              </tr>
            </thead>
            <tbody>
              {(prices ?? []).map((p, index) => (
                <tr key={p.category}>
                  <td>
                    <b>{p.label}</b>
                  </td>
                  <td className="dim num">
                    {p.range_from}
                    {p.range_to === null ? "+" : `–${p.range_to}`}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <input
                      type="number"
                      min={0}
                      value={p.price_min}
                      style={{ maxWidth: 130, textAlign: "right" }}
                      onChange={(e) => {
                        const next = [...(prices ?? [])];
                        next[index] = { ...p, price_min: e.target.value };
                        setPrices(next);
                        setPricesSaved(false);
                      }}
                    />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <input
                      type="number"
                      min={0}
                      value={p.price_max}
                      style={{ maxWidth: 130, textAlign: "right" }}
                      onChange={(e) => {
                        const next = [...(prices ?? [])];
                        next[index] = { ...p, price_max: e.target.value };
                        setPrices(next);
                        setPricesSaved(false);
                      }}
                    />
                  </td>
                  <td>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={p.is_active}
                        onChange={(e) => {
                          const next = [...(prices ?? [])];
                          next[index] = { ...p, is_active: e.target.checked };
                          setPrices(next);
                          setPricesSaved(false);
                        }}
                      />
                      {p.is_active ? "yes" : "no"}
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ErrorText error={savePrices.error} />
        <div>
          <button
            type="button"
            className="btn-primary"
            disabled={savePrices.isPending}
            onClick={() => savePrices.mutate()}
          >
            {savePrices.isPending ? "Saving…" : "Save pricing"}
          </button>
        </div>
      </div>

      <h2 style={{ marginBottom: 12 }}>Scan booking</h2>

      {saved && <Banner tone="ok">Saved. The calendar updates immediately.</Banner>}

      <div className="stack" style={{ marginTop: saved ? 16 : 0 }}>
        <div className="card stack-sm">
          <h4>Scheduling</h4>
          <div className="grid-2">
            {NUMBERS.map((field) => (
              <Field key={field.key} label={field.label}>
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={field.step ?? 1}
                  value={draft[field.key] as number}
                  onChange={(e) => {
                    setSaved(false);
                    setDraft({ ...draft, [field.key]: Number(e.target.value) });
                  }}
                />
                <span className="dim">{field.hint}</span>
              </Field>
            ))}
          </div>
          <div className="grid-2">
            <Field label="Service city">
              <input
                value={draft.service_city}
                onChange={(e) => {
                  setSaved(false);
                  setDraft({ ...draft, service_city: e.target.value });
                }}
              />
            </Field>
            <Field label="Time zone">
              <input
                value={draft.timezone_name}
                onChange={(e) => {
                  setSaved(false);
                  setDraft({ ...draft, timezone_name: e.target.value });
                }}
              />
              <span className="dim">
                Working hours and rosters are wall-clock times in this zone, e.g. Asia/Kolkata.
              </span>
            </Field>
          </div>
        </div>

        <div className="card stack-sm">
          <h4>Routing</h4>
          <p className="dim">
            A visit is assigned to whoever it costs the least to add to an existing round, not to
            whoever is nearest in a straight line. Raise the fairness weight to spread work more
            evenly at the cost of longer drives.
          </p>
          <div className="grid-2">
            {ROUTING.map((field) => (
              <Field key={field.key} label={field.label}>
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={field.step ?? 1}
                  value={draft[field.key] as number}
                  onChange={(e) => {
                    setSaved(false);
                    setDraft({ ...draft, [field.key]: Number(e.target.value) });
                  }}
                />
                <span className="dim">{field.hint}</span>
              </Field>
            ))}
          </div>
          <Field label="Lab address">
            <input
              value={draft.lab_address}
              onChange={(e) => {
                setSaved(false);
                setDraft({ ...draft, lab_address: e.target.value });
              }}
            />
            <span className="dim">
              Every technician's day starts and ends here, so the first and last visit are costed
              against a real origin.
            </span>
          </Field>
        </div>

        <div className="card stack-sm">
          <h4>Working hours</h4>
          <p className="dim">
            Clear both times to close a day. New technicians inherit this as their starting roster.
          </p>
          {WEEKDAYS.map((name, index) => {
            const value = hours[String(index)] ?? null;
            return (
              <div className="row" key={name}>
                <span style={{ width: 100, color: "var(--ink-3)", fontSize: "0.87rem" }}>{name}</span>
                <input
                  type="time"
                  style={{ maxWidth: 130 }}
                  value={value?.[0] ?? ""}
                  onChange={(e) => setDay(index, e.target.value, value?.[1] ?? "18:00")}
                />
                <input
                  type="time"
                  style={{ maxWidth: 130 }}
                  value={value?.[1] ?? ""}
                  onChange={(e) => setDay(index, value?.[0] ?? "09:00", e.target.value)}
                />
                {value ? (
                  <button type="button" className="btn-link" onClick={() => setDay(index, "", "")}>
                    Close this day
                  </button>
                ) : (
                  <span className="dim">closed</span>
                )}
              </div>
            );
          })}
        </div>

        <ErrorText error={save.error} />
        <div>
          <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>
    </main>
  );

  function setDay(index: number, start: string, end: string) {
    setSaved(false);
    const next = { ...(draft!.working_hours ?? {}) };
    if (!start || !end) delete next[String(index)];
    else next[String(index)] = [start, end];
    setDraft({ ...draft!, working_hours: next as BookingSettings["working_hours"] });
  }
}

/** Adding a city the lab has not priced yet. Kept separate so the table above
    stays a plain list of what already exists. */
function NewCityRow({ onAdd }: { onAdd: (city: string) => void }) {
  const [city, setCity] = useState("");
  return (
    <div className="row" style={{ gap: 8 }}>
      <input
        placeholder="Add a city"
        value={city}
        onChange={(e) => setCity(e.target.value)}
        style={{ maxWidth: 220 }}
      />
      <button
        type="button"
        className="btn-ghost"
        disabled={!city.trim()}
        onClick={() => {
          onAdd(city.trim());
          setCity("");
        }}
      >
        Add
      </button>
    </div>
  );
}
