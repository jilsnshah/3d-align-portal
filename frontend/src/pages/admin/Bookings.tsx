import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import RouteMap from "../../components/RouteMap";
import RouteSheet from "../../components/RouteSheet";

import { api, formatDay, formatTime, toISODate } from "../../api";
import AttentionQueue from "../../components/AttentionQueue";
import LeaveQueue from "../../components/LeaveQueue";
import type { Booking } from "../../api";
import { Empty, ErrorText, Field, Loading } from "../../components/ui";

const STATUS_TONE: Record<string, string> = {
  ASSIGNED: "pill pill-gold",
  EN_ROUTE: "pill pill-dark",
  COMPLETED: "pill pill-ok",
  CANCELLED: "pill pill-danger",
  NO_SHOW: "pill pill-danger",
};

export default function AdminBookings() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"week" | "list" | "routes" | "requests" | "leave">("week");
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [statusFilter, setStatusFilter] = useState("");
  const pending = useQuery({ queryKey: ["reassignments"], queryFn: () => api.reassignments(true) });
  const leavePending = useQuery({ queryKey: ["leave-queue"], queryFn: () => api.leaveQueue(true) });

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const technicians = useQuery({ queryKey: ["technicians"], queryFn: api.technicians });
  const bookings = useQuery({
    queryKey: ["bookings", view, toISODate(weekStart), statusFilter],
    queryFn: () =>
      api.bookings(
        view === "week"
          ? { from: toISODate(weekStart), to: toISODate(weekEnd) }
          : { status: statusFilter || undefined },
      ),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["bookings"] });
    void queryClient.invalidateQueries({ queryKey: ["technicians"] });
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Bookings</h1>
          <p className="sub">Scan visits across every technician.</p>
        </div>
        <div className="row">
          <button
            type="button"
            className={view === "week" ? "btn-dark btn-sm" : "btn-ghost btn-sm"}
            onClick={() => setView("week")}
          >
            Week
          </button>
          <button
            type="button"
            className={view === "list" ? "btn-dark btn-sm" : "btn-ghost btn-sm"}
            onClick={() => setView("list")}
          >
            List
          </button>
          <button
            type="button"
            className={view === "routes" ? "btn-dark btn-sm" : "btn-ghost btn-sm"}
            onClick={() => setView("routes")}
          >
            Routes
          </button>
          <button
            type="button"
            className={view === "leave" ? "btn-dark btn-sm" : "btn-ghost btn-sm"}
            onClick={() => setView("leave")}
          >
            Leave
            {(leavePending.data?.length ?? 0) > 0 && (
              <span className="bell-count" style={{ marginLeft: 6 }}>
                {leavePending.data?.length}
              </span>
            )}
          </button>
          <button
            type="button"
            className={view === "requests" ? "btn-dark btn-sm" : "btn-ghost btn-sm"}
            onClick={() => setView("requests")}
          >
            Requests
            {(pending.data?.length ?? 0) > 0 && (
              <span className="bell-count" style={{ marginLeft: 6 }}>
                {pending.data?.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* A stranded visit is somebody expecting a technician who is not coming,
          so it sits above whatever view is open rather than behind a tab. */}
      <div style={{ marginBottom: 16 }}>
        <AttentionQueue />
      </div>

      {view === "leave" ? (
        <LeaveQueue />
      ) : view === "requests" ? (
        <RequestsView />
      ) : view === "routes" ? (
        <RoutesView />
      ) : view === "week" ? (
        <>
          <div className="row-between" style={{ marginBottom: 14 }}>
            <button type="button" className="btn-ghost btn-sm" onClick={() => shift(-7)}>
              ‹ Previous
            </button>
            <strong>
              {weekStart.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} —{" "}
              {weekEnd.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
            </strong>
            <button type="button" className="btn-ghost btn-sm" onClick={() => shift(7)}>
              Next ›
            </button>
          </div>

          {bookings.isLoading || technicians.isLoading ? (
            <Loading what="bookings" />
          ) : (
            <div className="week">
              {technicians.data?.map((tech) => {
                const mine = (bookings.data ?? []).filter(
                  (b) => b.technician_name === tech.full_name,
                );
                return (
                  <div className="week-col" key={tech.id}>
                    <h5>
                      {tech.full_name}
                      {!tech.is_active && " · inactive"}
                    </h5>
                    {mine.length === 0 ? (
                      <p className="dim">Nothing this week.</p>
                    ) : (
                      mine.map((b) => (
                        <div
                          key={b.id}
                          className={`week-slot${b.status === "CANCELLED" || b.status === "NO_SHOW" ? " cancelled" : b.status === "COMPLETED" ? " done" : ""}`}
                        >
                          <b>
                            {formatDay(b.starts_at)} {formatTime(b.starts_at)}
                          </b>
                          {b.order.patient_name}
                          <div className="dim">{b.order.clinic_name || b.order.doctor_name}</div>
                        </div>
                      ))
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 14 }}>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{ maxWidth: 220 }}
            >
              <option value="">Every status</option>
              {Object.keys(STATUS_TONE).map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ").toLowerCase()}
                </option>
              ))}
            </select>
          </div>

          {bookings.isLoading ? (
            <Loading what="bookings" />
          ) : bookings.data?.length === 0 ? (
            <Empty>No bookings match.</Empty>
          ) : (
            <div className="stack">
              {bookings.data?.map((booking) => (
                <BookingRow
                  key={booking.id}
                  booking={booking}
                  technicians={technicians.data ?? []}
                  onDone={invalidate}
                />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );

  function shift(days: number) {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + days);
    setWeekStart(next);
  }
}

function BookingRow({
  booking,
  technicians,
  onDone,
}: {
  booking: Booking;
  technicians: { id: string; full_name: string }[];
  onDone: () => void;
}) {
  const [target, setTarget] = useState("");
  const reassign = useMutation({
    mutationFn: (force: boolean) => api.reassignBooking(booking.id, target, force),
    onSuccess: onDone,
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelAppointment(booking.id, "Cancelled by the lab."),
    onSuccess: onDone,
  });

  const live = booking.status === "ASSIGNED" || booking.status === "EN_ROUTE";
  const conflict = reassign.error instanceof Error && reassign.error.message.includes("not free");

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>
            {formatDay(booking.starts_at)} · {formatTime(booking.starts_at)}
          </h3>
          <p className="dim">
            {booking.order.order_number} · {booking.order.patient_name} ·{" "}
            {booking.order.clinic_name || booking.order.doctor_name}
          </p>
        </div>
        <span className={STATUS_TONE[booking.status]}>{booking.status_label}</span>
      </div>

      <dl className="kv">
        <dt>Technician</dt>
        <dd>{booking.technician_name}</dd>
        <dt>Where</dt>
        <dd>{booking.location || "—"}</dd>
        <dt>Contact</dt>
        <dd>
          {booking.contact_name || "—"}
          {booking.contact_phone ? ` · ${booking.contact_phone}` : ""}
        </dd>
        {booking.access_notes && (
          <>
            <dt>Access</dt>
            <dd>{booking.access_notes}</dd>
          </>
        )}
        <dt>Assigned</dt>
        <dd className="dim">{booking.assignment_reason}</dd>
        {booking.cancel_reason && (
          <>
            <dt>Cancelled</dt>
            <dd>{booking.cancel_reason}</dd>
          </>
        )}
        {booking.outcome_notes && (
          <>
            <dt>Outcome</dt>
            <dd>{booking.outcome_notes}</dd>
          </>
        )}
      </dl>

      {live && (
        <div className="stack-sm" style={{ marginTop: 14 }}>
          <div className="row">
            <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ maxWidth: 220 }}>
              <option value="">Reassign to…</option>
              {technicians
                .filter((t) => t.full_name !== booking.technician_name)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.full_name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={!target || reassign.isPending}
              onClick={() => reassign.mutate(false)}
            >
              Reassign
            </button>
            {conflict && (
              <button
                type="button"
                className="btn-danger btn-sm"
                onClick={() => reassign.mutate(true)}
              >
                Assign anyway
              </button>
            )}
            <button
              type="button"
              className="btn-link"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel visit
            </button>
          </div>
          <ErrorText error={reassign.error ?? cancel.error} />
        </div>
      )}
    </div>
  );
}

function startOfWeek(d: Date): Date {
  const copy = new Date(d);
  const offset = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - offset);
  copy.setHours(0, 0, 0, 0);
  return copy;
}


/** One technician's day, re-costed against traffic and drawn on a map. */
function RoutesView() {
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
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
      <div className="card row" style={{ gap: 14 }}>
        <Field label="Technician">
          <select value={chosen} onChange={(e) => setTechnicianId(e.target.value)}>
            {technicians.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.full_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Day">
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
      </div>

      {route.isLoading && <Loading what="the route" />}
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
    onSuccess: () => {
      setConflict({});
      setForced({});
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
    <div className="stack">
      <ErrorText error={resolve.error} />
      {requests.data.map((r) => (
        <div className="card stack-sm" key={r.id}>
          <div className="row-between">
            <div>
              <b>{r.requested_by}</b>{" "}
              <span className="dim">wants to hand over {formatDay(r.starts_at)}</span>{" "}
              <b className="num">{formatTime(r.starts_at)}</b>
            </div>
            <span className="pill pill-warn">Awaiting the lab</span>
          </div>
          <div className="dim">
            {r.order_reference} · {r.patient_name} · {r.clinic_name}
          </div>
          <p>“{r.reason}”</p>

          <input
            placeholder="Note (optional)"
            value={note[r.id] ?? ""}
            onChange={(e) => setNote({ ...note, [r.id]: e.target.value })}
          />

          {conflict[r.id] && (
            <div className="banner banner-warn">
              {conflict[r.id]} Assigning anyway will put them on a visit they cannot
              reach on time.
            </div>
          )}

          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={resolve.isPending}
              onClick={() =>
                resolve.mutate({ id: r.id, body: { action: "ANY", note: note[r.id] ?? "" } })
              }
            >
              Give it to whoever can reach it
            </button>

            <select
              value={pick[r.id] ?? ""}
              style={{ width: "auto" }}
              onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}
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
              className="btn-danger"
              disabled={resolve.isPending}
              onClick={() =>
                resolve.mutate({ id: r.id, body: { action: "DECLINE", note: note[r.id] ?? "" } })
              }
            >
              Decline
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
