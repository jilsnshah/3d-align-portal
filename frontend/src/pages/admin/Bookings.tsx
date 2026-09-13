/* Scan visits across every technician.
 *
 * The week was a column per technician with the visits stacked in it, so
 * seeing what Tuesday looked like meant reading every column, and changing a
 * visit meant switching to a list of cards. It is a board now: technicians
 * down the side, the days across, today lit, every visit a chip in its cell,
 * and a chip opens a panel to reassign or cancel that visit. The list, the
 * routes, handover requests and leave sit beside it as views of the same
 * diary, in one strip that counts what is waiting on the lab.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api, formatDay, formatTime, toISODate } from "../../api";
import type { Booking, Technician } from "../../api";
import AttentionQueue from "../../components/AttentionQueue";
import Avatar from "../../components/Avatar";
import Drawer from "../../components/Drawer";
import { useToast } from "../../components/Toast";
import LeaveQueue from "../../components/LeaveQueue";
import RouteMap from "../../components/RouteMap";
import RouteSheet from "../../components/RouteSheet";
import { ConfirmButton, Empty, ErrorText, Loading } from "../../components/ui";

type View = "week" | "list" | "routes" | "requests" | "leave";

const STATUS_TONE: Record<string, string> = {
  ASSIGNED: "pill pill-gold",
  EN_ROUTE: "pill pill-dark",
  COMPLETED: "pill pill-ok",
  CANCELLED: "pill pill-danger",
  NO_SHOW: "pill pill-danger",
};

const STATUS_NAME: Record<string, string> = {
  ASSIGNED: "Assigned",
  EN_ROUTE: "En route",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "No-show",
};

/** The calendar day a moment falls on, where the lab is — not in UTC, which
    would put a nine o'clock visit on the day before for half of India's
    mornings. */
