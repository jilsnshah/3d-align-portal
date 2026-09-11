/* Insights — what the practice, or the lab, has actually been doing.
 *
 * One page serving both sides. The shape of the question is identical — how
 * much work, of what, when, and worth what — and the only difference is the
 * cut that makes sense for the reader: a doctor breaks down by branch, the lab
 * by doctor. Two copies of this would have drifted within a month.
 *
 * It used to be a heading, six tiles of the same weight and two charts. It
 * could show a number but not say anything about it. Now it leads with the
 * period said as a sentence and set against the one before it, gives every
 * figure its change and its shape across the period, and picks out what stood
 * out — the busiest month, the appliance ordered most, the band seen most —
 * before the charts and breakdowns that back it up.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { api } from "../api";
import type { Stats, StatsBucket, StatsSlice } from "../api";
import { useAuth } from "../auth";
import { Loading } from "../components/ui";
import {
  ColumnChart,
  Legend,
  RankBars,
  SERIES_A,
  SERIES_B,
  TableToggle,
  formatCount,
  formatMoney,
} from "../components/charts";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-08-24" as a person would say it. */
function fullLabel(key: string, label: string): string {
  const parts = key.split("-");
  if (parts.length === 3) return `${label} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
  if (parts.length === 2) return `${label} ${parts[0]}`;
  return label;
}

function toRank(rows: StatsSlice[], showUnits: boolean) {
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    note: row.note,
    value: row.orders,
    extra: showUnits && row.units !== row.orders ? `${formatCount(row.units)} made` : undefined,
  }));
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** The period before the one being looked at: last year, or last month. */
function previousOf(view: "year" | "month", year: number, month: number) {
  if (view === "year") return { year: year - 1, month };
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

type Change = { text: string; tone: "up" | "down" | "flat" | "new" };

/** How a figure moved against the period before. Up is drawn as good and down
    as quiet rather than red: fewer cases in a month is not a fault. */
function change(current: number, previous: number | undefined): Change | null {
  if (previous === undefined) return null;
  if (current === 0 && previous === 0) return null;
  if (previous === 0) return { text: "New", tone: "new" };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: "Level", tone: "flat" };
  return { text: `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%`, tone: pct > 0 ? "up" : "down" };
}

const bucketTotal = (b: StatsBucket) => b.aligners + b.products + b.accessories;

/** The shape of a figure across the period, drawn small beside it. */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2 || values.every((v) => v === 0)) return <span className="in-spark empty" aria-hidden="true" />;
  const max = Math.max(...values);
  const w = 100;
  const h = 28;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - (v / max) * (h - 4) - 2]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  return (
    <svg className="in-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${line}L${w},${h}L0,${h}Z`} className="area" />
      <path d={line} className="line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Kpi({
  label,
  value,
  note,
  delta,
  spark,
  lead = false,
}: {
  label: string;
  value: string;
  note?: string;
  delta: Change | null;
  spark?: ReactNode;
  lead?: boolean;
}) {
  return (
    <div className={`in-kpi${lead ? " lead" : ""}`}>
      <span className="in-kpi-label">{label}</span>
      <b className="in-kpi-value">{value}</b>
      <span className="in-kpi-foot">
        {delta && <span className={`in-delta ${delta.tone}`}>{delta.text}</span>}
        {note && <span className="in-kpi-note">{note}</span>}
      </span>
      {spark}
    </div>
  );
}

