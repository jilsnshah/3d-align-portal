/* The scan team: who goes out to clinics, the week they work, and their time
 * off.
 *
 * It used to be a section of its own in the lab's top-level navigation, which
 * put a page nobody opens twice a month beside the queue and the case list. It
 * is an account roster — the same kind of thing as the orthodontists — so it
 * lives under Settings › People with them. The calls behind every change are
 * the ones the page always made.
 *
 * What it is for: a technician here is a bookable person. Their working week
 * is what the clinic's scan calendar offers, their daily cap is how many
 * visits the router will stack on them, and their time off closes the diary
 * for those dates. Deactivating an account takes them out of the rota without
 * touching the visits already on the board.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { WEEKDAYS, api } from "../api";
import type { AvailabilityRule, Technician } from "../api";
import Avatar from "./Avatar";
import Drawer from "./Drawer";
import { useToast } from "./Toast";
import { ConfirmButton, Empty, ErrorText, Field, Skeleton } from "./ui";

/** The working day as drawn: six in the morning to ten at night. */
const DAY_FROM = 6 * 60;
const DAY_SPAN = 16 * 60;

function minutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function weeklyHours(rules: AvailabilityRule[]): number {
  return rules.reduce((n, r) => n + Math.max(0, minutes(r.end_time) - minutes(r.start_time)), 0) / 60;
}

function hoursLabel(h: number): string {
  return `${Math.round(h * 10) / 10}h`;
}

function awayNow(t: Technician, now = Date.now()) {
  return t.time_off.find((o) => new Date(o.starts_at).getTime() <= now && new Date(o.ends_at).getTime() > now) ?? null;
}

function nextAway(t: Technician, now = Date.now()) {
  return (
    [...t.time_off]
      .filter((o) => new Date(o.starts_at).getTime() > now)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0] ?? null
  );
}

function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** A technician's week as seven small bars, each the working window on a
    six-to-ten day. */
function WeekBars({ rules }: { rules: AvailabilityRule[] }) {
  const say = WEEKDAYS.map((name, i) => {
    const day = rules.filter((r) => r.weekday === i);
    return `${name}: ${day.length ? day.map((r) => `${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`).join(", ") : "off"}`;
  }).join("; ");
  return (
    <span className="tc-week" role="img" aria-label={say} title={say}>
      {WEEKDAYS.map((name, i) => {
        const day = rules.filter((r) => r.weekday === i);
        return (
          <span key={name} className={`tc-day${day.length ? "" : " off"}`}>
            <span className="tc-bar">
              {day.map((r) => {
                const s = minutes(r.start_time);
                const e = minutes(r.end_time);
                return (
                  <i
                    key={`${r.start_time}-${r.end_time}`}
                    style={{
                      top: `${Math.max(0, ((s - DAY_FROM) / DAY_SPAN) * 100)}%`,
                      height: `${Math.max(4, ((e - s) / DAY_SPAN) * 100)}%`,
                    }}
                  />
                );
              })}
            </span>
            <small>{name.slice(0, 1)}</small>
          </span>
        );
      })}
    </span>
  );
}

type Cut = "active" | "inactive" | "all";

const CUTS: { key: Cut; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "inactive", label: "Inactive" },
  { key: "all", label: "All" },
];