function localDay(value: Date | string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfWeek(d: Date): Date {
  const copy = new Date(d);
  const offset = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - offset);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function weekLabel(start: Date): string {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const from = start.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const to = end.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  return `${from} – ${to}`;
}

const VIEWS: { key: View; label: string }[] = [
  { key: "week", label: "Week" },
  { key: "list", label: "List" },
  { key: "routes", label: "Routes" },
  { key: "requests", label: "Requests" },
  { key: "leave", label: "Leave" },
];

export default function AdminBookings() {
  const [view, setView] = useState<View>("week");
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [statusFilter, setStatusFilter] = useState("");
  const [techFilter, setTechFilter] = useState("");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const requests = useQuery({ queryKey: ["reassignments"], queryFn: () => api.reassignments(true) });
  const leave = useQuery({ queryKey: ["leave-queue"], queryFn: () => api.leaveQueue(true) });
  const technicians = useQuery({ queryKey: ["technicians"], queryFn: api.technicians });

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const week = useQuery({
    queryKey: ["bookings", "week", toISODate(weekStart)],
    queryFn: () => api.bookings({ from: toISODate(weekStart), to: toISODate(weekEnd) }),
  });
  const list = useQuery({
    queryKey: ["bookings", "list", statusFilter, techFilter],
    queryFn: () => api.bookings({ status: statusFilter || undefined, technician_id: techFilter || undefined }),
    enabled: view === "list",
  });

  const weekRows = useMemo(() => week.data ?? [], [week.data]);
  const live = weekRows.filter((b) => b.status !== "CANCELLED");
  const thisWeek = startOfWeek(new Date()).getTime() === weekStart.getTime();
  const todayCount = live.filter((b) => localDay(b.starts_at) === localDay(new Date())).length;
  const nRequests = requests.data?.length ?? 0;
  const nLeave = leave.data?.length ?? 0;

  const q = search.trim().toLowerCase();
  const listRows = useMemo(
    () =>
      (list.data ?? []).filter(
        (b) =>
          !q ||
          [b.order.patient_name, b.order.order_number, b.order.clinic_name, b.order.doctor_name, b.location].some((v) =>
            (v ?? "").toLowerCase().includes(q),
          ),
      ),
    [list.data, q],
  );

  const opened = openId ? [...weekRows, ...(list.data ?? [])].find((b) => b.id === openId) ?? null : null;

  function shift(days: number) {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + days);
    setWeekStart(next);
  }

  return (
    <main className="page page-wide bk">
      <header className="masthead">
        <div className="masthead-say">
          <span className="masthead-eyebrow">3D Align lab</span>
          <h1>Bookings</h1>
          <p className="masthead-sum">
            <b>{week.isLoading ? "…" : live.length}</b> {live.length === 1 ? "visit" : "visits"}{" "}
            {thisWeek ? "this week" : `in the week of ${weekStart.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}
            {thisWeek && (
              <>
                {" · "}
                <b>{todayCount}</b> today
              </>
            )}
            {nRequests > 0 && (
              <>
                {" · "}
                <b className="lit">{nRequests}</b> handover {nRequests === 1 ? "request" : "requests"}
              </>
            )}
            {nLeave > 0 && (
              <>
                {" · "}
                <b className="lit">{nLeave}</b> leave {nLeave === 1 ? "request" : "requests"}
              </>
            )}
          </p>
        </div>
        <div className="masthead-do">
          <Link to="/staff/technicians">
            <button type="button" className="btn-ghost">
              Technicians
            </button>
          </Link>
        </div>
      </header>

      {/* A stranded visit is somebody expecting a technician who is not coming,
          so it sits above whatever view is open rather than behind a tab. */}
      <div className="bk-alert">
        <AttentionQueue />
      </div>

      <section className="console" aria-label="View">
        <div className="cut" role="tablist" aria-label="View">
          {VIEWS.map((v) => {
            const n = v.key === "requests" ? nRequests : v.key === "leave" ? nLeave : null;
            return (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={view === v.key}
                className={view === v.key ? "on" : ""}
                onClick={() => setView(v.key)}
              >
                {n !== null && n > 0 && <span className="cut-dot" aria-hidden="true" />}
                {v.label}
                {n !== null && <span className="cut-n">{n}</span>}
              </button>
            );
          })}
        </div>

        {view === "week" && (
          <>
            <span className="console-rule" aria-hidden="true" />
            <div className="bk-weeknav">
              <button type="button" className="sort" onClick={() => shift(-7)} aria-label="Previous week">
                ‹
              </button>
              <button
                type="button"
                className="sort"
                disabled={thisWeek}
                onClick={() => setWeekStart(startOfWeek(new Date()))}
              >
                This week
              </button>
              <button type="button" className="sort" onClick={() => shift(7)} aria-label="Next week">
                ›
              </button>
            </div>
            <span className="tally-say">{weekLabel(weekStart)}</span>
          </>
        )}

        {view === "list" && (
          <>
            <span className="console-rule" aria-hidden="true" />
            <label className="pick">
              <span>Status</span>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">Any status</option>
                {Object.entries(STATUS_NAME).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="pick">
              <span>Technician</span>
              <select value={techFilter} onChange={(e) => setTechFilter(e.target.value)}>
                <option value="">Every technician</option>
                {(technicians.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.full_name}
                  </option>
                ))}
              </select>
            </label>
            <span className="search bk-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" strokeLinecap="round" />
              </svg>
              <input
                placeholder="Patient, case or clinic"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search visits"
              />
            </span>
            <span className="tally-say">
              {listRows.length} {listRows.length === 1 ? "visit" : "visits"}
            </span>
          </>
        )}
      </section>

      {view === "leave" ? (
        <LeaveQueue />
      ) : view === "requests" ? (
        <RequestsView />
      ) : view === "routes" ? (
        <RoutesView />
      ) : view === "week" ? (
        week.isLoading || technicians.isLoading ? (
          <Loading what="bookings" />
        ) : (
          <WeekBoard start={weekStart} bookings={weekRows} technicians={technicians.data ?? []} onOpen={setOpenId} />
        )
      ) : list.isLoading ? (
        <Loading what="bookings" />
      ) : listRows.length === 0 ? (
        <Empty>No visits match.</Empty>
      ) : (
        <BookingTable rows={listRows} onOpen={setOpenId} />
      )}

      {opened && (
        <BookingPanel booking={opened} technicians={technicians.data ?? []} onClose={() => setOpenId(null)} />
      )}
    </main>
  );
}

/** The week as a board: who is where, on which day. */
function WeekBoard({
  start,
  bookings,
  technicians,
  onOpen,
}: {
  start: Date;
  bookings: Booking[];
  technicians: Technician[];
  onOpen: (id: string) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
  const today = localDay(new Date());
  // Everyone active, and anyone inactive who still has a visit this week —
  // a visit left on a closed account is exactly what the board must show.
  const people = technicians.filter(
    (t) => t.is_active || bookings.some((b) => b.technician_name === t.full_name),
  );

  if (people.length === 0) {
    return (
      <Empty>
        No technicians yet. <Link to="/staff/technicians">Add one</Link> to start taking bookings.
      </Empty>
    );
  }

  return (
    <div className="bk-board-wrap">
      <div className="bk-board">
        <div className="bk-corner">Technician</div>
        {days.map((d) => {
          const key = localDay(d);
          const n = bookings.filter((b) => localDay(b.starts_at) === key && b.status !== "CANCELLED").length;
          return (
            <div key={key} className={`bk-day${key === today ? " today" : ""}`}>
              <b>{d.toLocaleDateString("en-IN", { weekday: "short" })}</b>
              <span>{d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
              <small>{n === 0 ? "No visits" : `${n} ${n === 1 ? "visit" : "visits"}`}</small>
            </div>
          );
        })}

        {people.map((t) => {
          const mine = bookings.filter((b) => b.technician_name === t.full_name);
          const live = mine.filter((b) => b.status !== "CANCELLED").length;
          return (
            <Fragment key={t.id}>
              <div className="bk-tech">
                <Avatar name={t.full_name} />
                <span>
                  <b>{t.full_name}</b>
                  <small>{t.is_active ? `${live} this week · up to ${t.max_daily_jobs} a day` : "Inactive"}</small>
                </span>
              </div>
              {days.map((d) => {
                const key = localDay(d);
                const cell = mine
                  .filter((b) => localDay(b.starts_at) === key)
                  .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
                return (
                  <div key={key} className={`bk-cell${key === today ? " today" : ""}`}>
                    {cell.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        className={`bk-chip ${b.status.toLowerCase()}${b.needs_attention ? " alert" : ""}`}
                        onClick={() => onOpen(b.id)}
                        title={`${formatTime(b.starts_at)} · ${b.order.patient_name} · ${b.status_label}`}
                      >
                        <b>{formatTime(b.starts_at)}</b>
                        <span>{b.order.patient_name}</span>
                        <small>{b.order.clinic_name || b.order.doctor_name}</small>
                      </button>
                    ))}
                  </div>
                );
              })}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function BookingTable({ rows, onOpen }: { rows: Booking[]; onOpen: (id: string) => void }) {
  return (
    <div className="case-table bk-table">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Patient</th>
            <th>Clinic</th>
            <th>Technician</th>
            <th>Where</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const over = b.status === "CANCELLED" || b.status === "COMPLETED" || b.status === "NO_SHOW";
            return (
              <tr
                key={b.id}
                className={`clickable${b.needs_attention ? " wants" : ""}${over ? " done" : ""}`}
                onClick={() => onOpen(b.id)}
              >
                <td className="col-when">
                  {formatDay(b.starts_at)}
                  <small>{formatTime(b.starts_at)}</small>
                </td>
                <td>
                  <span className="cell-title">{b.order.patient_name}</span>
                  <span className="pt-meta mono">{b.order.order_number}</span>
                </td>
                <td>{b.order.clinic_name || b.order.doctor_name}</td>
                <td>{b.technician_name}</td>
                <td className="bk-where" title={b.location}>
                  {b.location || <span className="dim">—</span>}
                </td>
                <td>
                  <span className={STATUS_TONE[b.status] ?? "pill"}>{b.status_label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One visit, opened: where and with whom, and — while it is still ahead — the
    two things the lab can do about it. */
function BookingPanel({
  booking: b,
  technicians,
  onClose,
}: {
  booking: Booking;
  technicians: Technician[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [target, setTarget] = useState("");
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ["bookings"] });
    void queryClient.invalidateQueries({ queryKey: ["technicians"] });
  };
  const reassign = useMutation({
    mutationFn: (force: boolean) => api.reassignBooking(b.id, target, force),
    onSuccess: (moved) => {
      setTarget("");
      done();
      toast({ title: "Visit reassigned", body: `${moved.technician_name} now attends ${b.order.patient_name}.` });
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelAppointment(b.id, "Cancelled by the lab."),
    onSuccess: () => {
      done();
      toast({ title: "Visit cancelled", tone: "warn", body: "The clinic can book another time." });
    },
  });

  const live = b.status === "ASSIGNED" || b.status === "EN_ROUTE";
  const conflict = reassign.error instanceof Error && reassign.error.message.includes("not free");

  return (
    <Drawer
      eyebrow="Scan visit"
      title={b.order.patient_name}
      sub={`${formatDay(b.starts_at)} · ${formatTime(b.starts_at)} – ${formatTime(b.ends_at)}`}
      onClose={onClose}
      foot={
        live ? (
          <>
            <div className="dw-actions start">
              <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Reassign to">
                <option value="">Reassign to…</option>
                {technicians
                  .filter((t) => t.is_active && t.full_name !== b.technician_name)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.full_name}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className={conflict ? "btn-danger" : "btn-dark"}
                disabled={!target || reassign.isPending}
                onClick={() => reassign.mutate(conflict)}
              >
                {conflict ? "Assign anyway" : "Reassign"}
              </button>
              <ConfirmButton
                label="Cancel visit"
                confirmLabel="Cancel this visit"
                className="btn-ghost"
                disabled={cancel.isPending}
                onConfirm={() => cancel.mutate()}
              />
            </div>
            <ErrorText error={reassign.error ?? cancel.error} />
          </>
        ) : undefined
      }
    >
      <section className="dw-section">
        <h3>Status</h3>
        <p className="dw-line">
          <span className={STATUS_TONE[b.status] ?? "pill"}>{b.status_label}</span>
          {b.assignment_reason && <span className="dim">{b.assignment_reason}</span>}
        </p>
        {b.needs_attention && <p className="dw-note bad">{b.attention_reason || "Nobody could cover this visit."}</p>}
        {b.cancel_reason && <p className="dw-note">Cancelled: {b.cancel_reason}</p>}
        {b.outcome_notes && <p className="dw-note">Outcome: {b.outcome_notes}</p>}
      </section>

      <section className="dw-section">
        <h3>The visit</h3>
        <dl className="dw-dl">
          <div>
            <dt>Case</dt>
            <dd>
              <Link to={`/staff/orders/${b.order.id}`} onClick={onClose} className="mono">
                {b.order.order_number}
              </Link>
            </dd>
          </div>
          <div>
            <dt>Clinic</dt>
            <dd>{b.order.clinic_name || "—"}</dd>
          </div>
          <div>
            <dt>Doctor</dt>
            <dd>{b.order.doctor_name}</dd>
          </div>
          <div>
            <dt>Technician</dt>
            <dd>
              {b.technician_name}
              {b.technician_phone && <span className="dim"> · {b.technician_phone}</span>}
            </dd>
          </div>
          <div className="wide">
            <dt>Where</dt>
            <dd>{b.location || "—"}</dd>
          </div>
          <div>
            <dt>Contact</dt>
            <dd>
              {b.contact_name || "—"}
              {b.contact_phone ? ` · ${b.contact_phone}` : ""}
            </dd>
          </div>
          {b.access_notes && (
            <div className="wide">
              <dt>Access</dt>
              <dd>{b.access_notes}</dd>
            </div>
          )}
        </dl>
      </section>
    </Drawer>
  );
}

/** One technician's day, re-costed against traffic and drawn on a map. */
function RoutesView() {
  const [day, setDay] = useState(() => localDay(new Date()));
  const [technicianId, setTechnicianId] = useState("");

  const technicians = useQuery({ queryKey: ["technicians"], queryFn: api.technicians });
  const chosen = technicianId || technicians.data?.[0]?.id || "";

  const route = useQuery({
    queryKey: ["route", chosen, day],
    queryFn: () => api.technicianRoute(chosen, day),
    enabled: Boolean(chosen),
  });

  return (
    <div className="stack">
      <section className="console" aria-label="Route">
        <label className="pick">
          <span>Technician</span>
          <select value={chosen} onChange={(e) => setTechnicianId(e.target.value)}>
            {technicians.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.full_name}
              </option>
            ))}
          </select>
        </label>
        <label className="pick">
          <span>Day</span>
          <input className="bk-date" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
      </section>

      {!chosen && <Empty>No technicians yet.</Empty>}
      {route.isLoading && chosen && <Loading what="the route" />}
      {route.data && (
        <div className="split">
          <div className="card">
            <RouteMap route={route.data} />
          </div>
          <div className="card">
            <RouteSheet route={route.data} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Handover requests from technicians.

    The lab has three ways out, and none of them is new machinery: name a
    technician, let the scheduler choose whoever can actually reach it, or
    decline and leave the visit where it is. */
function RequestsView() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const requests = useQuery({ queryKey: ["reassignments"], queryFn: () => api.reassignments(true) });
  const technicians = useQuery({ queryKey: ["technicians"], queryFn: api.technicians });
  const [note, setNote] = useState<Record<string, string>>({});
  const [pick, setPick] = useState<Record<string, string>>({});
  // A named technician is offered without force first. Overriding their
  // availability is a decision the lab should make knowingly, not a default —
  // otherwise "assign to them" quietly contradicts "nobody can reach it".
  const [forced, setForced] = useState<Record<string, boolean>>({});
  const [conflict, setConflict] = useState<Record<string, string>>({});

  const resolve = useMutation({
    mutationFn: (args: { id: string; body: Parameters<typeof api.resolveReassignment>[1] }) =>
      api.resolveReassignment(args.id, args.body).catch((err) => {
        if (err instanceof Error && err.message.includes("not free")) {
          setConflict((c) => ({ ...c, [args.id]: err.message }));
          setForced((f) => ({ ...f, [args.id]: true }));
        }
        throw err;
      }),
    onSuccess: (_result, args) => {
      setConflict({});
      setForced({});
      toast(
        args.body.action === "DECLINE"
          ? { title: "Handover declined", tone: "warn", body: "The visit stays where it is." }
          : { title: "Visit handed over", body: "The technician has been told." },
      );
      void queryClient.invalidateQueries({ queryKey: ["reassignments"] });
      void queryClient.invalidateQueries({ queryKey: ["bookings"] });
      void queryClient.invalidateQueries({ queryKey: ["route"] });
    },
  });

  if (requests.isLoading) return <Loading what="requests" />;
  if (!requests.data?.length) {
    return <Empty>No technician has asked to hand over a visit.</Empty>;
  }

  return (
    <div className="bk-reqs">
      <ErrorText error={resolve.error} />
      {requests.data.map((r) => (
        <article className="bk-req" key={r.id}>
          <header className="bk-req-head">
            <Avatar name={r.requested_by} />
            <div>
              <b>{r.requested_by}</b>
              <span>
                wants to hand over {formatDay(r.starts_at)} at <b className="num">{formatTime(r.starts_at)}</b>
              </span>
            </div>
            <span className="pill pill-warn">Awaiting the lab</span>
          </header>
          <p className="bk-req-case">
            <span className="mono">{r.order_reference}</span> · {r.patient_name} · {r.clinic_name}
          </p>
          <blockquote>“{r.reason}”</blockquote>

          <input
            placeholder="Note (optional)"
            value={note[r.id] ?? ""}
            onChange={(e) => setNote({ ...note, [r.id]: e.target.value })}
          />

          {conflict[r.id] && (
            <div className="banner banner-warn">
              {conflict[r.id]} Assigning anyway will put them on a visit they cannot reach on time.
            </div>
          )}

          <div className="bk-req-do">
            <button
              type="button"
              className="btn-primary"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ id: r.id, body: { action: "ANY", note: note[r.id] ?? "" } })}
            >
              Give it to whoever can reach it
            </button>

            <select
              value={pick[r.id] ?? ""}
              onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}
              aria-label="Choose a technician"
            >
              <option value="">Choose a technician…</option>
              {technicians.data
                ?.filter((t) => t.full_name !== r.requested_by)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.full_name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className={forced[r.id] ? "btn-danger" : "btn-ghost"}
              disabled={!pick[r.id] || resolve.isPending}
              onClick={() =>
                resolve.mutate({
                  id: r.id,
                  body: {
                    action: "TECHNICIAN",
                    technician_id: pick[r.id],
                    note: note[r.id] ?? "",
                    force: forced[r.id] ?? false,
                  },
                })
              }
            >
              {forced[r.id] ? "Assign anyway" : "Assign to them"}
            </button>

            <button
              type="button"
              className="btn-link"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ id: r.id, body: { action: "DECLINE", note: note[r.id] ?? "" } })}
            >
              Decline
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
