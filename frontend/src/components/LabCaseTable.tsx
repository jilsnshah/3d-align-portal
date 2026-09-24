/* The lab's case table.
 *
 * The same frame as the clinic's — the case and patient pinned while the rest
 * scrolls under them, the journey drawn as segments, one anchor per row — read
 * from the other side of the counter. The gold rail marks what is on the lab's
 * desk, and the line under the patient says what the lab has to do next; a
 * case waiting on a clinic says so quietly instead.
 *
 * Shared by the queue and the case list, so a case reads the same on both.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, formatDate, since } from "../api";
import type { OrderSummary } from "../api";
import StageTrack from "./StageTrack";
import { CategoryPill, StatusPill } from "./ui";
import { ASK_ONE, LAB_ASK_ONE, onLabDesk } from "../workflow";

/** "11 Sep, 10:30" — the year only when it is not this one. */
export function shortWhen(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const day = d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "2-digit" }),
  });
  const time = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day}, ${time}`;
}

function archLabel(arch: OrderSummary["arch"]): string {
  if (arch === "UPPER") return "Upper";
  if (arch === "LOWER") return "Lower";
  return "Both";
}

/** What is being made, and how big. */
function TreatmentCell({ order }: { order: OrderSummary }) {
  if (order.kind !== "ALIGNER") {
    return <span className="cell-treat">{order.product_label || "—"}</span>;
  }
  return (
    <span className="cell-treat">
      {order.category_label ? (
        <CategoryPill label={order.category_label} confirmed={order.category_confirmed} />
      ) : (
        <span className="dim" title="The band is set when the treatment plan is made">
          Not sized yet
        </span>
      )}
      <span className="cell-arch">{archLabel(order.arch)}</span>
    </span>
  );
}

/** Who is planning a case, changed from the table itself.
 *
 *  The admin picks from the list; an orthodontist sees the name and cannot
 *  move it, because handing cases around is what divides the board in the
 *  first place. The roster is fetched once for the whole table rather than per
 *  row.
 */
export function AssigneeCell({ order, canAssign }: { order: OrderSummary; canAssign: boolean }) {
  const queryClient = useQueryClient();
  const people = useQuery({
    queryKey: ["orthodontists"],
    queryFn: api.orthodontists,
    enabled: canAssign,
    staleTime: 5 * 60 * 1000,
  });

  const assign = useMutation({
    mutationFn: (userId: string | null) => api.assignCase(order.id, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["staff-orders"] });
      void queryClient.invalidateQueries({ queryKey: ["queue"] });
    },
  });

  if (!canAssign) {
    return order.assigned_to_name ? <span>{order.assigned_to_name}</span> : <span className="dim">3D Align</span>;
  }

  return (
    <select
      className="assignee-select"
      value={order.assigned_to_id ?? ""}
      disabled={assign.isPending}
      onChange={(e) => assign.mutate(e.target.value || null)}
      title={assign.error ? String(assign.error) : undefined}
    >
      <option value="">3D Align</option>
      {(people.data ?? [])
        .filter((p) => p.is_active || p.id === order.assigned_to_id)
        .map((p) => (
          <option key={p.id} value={p.id}>
            {p.full_name || p.email}
            {p.is_active ? "" : " (inactive)"}
          </option>
        ))}
    </select>
  );
}

export default function LabCaseTable({
  orders,
  canAssign,
  onOpen,
  planner = true,
}: {
  orders: OrderSummary[];
  canAssign: boolean;
  onOpen: (id: string) => void;
  /** The planner column, which only aligner cases carry. */
  planner?: boolean;
}) {
  return (
    <div className="case-table lab-table">
      <table>
        <thead>
          <tr>
            <th className="col-case">Case</th>
            <th className="col-patient">Patient</th>
            <th className="col-clinic">Clinic</th>
            {planner && <th className="col-plan">Planned by</th>}
            <th>Treatment</th>
            <th>Stage</th>
            <th className="col-progress">Progress</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const closed = order.status === "COMPLETED" || order.status === "CANCELLED";
            const desk = onLabDesk(order);
            const clinicAsk = !closed && order.needs_doctor_action ? ASK_ONE[order.status] : undefined;
            return (
              <tr
                key={order.id}
                className={`clickable${desk ? " wants" : ""}${closed ? " done" : ""}`}
                onClick={() => onOpen(order.id)}
              >
                <td className="col-case mono">{order.order_number}</td>
                <td className="col-patient">
                  <span className="cell-title" title={order.patient_number || undefined}>
                    {order.patient_name || "Aligner accessories"}
                    {order.priority === "EXPRESS" && (
                      <span className="tag-express" title="Express">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" strokeLinejoin="round" />
                        </svg>
                        Express
                      </span>
                    )}
                  </span>
                  {desk ? (
                    <span className="cell-ask">{LAB_ASK_ONE[order.status]}</span>
                  ) : clinicAsk ? (
                    <span className="cell-wait">With the clinic · {clinicAsk}</span>
                  ) : null}
                </td>
                <td className="col-clinic" title={[order.clinic_name, order.doctor_name].filter(Boolean).join(" · ")}>
                  <span className="lc-clinic">
                    <b>{order.clinic_name || order.doctor_name}</b>
                    {order.clinic_name && <span>{order.doctor_name}</span>}
                  </span>
                </td>
                {planner && (
                  /* Stops the click reaching the row, which would open the case.
                     Only a case in the aligner series — one carrying an AL
                     number rather than an enquiry's EN reference — can be
                     handed to an orthodontist, so only those get the menu. */
                  <td className="col-plan" onClick={(e) => e.stopPropagation()}>
                    {order.kind === "ALIGNER" && order.order_number && !order.order_number.startsWith("EN") ? (
                      <AssigneeCell order={order} canAssign={canAssign} />
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                )}
                <td>
                  <TreatmentCell order={order} />
                </td>
                <td>
                  <StatusPill status={order.status} label={order.status_label} />
                </td>
                <td className="col-progress">
                  <StageTrack order={order} />
                </td>
                <td
                  className="col-when"
                  title={`Opened ${formatDate(order.created_at)} · last change ${since(order.updated_at)} ago`}
                >
                  {shortWhen(order.created_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