export default function TechnicianRoster() {
  const technicians = useQuery({ queryKey: ["technicians"], queryFn: api.technicians });
  const [search, setSearch] = useState("");
  const [cut, setCut] = useState<Cut>("active");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const list = useMemo(() => technicians.data ?? [], [technicians.data]);
  const q = search.trim().toLowerCase();
  const base = useMemo(
    () =>
      list.filter(
        (t) => !q || [t.full_name, t.email, t.phone, t.employee_code].some((v) => (v ?? "").toLowerCase().includes(q)),
      ),
    [list, q],
  );
  const counts = {
    active: base.filter((t) => t.is_active).length,
    inactive: base.filter((t) => !t.is_active).length,
    all: base.length,
  };
  const shown = base
    .filter((t) => (cut === "all" ? true : cut === "active" ? t.is_active : !t.is_active))
    .sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.full_name.localeCompare(b.full_name));

  const active = list.filter((t) => t.is_active);
  const upcoming = active.reduce((n, t) => n + t.upcoming_jobs, 0);
  const away = active.filter((t) => awayNow(t)).length;
  const opened = openId ? list.find((t) => t.id === openId) ?? null : null;

  return (
    <>
      <section className="pr-card">
        <div className="card-head tc-head">
          <h2 className="st-card-title">Scan technicians</h2>
          <span className="dim">
            They take the scan visits. Their hours are what a clinic's calendar offers.
          </span>
        </div>

        {technicians.isLoading ? (
          <Skeleton rows={3} />
        ) : (
          <>
            <p className="st-note tc-sum">
              <b>{active.length}</b> active
              {" · "}
              <b>{upcoming}</b> upcoming {upcoming === 1 ? "visit" : "visits"}
              {away > 0 && (
                <>
                  {" · "}
                  <b className="lit">{away}</b> away today
                </>
              )}
            </p>

            <section className="console" aria-label="Filters">
              <div className="cut" role="tablist" aria-label="Show">
                {CUTS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    role="tab"
                    aria-selected={cut === c.key}
                    className={cut === c.key ? "on" : ""}
                    onClick={() => setCut(c.key)}
                  >
                    {c.label}
                    <span className="cut-n">{counts[c.key]}</span>
                  </button>
                ))}
              </div>

              <span className="console-rule" aria-hidden="true" />

              <span className="search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" strokeLinecap="round" />
                </svg>
                <input
                  placeholder="Name, phone or employee code"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search technicians"
                />
              </span>

              <span className="tally-say">
                {shown.length} {shown.length === 1 ? "technician" : "technicians"}
              </span>

              <Link to="/staff/bookings" className="btn-link clear">
                Open bookings
              </Link>
            </section>

            {list.length === 0 ? (
              <Empty>
                No technicians yet.{" "}
                <button type="button" className="btn-link" onClick={() => setAdding(true)}>
                  Add the first one
                </button>
              </Empty>
            ) : shown.length === 0 ? (
              <Empty>No technician matches.</Empty>
            ) : (
              <div className="tc-grid">
                {shown.map((t) => {
                  const out = awayNow(t);
                  const next = nextAway(t);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={`tc-card${t.is_active ? "" : " off"}`}
                      onClick={() => setOpenId(t.id)}
                    >
                      <span className="tc-top">
                        <Avatar name={t.full_name} />
                        <span className="tc-name">
                          <b>{t.full_name}</b>
                          <small>{[t.employee_code, t.phone || t.email].filter(Boolean).join(" · ")}</small>
                        </span>
                        <span className={!t.is_active ? "pill pill-danger" : out ? "pill pill-warn" : "pill pill-ok"}>
                          {!t.is_active ? "Inactive" : out ? "On leave" : "Active"}
                        </span>
                      </span>
                      <span className="tc-figs">
                        <span>
                          <b>{t.upcoming_jobs}</b>
                          <small>Upcoming</small>
                        </span>
                        <span>
                          <b>{hoursLabel(weeklyHours(t.availability))}</b>
                          <small>A week</small>
                        </span>
                        <span>
                          <b>{t.max_daily_jobs}</b>
                          <small>Visits a day</small>
                        </span>
                      </span>
                      <WeekBars rules={t.availability} />
                      <span className={`tc-foot${out ? " away" : ""}`}>
                        {out
                          ? `Away until ${shortDay(out.ends_at)}`
                          : next
                            ? `Time off from ${shortDay(next.starts_at)}`
                            : "No time off booked"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="pr-actions">
              <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
                Add technician
              </button>
            </div>
          </>
        )}
      </section>

      {opened && <TechPanel key={opened.id} tech={opened} onClose={() => setOpenId(null)} />}
      {adding && <AddTechnician onClose={() => setAdding(false)} />}
    </>
  );
}

/** One technician, opened: their details, their week and their time off, each
    changed here. */
function TechPanel({ tech, onClose }: { tech: Technician; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const onDone = () => void queryClient.invalidateQueries({ queryKey: ["technicians"] });
  const [rules, setRules] = useState<AvailabilityRule[]>(tech.availability);
  const [off, setOff] = useState({ starts_at: "", ends_at: "", reason: "" });
  const [editing, setEditing] = useState(false);

  const save = useMutation({
    mutationFn: () => api.setAvailability(tech.id, rules),
    onSuccess: () => {
      setEditing(false);
      onDone();
      toast({ title: "Hours saved", body: `${tech.full_name} is bookable in the new windows.` });
    },
  });
  const toggle = useMutation({
    mutationFn: () => api.updateTechnician(tech.id, { is_active: !tech.is_active }),
    onSuccess: () => {
      onDone();
      toast(
        tech.is_active
          ? { title: "Account deactivated", tone: "warn", body: `${tech.full_name} takes no new visits.` }
          : { title: "Account reactivated", body: `${tech.full_name} can be booked again.` },
      );
    },
  });
  const addOff = useMutation({
    mutationFn: () =>
      api.addTimeOff(tech.id, {
        starts_at: new Date(off.starts_at).toISOString(),
        ends_at: new Date(off.ends_at).toISOString(),
        reason: off.reason,
      }),
    onSuccess: () => {
      setOff({ starts_at: "", ends_at: "", reason: "" });
      onDone();
      toast({ title: "Time off booked", body: "The diary is closed for those dates." });
    },
  });
  const dropOff = useMutation({ mutationFn: (id: string) => api.removeTimeOff(id), onSuccess: onDone });

  const byDay = (list: AvailabilityRule[], weekday: number) => list.filter((r) => r.weekday === weekday);
  function setRule(weekday: number, start: string, end: string) {
    const others = rules.filter((r) => r.weekday !== weekday);
    setRules([...others, { weekday, start_time: start, end_time: end }]);
  }
  const out = awayNow(tech);
  const timeOff = [...tech.time_off].sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  return (
    <Drawer
      eyebrow="Technician"
      title={tech.full_name}
      sub={[tech.employee_code, tech.email].filter(Boolean).join(" · ")}
      lead={<Avatar name={tech.full_name} large />}
      onClose={onClose}
      stats={
        <div className="pt-stats">
          <div>
            <b>{tech.upcoming_jobs}</b>
            <span>Upcoming visits</span>
          </div>
          <div>
            <b>{hoursLabel(weeklyHours(tech.availability))}</b>
            <span>Hours a week</span>
          </div>
          <div>
            <b>{tech.max_daily_jobs}</b>
            <span>Visits a day, at most</span>
          </div>
        </div>
      }
      foot={
        <div className="dw-actions">
          <Link to="/staff/bookings" className="btn-link" onClick={onClose}>
            See their visits
          </Link>
          {tech.is_active ? (
            <ConfirmButton
              label="Deactivate"
              confirmLabel="Deactivate this account"
              className="btn-ghost"
              disabled={toggle.isPending}
              onConfirm={() => toggle.mutate()}
            />
          ) : (
            <button type="button" className="btn-primary" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
              Reactivate
            </button>
          )}
        </div>
      }
    >
      <section className="dw-section">
        <h3>Contact</h3>
        <dl className="dw-dl">
          <div>
            <dt>Status</dt>
            <dd>
              <span className={!tech.is_active ? "pill pill-danger" : out ? "pill pill-warn" : "pill pill-ok"}>
                {!tech.is_active ? "Inactive" : out ? `On leave until ${shortDay(out.ends_at)}` : "Active"}
              </span>
            </dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{tech.phone || "—"}</dd>
          </div>
          <div className="wide">
            <dt>Email</dt>
            <dd>{tech.email}</dd>
          </div>
        </dl>
        <ErrorText error={toggle.error} />
      </section>

      <section className="dw-section">
        <div className="dw-section-head">
          <h3>Working week</h3>
          {!editing && (
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setRules(tech.availability);
                setEditing(true);
              }}
            >
              Edit hours
            </button>
          )}
        </div>
        {!editing ? (
          <>
            <WeekBars rules={tech.availability} />
            <ul className="tc-hours-view">
              {WEEKDAYS.map((name, index) => {
                const day = byDay(tech.availability, index);
                return (
                  <li key={name} className={day.length ? "" : "off"}>
                    <span>{name}</span>
                    <b>
                      {day.length === 0
                        ? "Off"
                        : day.map((r) => `${r.start_time.slice(0, 5)} – ${r.end_time.slice(0, 5)}`).join(", ")}
                    </b>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <div className="tc-hours">
            {WEEKDAYS.map((name, index) => {
              const rule = byDay(rules, index)[0];
              return (
                <div key={name} className="tc-hour">
                  <span>{name}</span>
                  <input
                    type="time"
                    value={rule?.start_time?.slice(0, 5) ?? ""}
                    aria-label={`${name} from`}
                    onChange={(e) => setRule(index, e.target.value, rule?.end_time?.slice(0, 5) ?? "18:00")}
                  />
                  <input
                    type="time"
                    value={rule?.end_time?.slice(0, 5) ?? ""}
                    aria-label={`${name} to`}
                    onChange={(e) => setRule(index, rule?.start_time?.slice(0, 5) ?? "09:00", e.target.value)}
                  />
                  {rule ? (
                    <button type="button" className="btn-link" onClick={() => setRules(rules.filter((r) => r.weekday !== index))}>
                      Clear
                    </button>
                  ) : (
                    <span className="dim">Off</span>
                  )}
                </div>
              );
            })}
            <ErrorText error={save.error} />
            <div className="dw-actions start">
              <button type="button" className="btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? "Saving…" : "Save hours"}
              </button>
              <button
                type="button"
                className="btn-link"
                onClick={() => {
                  setRules(tech.availability);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="dw-section">
        <h3>Time off</h3>
        {timeOff.length === 0 ? (
          <p className="dim">None booked.</p>
        ) : (
          <ul className="tc-offs">
            {timeOff.map((t) => (
              <li key={t.id}>
                <span>
                  <b>
                    {when(t.starts_at)} → {when(t.ends_at)}
                  </b>
                  {t.reason && <small>{t.reason}</small>}
                </span>
                <button type="button" className="btn-link" disabled={dropOff.isPending} onClick={() => dropOff.mutate(t.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="tc-off-add">
          <Field label="From">
            <input type="datetime-local" value={off.starts_at} onChange={(e) => setOff({ ...off, starts_at: e.target.value })} />
          </Field>
          <Field label="To">
            <input type="datetime-local" value={off.ends_at} onChange={(e) => setOff({ ...off, ends_at: e.target.value })} />
          </Field>
          <Field label="Reason">
            <input placeholder="Optional" value={off.reason} onChange={(e) => setOff({ ...off, reason: e.target.value })} />
          </Field>
          <button
            type="button"
            className="btn-ghost"
            disabled={!off.starts_at || !off.ends_at || addOff.isPending}
            onClick={() => addOff.mutate()}
          >
            Add time off
          </button>
        </div>
        <ErrorText error={addOff.error ?? dropOff.error} />
      </section>
    </Drawer>
  );
}

const BLANK = { email: "", password: "", full_name: "", phone: "", employee_code: "", max_daily_jobs: 4 };

/** A new scan technician's account, made in a panel of its own. */
function AddTechnician({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(BLANK);
  const create = useMutation({
    mutationFn: () => api.createTechnician(form),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["technicians"] });
      onClose();
      toast({ title: "Technician added", body: `${created.full_name} is bookable from today.` });
    },
  });

  return (
    <Drawer
      eyebrow="New technician"
      title="Add a technician"
      sub="Their working week is seeded from the lab's hours, so they can be booked straight away."
      onClose={onClose}
      foot={
        <>
          <ErrorText error={create.error} />
          <div className="dw-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" form="tc-add" className="btn-primary" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create account"}
            </button>
          </div>
        </>
      }
    >
      <form
        id="tc-add"
        className="pr-form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Full name">
          <input required autoFocus value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </Field>
        <Field label="Email">
          <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Password" hint="At least 8 characters. They can change it after signing in.">
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </Field>
        <div className="pr-form two">
          <Field label="Phone">
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="Employee code">
            <input value={form.employee_code} onChange={(e) => setForm({ ...form, employee_code: e.target.value })} />
          </Field>
        </div>
        <Field label="Most visits in a day">
          <input
            type="number"
            min={1}
            max={20}
            value={form.max_daily_jobs}
            onChange={(e) => setForm({ ...form, max_daily_jobs: Number(e.target.value) })}
          />
        </Field>
      </form>
    </Drawer>
  );
}
