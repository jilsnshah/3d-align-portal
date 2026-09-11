/* The practices that send the lab work.
 *
 * It was a stack of cards, one per doctor, each with its own reason box and
 * two buttons, behind a single "awaiting verification only" checkbox — fine
 * for three sign-ups, useless for finding a practice among two hundred or
 * seeing which of them is sending the work.
 *
 * Now it is the same list-and-filters shape as the rest of the portal: every
 * doctor in one table with the registry check, how many cases they sent this
 * year and what they owe beside their registration, filters for verification,
 * registry result and council, and a row that opens into a panel to verify or
 * decline them. Verification itself is unchanged — the same call, the same
 * rule that a refusal needs a reason.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api, formatDate, formatMoney, since } from "../../api";
import type { PendingDoctor } from "../../api";
import Avatar from "../../components/Avatar";
import Drawer from "../../components/Drawer";
import { Empty, ErrorText, Loading } from "../../components/ui";
import { everyDoctor } from "../../fetchAll";

type Check = {
  checked?: boolean;
  passed?: boolean;
  name_match_score?: number;
  registry_names?: string[];
  reason?: string;
} | null;

type Registry = "matched" | "unsure" | "unchecked";

function checkOf(d: PendingDoctor): Check {
  return d.registry_check_result as Check;
}

/** What the automatic look-up against the council register made of them. */
function registryOf(d: PendingDoctor): Registry {
  const c = checkOf(d);
  if (!c || !c.checked) return "unchecked";
  return c.passed ? "matched" : "unsure";
}

const REGISTRY: Record<Registry, [string, string]> = {
  matched: ["Name matched", "pill pill-ok"],
  unsure: ["No confident match", "pill pill-warn"],
  unchecked: ["Not checked", "pill"],
};

const STATUS: Record<string, [string, string]> = {
  PENDING: ["Awaiting verification", "pill pill-gold"],
  VERIFIED: ["Verified", "pill pill-ok"],
  REJECTED: ["Declined", "pill pill-danger"],
};

type Cut = "PENDING" | "VERIFIED" | "REJECTED" | "all";

const CUTS: { key: Cut; label: string }[] = [
  { key: "PENDING", label: "Awaiting verification" },
  { key: "VERIFIED", label: "Verified" },
  { key: "REJECTED", label: "Declined" },
  { key: "all", label: "All" },
];

type Sort = "waiting" | "cases" | "owed" | "newest" | "name";

function shortDay(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "2-digit" }) });
}

