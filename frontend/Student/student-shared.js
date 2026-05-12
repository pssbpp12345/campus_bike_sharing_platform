/* Shared Student Components: Topbar, Sidebar, Icons, Auth helpers, Toasts */
const { useState, useEffect, useCallback } = React;

const StudentIcons = {
  logo: () => (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <circle cx="8" cy="22" r="5" stroke="currentColor" strokeWidth="2.4"/>
      <circle cx="24" cy="22" r="5" stroke="currentColor" strokeWidth="2.4"/>
      <path d="M11 22 L16 12 H22 M16 12 L20 22 M11 12 H14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  ),
  home:     () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 11l9-8 9 8v10a2 2 0 01-2 2h-4v-7H9v7H5a2 2 0 01-2-2V11z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>),
  calendar: () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M3 9h18M8 2v4M16 2v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  bike:     ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="6" cy="17" r="3.5" stroke="currentColor" strokeWidth="2"/><circle cx="18" cy="17" r="3.5" stroke="currentColor" strokeWidth="2"/><path d="M8 17 L12 9 H15 M12 9 L15 17 M8 9 H11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>),
  person:   () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  help:     () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/><path d="M9.5 9a2.5 2.5 0 015 0c0 1.5-2.5 2-2.5 4M12 17.5v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  bell:     () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 16V11a6 6 0 1112 0v5l1.5 2H4.5L6 16zm4 4a2 2 0 004 0" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/></svg>),
  search:   () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  pin:      () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 22s7-7.5 7-13a7 7 0 10-14 0c0 5.5 7 13 7 13z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><circle cx="12" cy="9" r="2.5" stroke="currentColor" strokeWidth="2"/></svg>),
  check:    () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  alert:    () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 9v4M12 17v.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/><path d="M10.3 3.86 1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>),
  route:    ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="6" cy="19" r="3" stroke="currentColor" strokeWidth="2"/><circle cx="18" cy="5" r="3" stroke="currentColor" strokeWidth="2"/><path d="M9 19h6a4 4 0 000-8H9a4 4 0 010-8h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  leaf:     ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M3 21c0-8 6-14 18-14 0 8-5 14-13 14a5 5 0 01-5 0z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M3 21c5-5 9-7 13-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  wallet:   ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="14" rx="3" stroke="currentColor" strokeWidth="2"/><path d="M16 13h2" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/><path d="M3 9c0-1.5 1-3 3-3h12" stroke="currentColor" strokeWidth="2"/></svg>),
  mail:     () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M3 7l9 7 9-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  phone:    () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 4l3-1 3 5-2 2c1 3 3 5 6 6l2-2 5 3-1 3a3 3 0 01-3 2C9.6 22 2 14.4 2 7a3 3 0 013-3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>),
  id:       () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2"/><circle cx="9" cy="12" r="2.5" stroke="currentColor" strokeWidth="2"/><path d="M14 10h4M14 14h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  shield:   () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  lock:     () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M8 10V7a4 4 0 018 0v3" stroke="currentColor" strokeWidth="2"/></svg>),
  edit:     () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 20h4l11-11-4-4L4 16v4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M14 6l4 4" stroke="currentColor" strokeWidth="2"/></svg>),
  chev:     () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  send:     () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 11l18-7-7 18-3-7-8-4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>),
  bug:      () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="6" y="8" width="12" height="13" rx="6" stroke="currentColor" strokeWidth="2"/><path d="M9 5l1 3M15 5l-1 3M4 13h2M18 13h2M4 18h2M18 18h2M4 8h2M18 8h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  card:     () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M3 10h18" stroke="currentColor" strokeWidth="2"/></svg>),
  user2:    () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="9" r="3.5" stroke="currentColor" strokeWidth="2"/><path d="M5 21c0-4 3-6 7-6s7 2 7 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  station:  () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 21V8l8-5 8 5v13" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M9 21v-6h6v6" stroke="currentColor" strokeWidth="2"/></svg>),
  more:     () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/><path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  logout:   () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M15 5h3a2 2 0 012 2v10a2 2 0 01-2 2h-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M10 17l5-5-5-5M3 12h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>),
};
window.StudentIcons = StudentIcons;

