/* The lab's money, across every clinic.
 *
 * The clinic's own ledger answers "what do I owe". This answers a different
 * question over the same rows, and the order matters: the lab's first job is
 * not chasing debt but checking the receipts already sent, because a receipt
 * sitting unread holds up whatever the charge was gating — a treatment plan,
 * a training aligner, a box waiting to be dispatched. Until now the only way
 * to find one was to open cases until you hit it.
 *
 * So "To check" is the first tab and the default. Chasing comes after, and
 * deliberately excludes clinics whose receipt is already on this desk: they
 * have paid, and the delay is ours.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api, formatDate, formatMoney } from "../../api";
import type { LedgerEntry } from "../../api";
import { VerifyRow } from "../../components/PaymentReview";
import { StatTile } from "../../components/charts";
import { Loading } from "../../components/ui";

type Tab = "verify" | "owed" | "received";

/** Which case, and whose. Both are needed here and neither is on the screen
    already, unlike inside a case. */
function CaseLine({ entry }: { entry: LedgerEntry }) {
  return (
    <div className="pay-case">
      <Link to={`/staff/orders/${entry.order_id}`} className="pay-case-ref">
        {entry.order_reference}
      </Link>
      <span className="dim">
        {entry.subject} · {entry.doctor_name}
        {entry.clinic_name ? `, ${entry.clinic_name}` : ""} · {entry.order_status_label}
      </span>
    </div>
  );
}

function ReceivedTable({ rows }: { rows: LedgerEntry[] }) {
  return (
    <div className="table-wrap">
      <table className="pay-history">
        <thead>
          <tr>
            <th>Confirmed</th>
            <th>Case</th>
            <th>Clinic</th>
            <th>For</th>
            <th className="num">Amount</th>
            <th>Receipt</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.verified_at ? formatDate(row.verified_at) : "—"}</td>
              <td>
                <Link to={`/staff/orders/${row.order_id}`}>{row.order_reference}</Link>
                <div className="dim">{row.subject}</div>
              </td>
              <td>
                {row.doctor_name}
                <div className="dim">{row.clinic_name}</div>
              </td>
              <td>{row.label}</td>
              <td className="num">{formatMoney(row.total)}</td>
              <td className="dim">
                {row.proof_file_id ? (
                  <a
                    href={api.previewUrl(row.order_id, row.proof_file_id)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {row.reference || "View"}
                  </a>
                ) : (
                  row.reference || "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function StaffPayments() {
  const [tab, setTab] = useState<Tab>("verify");
  const [doctorId, setDoctorId] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["staff-payments", doctorId],
    queryFn: () => api.labPayments(doctorId || undefined),
  });
  const doctors = useQuery({
    queryKey: ["staff-doctors", "picker"],
    queryFn: () => api.staffDoctors(false, { limit: 200 }),
  });

  if (isLoading) return <Loading what="payments" />;
  if (!data) return null;

  // What is owed, minus anything whose receipt is already on this desk.
  const owed = data.pending.filter((p) => p.status !== "SUBMITTED");

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Payments</h1>
          <p className="sub">
            Every charge 3D Align has raised. Check a receipt against the bank before
            confirming it — approving is what unlocks whatever the charge was holding.
          </p>
        </div>
        <div className="row">
          <select
            value={doctorId}
            onChange={(e) => setDoctorId(e.target.value)}
            aria-label="Clinic"
            style={{ maxWidth: 260 }}
          >
            <option value="">Every clinic</option>
            {doctors.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.full_name}
                {d.clinic_name ? ` — ${d.clinic_name}` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="stat-row">
        <StatTile
          label="To check"
          value={String(data.to_verify.length)}
          note={
            data.to_verify.length > 0
              ? `${formatMoney(data.in_review)} waiting on us`
              : "Nothing waiting"
          }
          tone={data.to_verify.length > 0 ? "gold" : undefined}
        />
        <StatTile
          label="Owed to the lab"
          value={formatMoney(data.outstanding)}
          note={`${owed.length} open charge${owed.length === 1 ? "" : "s"}`}
        />
        <StatTile
          label={`Received ${data.financial_year}`}
          value={formatMoney(data.paid_this_year)}
          note="Confirmed since 1 April"
        />
        <StatTile
          label="Received in total"
          value={formatMoney(data.paid_total)}
          note="Every confirmed payment"
        />
      </div>

      <div className="seg" role="tablist" aria-label="Payments">
        {(
          [
            ["verify", `To check (${data.to_verify.length})`],
            ["owed", `Owed (${owed.length})`],
            ["received", `Received (${data.history.length})`],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "verify" && (
        <section className="card">
          {data.to_verify.length === 0 ? (
            <p className="dim">
              No receipts waiting. Everything a clinic has sent has been checked.
            </p>
          ) : (
            <>
              <p className="dim" style={{ marginBottom: 12 }}>
                Oldest first — the clinic at the top has been waiting longest.
              </p>
              {data.to_verify.map((entry) => (
                <VerifyRow
                  key={entry.id}
                  orderId={entry.order_id}
                  payment={entry}
                  header={<CaseLine entry={entry} />}
                />
              ))}
            </>
          )}
        </section>
      )}

      {tab === "owed" && (
        <div className="stack">
          {data.owed_by_doctor.length > 1 && (
            <section className="card">
              <h4 style={{ marginBottom: 10 }}>Who owes what</h4>
              <div className="table-wrap">
                <table className="pay-history">
                  <thead>
                    <tr>
                      <th>Clinic</th>
                      <th className="num">Charges</th>
                      <th className="num">Owed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.owed_by_doctor.map((row) => (
                      <tr key={row.doctor_id || row.doctor_name}>
                        <td>
                          {row.doctor_name}
                          <div className="dim">{row.clinic_name}</div>
                        </td>
                        <td className="num">{row.charges}</td>
                        <td className="num">
                          <b>{formatMoney(row.amount)}</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="dim" style={{ marginTop: 8 }}>
                A clinic whose receipt is already with us is not listed — they have paid,
                and the delay is ours.
              </p>
            </section>
          )}

          <section className="card">
            {owed.length === 0 ? (
              <p className="dim">Nothing is owed. Every charge has been settled.</p>
            ) : (
              owed.map((entry) => (
                <VerifyRow
                  key={entry.id}
                  orderId={entry.order_id}
                  payment={entry}
                  header={<CaseLine entry={entry} />}
                />
              ))
            )}
          </section>
        </div>
      )}

      {tab === "received" && (
        <section className="card">
          {data.history.length === 0 ? (
            <p className="dim">Nothing confirmed yet.</p>
          ) : (
            <ReceivedTable rows={data.history} />
          )}
        </section>
      )}
    </main>
  );
}
