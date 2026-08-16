import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, formatDay, formatTime, toISODate } from "../../api";
import type { Booking } from "../../api";
import { Empty, ErrorText, Loading } from "../../components/ui";

const STATUS_TONE: Record<string, string> = {
  ASSIGNED: "pill pill-gold",
  EN_ROUTE: "pill pill-dark",
  COMPLETED: "pill pill-ok",
  CANCELLED: "pill pill-danger",
  NO_SHOW: "pill pill-danger",
};

export default function AdminBookings() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"week" | "list">("week");
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [statusFilter, setStatusFilter] = useState("");

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
        </div>
      </div>

      {view === "week" ? (
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
