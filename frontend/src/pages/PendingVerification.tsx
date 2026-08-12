import { useAuth } from "../auth";
import { Banner } from "../components/ui";

export default function PendingVerification() {
  const { me, refresh } = useAuth();
  const rejected = me?.doctor?.verification_status === "REJECTED";

  return (
    <div className="page page-narrow">
      <div className="card" style={{ marginTop: "6vh" }}>
        <h1 style={{ marginBottom: 8 }}>
          {rejected ? "Verification was not approved" : "Verification in progress"}
        </h1>

        {rejected ? (
          <>
            <Banner tone="danger">
              {me?.doctor?.rejection_reason || "Contact 3D Align for details."}
            </Banner>
            <p className="muted" style={{ marginTop: 14 }}>
              Get in touch with the lab to resolve this and have your account reviewed again.
            </p>
          </>
        ) : (
          <>
            <p className="muted">
              3D Align is checking your council registration. You will be able to submit cases as
              soon as the lab approves your account.
            </p>
            <dl className="kv" style={{ marginTop: 18 }}>
              <dt>Practitioner</dt>
              <dd>{me?.doctor?.full_name}</dd>
              <dt>Clinic</dt>
              <dd>{me?.doctor?.clinic_name || "—"}</dd>
              <dt>Council</dt>
              <dd>{me?.doctor?.dental_council || "—"}</dd>
              <dt>Registration</dt>
              <dd className="mono">{me?.doctor?.registration_number || "—"}</dd>
            </dl>
          </>
        )}

        <div className="row" style={{ marginTop: 20 }}>
          <button type="button" className="btn-ghost" onClick={() => void refresh()}>
            Check again
          </button>
        </div>
      </div>
    </div>
  );
}
