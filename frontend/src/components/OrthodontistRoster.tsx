import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../api";
import { Banner, ErrorText, Field } from "./ui";

/** The orthodontists who plan for the lab.
 *
 *  They work the same tools as the admin — settings, bookings, technicians, the
 *  case screens — on the cases assigned to them and no others. Only the admin
 *  can create or close an account, because making a colleague is the same
 *  power as handing cases around.
 */
export default function OrthodontistRoster() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const roster = useQuery({ queryKey: ["orthodontists"], queryFn: api.orthodontists });

  const create = useMutation({
    mutationFn: () => api.createOrthodontist({ email, password, full_name: name }),
    onSuccess: () => {
      setOpen(false);
      setEmail("");
      setName("");
      setPassword("");
      void queryClient.invalidateQueries({ queryKey: ["orthodontists"] });
    },
  });

  const toggle = useMutation({
    mutationFn: (v: { id: string; is_active: boolean }) =>
      api.updateOrthodontist(v.id, { is_active: v.is_active }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["orthodontists"] }),
  });

  const rows = roster.data ?? [];

  return (
    <div className="card stack-sm" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h4>Orthodontists</h4>
        <span className="dim">
          They see only the cases assigned to them, and everything else the lab sees.
        </span>
      </div>

      {rows.length === 0 && <p className="dim">Nobody yet. Every case stays with the lab.</p>}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>{p.full_name || "—"}</td>
                  <td className="dim">{p.email}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={p.is_active}
                      disabled={toggle.isPending}
                      onChange={(e) => toggle.mutate({ id: p.id, is_active: e.target.checked })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toggle.error != null && <ErrorText error={toggle.error} />}

      {open ? (
        <>
          <div className="grid-2">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dr. …" />
            </Field>
            <Field label="Email">
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
            </Field>
          </div>
          <Field label="Password (at least 8 characters)">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <ErrorText error={create.error} />
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn-primary"
              disabled={!email || password.length < 8 || create.isPending}
              onClick={() => create.mutate()}
            >
              Add the orthodontist
            </button>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="row">
          <button type="button" className="btn-ghost" onClick={() => setOpen(true)}>
            Add an orthodontist
          </button>
        </div>
      )}

      <Banner tone="warn">
        Deactivating an account signs it out at once. The cases stay where they are and
        remain visible to the lab.
      </Banner>
    </div>
  );
}
