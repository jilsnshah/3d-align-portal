/* The lab's settings: what clinics pay, what delivery costs, how aligners are
 * priced, and how the scan calendar books and routes.
 *
 * It was one long page — people, UPI, delivery, pricing, scheduling, routing
 * and hours stacked down it — and the button that saved the UPI details sat at
 * the very bottom, under the working hours, where nobody editing a UPI ID
 * would look for it. It is laid out as settings now, like the clinic's
 * account: a rail of sections and one on the screen at a time. Everything that
 * belongs to the booking settings saves together from a bar that appears the
 * moment anything is changed, whichever section it was changed in; delivery
 * rates and pricing keep their own save, as they always had.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";

import { WEEKDAYS, api, formatMoney } from "../../api";
import type { AlignerPrice, BookingSettings, DeliveryCity, ShippingRate } from "../../api";
import { Banner, ErrorText, Field, Loading } from "../../components/ui";
import OrthodontistRoster from "../../components/OrthodontistRoster";
import { useToast } from "../../components/Toast";
import LocationPicker from "../../components/LocationPicker";
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

type Tab = "payments" | "delivery" | "pricing" | "scheduling" | "routing" | "hours" | "people";

const Glyph = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const TABS: { key: Tab; label: string; hint: string; icon: ReactNode; admin?: boolean }[] = [
  {
    key: "payments",
    label: "Payments",
    hint: "UPI ID and fixed fees",
    icon: (
      <Glyph>
        <path d="M6 5h12M6 9.5h12M9.5 5v3a4 4 0 0 1-4 4h-.5l7 7" />
      </Glyph>
    ),
  },
  {
    key: "delivery",
    label: "Delivery charges",
    hint: "By the clinic's city",
    icon: (
      <Glyph>
        <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7" />
        <circle cx="7" cy="17.5" r="1.8" />
        <circle cx="17" cy="17.5" r="1.8" />
      </Glyph>
    ),
  },
  {
    key: "pricing",
    label: "Aligner pricing",
    hint: "Each band's price range",
    icon: (
      <Glyph>
        <path d="M20 12 12 20l-8-8V4h8z" />
        <circle cx="8.5" cy="8.5" r="1.4" />
      </Glyph>
    ),
  },
  {
    key: "scheduling",
    label: "Scan scheduling",
    hint: "Visit length, notice, horizon",
    icon: (
      <Glyph>
        <rect x="4" y="5" width="16" height="15" rx="2" />
        <path d="M4 10h16M9 3v4M15 3v4" />
      </Glyph>
    ),
  },
  {
    key: "routing",
    label: "Routing",
    hint: "Travel costs and the lab's address",
    icon: (
      <Glyph>
        <circle cx="6" cy="18" r="2" />
        <circle cx="18" cy="6" r="2" />
        <path d="M8 18h6a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h6" />
      </Glyph>
    ),
  },
  {
    key: "hours",
    label: "Working hours",
    hint: "When visits can be booked",
    icon: (
      <Glyph>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </Glyph>
    ),
  },
  {
    key: "people",
    label: "People",
    hint: "Orthodontists who plan",
    admin: true,
    icon: (
      <Glyph>
        <circle cx="9" cy="8.5" r="3.2" />
        <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
        <path d="M16 5.5a3 3 0 0 1 0 6M17.5 14a5 5 0 0 1 3 5.5" />
      </Glyph>
    ),
  },
];

/** The sections whose fields belong to the booking settings, and save
    together. */
const DRAFT_TABS: Tab[] = ["payments", "delivery", "scheduling", "routing", "hours"];

/** The working day as drawn: six in the morning to ten at night. */
const DAY_FROM = 6 * 60;
const DAY_SPAN = 16 * 60;

function minutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
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

