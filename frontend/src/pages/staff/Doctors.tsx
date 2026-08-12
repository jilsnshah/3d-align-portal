import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, formatDate } from "../../api";
import type { PendingDoctor } from "../../api";
import { Empty, ErrorText, Loading } from "../../components/ui";

export default function StaffDoctors() {
  const queryClient = useQueryClient();
  const [pendingOnly, setPendingOnly] = useState(true);

  const doctors = useQuery({
    queryKey: ["staff-doctors", pendingOnly],
    queryFn: () => api.staffDoctors(pendingOnly),
  });

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Doctors</h1>
          <p className="sub">Verify council registration before a clinic can submit cases.</p>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={pendingOnly}
            onChange={(e) => setPendingOnly(e.target.checked)}
          />
          Awaiting verification only
        </label>
      </div>

      {doctors.isLoading ? (
        <Loading what="doctors" />
      ) : doctors.data?.length === 0 ? (
        <Empty>{pendingOnly ? "Nobody is waiting for verification." : "No doctors yet."}</Empty>
      ) : (
        <div className="stack">
          {doctors.data?.map((doctor) => (
            <DoctorCard
              key={doctor.id}
              doctor={doctor}
              onDone={() => {
                void queryClient.invalidateQueries({ queryKey: ["staff-doctors"] });
                void queryClient.invalidateQueries({ queryKey: ["queue"] });
              }}
            />
          ))}
        </div>
      )}
    </main>
  );
}

function DoctorCard({ doctor, onDone }: { doctor: PendingDoctor; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const verify = useMutation({
    mutationFn: (approve: boolean) => api.verifyDoctor(doctor.id, approve, reason),
    onSuccess: onDone,
  });

  const check = doctor.registry_check_result as
    | { checked?: boolean; passed?: boolean; name_match_score?: number; registry_names?: string[]; reason?: string }
    | null;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>{doctor.full_name}</h3>
          <p className="dim">
            {doctor.clinic_name || "No clinic name"} · {doctor.email}
          </p>
        </div>
        <span
          className={
            doctor.verification_status === "VERIFIED"
              ? "pill pill-ok"
              : doctor.verification_status === "REJECTED"
                ? "pill pill-danger"
                : "pill pill-gold"
          }
        >
          {doctor.verification_status.toLowerCase()}
        </span>
      </div>

      <div className="grid-2">
        <dl className="kv">
          <dt>Council</dt>
          <dd>{doctor.dental_council || "—"}</dd>
          <dt>Registration</dt>
          <dd className="mono">{doctor.registration_number || "—"}</dd>
          <dt>Phone</dt>
          <dd>{doctor.phone || "—"}</dd>
          <dt>Signed up</dt>
          <dd>{formatDate(doctor.created_at)}</dd>
        </dl>

        <div>
          <h4 style={{ marginBottom: 6 }}>Registry check</h4>
          {!check || !check.checked ? (
            <p className="dim">
              Not checked automatically{check?.reason ? ` — ${check.reason}` : ""}. Verify against
              the council register yourself.
            </p>
          ) : (
            <>
              <p>
                <span className={check.passed ? "pill pill-ok" : "pill pill-warn"}>
                  {check.passed ? "Name matched" : "No confident match"}
                </span>{" "}
                <span className="dim num">score {check.name_match_score}</span>
              </p>
              {check.registry_names && check.registry_names.length > 0 && (
                <p className="dim" style={{ marginTop: 6 }}>
                  Register says: {check.registry_names.join(", ")}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {doctor.verification_status === "PENDING" && (
        <div className="stack-sm" style={{ marginTop: 16 }}>
          <input
            placeholder="Reason (required to reject)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <ErrorText error={verify.error} />
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={verify.isPending}
              onClick={() => verify.mutate(true)}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={verify.isPending || !reason.trim()}
              onClick={() => verify.mutate(false)}
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {doctor.verification_status === "REJECTED" && doctor.rejection_reason && (
        <p style={{ marginTop: 12, color: "var(--danger)", fontSize: "0.88rem" }}>
          Rejected: {doctor.rejection_reason}
        </p>
      )}
    </div>
  );
}
