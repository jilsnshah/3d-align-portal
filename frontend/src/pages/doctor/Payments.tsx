/* Everything this practice owes, and everything it has already paid.
 *
 * Money used to live one case at a time: open a case, scroll to its payments
 * card. That answers "what does this case owe" and nothing else. A practice
 * with twenty live cases could not see what it owed in total, could not find
 * the one charge holding a treatment plan up, and had no record of what it had
 * paid without opening every case in turn.
 *
 * The rows here are the same rows the case panel shows — same component, same
 * endpoint for sending a receipt. Nothing on this page raises or settles a
 * charge on its own; it is a different way into the flow that already exists.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api, formatDate, formatMoney } from "../../api";
import type { LedgerEntry } from "../../api";
import { PaymentRow } from "../../components/PaymentPanel";
import { StatTile } from "../../components/charts";
import { Loading } from "../../components/ui";

/** Which case a charge belongs to, printed above the charge itself.
 *  The case page leaves this out — the case is already on the screen. */
function CaseLine({ entry }: { entry: LedgerEntry }) {
  return (
    <div className="pay-case">
      <Link to={`/orders/${entry.order_id}`} className="pay-case-ref">
        {entry.order_reference}
      </Link>
      <span className="dim">
        {entry.subject} · {entry.order_status_label}
      </span>
    </div>
  );
}

/** A settled charge. It cannot be acted on, so it is a line in a table rather
    than a card with controls that would all be disabled. */
function HistoryTable({ rows }: { rows: LedgerEntry[] }) {
  return (
    <div className="table-wrap">
      <table className="pay-history">
        <thead>
          <tr>
            <th>Paid</th>
            <th>Case</th>
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
                <Link to={`/orders/${row.order_id}`}>{row.order_reference}</Link>
                <div className="dim">{row.subject}</div>
              </td>
              <td>{row.label}</td>
              <td className="num">{formatMoney(row.total)}</td>
              <td className="dim">
                {row.proof_file_id ? (
                  <a
                    href={`/api/orders/${row.order_id}/files/${row.proof_file_id}`}
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

export default function Payments() {
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const { data, isLoading } = useQuery({
    queryKey: ["payment-ledger"],
    queryFn: api.paymentLedger,
  });

  if (isLoading) return <Loading />;
  if (!data) return null;

  // A rejected receipt is money that left the account against a charge that is
  // still open, so it is worth naming rather than folding into "outstanding".
  const rejected = data.pending.filter((p) => p.status === "REJECTED");
  const rows = tab === "pending" ? data.pending : data.history;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Payments</h1>
          <p className="sub">
            Everything 3D Align has charged this practice. Pay by UPI and send the
            screenshot — the lab confirms each one.
          </p>
        </div>
      </div>

      <div className="stat-row">
        <StatTile
          label="Due now"
          value={formatMoney(data.outstanding)}
          note={
            rejected.length > 0
              ? `${rejected.length} receipt${rejected.length > 1 ? "s" : ""} not accepted`
              : "Awaiting payment"
          }
          tone={Number(data.outstanding) > 0 ? "gold" : undefined}
        />
        <StatTile
          label="With the lab"
          value={formatMoney(data.in_review)}
          note="Receipts being checked"
        />
        <StatTile
          label={`Paid ${data.financial_year}`}
          value={formatMoney(data.paid_this_year)}
          note="Confirmed since 1 April"
        />
        <StatTile
          label="Paid in total"
          value={formatMoney(data.paid_total)}
          note="Every confirmed payment"
        />
      </div>

      <div className="seg" role="tablist" aria-label="Payments">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "pending"}
          className={tab === "pending" ? "active" : ""}
          onClick={() => setTab("pending")}
        >
          Pending ({data.pending.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "history"}
          className={tab === "history" ? "active" : ""}
          onClick={() => setTab("history")}
        >
          Paid ({data.history.length})
        </button>
      </div>

      {rows.length === 0 ? (
        <section className="card">
          <p className="dim">
            {tab === "pending"
              ? "Nothing to pay. Every charge on this practice has been confirmed."
              : "No confirmed payments yet."}
          </p>
        </section>
      ) : tab === "history" ? (
        <section className="card">
          <HistoryTable rows={data.history} />
        </section>
      ) : (
        <section className="card">
          {data.pending.map((entry) => (
            <PaymentRow
              key={entry.id}
              orderId={entry.order_id}
              payment={entry}
              header={<CaseLine entry={entry} />}
            />
          ))}
        </section>
      )}
    </main>
  );
}