export default function AdminSettings() {
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const settings = useQuery({ queryKey: ["booking-settings"], queryFn: api.bookingSettings });
  const pricing = useQuery({ queryKey: ["pricing"], queryFn: api.pricing });
  const [prices, setPrices] = useState<AlignerPrice[] | null>(null);
  const [pricesSaved, setPricesSaved] = useState(false);
  const [draft, setDraft] = useState<BookingSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const rates = useQuery({ queryKey: ["shipping-rates"], queryFn: api.shippingRates });
  // The cities clinics are actually in. Delivery is matched on the name, so a
  // rate typed by hand can miss every clinic and quietly bill the default.
  const cities = useQuery({ queryKey: ["delivery-cities"], queryFn: api.deliveryCities });
  const [shipping, setShipping] = useState<ShippingRate[] | null>(null);
  const [shippingSaved, setShippingSaved] = useState(false);

  const tabs = TABS.filter((t) => !t.admin || me?.role === "ADMIN");
  const tab = tabs.find((t) => t.key === params.get("tab"))?.key ?? tabs[0].key;
  function go(next: Tab) {
    const q = new URLSearchParams(params);
    if (next === tabs[0].key) q.delete("tab");
    else q.set("tab", next);
    setParams(q, { replace: true });
  }

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
      toast({ title: "Delivery charges saved", body: "New production phases are billed at these rates." });
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
      toast({ title: "Pricing saved", body: "Quotes from now on use these bands." });
    },
  });

  const save = useMutation({
    mutationFn: () => api.saveBookingSettings(draft),
    onSuccess: () => {
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["booking-settings"] });
      void queryClient.invalidateQueries({ queryKey: ["availability"] });
      toast({ title: "Settings saved", body: "The booking calendar and payment details update immediately." });
    },
  });

  if (settings.isLoading || !draft) return <Loading what="settings" />;

  const d = draft;
  const hours = d.working_hours ?? {};
  const dirty = settings.data !== undefined && JSON.stringify(d) !== JSON.stringify(settings.data);

  function edit(patch: Partial<BookingSettings>) {
    setSaved(false);
    setDraft({ ...d, ...patch });
  }

  function setDay(index: number, start: string, end: string) {
    const next = { ...(d.working_hours ?? {}) };
    if (!start || !end) delete next[String(index)];
    else next[String(index)] = [start, end];
    edit({ working_hours: next as BookingSettings["working_hours"] });
  }

  const knob = (field: Knob) => (
    <Field key={field.key} label={field.label} hint={field.hint}>
      <input
        type="number"
        min={field.min}
        max={field.max}
        step={field.step ?? 1}
        value={d[field.key] as number}
        onChange={(e) => edit({ [field.key]: Number(e.target.value) } as Partial<BookingSettings>)}
      />
    </Field>
  );

  const missing = (cities.data ?? []).filter((c) => c.amount === null);
  const openDays = WEEKDAYS.filter((_, i) => Boolean(hours[String(i)])).length;

  return (
    <main className="page page-wide pr st">
      <aside className="pr-rail">
        <div className="pr-me">
          <span className="pr-avatar" aria-hidden="true">
            3D
          </span>
          <div>
            <b>3D Align lab</b>
            <span>
              {d.service_city || "Settings"}
              {d.timezone_name ? ` · ${d.timezone_name}` : ""}
            </span>
          </div>
        </div>
        <nav className="pr-tabs" aria-label="Settings sections">
          {tabs.map((t) => (
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
            </button>
          ))}
        </nav>
      </aside>

      <div className="pr-pane" key={tab}>
        {saved && !dirty && DRAFT_TABS.includes(tab) && (
          <Banner tone="ok">Saved. The calendar and the payment details update immediately.</Banner>
        )}

        {tab === "payments" && (
          <>
            <PaneHead
              kicker="Payments"
              title="UPI and fixed fees"
              sub="Clinics pay by UPI and send a screenshot. These details fill in their payment app, so nothing is typed by hand."
            />
            <section className="pr-card">
              <div className="pr-form two">
                <Field label="UPI ID">
                  <input value={d.upi_vpa ?? ""} placeholder="3dalign@okhdfcbank" onChange={(e) => edit({ upi_vpa: e.target.value })} />
                </Field>
                <Field label="Payee name">
                  <input value={d.upi_payee_name ?? ""} onChange={(e) => edit({ upi_payee_name: e.target.value })} />
                </Field>
              </div>
              <div className="st-upi" aria-label="What clinics see">
                <span className="st-upi-mark" aria-hidden="true">
                  UPI
                </span>
                <span className="st-upi-say">
                  <small>What a clinic's UPI app shows</small>
                  <b>{d.upi_payee_name || "3D Align"}</b>
                  <span className="mono">{d.upi_vpa || "No UPI ID yet — clinics cannot pay"}</span>
                </span>
              </div>
            </section>
            <section className="pr-card">
              <h2 className="st-card-title">Fixed fees</h2>
              <div className="pr-form two">
                <Field label="Treatment plan fee">
                  <input type="number" min={0} value={d.plan_fee ?? ""} onChange={(e) => edit({ plan_fee: e.target.value })} />
                </Field>
                <Field label="Training fit aligner fee">
                  <input
                    type="number"
                    min={0}
                    value={d.training_fit_fee ?? ""}
                    onChange={(e) => edit({ training_fit_fee: e.target.value })}
                  />
                </Field>
              </div>
              <p className="st-note">
                Both are charged once per case and are deducted from the quote, so production phases never carry them
                again. Together they come to <b>{formatMoney(Number(d.plan_fee ?? 0) + Number(d.training_fit_fee ?? 0))}</b>.
              </p>
            </section>
          </>
        )}

        {tab === "delivery" && (
          <>
            <PaneHead kicker="Delivery" title="Delivery charges" sub="Added to every production phase, by the clinic's city." />
            <section className="pr-card">
              <Field label="Default charge, for a city with no rate below" hint="Saved with the booking settings.">
                <input
                  type="number"
                  min={0}
                  value={d.default_shipping_fee ?? ""}
                  onChange={(e) => edit({ default_shipping_fee: e.target.value })}
                />
              </Field>
            </section>
            <section className="pr-card">
              <h2 className="st-card-title">By city</h2>
              {shippingSaved && <Banner tone="ok">Delivery charges saved.</Banner>}
              <div className="case-table st-table">
                <table>
                  <thead>
                    <tr>
                      <th>City</th>
                      <th>Charge</th>
                      <th>Clinics</th>
                      <th>Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(shipping ?? []).map((row, index) => (
                      <tr key={row.city}>
                        <td>
                          <span className="cell-title">{row.city}</span>
                        </td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            value={row.amount}
                            aria-label={`Charge for ${row.city}`}
                            onChange={(e) => {
                              const next = [...(shipping ?? [])];
                              next[index] = { ...row, amount: e.target.value };
                              setShipping(next);
                              setShippingSaved(false);
                            }}
                          />
                        </td>
                        <td>
                          {row.clinics > 0 ? (
                            <span>{row.clinics}</span>
                          ) : (
                            <span className="pill pill-danger" title="No clinic is in a city spelled this way, so this rate is never used.">
                              reaches none
                            </span>
                          )}
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={row.is_active}
                            aria-label={`Charge ${row.city}`}
                            onChange={(e) => {
                              const next = [...(shipping ?? [])];
                              next[index] = { ...row, is_active: e.target.checked };
                              setShipping(next);
                              setShippingSaved(false);
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Cities with clinics but no rate. Each one is silently billing
                  the default until it is priced, which is the same failure a
                  misspelled rate causes from the other direction. */}
              {missing.length > 0 && (
                <Banner tone="warn">
                  <span>
                    No delivery charge set for{" "}
                    {missing.map((c) => `${c.city} (${c.clinics} clinic${c.clinics === 1 ? "" : "s"})`).join(", ")}. They are
                    billed the default until priced.
                  </span>
                </Banner>
              )}
              <NewCityRow
                cities={missing}
                onAdd={(city) => {
                  setShipping([...(shipping ?? []), { city, amount: "0", is_active: true, clinics: 0 }]);
                  setShippingSaved(false);
                }}
              />
              <ErrorText error={saveShipping.error} />
              <div className="pr-actions">
                <button type="button" className="btn-dark" disabled={saveShipping.isPending} onClick={() => saveShipping.mutate()}>
                  {saveShipping.isPending ? "Saving…" : "Save delivery charges"}
                </button>
              </div>
            </section>
          </>
        )}

        {tab === "pricing" && (
          <>
            <PaneHead
              kicker="Pricing"
              title="Aligner pricing"
              sub="Each band quotes a range. The exact figure is set on the treatment plan."
            />
            <section className="pr-card">
              {pricesSaved && <Banner tone="ok">Pricing saved.</Banner>}
              <div className="case-table st-table">
                <table>
                  <thead>
                    <tr>
                      <th>Band</th>
                      <th>Aligners</th>
                      <th className="num">From</th>
                      <th className="num">To</th>
                      <th>Offered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(prices ?? []).map((p, index) => (
                      <tr key={p.category} className={p.is_active ? "" : "done"}>
                        <td>
                          <span className="cell-title">{p.label}</span>
                        </td>
                        <td className="num-left">
                          {p.range_from}
                          {p.range_to === null ? "+" : `–${p.range_to}`}
                        </td>
                        <td className="num">
                          <input
                            type="number"
                            min={0}
                            value={p.price_min}
                            aria-label={`${p.label} from`}
                            onChange={(e) => {
                              const next = [...(prices ?? [])];
                              next[index] = { ...p, price_min: e.target.value };
                              setPrices(next);
                              setPricesSaved(false);
                            }}
                          />
                        </td>
                        <td className="num">
                          <input
                            type="number"
                            min={0}
                            value={p.price_max}
                            aria-label={`${p.label} to`}
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
                            {p.is_active ? "Yes" : "No"}
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ErrorText error={savePrices.error} />
              <div className="pr-actions">
                <button type="button" className="btn-primary" disabled={savePrices.isPending} onClick={() => savePrices.mutate()}>
                  {savePrices.isPending ? "Saving…" : "Save pricing"}
                </button>
              </div>
            </section>
          </>
        )}

        {tab === "scheduling" && (
          <>
            <PaneHead
              kicker="Scan booking"
              title="Scan scheduling"
              sub="How long a visit takes, how far ahead and how late a clinic can book, and how many visits a technician takes."
            />
            <section className="pr-card">
              <div className="st-knobs">{NUMBERS.map(knob)}</div>
            </section>
            <section className="pr-card">
              <h2 className="st-card-title">Where and when</h2>
              <div className="pr-form two">
                <Field label="Service city">
                  <input value={d.service_city} onChange={(e) => edit({ service_city: e.target.value })} />
                </Field>
                <Field label="Time zone" hint="Working hours and rosters are wall-clock times in this zone, e.g. Asia/Kolkata.">
                  <input value={d.timezone_name} onChange={(e) => edit({ timezone_name: e.target.value })} />
                </Field>
              </div>
            </section>
          </>
        )}

        {tab === "routing" && (
          <>
            <PaneHead
              kicker="Scan booking"
              title="Routing"
              sub="A visit is assigned to whoever it costs the least to add to an existing round, not to whoever is nearest in a straight line."
            />
            <section className="pr-card">
              <div className="st-knobs">{ROUTING.map(knob)}</div>
            </section>
            <section className="pr-card">
              <h2 className="st-card-title">The lab's address</h2>
              <Field
                label="Lab address"
                hint="Every technician's day starts and ends here. Search or drag the pin to place it exactly — otherwise the address is looked up when you save."
              >
                <input
                  value={d.lab_address}
                  onChange={(e) =>
                    // Typing changes the words; the point below is what actually
                    // costs the routes, so it is re-derived on save unless the
                    // pin has been placed by hand.
                    edit({ lab_address: e.target.value, lab_latitude: null, lab_longitude: null })
                  }
                />
              </Field>
              <div className="st-map">
                <LocationPicker
                  value={d.lab_latitude != null && d.lab_longitude != null ? { lat: d.lab_latitude, lng: d.lab_longitude } : null}
                  query={d.lab_address}
                  onChange={(next) => edit({ lab_latitude: next ? next.lat : null, lab_longitude: next ? next.lng : null })}
                  onResolved={(addr) => {
                    // The pin knows where it landed, so the words follow it.
                    const line = [addr.line1, addr.city, addr.pincode].filter(Boolean).join(", ");
                    if (line) setDraft((prev) => (prev ? { ...prev, lab_address: line } : prev));
                  }}
                />
              </div>
              {d.lab_geocode_source === "pincode" && (
                <Banner tone="warn">
                  This point came from the pincode, which is the centre of a whole postal area. Drop the pin on the
                  building for accurate travel times.
                </Banner>
              )}
            </section>
          </>
        )}

        {tab === "hours" && (
          <>
            <PaneHead
              kicker="Scan booking"
              title="Working hours"
              sub={`Open ${openDays} ${openDays === 1 ? "day" : "days"} a week. Close a day to take no bookings on it. New technicians inherit this as their starting roster.`}
            />
            <section className="pr-card">
              <div className="st-days">
                {WEEKDAYS.map((name, index) => {
                  const value = hours[String(index)] ?? null;
                  const from = value ? minutes(value[0]) : 0;
                  const to = value ? minutes(value[1]) : 0;
                  return (
                    <div className={`st-day${value ? "" : " closed"}`} key={name}>
                      <span className="st-day-name">{name}</span>
                      <input
                        type="time"
                        value={value?.[0] ?? ""}
                        aria-label={`${name} opens`}
                        onChange={(e) => setDay(index, e.target.value, value?.[1] ?? "18:00")}
                      />
                      <input
                        type="time"
                        value={value?.[1] ?? ""}
                        aria-label={`${name} closes`}
                        onChange={(e) => setDay(index, value?.[0] ?? "09:00", e.target.value)}
                      />
                      <span className="st-day-bar" aria-hidden="true">
                        {value && (
                          <i
                            style={{
                              left: `${Math.max(0, ((from - DAY_FROM) / DAY_SPAN) * 100)}%`,
                              width: `${Math.max(2, ((to - from) / DAY_SPAN) * 100)}%`,
                            }}
                          />
                        )}
                      </span>
                      {value ? (
                        <button type="button" className="btn-link" onClick={() => setDay(index, "", "")}>
                          Close
                        </button>
                      ) : (
                        <button type="button" className="btn-link" onClick={() => setDay(index, "09:00", "18:00")}>
                          Open
                        </button>
                      )}
                    </div>
                  );
                })}
                <div className="st-scale" aria-hidden="true">
                  <span>6:00</span>
                  <span>10:00</span>
                  <span>14:00</span>
                  <span>18:00</span>
                  <span>22:00</span>
                </div>
              </div>
            </section>
          </>
        )}

        {tab === "people" && (
          <>
            <PaneHead
              kicker="People"
              title="Orthodontists"
              sub="They plan the cases assigned to them and see everything else the lab sees. Only the admin can add or close an account."
            />
            <OrthodontistRoster />
          </>
        )}

        {dirty && (
          <div className="st-savebar" role="status">
            <span>
              <b>Unsaved changes</b> to the lab's booking and payment settings.
            </span>
            <ErrorText error={save.error} />
            <button
              type="button"
              className="st-discard"
              onClick={() => {
                if (settings.data) setDraft(settings.data);
                setSaved(false);
              }}
            >
              Discard
            </button>
            <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save changes"}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

/** Adding a city the lab has not priced yet.
 *
 *  Chosen from the places clinics really are rather than typed: delivery is
 *  matched on the name, and a rate spelled even slightly differently reaches
 *  nobody and bills the default instead, with nothing to show for it.
 */
function NewCityRow({ cities, onAdd }: { cities: DeliveryCity[]; onAdd: (city: string) => void }) {
  const [city, setCity] = useState("");
  if (cities.length === 0) {
    return <p className="st-note">Every city with a clinic in it has a rate.</p>;
  }
  return (
    <div className="st-addcity">
      <label className="pick">
        <span>Add a city</span>
        <select value={city} onChange={(e) => setCity(e.target.value)}>
          <option value="">Choose a city…</option>
          {cities.map((c) => (
            <option key={c.city} value={c.city}>
              {c.city} — {c.clinics} clinic{c.clinics === 1 ? "" : "s"}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn-ghost btn-sm"
        disabled={!city}
        onClick={() => {
          onAdd(city);
          setCity("");
        }}
      >
        Add
      </button>
    </div>
  );
}