function Panel({
  title,
  hint,
  className = "",
  children,
}: {
  title: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`in-panel ${className}`}>
      <div className="in-panel-head">
        <h3>{title}</h3>
        {hint && <p>{hint}</p>}
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

/** What stood out, said in words — the things a reader would otherwise have to
    find by reading every chart. Only what the data actually supports. */
function highlights(d: Stats, view: "year" | "month", lab: boolean) {
  const out: { label: string; value: string; note: string }[] = [];
  const busiest = d.series.reduce<StatsBucket | null>(
    (best, b) => (bucketTotal(b) > (best ? bucketTotal(best) : 0) ? b : best),
    null,
  );
  if (busiest) {
    out.push({
      label: view === "year" ? "Busiest month" : "Busiest day",
      value: fullLabel(busiest.key, busiest.label),
      note: `${plural(bucketTotal(busiest), "case")} opened`,
    });
  }
  const top = (rows: StatsSlice[]) => [...rows].sort((a, b) => b.orders - a.orders)[0];
  const product = top(d.products);
  if (product) {
    out.push({
      label: "Most-ordered appliance",
      value: product.label,
      note: `${plural(product.orders, "order")} · ${formatCount(product.units)} made`,
    });
  }
  const band = top(d.categories);
  if (band) out.push({ label: "Most common band", value: band.label, note: plural(band.orders, "case") });
  const item = top(d.accessories);
  if (item) out.push({ label: "Most-restocked item", value: item.label, note: `${formatCount(item.units)} supplied` });
  if (lab) {
    const practice = top(d.doctors);
    if (practice) out.push({ label: "Busiest practice", value: practice.label, note: plural(practice.orders, "case") });
  }
  if (d.totals.cancelled > 0) {
    out.push({ label: "Cancelled", value: plural(d.totals.cancelled, "case"), note: "in this period" });
  }
  return out;
}

export default function StatsPage({ lab = false }: { lab?: boolean }) {
  const { me } = useAuth();
  const now = new Date();
  const [view, setView] = useState<"year" | "month">("year");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [doctorId, setDoctorId] = useState("");

  const fetch = (q: { year: number; month: number }) =>
    lab
      ? api.labStats({ view, year: q.year, month: q.month, doctorId: doctorId || undefined })
      : api.practiceStats({ view, year: q.year, month: q.month });

  const stats = useQuery({
    queryKey: ["stats", lab, view, year, month, doctorId],
    queryFn: () => fetch({ year, month }),
  });
  const prev = previousOf(view, year, month);
  const before = useQuery({
    queryKey: ["stats", lab, view, prev.year, prev.month, doctorId],
    queryFn: () => fetch(prev),
  });

  // Only the lab can narrow to a practice, and only from the practices that
  // actually sent work in the year being looked at.
  const doctors = useQuery({
    queryKey: ["stats", "doctor-list", year],
    queryFn: () => api.labStats({ view: "year", year }),
    enabled: lab,
  });

  const data: Stats | undefined = stats.data;
  const was = before.data;
  const years = data?.available_years ?? [year];
  const facts = useMemo(() => (data ? highlights(data, view, lab) : []), [data, view, lab]);

  const who = lab ? "Every practice" : me?.doctor?.clinic_name || "Your practice";
  const paidWord = lab ? "collected" : "paid";

  return (
    <main className="page in">
      <section className="in-hero">
        <div className="in-say">
          <span className="in-eyebrow">Insights · {who}</span>
          {!data ? (
            <h1>Reading the figures…</h1>
          ) : (
            <h1>
              <em>{plural(data.totals.orders, "case")}</em> {view === "year" ? "in" : "in"} {data.period_label}.
            </h1>
          )}
          {data && (
            <p className="in-sub">
              {[
                data.totals.aligners ? plural(data.totals.aligners, "aligner case") : "",
                data.totals.products ? plural(data.totals.products, "appliance order") : "",
                data.totals.accessories ? plural(data.totals.accessories, "accessory order") : "",
              ]
                .filter(Boolean)
                .join(", ") || "Nothing opened yet"}
              {data.totals.patients ? `, for ${plural(data.totals.patients, "patient")}` : ""}
              {Number(data.totals.paid) > 0 ? ` — and ${formatMoney(Number(data.totals.paid))} ${paidWord}.` : "."}
            </p>
          )}

          {/* The period is chosen where it is read, not in a strip above it. */}
          <div className="in-period" role="group" aria-label="Period">
            <div className="in-seg">
              <button type="button" className={view === "year" ? "on" : ""} aria-pressed={view === "year"} onClick={() => setView("year")}>
                By year
              </button>
              <button type="button" className={view === "month" ? "on" : ""} aria-pressed={view === "month"} onClick={() => setView("month")}>
                By month
              </button>
            </div>
            <select className="in-select" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
              {years.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            {view === "month" && (
              <select className="in-select" value={month} onChange={(e) => setMonth(Number(e.target.value))} aria-label="Month">
                {MONTHS.map((name, index) => (
                  <option key={name} value={index + 1}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            {lab && (
              <select className="in-select" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} aria-label="Practice">
                <option value="">Every practice</option>
                {(doctors.data?.doctors ?? []).map((row) => (
                  <option key={row.key} value={row.key}>
                    {row.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* The same figures a period earlier, so a number has something to be
            measured against. */}
        <aside className="in-versus" aria-label="Against the period before">
          <span className="in-eyebrow">Against {was?.period_label ?? (view === "year" ? String(prev.year) : `${MONTHS[prev.month - 1]} ${prev.year}`)}</span>
          {data && (
            <ul>
              {[
                { label: "Cases opened", cur: data.totals.orders, old: was?.totals.orders, fmt: formatCount },
                { label: "Patients", cur: data.totals.patients, old: was?.totals.patients, fmt: formatCount },
                {
                  label: lab ? "Collected" : "Paid",
                  cur: Number(data.totals.paid),
                  old: was ? Number(was.totals.paid) : undefined,
                  fmt: (v: number) => formatMoney(v),
                },
              ].map((row) => {
                const d = change(row.cur, row.old);
                return (
                  <li key={row.label}>
                    <span>{row.label}</span>
                    <b>{row.fmt(row.cur)}</b>
                    <small>
                      {row.old === undefined ? "…" : `was ${row.fmt(row.old)}`}
                      {d && <i className={`in-delta ${d.tone}`}>{d.text}</i>}
                    </small>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </section>

      {stats.isLoading || !data ? (
        <Loading what="figures" />
      ) : (
        <>
          <section className="in-kpis" aria-label="The period in figures">
            <Kpi
              lead
              label="Cases opened"
              value={formatCount(data.totals.orders)}
              delta={change(data.totals.orders, was?.totals.orders)}
              spark={<Spark values={data.series.map(bucketTotal)} />}
            />
            <Kpi
              label="Aligner cases"
              value={formatCount(data.totals.aligners)}
              delta={change(data.totals.aligners, was?.totals.aligners)}
              spark={<Spark values={data.series.map((b) => b.aligners)} />}
            />
            <Kpi
              label="Appliance orders"
              value={formatCount(data.totals.products)}
              delta={change(data.totals.products, was?.totals.products)}
              spark={<Spark values={data.series.map((b) => b.products)} />}
            />
            <Kpi
              label="Accessory orders"
              value={formatCount(data.totals.accessories)}
              delta={change(data.totals.accessories, was?.totals.accessories)}
              spark={<Spark values={data.series.map((b) => b.accessories)} />}
            />
            <Kpi
              label="Patients"
              value={formatCount(data.totals.patients)}
              note={data.totals.cancelled > 0 ? `${data.totals.cancelled} cancelled` : undefined}
              delta={change(data.totals.patients, was?.totals.patients)}
            />
            <Kpi
              label={lab ? "Collected" : "Paid"}
              value={formatMoney(Number(data.totals.paid))}
              note="Verified in this period"
              delta={change(Number(data.totals.paid), was ? Number(was.totals.paid) : undefined)}
              spark={<Spark values={data.series.map((b) => Number(b.paid))} />}
            />
          </section>

          <div className="in-row">
            <Panel
              className="wide"
              title="Cases opened"
              hint={view === "year" ? "By the month the case was opened." : "By the day the case was opened."}
            >
              <Legend
                items={[
                  { color: SERIES_A, label: "Aligner cases" },
                  { color: SERIES_B, label: "Appliance orders" },
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
                labelB="Appliance orders"
              />
              <TableToggle label="this chart">
                <table>
                  <thead>
                    <tr>
                      <th>{view === "year" ? "Month" : "Day"}</th>
                      <th>Aligner cases</th>
                      <th>Appliance orders</th>
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

            <Panel title="What stood out" hint={data.period_label}>
              {facts.length === 0 ? (
                <p className="in-none">Nothing to pick out yet — the figures fill in as cases are opened.</p>
              ) : (
                <ul className="in-facts">
                  {facts.map((f) => (
                    <li key={f.label}>
                      <span>{f.label}</span>
                      <b>{f.value}</b>
                      <small>{f.note}</small>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

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

          <div className="in-grid">
            <Panel title="Appliances" hint="What was ordered besides aligner series.">
              {data.products.length === 0 ? (
                <p className="in-none">No appliance orders in this period.</p>
              ) : (
                <>
                  <RankBars rows={toRank(data.products, true)} unit="orders" />
                  <TableToggle label="appliances">
                    <SliceTable rows={data.products} unit="Appliance" />
                  </TableToggle>
                </>
              )}
            </Panel>

            <Panel title="Accessories" hint="Shelf items, wherever they rode.">
              {data.accessories.length === 0 ? (
                <p className="in-none">No accessories in this period.</p>
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
                <p className="in-none">No band has been set on a case in this period.</p>
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