function StudentTopbar({ active, user, onLogout, pushToast }) {
  const firstName = (user && (user.full_name || user.name) || "Rider").split(" ")[0];
  return (
    <header className="d-topbar">
      <a href="Student_dashboard.html" className="d-brand" data-testid="topbar-brand">
        <span className="d-brand-logo"><StudentIcons.logo/></span>
        <span className="d-brand-name">Campus <span className="accent">Bike Sharing</span></span>
      </a>
      <nav className="d-nav">
        <a className={"d-nav-item" + (active === "home" ? " active" : "")} href="Student_dashboard.html" data-testid="topbar-home">
          <StudentIcons.home/><span className="d-nav-text">Home</span>
        </a>
        <a className={"d-nav-item" + (active === "bookings" ? " active" : "")} href="Student_MyBooking.html" data-testid="topbar-bookings">
          <StudentIcons.calendar/><span className="d-nav-text">My Bookings</span>
        </a>
        <button className="d-icon-btn" title="Notifications" onClick={() => pushToast && pushToast("No new notifications", "You're all caught up!")} data-testid="topbar-notif">
          <StudentIcons.bell/>
        </button>
        <a className="d-user-avatar" href="Student_profile.html" title="Profile" data-testid="topbar-profile-avatar">
          {firstName.charAt(0).toUpperCase()}
        </a>
      </nav>
    </header>
  );
}
window.StudentTopbar = StudentTopbar;

function StudentSidebar({ active }) {
  return (
    <aside className="d-sidebar">
      <a className={"d-side-btn" + (active === "home" ? " active" : "")} href="Student_dashboard.html" title="Dashboard" data-testid="side-home"><StudentIcons.home/></a>
      <a className={"d-side-btn" + (active === "bookings" ? " active" : "")} href="Student_MyBooking.html" title="My Bookings" data-testid="side-bookings"><StudentIcons.calendar/></a>
      <a className={"d-side-btn" + (active === "rides" ? " active" : "")} href="Student_ride_history.html" title="Ride History" data-testid="side-rides"><StudentIcons.bike/></a>
      <a className={"d-side-btn" + (active === "profile" ? " active" : "")} href="Student_profile.html" title="Profile" data-testid="side-profile"><StudentIcons.person/></a>
      <a className={"d-side-btn" + (active === "help" ? " active" : "")} href="Student_need_help.html" title="Need Help" data-testid="side-help"><StudentIcons.help/></a>
    </aside>
  );
}
window.StudentSidebar = StudentSidebar;

function StudentToastStack({ toasts }) {
  if (!toasts || !toasts.length) return null;
  return (
    <div className="s-toast-wrap" data-testid="toast-stack">
      {toasts.map(t => (
        <div key={t.id} className={"s-toast" + (t.type === "error" ? " error" : "")}>
          <div className="ico">{t.type === "error" ? <StudentIcons.alert/> : <StudentIcons.check/>}</div>
          <div className="body">
            <div className="title">{t.title}</div>
            {t.text && <div className="text">{t.text}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
window.StudentToastStack = StudentToastStack;

window.useStudentAuth = function () {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem("cbs_user") || "null"); } catch (_) { return null; }
  });
  const [toasts, setToasts] = useState([]);
  const pushToast = useCallback((title, text, type) => {
    const id = "t" + Date.now() + Math.random();
    setToasts(prev => [...prev, { id, title, text, type }]);
    setTimeout(() => setToasts(prev => prev.filter(x => x.id !== id)), 4000);
  }, []);
  const requireAuth = useCallback(() => {
    const token = localStorage.getItem("cbs_token");
    if (!token) { window.location.replace("../../login.html"); return false; }
    return true;
  }, []);
  const logout = useCallback(() => {
    try { localStorage.removeItem("cbs_token"); localStorage.removeItem("cbs_user"); } catch (_) {}
    window.location.replace("../../login.html?loggedout=1");
  }, []);
  return { user, setUser, toasts, pushToast, requireAuth, logout };
};
