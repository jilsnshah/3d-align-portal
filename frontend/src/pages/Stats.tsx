/* What the practice, or the lab, has actually been doing.

   One page serving both sides. The shape of the question is identical — how
   much work, of what, when, and worth what — and the only difference is the
   cut that makes sense for the reader: a doctor breaks down by branch, the lab
   by doctor. Two copies of this would have drifted within a month. */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../api";
import type { Stats, StatsSlice } from "../api";
import { Loading } from "../components/ui";
import {
  ColumnChart,
  Legend,
  RankBars,
  SERIES_A,
  SERIES_B,
  StatTile,
  TableToggle,
  formatCount,
  formatMoney,
} from "../components/charts";

/** "2026-08-24" as a person would say it, for the tooltip. */
function fullLabel(key: string, label: string): string {
  const parts = key.split("-");
  if (parts.length === 3) return `${label} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
  if (parts.length === 2) return `${label} ${parts[0]}`;
  return label;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function toRank(rows: StatsSlice[], showUnits: boolean) {
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    note: row.note,
    value: row.orders,
    extra: showUnits && row.units !== row.orders ? `${formatCount(row.units)} made` : undefined,
  }));
}

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card stat-panel">
      <div className="stat-panel-head">
        <h3>{title}</h3>
        {hint && <p className="dim">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function SliceTable({ rows, unit }: { rows: StatsSlice[]; unit: string }) {
  return (
    <table>
      <thead>
        <tr>
          <th>{unit}</th>
          <th>Cases</th>
          <th>Made</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td>
              {row.label}
              {row.note && <span className="dim"> · {row.note}</span>}
            </td>
            <td>{formatCount(row.orders)}</td>
            <td>{formatCount(row.units)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function StatsPage({ lab = false }: { lab?: boolean }) {
  const now = new Date();
  const [view, setView] = useState<"year" | "month">("year");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [doctorId, setDoctorId] = useState("");

  const stats = useQuery({
    queryKey: ["stats", lab, view, year, month, doctorId],
    queryFn: () =>
      lab
        ? api.labStats({ view, year, month, doctorId: doctorId || undefined })
        : api.practiceStats({ view, year, month }),
  });

  // Only the lab can narrow to a practice, and only from the list of practices
  // that actually sent work in the window being looked at.
  const doctors = useQuery({
    queryKey: ["stats", "doctor-list", year],
    queryFn: () => api.labStats({ view: "year", year }),
    enabled: lab,
  });

  const data: Stats | undefined = stats.data;
  const years = data?.available_years ?? [year];

  return (
    <main className="page stack">
      <div className="page-head">
        <div>
          <h1>{lab ? "The lab's book" : "Your practice"}</h1>
          <p className="sub">
            {lab
              ? "Every clinic's work, by month and by year."
              : "What you have sent us, by month and by year."}
          </p>
        </div>
      </div>

      {/* Filters in one row, above everything they change. */}
      <div className="stat-filters">
        <div className="seg" role="group" aria-label="Period">
          <button
            type="button"
            className={view === "year" ? "active" : ""}
            aria-pressed={view === "year"}
            onClick={() => setView("year")}
          >
            By year
          </button>
          <button
            type="button"
            className={view === "month" ? "active" : ""}
            aria-pressed={view === "month"}
            onClick={() => setView("month")}
          >
            By month
          </button>
        </div>

        <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
          {years.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        {view === "month" && (
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            aria-label="Month"
          >
            {MONTHS.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </select>
        )}

        {lab && (
          <select
            value={doctorId}
            onChange={(e) => setDoctorId(e.target.value)}
            aria-label="Practice"
          >
            <option value="">Every practice</option>
            {(doctors.data?.doctors ?? []).map((row) => (
              <option key={row.key} value={row.key}>
                {row.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {stats.isLoading || !data ? (
        <Loading what="figures" />
      ) : (
        <>
          <div className="stat-row">
            <StatTile
              label="Cases opened"
              value={formatCount(data.totals.orders)}
              note={data.period_label}
              tone="gold"
            />
            <StatTile label="Aligner cases" value={formatCount(data.totals.aligners)} />
            <StatTile label="Product orders" value={formatCount(data.totals.products)} />
            <StatTile label="Accessory orders" value={formatCount(data.totals.accessories)} />
            <StatTile
              label="Patients"
              value={formatCount(data.totals.patients)}
              note={data.totals.cancelled > 0 ? `${data.totals.cancelled} cancelled` : undefined}
            />
            <StatTile
              label={lab ? "Collected" : "Paid"}
              value={formatMoney(Number(data.totals.paid))}
              note="Verified in this period"
            />
          </div>

          <Panel
            title="Cases opened"
            hint={
              view === "year"
                ? "By the month the case was opened."
                : "By the day the case was opened."
            }
          >
            <Legend
              items={[
                { color: SERIES_A, label: "Aligner cases" },
                { color: SERIES_B, label: "Product orders" },
              ]}
            />
            <ColumnChart
              data={data.series.map((b) => ({
                key: b.key,
                label: b.label,
                full: fullLabel(b.key, b.label),
                a: b.aligners,
                b: b.products,
              }))}
              labelA="Aligner cases"
              labelB="Product orders"
            />
            <TableToggle label="this chart">
              <table>
                <thead>
                  <tr>
                    <th>{view === "year" ? "Month" : "Day"}</th>
                    <th>Aligner cases</th>
                    <th>Product orders</th>
                    <th>{lab ? "Collected" : "Paid"}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.series.map((bucket) => (
                    <tr key={bucket.key}>
                      <td>{bucket.label}</td>
                      <td>{formatCount(bucket.aligners)}</td>
                      <td>{formatCount(bucket.products)}</td>
                      <td>{formatMoney(Number(bucket.paid))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableToggle>
          </Panel>

          {/* Money gets its own chart rather than a second axis on the one
              above. Cases and rupees share no scale, and drawing them against
              two axes is the fastest way to imply a relationship that is not
              in the data. */}
          <Panel
            title={lab ? "Collected" : "Paid"}
            hint="By the day the payment was verified, not the day the case was opened."
          >
            <ColumnChart
              data={data.series.map((b) => ({
                key: b.key,
                label: b.label,
                full: fullLabel(b.key, b.label),
                a: Number(b.paid),
              }))}
              labelA={lab ? "Collected" : "Paid"}
              money
              height={180}
            />
          </Panel>

          <div className="stat-grid">
            <Panel title="Products" hint="What was ordered besides aligner series.">
              {data.products.length === 0 ? (
                <p className="dim">No product orders in this period.</p>
              ) : (
                <>
                  <RankBars rows={toRank(data.products, true)} unit="orders" />
                  <TableToggle label="products">
                    <SliceTable rows={data.products} unit="Product" />
                  </TableToggle>
                </>
              )}
            </Panel>

            <Panel title="Accessories" hint="Shelf items, wherever they rode.">
              {data.accessories.length === 0 ? (
                <p className="dim">No accessories in this period.</p>
              ) : (
                <>
                  <RankBars rows={toRank(data.accessories, true)} unit="orders" />
                  <TableToggle label="accessories">
                    <SliceTable rows={data.accessories} unit="Accessory" />
                  </TableToggle>
                </>
              )}
            </Panel>

            <Panel title="Aligner bands" hint="Cases whose band has been decided.">
              {data.categories.length === 0 ? (
                <p className="dim">No band has been set on a case in this period.</p>
              ) : (
                <>
                  <RankBars rows={toRank(data.categories, false)} unit="cases" />
                  <TableToggle label="bands">
                    <SliceTable rows={data.categories} unit="Band" />
                  </TableToggle>
                </>
              )}
            </Panel>

            {lab && data.doctors.length > 0 && (
              <Panel title="Practices" hint="Who is sending the work.">
                <RankBars rows={toRank(data.doctors, false)} unit="cases" />
                <TableToggle label="practices">
                  <SliceTable rows={data.doctors} unit="Doctor" />
                </TableToggle>
              </Panel>
            )}

            {data.branches.length > 1 && (
              <Panel title="Branches" hint="Where the work was sent from.">
                <RankBars rows={toRank(data.branches, false)} unit="cases" />
                <TableToggle label="branches">
                  <SliceTable rows={data.branches} unit="Branch" />
                </TableToggle>
              </Panel>
            )}
          </div>
        </>
      )}
    </main>
  );
}
