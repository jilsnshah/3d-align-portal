import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useAuth } from "../auth";
import { ErrorText, Field } from "../components/ui";

export default function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await signIn(email, password);
      navigate(me.role === "ADMIN" ? "/staff" : me.role === "TECHNICIAN" ? "/tech" : "/orders");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <img className="brand-logo" src="/logo.png" alt="3D Aligners" />
          <span className="brand-sub">Clear aligner lab</span>
        </div>
        <div className="card">
          <h2 style={{ marginBottom: 4 }}>Sign in</h2>
          <p className="muted" style={{ marginBottom: 18, fontSize: "0.9rem" }}>
            Order portal for clear aligner cases.
          </p>
          <form className="stack-sm" onSubmit={handleSubmit}>
            <Field label="Email">
              <input
                type="email"
                value={email}
                autoComplete="username"
                required
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                required
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <ErrorText error={error} />
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
        <p className="auth-foot">
          New to 3D Align? <Link to="/register">Register your clinic</Link>
        </p>
      </div>
    </div>
  );
}
