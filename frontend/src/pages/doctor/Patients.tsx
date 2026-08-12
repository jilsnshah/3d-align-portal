import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, formatDate } from "../../api";
import { Empty, ErrorText, Field, Loading } from "../../components/ui";

export default function Patients() {
  const queryClient = useQueryClient();
  const patients = useQuery({ queryKey: ["patients"], queryFn: api.patients });
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
      </div>

      <div className="split">
        <div>
          {patients.data?.length === 0 ? (
            <Empty>No patients yet.</Empty>
          ) : (
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
                  {patients.data?.map((patient) => (
                    <tr key={patient.id}>
                      <td>{patient.full_name}</td>
                      <td className="mono">{patient.external_ref || "—"}</td>
                      <td>{patient.date_of_birth || "—"}</td>
                      <td className="dim">{formatDate(patient.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
