import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { api, formatDate, openFreshTab } from "../api";
import { useAuth } from "../auth";

const DOCTOR_NAV = [
  { to: "/", label: "Home" },
  { to: "/orders", label: "Cases" },
  { to: "/catalogue", label: "Products" },
  { to: "/patients", label: "Patients" },
  { to: "/profile", label: "Profile" },
];

const ADMIN_NAV = [
  { to: "/staff", label: "Queue" },
  { to: "/staff/orders", label: "All cases" },
  { to: "/staff/doctors", label: "Doctors" },
  { to: "/staff/bookings", label: "Bookings" },
  { to: "/staff/technicians", label: "Technicians" },
  { to: "/staff/settings", label: "Settings" },
];

const TECH_NAV = [{ to: "/tech", label: "My schedule" }];

export default function Layout() {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const isAdmin = me?.role === "ADMIN" || me?.role === "ORTHODONTIST";
  const isOrtho = me?.role === "ORTHODONTIST";
  const isTech = me?.role === "TECHNICIAN";
  const nav = isAdmin ? ADMIN_NAV : isTech ? TECH_NAV : DOCTOR_NAV;

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
        <NavLink to={isAdmin ? "/staff" : isTech ? "/tech" : "/"} className="brand">
          <img className="brand-logo" src="/logo.png" alt="3D Aligners" />
          {isAdmin && <span className="brand-sub">{isOrtho ? "Planning" : "Lab"}</span>}
          {isTech && <span className="brand-sub">Scan team</span>}
        </NavLink>

        <nav className="topnav">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/staff" || item.to === "/" || item.to === "/tech"}
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
            <b>
              {me?.doctor?.full_name ??
                me?.full_name ??
                (isTech ? "Scan technician" : "3D Align Lab")}
            </b>
            {me?.email}
          </div>
          <button
            type="button"
            className="bell"
            title="Opens a new tab signed out, so you can use another account alongside this one"
            onClick={openFreshTab}
          >
            + Account
          </button>
          <button type="button" className="bell" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>

      {drawerOpen && (
        <button
          type="button"
          className="drawer-scrim"
          aria-label="Close alerts"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {drawerOpen && (
        <aside className="drawer" aria-label="Alerts">
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