export default function StaffDoctors() {
  const year = new Date().getFullYear();
  const doctors = useQuery({ queryKey: ["staff-doctors", "every"], queryFn: everyDoctor });
  // Cases per practice this year, as the insights page counts them.
  const stats = useQuery({
    queryKey: ["stats", "doctor-list", year],
    queryFn: () => api.labStats({ view: "year", year }),
  });
  const ledger = useQuery({ queryKey: ["staff-payments", ""], queryFn: () => api.labPayments() });

  const [search, setSearch] = useState("");
  const [cut, setCut] = useState<Cut | null>(null);
  const [registry, setRegistry] = useState<"" | Registry>("");
  const [council, setCouncil] = useState("");
  const [sort, setSort] = useState<Sort>("waiting");
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useMemo(() => doctors.data ?? [], [doctors.data]);
  const casesBy = useMemo(() => new Map((stats.data?.doctors ?? []).map((r) => [r.key, r.orders])), [stats.data]);
  const owesBy = useMemo(
    () => new Map((ledger.data?.owed_by_doctor ?? []).map((r) => [r.doctor_id, Number(r.amount)])),
    [ledger.data],
  );

  const pending = list.filter((d) => d.verification_status === "PENDING").length;
  const verified = list.filter((d) => d.verification_status === "VERIFIED").length;
  const sending = list.filter((d) => (casesBy.get(d.id) ?? 0) > 0).length;
  // Opens on whoever is waiting to be let in, when anybody is.
  const active: Cut = cut ?? (pending > 0 ? "PENDING" : "all");

  const councils = useMemo(
    () => [...new Set(list.map((d) => d.dental_council).filter(Boolean))].sort(),
    [list],
  );

  const q = search.trim().toLowerCase();
  const base = useMemo(
    () =>
      list.filter(
        (d) =>
          (!q ||
            [d.full_name, d.clinic_name, d.email, d.registration_number, d.phone].some((v) =>
              (v ?? "").toLowerCase().includes(q),
            )) &&
          (!registry || registryOf(d) === registry) &&
          (!council || d.dental_council === council),
      ),
    [list, q, registry, council],
  );

  const counts = useMemo(
    () =>
      Object.fromEntries(
        CUTS.map((c) => [c.key, c.key === "all" ? base.length : base.filter((d) => d.verification_status === c.key).length]),
      ) as Record<Cut, number>,
    [base],
  );

  const shown = useMemo(() => {
    const out = base.filter((d) => active === "all" || d.verification_status === active);
    return out.sort((a, b) => {
      if (sort === "name") return a.full_name.localeCompare(b.full_name);
      if (sort === "newest") return b.created_at.localeCompare(a.created_at);
      if (sort === "cases") return (casesBy.get(b.id) ?? 0) - (casesBy.get(a.id) ?? 0);
      if (sort === "owed") return (owesBy.get(b.id) ?? 0) - (owesBy.get(a.id) ?? 0);
      // Waiting: whoever has waited longest to be let in, then everyone else
      // newest first.
      const pa = a.verification_status === "PENDING" ? 0 : 1;
      const pb = b.verification_status === "PENDING" ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return pa === 0 ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at);
    });
  }, [base, active, sort, casesBy, owesBy]);

  const any = cut !== null || Boolean(registry) || Boolean(council);
  function clearFilters() {
    setCut("all");
    setRegistry("");
    setCouncil("");
  }

  const opened = openId ? list.find((d) => d.id === openId) ?? null : null;

  if (doctors.isLoading) return <Loading what="doctors" />;

  return (
    <main className="page page-wide">
      <header className="masthead">
        <div className="masthead-say">
          <span className="masthead-eyebrow">3D Align lab</span>
          <h1>Doctors</h1>
          <p className="masthead-sum">
            <b>{list.length}</b> {list.length === 1 ? "practice" : "practices"}
            {pending > 0 && (
              <>
                {" · "}
                <b className="lit">{pending}</b> awaiting verification
              </>
            )}
            {" · "}
            <b>{verified}</b> verified
            {stats.data && (
              <>
                {" · "}
                <b>{sending}</b> sent work in {year}
              </>
            )}
          </p>
        </div>

        <div className="masthead-do">
          <span className="search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input
              placeholder="Name, clinic, email or registration"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search doctors"
            />
          </span>
        </div>
      </header>

      <section className="console" aria-label="Filters">
        <div className="cut" role="tablist" aria-label="Show">
          {CUTS.map((c) => (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={active === c.key}
              className={active === c.key ? "on" : ""}
              onClick={() => setCut(c.key)}
            >
              {c.key === "PENDING" && counts.PENDING > 0 && <span className="cut-dot" aria-hidden="true" />}
              {c.label}
              <span className="cut-n">{counts[c.key]}</span>
            </button>
          ))}
        </div>

        <span className="console-rule" aria-hidden="true" />

        <label className="pick">
          <span>Registry</span>
          <select value={registry} onChange={(e) => setRegistry(e.target.value as "" | Registry)}>
            <option value="">Any registry result</option>
            <option value="matched">Name matched</option>
            <option value="unsure">No confident match</option>
            <option value="unchecked">Not checked</option>
          </select>
        </label>

        {councils.length > 1 && (
          <label className="pick">
            <span>Council</span>
            <select value={council} onChange={(e) => setCouncil(e.target.value)}>
              <option value="">Every council</option>
              {councils.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        )}

        {any && (
          <button type="button" className="btn-link clear" onClick={clearFilters}>
            Clear filters
          </button>
        )}

        <span className="tally-say">
          {shown.length === list.length ? `${list.length} doctors` : `${shown.length} of ${list.length}`}
        </span>

        <label className="pick">
          <span>Order</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="waiting">Waiting longest first</option>
            <option value="cases">Most cases this year</option>
            <option value="owed">Owes the most</option>
            <option value="newest">Newest sign-ups</option>
            <option value="name">Name, A to Z</option>
          </select>
        </label>
      </section>

      {list.length === 0 ? (
        <Empty>No doctors have signed up yet.</Empty>
      ) : shown.length === 0 ? (
        <Empty>
          {active === "PENDING" && !q ? "Nobody is waiting for verification." : "No doctor matches these filters."}{" "}
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              clearFilters();
              setSearch("");
            }}
          >
            Show every doctor
          </button>
        </Empty>
      ) : (
        <div className="case-table pt-table dr-table">
          <table>
            <thead>
              <tr>
                <th className="col-who">Doctor</th>
                <th>Clinic</th>
                <th>Registration</th>
                <th>Registry check</th>
                <th className="num">Cases {year}</th>
                <th className="num">Owes</th>
                <th>Signed up</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => {
                const r = registryOf(d);
                const owes = owesBy.get(d.id) ?? 0;
                const [statusLabel, statusPill] = STATUS[d.verification_status] ?? [d.verification_status, "pill"];
                return (
                  <tr
                    key={d.id}
                    className={`clickable${d.verification_status === "PENDING" ? " wants" : ""}${d.verification_status === "REJECTED" ? " done" : ""}`}
                    onClick={() => setOpenId(d.id)}
                  >
                    <td className="col-who">
                      <span className="pt-who">
                        <Avatar name={d.full_name} />
                        <span className="pt-who-say">
                          <span className="cell-title">{d.full_name}</span>
                          <span className="pt-meta">{d.email}</span>
                        </span>
                      </span>
                    </td>
                    <td className="dr-clinic">{d.clinic_name || <span className="dim">—</span>}</td>
                    <td>
                      <span className="dr-reg">
                        <span>{d.dental_council || "—"}</span>
                        {d.registration_number && <span className="mono">{d.registration_number}</span>}
                      </span>
                    </td>
                    <td>
                      <span className={REGISTRY[r][1]}>{REGISTRY[r][0]}</span>
                    </td>
                    <td className="num">{casesBy.get(d.id) ?? 0}</td>
                    <td className="num">
                      {owes > 0 ? <span className="pay due">{formatMoney(owes)}</span> : <span className="dim">—</span>}
                    </td>
                    <td className="col-when" title={formatDate(d.created_at)}>
                      {shortDay(d.created_at)}
                      {d.verification_status === "PENDING" && <small>waiting {since(d.created_at)}</small>}
                    </td>
                    <td>
                      <span className={statusPill}>{statusLabel}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {opened && (
        <DoctorPanel
          doctor={opened}
          cases={casesBy.get(opened.id) ?? 0}
          owes={owesBy.get(opened.id) ?? 0}
          year={year}
          onClose={() => setOpenId(null)}
        />
      )}
    </main>
  );
}

/** One doctor, opened: who they are, what the register made of them, what
    they have sent and owe — and, while they wait, the decision. */
function DoctorPanel({
  doctor: d,
  cases,
  owes,
  year,
  onClose,
}: {
  doctor: PendingDoctor;
  cases: number;
  owes: number;
  year: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const verify = useMutation({
    mutationFn: (approve: boolean) => api.verifyDoctor(d.id, approve, reason),
    onSuccess: () => {
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["staff-doctors"] });
      void queryClient.invalidateQueries({ queryKey: ["queue"] });
    },
  });

  const check = checkOf(d);
  const r = registryOf(d);
  const [statusLabel, statusPill] = STATUS[d.verification_status] ?? [d.verification_status, "pill"];

  return (
    <Drawer
      eyebrow="Doctor"
      title={d.full_name}
      sub={[d.clinic_name, d.email].filter(Boolean).join(" · ")}
      lead={<Avatar name={d.full_name} large />}
      onClose={onClose}
      stats={
        <div className="pt-stats">
          <div>
            <b>{cases}</b>
            <span>Cases in {year}</span>
          </div>
          <div>
            <b className={owes > 0 ? "lit" : ""}>{owes > 0 ? formatMoney(owes) : "₹0"}</b>
            <span>Owes the lab</span>
          </div>
          <div>
            <b>{shortDay(d.created_at)}</b>
            <span>Signed up</span>
          </div>
        </div>
      }
      foot={
        d.verification_status === "PENDING" ? (
          <>
            <input
              placeholder="Reason — needed to decline, and sent to the doctor"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label="Reason for declining"
            />
            <ErrorText error={verify.error} />
            <div className="dw-actions">
              <button
                type="button"
                className="btn-danger"
                disabled={verify.isPending || !reason.trim()}
                onClick={() => verify.mutate(false)}
              >
                Decline
              </button>
              <button type="button" className="btn-primary" disabled={verify.isPending} onClick={() => verify.mutate(true)}>
                {verify.isPending ? "Saving…" : "Verify and let them in"}
              </button>
            </div>
          </>
        ) : undefined
      }
    >
      <section className="dw-section">
        <h3>Status</h3>
        <p className="dw-line">
          <span className={statusPill}>{statusLabel}</span>
          {d.verification_status === "PENDING" && <span className="dim">Waiting {since(d.created_at)} — cases cannot be sent until verified.</span>}
        </p>
        {d.verification_status === "REJECTED" && d.rejection_reason && (
          <p className="dw-note bad">Declined: {d.rejection_reason}</p>
        )}
      </section>

      <section className="dw-section">
        <h3>Registration</h3>
        <dl className="dw-dl">
          <div>
            <dt>Council</dt>
            <dd>{d.dental_council || "—"}</dd>
          </div>
          <div>
            <dt>Registration number</dt>
            <dd className="mono">{d.registration_number || "—"}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{d.phone || "—"}</dd>
          </div>
          <div>
            <dt>Signed up</dt>
            <dd>{formatDate(d.created_at)}</dd>
          </div>
        </dl>
      </section>

      <section className="dw-section">
        <h3>Registry check</h3>
        <div className={`dr-registry ${r}`}>
          <span className={REGISTRY[r][1]}>{REGISTRY[r][0]}</span>
          {r === "unchecked" ? (
            <p>
              Not checked automatically{check?.reason ? ` — ${check.reason}` : ""}. Verify against the council register
              yourself.
            </p>
          ) : (
            <>
              {check?.name_match_score !== undefined && <p className="dim">Match score {check.name_match_score}</p>}
              {check?.registry_names && check.registry_names.length > 0 && (
                <p>
                  Register says: <b>{check.registry_names.join(", ")}</b>
                </p>
              )}
            </>
          )}
        </div>
      </section>

      <div className="pt-actions">
        <Link className="ghost" to={`/staff/orders?series=all&q=${encodeURIComponent(d.full_name)}`} onClick={onClose}>
          Their cases
        </Link>
        <Link className="ghost" to={`/staff/payments?doctor=${d.id}`} onClick={onClose}>
          Their payments
        </Link>
      </div>
    </Drawer>
  );
}
