import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { WEEKDAYS, api, formatDate } from "../../api";
import type { AvailabilityRule, Technician } from "../../api";
import { Empty, ErrorText, Field, Loading } from "../../components/ui";

export default function AdminTechnicians() {
  const queryClient = useQueryClient();
  const technicians = useQuery({ queryKey: ["technicians"], queryFn: api.technicians });
  const [form, setForm] = useState({
    email: "",
    password: "",
    full_name: "",
    phone: "",
    employee_code: "",
    max_daily_jobs: 4,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["technicians"] });

  const create = useMutation({
    mutationFn: () => api.createTechnician(form),
    onSuccess: () => {
      setForm({ email: "", password: "", full_name: "", phone: "", employee_code: "", max_daily_jobs: 4 });
      invalidate();
    },
  });

  if (technicians.isLoading) return <Loading what="technicians" />;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Technicians</h1>
          <p className="sub">Scan staff, their working week, and time off.</p>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          {technicians.data?.length === 0 ? (
            <Empty>No technicians yet. Add one on the right.</Empty>
          ) : (
            technicians.data?.map((tech) => (
              <TechnicianCard key={tech.id} tech={tech} onDone={invalidate} />
            ))
          )}
        </div>

        <form
          className="card stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <h4>Add a technician</h4>
          <p className="dim">
            Their working week is seeded from the lab's hours, so they are bookable straight away.
          </p>
          <Field label="Full name">
            <input required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          </Field>
          <Field label="Email">
            <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Password">
            <input
              type="password"
              required
              minLength={8}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
          <div className="grid-2">
            <Field label="Phone">
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>
            <Field label="Employee code">
              <input value={form.employee_code} onChange={(e) => setForm({ ...form, employee_code: e.target.value })} />
            </Field>
          </div>
          <Field label="Max visits per day">
            <input
              type="number"
              min={1}
              max={20}
              value={form.max_daily_jobs}
              onChange={(e) => setForm({ ...form, max_daily_jobs: Number(e.target.value) })}
            />
          </Field>
          <ErrorText error={create.error} />
          <button type="submit" className="btn-primary" disabled={create.isPending}>
            Create account
          </button>
        </form>
      </div>
    </main>
  );
}

function TechnicianCard({ tech, onDone }: { tech: Technician; onDone: () => void }) {
  const [rules, setRules] = useState<AvailabilityRule[]>(tech.availability);
  const [off, setOff] = useState({ starts_at: "", ends_at: "", reason: "" });
  const [editing, setEditing] = useState(false);

  const save = useMutation({ mutationFn: () => api.setAvailability(tech.id, rules), onSuccess: () => { setEditing(false); onDone(); } });
  const toggle = useMutation({
    mutationFn: () => api.updateTechnician(tech.id, { is_active: !tech.is_active }),
    onSuccess: onDone,
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
    },
  });
  const dropOff = useMutation({ mutationFn: (id: string) => api.removeTimeOff(id), onSuccess: onDone });

  const byDay = (weekday: number) => rules.filter((r) => r.weekday === weekday);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>{tech.full_name}</h3>
          <p className="dim">
            {tech.email}
            {tech.phone ? ` · ${tech.phone}` : ""}
            {tech.employee_code ? ` · ${tech.employee_code}` : ""}
          </p>
        </div>
        <div className="row">
          <span className="pill">{tech.upcoming_jobs} upcoming</span>
          <span className={tech.is_active ? "pill pill-ok" : "pill pill-danger"}>
            {tech.is_active ? "active" : "inactive"}
          </span>
        </div>
      </div>

      <h4 style={{ marginBottom: 8 }}>Working week</h4>
      {!editing ? (
        <div className="stack-sm">
          {WEEKDAYS.map((name, index) => (
            <div key={name} className="row" style={{ fontSize: "0.87rem" }}>
              <span style={{ width: 90, color: "var(--ink-3)" }}>{name}</span>
              <span>
                {byDay(index).length === 0
                  ? "—"
                  : byDay(index).map((r) => `${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`).join(", ")}
              </span>
            </div>
          ))}
          <div className="row">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(true)}>
              Edit hours
            </button>
            <button type="button" className="btn-link" onClick={() => toggle.mutate()}>
              {tech.is_active ? "Deactivate" : "Reactivate"}
            </button>
          </div>
        </div>
      ) : (
        <div className="stack-sm">
          {WEEKDAYS.map((name, index) => {
            const rule = byDay(index)[0];
            return (
              <div key={name} className="row">
                <span style={{ width: 90, color: "var(--ink-3)", fontSize: "0.85rem" }}>{name}</span>
                <input
                  type="time"
                  value={rule?.start_time?.slice(0, 5) ?? ""}
                  style={{ maxWidth: 120 }}
                  onChange={(e) => setRule(index, e.target.value, rule?.end_time?.slice(0, 5) ?? "18:00")}
                />
                <input
                  type="time"
                  value={rule?.end_time?.slice(0, 5) ?? ""}
                  style={{ maxWidth: 120 }}
                  onChange={(e) => setRule(index, rule?.start_time?.slice(0, 5) ?? "09:00", e.target.value)}
                />
                {rule && (
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => setRules(rules.filter((r) => r.weekday !== index))}
                  >
                    Clear
                  </button>
                )}
              </div>
            );
          })}
          <ErrorText error={save.error} />
          <div className="row">
            <button type="button" className="btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}>
              Save hours
            </button>
            <button type="button" className="btn-link" onClick={() => { setRules(tech.availability); setEditing(false); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <h4 style={{ margin: "18px 0 8px" }}>Time off</h4>
      {tech.time_off.length === 0 ? (
        <p className="dim">None booked.</p>
      ) : (
        tech.time_off.map((t) => (
          <div key={t.id} className="file-row">
            <span className="name">
              {formatDate(t.starts_at)} → {formatDate(t.ends_at)}
              {t.reason ? ` · ${t.reason}` : ""}
            </span>
            <button type="button" className="btn-link" onClick={() => dropOff.mutate(t.id)}>
              Remove
            </button>
          </div>
        ))
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <input
          type="datetime-local"
          value={off.starts_at}
          style={{ maxWidth: 200 }}
          onChange={(e) => setOff({ ...off, starts_at: e.target.value })}
        />
        <input
          type="datetime-local"
          value={off.ends_at}
          style={{ maxWidth: 200 }}
          onChange={(e) => setOff({ ...off, ends_at: e.target.value })}
        />
        <input
          placeholder="Reason"
          value={off.reason}
          style={{ maxWidth: 160 }}
          onChange={(e) => setOff({ ...off, reason: e.target.value })}
        />
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={!off.starts_at || !off.ends_at || addOff.isPending}
          onClick={() => addOff.mutate()}
        >
          Add
        </button>
      </div>
      <ErrorText error={addOff.error} />
    </div>
  );

  function setRule(weekday: number, start: string, end: string) {
    const others = rules.filter((r) => r.weekday !== weekday);
    setRules([...others, { weekday, start_time: start, end_time: end }]);
  }
}
