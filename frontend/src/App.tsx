import { Navigate, Route, Routes } from "react-router-dom";

import Layout from "./components/Layout";
import { Loading } from "./components/ui";
import { useAuth } from "./auth";
import Login from "./pages/Login";
import Register from "./pages/Register";
import PendingVerification from "./pages/PendingVerification";
import Catalogue from "./pages/doctor/Catalogue";
import DoctorHome from "./pages/doctor/Home";
import DoctorOrders from "./pages/doctor/Orders";
import NewOrder from "./pages/doctor/NewOrder";
import DoctorOrderDetail from "./pages/doctor/OrderDetail";
import Patients from "./pages/doctor/Patients";
import Profile from "./pages/doctor/Profile";
import StaffQueue from "./pages/staff/Queue";
import StaffOrders from "./pages/staff/Orders";
import StaffOrderDetail from "./pages/staff/OrderDetail";
import StaffDoctors from "./pages/staff/Doctors";
import AdminBookings from "./pages/admin/Bookings";
import AdminTechnicians from "./pages/admin/Technicians";
import AdminSettings from "./pages/admin/Settings";
import TechSchedule from "./pages/tech/Schedule";
import StatsPage from "./pages/Stats";
import Viewer from "./pages/Viewer";

export default function App() {
  const { me, loading } = useAuth();

  if (loading) return <Loading />;

  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (me.role === "TECHNICIAN") {
    return (
      <Routes>
        <Route element={<Layout />}>
          <Route path="/tech" element={<TechSchedule />} />
          <Route path="/tech/jobs/:orderId" element={<StaffOrderDetail />} />
          <Route path="/viewer/:orderId" element={<Viewer />} />
        </Route>
        <Route path="*" element={<Navigate to="/tech" replace />} />
      </Routes>
    );
  }

  if (me.role === "ADMIN" || me.role === "ORTHODONTIST") {
    return (
      <Routes>
        <Route element={<Layout />}>
          <Route path="/staff" element={<StaffQueue />} />
          <Route path="/staff/orders" element={<StaffOrders />} />
          <Route path="/staff/orders/:orderId" element={<StaffOrderDetail />} />
          <Route path="/viewer/:orderId" element={<Viewer />} />
          <Route path="/staff/doctors" element={<StaffDoctors />} />
          <Route path="/staff/bookings" element={<AdminBookings />} />
          <Route path="/staff/technicians" element={<AdminTechnicians />} />
          <Route path="/staff/settings" element={<AdminSettings />} />
          <Route path="/staff/stats" element={<StatsPage lab />} />
        </Route>
        <Route path="*" element={<Navigate to="/staff" replace />} />
      </Routes>
    );
  }

  if (me.doctor && me.doctor.verification_status !== "VERIFIED") {
    return (
      <Routes>
        <Route element={<Layout />}>
          <Route path="/pending" element={<PendingVerification />} />
        </Route>
        <Route path="*" element={<Navigate to="/pending" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DoctorHome />} />
        <Route path="/orders" element={<DoctorOrders />} />
        <Route path="/orders/new" element={<NewOrder />} />
        <Route path="/orders/:orderId" element={<DoctorOrderDetail />} />
        {/* The clinic reviews the planned movement here before approving the
            plan, so the viewer has to be reachable from their side too. */}
        <Route path="/viewer/:orderId" element={<Viewer />} />
        <Route path="/catalogue" element={<Catalogue />} />
        <Route path="/patients" element={<Patients />} />
        <Route path="/stats" element={<StatsPage />} />
        <Route path="/profile" element={<Profile />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
