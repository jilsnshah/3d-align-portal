/* The 3D plan, on its own page.

   Opened from the treatment plan rather than embedded in it: the clinic is
   usually looking at this full-screen with a patient beside them. */

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { api } from "../api";
import ArchViewer from "../components/ArchViewer";
import { Empty, Loading } from "../components/ui";
import { useAuth } from "../auth";

export default function Viewer() {
  const { orderId } = useParams();
  const { me } = useAuth();
  const simulation = useQuery({
    queryKey: ["simulation", orderId],
    queryFn: () => api.simulation(orderId!),
    enabled: Boolean(orderId),
  });

  const backTo =
    me?.role === "ADMIN" ? `/staff/orders/${orderId}` : `/orders/${orderId}`;

  if (simulation.isLoading) return <Loading what="the plan" />;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Treatment simulation</h1>
          <p className="sub">
            {simulation.data?.order_reference} · {simulation.data?.patient_name}
            {simulation.data?.total_aligners
              ? ` · ${simulation.data.total_aligners} aligners`
              : ""}
          </p>
        </div>
        <Link to={backTo}>
          <button type="button" className="btn-ghost">
            Back to the case
          </button>
        </Link>
      </div>

      {!simulation.data?.stages.length ? (
        <Empty>
          The lab has not uploaded staged models for this case yet.
        </Empty>
      ) : (
        <ArchViewer orderId={orderId!} simulation={simulation.data} />
      )}
    </main>
  );
}
