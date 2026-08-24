/* A technician's day. Used standing in a car park, so: big times, tap-to-call,
   maps link, and only the jobs they were actually sent to. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api, formatDay, formatTime } from "../../api";
import LeavePanel from "../../components/LeavePanel";
import type { Job } from "../../api";
import RouteSheet from "../../components/RouteSheet";
import { Empty, ErrorText, Loading } from "../../components/ui";

const TABS = [
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Upcoming" },
  // Not "past": a cancelled or completed visit can still be in the future.
  { key: "past", label: "Closed" },
] as const;

type Scope = (typeof TABS)[number]["key"];

export default function TechSchedule() {
  const [scope, setScope] = useState<Scope | null>(null);
  const queryClient = useQueryClient();
  const todayISO = new Date().toISOString().slice(0, 10);
  const [routeDay, setRouteDay] = useState(todayISO);
  // Recomputed against current traffic, so a route that no longer holds shows
  // up before the technician sets off rather than on the road.
  const myRoute = useQuery({
    queryKey: ["my-route", routeDay],
    queryFn: () => api.myRoute(routeDay),
    refetchInterval: 10 * 60 * 1000,
  });

  // All three at once so the tabs can carry counts — an empty day should read
  // as empty, not as a page that failed to load.
  const today = useQuery({ queryKey: ["schedule", "today"], queryFn: () => api.mySchedule("today") });
  const upcoming = useQuery({ queryKey: ["schedule", "upcoming"], queryFn: () => api.mySchedule("upcoming") });
  const closed = useQuery({ queryKey: ["schedule", "past"], queryFn: () => api.mySchedule("past") });

  const counts: Record<Scope, number> = {
    today: today.data?.length ?? 0,
    upcoming: upcoming.data?.length ?? 0,
    past: closed.data?.length ?? 0,
  };
  const loading = today.isLoading || upcoming.isLoading || closed.isLoading;

  // Open on a tab that has something rather than a blank Today.
  const active: Scope = scope ?? (counts.today > 0 ? "today" : counts.upcoming > 0 ? "upcoming" : "today");
  const jobs = { today, upcoming, past: closed }[active];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["schedule"] });
    void queryClient.invalidateQueries({ queryKey: ["unread"] });
  };

  return (
    <main className="page page-narrow">
      <div className="page-head">
        <div>
          <h1>My schedule</h1>
          <p className="sub">
            {loading
              ? "Scan visits assigned to you."
              : counts.today > 0
                ? `${counts.today} visit(s) today, ${counts.upcoming} coming up.`
                : counts.upcoming > 0
                  ? `Nothing today. ${counts.upcoming} visit(s) coming up.`
                  : "No scan visits assigned to you yet."}
          </p>
        </div>
      </div>

      <div style={{ marginBottom: 18 }}>
        <LeavePanel />
      </div>

      <div className="steps" style={{ marginBottom: 18 }}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`step${active === tab.key ? " on" : counts[tab.key] > 0 ? " done" : ""}`}
            style={{ cursor: "pointer" }}
            onClick={() => setScope(tab.key)}
          >
            {tab.label} · {counts[tab.key]}
          </button>
        ))}
      </div>

      <details className="fold" style={{ marginBottom: 18 }} open={myRoute.data?.at_risk}>
        <summary>
          <span className="fold-chevron">▶</span>
          <h4>My run</h4>
          <span className="fold-sub">
            {myRoute.data && myRoute.data.stops.length > 0
              ? `${myRoute.data.total_km.toFixed(0)} km · ${Math.round(
                  myRoute.data.drive_minutes,
                )} min driving${myRoute.data.at_risk ? " · running late" : ""}`
              : "nothing scheduled"}
          </span>
        </summary>
        <div className="fold-body stack-sm">
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => setRouteDay(shiftDay(routeDay, -1))}
            >
              ‹ Previous
            </button>
            <input
              type="date"
              value={routeDay}
              style={{ width: "auto" }}
              onChange={(e) => setRouteDay(e.target.value || todayISO)}
            />
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => setRouteDay(shiftDay(routeDay, 1))}
            >
              Next ›
            </button>
            {routeDay !== todayISO && (
              <button type="button" className="btn-link" onClick={() => setRouteDay(todayISO)}>
                Today
              </button>
            )}
          </div>

          {myRoute.isLoading ? (
            <Loading what="route" />
          ) : (
            <>
              <RouteSheet route={myRoute.data!} navigable />
              {myRoute.data?.maps_url && (
                <a
                  className="btn-primary"
                  href={myRoute.data.maps_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: "inline-block", textDecoration: "none", padding: "10px 16px" }}
                >
                  Navigate the whole day ↗
                </a>
              )}
            </>
          )}
        </div>
      </details>

      {jobs.isLoading ? (
        <Loading what="schedule" />
      ) : jobs.data?.length === 0 ? (
        <Empty>
          {active === "today"
            ? counts.upcoming > 0
              ? "Nothing scheduled today — check Upcoming."
              : "Nothing scheduled today."
            : active === "upcoming"
              ? "No upcoming visits."
              : "No closed visits yet."}
        </Empty>
      ) : (
        <div className="stack">
          {jobs.data?.map((job) => (
            <JobCard key={job.id} job={job} onDone={invalidate} />
          ))}
        </div>
      )}
    </main>
  );
}

function JobCard({ job, onDone }: { job: Job; onDone: () => void }) {
  const [noShowNote, setNoShowNote] = useState("");
  const [showNoShow, setShowNoShow] = useState(false);
  const [handoverReason, setHandoverReason] = useState("");
  const [showHandover, setShowHandover] = useState(false);
  const [asked, setAsked] = useState(false);

  const enRoute = useMutation({ mutationFn: () => api.markEnRoute(job.id), onSuccess: onDone });
  const noShow = useMutation({
    mutationFn: () => api.markNoShow(job.id, noShowNote),
    onSuccess: onDone,
  });
  // The lab decides who picks it up; this only puts the ask in their queue.
  const handover = useMutation({
    mutationFn: () => api.requestReassignment(job.id, handoverReason),
    onSuccess: () => {
      setAsked(true);
      setShowHandover(false);
      onDone();
    },
  });

  const live = job.status === "ASSIGNED" || job.status === "EN_ROUTE";
  const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(job.location)}`;

  return (
    <div className={`job${live ? "" : " done"}`}>
      <div className="row-between">
        <span className="when">{formatTime(job.starts_at)}</span>
        <span className="row" style={{ gap: 6 }}>
          {job.is_day_visit && <span className="pill pill-dark">Full day</span>}
          <span className={live ? "pill pill-gold" : "pill"}>{job.status_label}</span>
        </span>
      </div>
      <div className="dim">{formatDay(job.starts_at)}</div>

      <div className="who">
        {job.order.clinic_name || job.order.doctor_name}
        <span className="dim"> · {job.order.patient_name}</span>
      </div>
      {job.location && (
        <a className="where" href={mapsUrl} target="_blank" rel="noreferrer">
          {job.location} ↗
        </a>
      )}
      {job.contact_phone && (
        <a className="where" href={`tel:${job.contact_phone}`}>
          {job.contact_name || "Contact"} · {job.contact_phone}
        </a>
      )}
      {job.access_notes && <p className="dim">{job.access_notes}</p>}
      <p className="dim">
        {job.order.order_number} · {job.order.arch === "BOTH" ? "Both arches" : job.order.arch}
      </p>
      {job.outcome_notes && <p className="dim">Outcome: {job.outcome_notes}</p>}

      {live && (
        <>
          <ErrorText error={enRoute.error ?? noShow.error} />
          <div className="row">
            {job.status === "ASSIGNED" && (
              <button
                type="button"
                className="btn-primary"
                disabled={enRoute.isPending}
                onClick={() => enRoute.mutate()}
              >
                On my way
              </button>
            )}
            <Link to={`/tech/jobs/${job.order.id}`}>
              <button type="button" className="btn-dark">
                Open case &amp; upload
              </button>
            </Link>
            <button type="button" className="btn-link" onClick={() => setShowNoShow((v) => !v)}>
              Could not scan
            </button>
            <button
              type="button"
              className="btn-link"
              disabled={asked}
              onClick={() => setShowHandover((v) => !v)}
            >
              {asked ? "Handover requested" : "Ask lab to reassign"}
            </button>
          </div>

          {showHandover && (
            <div className="stack-sm">
              <ErrorText error={handover.error} />
              <input
                placeholder="Why can you not take this visit?"
                value={handoverReason}
                onChange={(e) => setHandoverReason(e.target.value)}
              />
              <div className="row">
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={handoverReason.trim().length < 3 || handover.isPending}
                  onClick={() => handover.mutate()}
                >
                  Send request to the lab
                </button>
                <button type="button" className="btn-link" onClick={() => setShowHandover(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {showNoShow && (
            <div className="stack-sm">
              <input
                placeholder="What happened?"
                value={noShowNote}
                onChange={(e) => setNoShowNote(e.target.value)}
              />
              <div>
                <button
                  type="button"
                  className="btn-danger"
                  disabled={!noShowNote.trim() || noShow.isPending}
                  onClick={() => noShow.mutate()}
                >
                  Report no-show
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}


/** Steps a yyyy-mm-dd string without dragging in a date library. */
function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
