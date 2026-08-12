import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { api, formatDate } from "../api";
import { useAuth } from "../auth";

const DOCTOR_NAV = [
  { to: "/orders", label: "Cases" },
  { to: "/orders/new", label: "New case" },
  { to: "/patients", label: "Patients" },
  { to: "/profile", label: "Profile" },
];

const STAFF_NAV = [
  { to: "/staff", label: "Queue" },
  { to: "/staff/orders", label: "All cases" },
  { to: "/staff/doctors", label: "Doctors" },
];

export default function Layout() {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const isStaff = me?.role === "STAFF";
  const nav = isStaff ? STAFF_NAV : DOCTOR_NAV;

  const unread = useQuery({
    queryKey: ["unread"],
    queryFn: api.unreadCount,
    refetchInterval: 60_000,
  });

  const notifications = useQuery({
    queryKey: ["notifications"],
    queryFn: api.notifications,
    enabled: drawerOpen,
  });

  async function handleSignOut() {
    await signOut();
    queryClient.clear();
    navigate("/login");
  }

  async function openDrawer() {
    const next = !drawerOpen;
    setDrawerOpen(next);
    if (next && (unread.data?.count ?? 0) > 0) {
      await api.markAllRead();
      void queryClient.invalidateQueries({ queryKey: ["unread"] });
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to={isStaff ? "/staff" : "/orders"} className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>
            3D Align
            {isStaff && <span className="brand-sub"> · Lab</span>}
          </span>
        </NavLink>

        <nav className="topnav">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/staff" || item.to === "/orders"}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="topbar-right">
          <button type="button" className="bell" onClick={openDrawer}>
            Alerts
            {(unread.data?.count ?? 0) > 0 && (
              <span className="bell-count">{unread.data?.count}</span>
            )}
          </button>
          <div className="who">
            <b>{me?.doctor?.full_name ?? "3D Align Lab"}</b>
            {me?.email}
          </div>
          <button type="button" className="bell" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>

      {drawerOpen && (
        <aside className="drawer">
          <div className="row-between" style={{ marginBottom: 12 }}>
            <h2>Alerts</h2>
            <button type="button" className="btn-link" onClick={() => setDrawerOpen(false)}>
              Close
            </button>
          </div>
          {notifications.isLoading && <p className="dim">Loading…</p>}
          {notifications.data?.length === 0 && <p className="dim">Nothing yet.</p>}
          {notifications.data?.map((note) => (
            <div key={note.id} className={`notif${note.read_at ? "" : " unread"}`}>
              <div className="t">{note.title}</div>
              <div className="b">{note.body}</div>
              <div className="dim">{formatDate(note.created_at)}</div>
            </div>
          ))}
        </aside>
      )}

      <Outlet />
    </div>
  );
}
