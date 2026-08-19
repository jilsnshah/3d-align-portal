import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { useNavigate } from "react-router-dom";

import { PAGE_SIZE, api, formatDate } from "../../api";
import { LoadMore } from "../../components/LoadMore";
import { StatusPill } from "../../components/ui";
import { Empty, ErrorText, Field, Loading } from "../../components/ui";

export default function Patients() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [openPatient, setOpenPatient] = useState<string | null>(null);
  const patients = useInfiniteQuery({
    queryKey: ["patients", "list", search],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.patients({ limit: PAGE_SIZE + 1, offset: pageParam as number }, search),
    // A full page plus the probe row means there is another page behind it.
    getNextPageParam: (last, all) => (last.length > PAGE_SIZE ? all.length * PAGE_SIZE : undefined),
  });
  const rows = (patients.data?.pages ?? []).flatMap((p) => p.slice(0, PAGE_SIZE));
  const [form, setForm] = useState({ full_name: "", date_of_birth: "", sex: "", external_ref: "" });

  const create = useMutation({
    mutationFn: () => api.createPatient(form),
    onSuccess: () => {
      setForm({ full_name: "", date_of_birth: "", sex: "", external_ref: "" });
      void queryClient.invalidateQueries({ queryKey: ["patients"] });
    },
  });

  if (patients.isLoading) return <Loading what="patients" />;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Patients</h1>
          <p className="sub">Patients are private to your clinic.</p>
        </div>
        <input
          placeholder="Search by name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 240 }}
        />
      </div>

      <div className="split">
        <div>
          {rows.length === 0 ? (
            <Empty>No patients yet.</Empty>
          ) : (
            <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Chart no.</th>
                    <th>Date of birth</th>
                    <th>Added</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((patient) => (
                    <Fragment key={patient.id}>
                      <tr
                        className="clickable"
                        onClick={() =>
                          setOpenPatient((id) => (id === patient.id ? null : patient.id))
                        }
                      >
                        <td>{patient.full_name}</td>
                        <td className="mono">{patient.external_ref || "—"}</td>
                        <td>{patient.date_of_birth || "—"}</td>
                        <td className="dim">{formatDate(patient.created_at)}</td>
                      </tr>
                      {openPatient === patient.id && (
                        <tr>
                          <td colSpan={4} style={{ background: "var(--paper)" }}>
                            <PatientCases patientId={patient.id} name={patient.full_name} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <LoadMore query={patients} noun="patients" shown={rows.length} />
            </>
          )}
        </div>

        <form
          className="card stack-sm"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <h4>Add a patient</h4>
          <Field label="Full name">
            <input
              required
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            />
          </Field>
          <Field label="Date of birth">
            <input
              type="date"
              value={form.date_of_birth}
              onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
            />
          </Field>
          <Field label="Sex">
            <select value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value })}>
              <option value="">Not stated</option>
              <option value="F">Female</option>
              <option value="M">Male</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
          <Field label="Your chart number">
            <input
              value={form.external_ref}
              onChange={(e) => setForm({ ...form, external_ref: e.target.value })}
            />
          </Field>
          <ErrorText error={create.error} />
          <button type="submit" className="btn-primary" disabled={create.isPending}>
            Add patient
          </button>
        </form>
      </div>
    </main>
  );
}


/** The cases opened for one patient, revealed under their row. */
function PatientCases({ patientId, name }: { patientId: string; name: string }) {
  const navigate = useNavigate();
  const cases = useQuery({
    queryKey: ["patient-cases", patientId],
    queryFn: () => api.orders(false, { limit: 50 }, { patientId }),
  });

  if (cases.isLoading) return <p className="dim">Loading cases…</p>;
  if (!cases.data?.length) return <p className="dim">No cases for {name} yet.</p>;

  return (
    <div className="stack-sm" style={{ padding: "4px 0" }}>
      {cases.data.map((order) => (
        <button
          key={order.id}
          type="button"
          className="patient-case"
          onClick={() => navigate(`/orders/${order.id}`)}
        >
          <span className="mono">{order.order_number}</span>
          <StatusPill status={order.status} label={order.status_label} />
          <span className="dim">{formatDate(order.updated_at)}</span>
        </button>
      ))}
    </div>
  );
}
