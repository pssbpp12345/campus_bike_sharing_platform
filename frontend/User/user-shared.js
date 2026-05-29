/* Shared User Components — full chrome that matches User_dashboard */
const { useState, useEffect, useCallback, useRef } = React;

const UserIcons = {
  // Keep these topbar/sidebar SVGs identical to User_dashboard.html.
  // This prevents the logo/nav/sidebar changing size between Dashboard/My Bookings and the shared pages.
  logo:     () => (<svg viewBox="0 0 64 64" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="16" cy="44" r="12"/><circle cx="48" cy="44" r="12"/><path d="M16 44 L28 24 L42 24 L48 44"/><path d="M28 24 L34 14 L42 14"/><circle cx="32" cy="24" r="2" fill="currentColor"/></svg>),
  home:     ({s=20} = {}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-4a2 2 0 0 0-2-2h0a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>),
  map:      ({s=22} = {}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21 3 6"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>),
  calendar: ({s=20} = {}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>),
  bike:     ({s=20} = {}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1" fill="currentColor"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>),
  person:   ({s=20} = {}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>),
  help:     ({s=20} = {}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>),
  bell:     ({s=22} = {}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>),
  search:   ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  pin:      ({s=14}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M12 22s7-7.5 7-13a7 7 0 10-14 0c0 5.5 7 13 7 13z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><circle cx="12" cy="9" r="2.5" stroke="currentColor" strokeWidth="2"/></svg>),
  check:    ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  alert:    ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M12 9v4M12 17v.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/><path d="M10.3 3.86 1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>),
  info:     ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/><path d="M12 8v.5M12 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  route:    ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="6" cy="19" r="3" stroke="currentColor" strokeWidth="2"/><circle cx="18" cy="5" r="3" stroke="currentColor" strokeWidth="2"/><path d="M9 19h6a4 4 0 000-8H9a4 4 0 010-8h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  leaf:     ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M3 21c0-8 6-14 18-14 0 8-5 14-13 14a5 5 0 01-5 0z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M3 21c5-5 9-7 13-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  wallet:   ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="14" rx="3" stroke="currentColor" strokeWidth="2"/><path d="M16 13h2" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/><path d="M3 9c0-1.5 1-3 3-3h12" stroke="currentColor" strokeWidth="2"/></svg>),
  mail:     ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M3 7l9 7 9-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  phone:    ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M5 4l3-1 3 5-2 2c1 3 3 5 6 6l2-2 5 3-1 3a3 3 0 01-3 2C9.6 22 2 14.4 2 7a3 3 0 013-3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>),
  id:       ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2"/><circle cx="9" cy="12" r="2.5" stroke="currentColor" strokeWidth="2"/><path d="M14 10h4M14 14h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  shield:   ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  lock:     ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M8 10V7a4 4 0 018 0v3" stroke="currentColor" strokeWidth="2"/></svg>),
  edit:     ({s=16}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M4 20h4l11-11-4-4L4 16v4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M14 6l4 4" stroke="currentColor" strokeWidth="2"/></svg>),
  chev:     ({s=16}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  send:     ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M3 11l18-7-7 18-3-7-8-4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>),
  bug:      ({s=20}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><rect x="6" y="8" width="12" height="13" rx="6" stroke="currentColor" strokeWidth="2"/><path d="M9 5l1 3M15 5l-1 3M4 13h2M18 13h2M4 18h2M18 18h2M4 8h2M18 8h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  card:     ({s=20}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M3 10h18" stroke="currentColor" strokeWidth="2"/></svg>),
  user2:    ({s=20}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="9" r="3.5" stroke="currentColor" strokeWidth="2"/><path d="M5 21c0-4 3-6 7-6s7 2 7 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  station:  ({s=20}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M4 21V8l8-5 8 5v13" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M9 21v-6h6v6" stroke="currentColor" strokeWidth="2"/></svg>),
  more:     ({s=20}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/><path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>),
  logout:   ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M15 5h3a2 2 0 012 2v10a2 2 0 01-2 2h-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M10 17l5-5-5-5M3 12h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  settings: ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 01-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1A2 2 0 117 4.6l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>),
  camera:   ({s=18}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M4 7h3l2-3h6l2 3h3a2 2 0 012 2v9a2 2 0 01-2 2H4a2 2 0 01-2-2V9a2 2 0 012-2z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="2"/></svg>),
  trash:    ({s=16}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/></svg>),
  reset:    ({s=16}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M4 12a8 8 0 0114-5l2-2v6h-6l2-2a6 6 0 100 6l1.5 1.5A8 8 0 014 12z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>),
  clock:    ({s=16}) => (<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/></svg>),
};
window.UserIcons = UserIcons;
window.StudentIcons = UserIcons; // legacy alias

/* ---------- API + auth helpers ---------- */
const AUTH_KEYS = { token: "cbs_token", user: "cbs_user" };

function redirectToLogin(next) {
  const target = next || (window.location.pathname + window.location.search);
  window.location.replace("../../login.html?next=" + encodeURIComponent(target));
}

function getAuthToken() {
  try {
    const token = localStorage.getItem(AUTH_KEYS.token);
    if (!token || token === "demo-token") return null;
    return token;
  } catch (_) {
    return null;
  }
}

function getCurrentUser() {
  try {
    const user = JSON.parse(localStorage.getItem(AUTH_KEYS.user) || "null");
    if (!user || String(user.id || "").startsWith("demo-")) return null;
    return user;
  } catch (_) {
    return null;
  }
}

function setCurrentUser(user) {
  if (!user) return;
  localStorage.setItem(AUTH_KEYS.user, JSON.stringify(user));
}

function clearAuth() {
  try {
    localStorage.removeItem(AUTH_KEYS.token);
    localStorage.removeItem(AUTH_KEYS.user);
  } catch (_) {}
}

async function authFetch(path, opts = {}) {
  const token = getAuthToken();
  const headers = Object.assign({}, opts.headers || {});
  if (token) headers.Authorization = "Bearer " + token;
  if (opts.body && !(opts.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    clearAuth();
    if (opts.redirectOnUnauthorized !== false) redirectToLogin();
  }
  return res;
}

window.getAuthToken = getAuthToken;
window.getCurrentUser = getCurrentUser;
window.setCurrentUser = setCurrentUser;
window.clearUserAuth = clearAuth;
window.clearStudentAuth = clearAuth; // legacy alias
window.authFetch = authFetch;
/* Backfill cached cbs_user from /api/profile when avatar_url is missing.
   This makes the topbar avatar work right after a fresh login even if
   /api/auth/me or /api/auth/login don't include avatar_url (e.g. older backend). */
window.cbsBackfillProfile = async function () {
  try {
    if (!getAuthToken()) return null;
    const cached = getCurrentUser() || {};
    // Only run when something obvious is missing — keeps cost to one fetch
    const needs = !cached.avatar_url || !cached.phone || !cached.student_id;
    if (!needs) return cached;
    const d = await window.cbsApi("/api/profile");
    if (!d || !d.user) return cached;
    const merged = { ...cached, ...d.user };
    setCurrentUser(merged);
    try { window.dispatchEvent(new CustomEvent("cbs:user-updated", { detail: merged })); } catch (_) {}
    return merged;
  } catch (_) { return null; }
};

window.requireUserAuth = async function () {
  if (!getAuthToken()) {
    clearAuth();
    redirectToLogin();
    return null;
  }
  const data = await window.cbsApi("/api/auth/me");
  // Merge with cached user instead of replacing — this preserves locally-set
  // fields like avatar_url when an older backend response doesn't include them.
  const cached = getCurrentUser() || {};
  const merged = { ...cached, ...(data && data.user ? data.user : {}) };
  // If the new response doesn't carry an avatar_url but the cache does, keep it.
  if (cached.avatar_url && !(data && data.user && Object.prototype.hasOwnProperty.call(data.user, "avatar_url"))) {
    merged.avatar_url = cached.avatar_url;
  }
  setCurrentUser(merged);
  try { window.dispatchEvent(new CustomEvent("cbs:user-updated", { detail: merged })); } catch (_) {}
  return merged;
};
window.requireStudentAuth = window.requireUserAuth; // legacy alias

window.cbsApi = async function (path, opts = {}) {
  const res = await authFetch(path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
};

window.cbsPublicSettings = {
  platformName: "Campus Bike Sharing",
  defaultCampusCity: "Sydney Campus",
  operatingHours: "6:00 AM - 10:00 PM",
  supportEmail: "support@campusbikesharing.local",
  currency: "AUD",
  maintenanceMode: false,
  allowNewRegistrations: true,
  pricing: {
    unlockFee: 1,
    perMinuteFee: 0.2,
    minimumRideDuration: 5,
    maximumRideDuration: 180,
    lateReturnFee: 5,
    cancellationFee: 0,
    refundWindowHours: 24,
  },
};

window.cbsLoadPublicSettings = async function () {
  if (window.__cbsPublicSettingsPromise) return window.__cbsPublicSettingsPromise;
  window.__cbsPublicSettingsPromise = fetch("/api/settings/public", { cache: "no-store" })
    .then((res) => res.ok ? res.json() : null)
    .then((data) => {
      if (data) {
        window.cbsPublicSettings = {
          ...window.cbsPublicSettings,
          ...data,
          pricing: { ...window.cbsPublicSettings.pricing, ...(data.pricing || {}) },
        };
        window.dispatchEvent(new CustomEvent("cbs:settings-updated", { detail: window.cbsPublicSettings }));
      }
      return window.cbsPublicSettings;
    })
    .catch(() => window.cbsPublicSettings);
  return window.__cbsPublicSettingsPromise;
};

window.cbsLoadPublicSettings();

/* ---------- Auth hook ---------- */
window.useStudentAuth = function () { return window.useUserAuth(); }; // legacy alias
window.useUserAuth = function () {
  const [user, setUser] = useState(() => getCurrentUser());
  const [toasts, setToasts] = useState([]);
  const pushToast = useCallback((title, text, type) => {
    const id = "t" + Date.now() + Math.random();
    setToasts(prev => [...prev, { id, title, text, type }]);
    setTimeout(() => setToasts(prev => prev.filter(x => x.id !== id)), 4000);
  }, []);
  const requireAuth = useCallback(() => {
    const token = getAuthToken();
    if (!token) { clearAuth(); redirectToLogin(); return false; }
    return true;
  }, []);
  const refreshUser = useCallback(async () => {
    try {
      const d = await window.cbsApi("/api/auth/me");
      // Merge instead of replace — keep cached avatar_url if the server response
      // doesn't include it (e.g. older backend build).
      const cached = getCurrentUser() || {};
      const merged = { ...cached, ...(d && d.user ? d.user : {}) };
      if (cached.avatar_url && !(d && d.user && Object.prototype.hasOwnProperty.call(d.user, "avatar_url"))) {
        merged.avatar_url = cached.avatar_url;
      }
      setCurrentUser(merged);
      setUser(merged);
      // Notify other components in the same tab (e.g. topbar) that user changed
      try { window.dispatchEvent(new CustomEvent("cbs:user-updated", { detail: merged })); } catch (_) {}
    } catch (_) {}
  }, []);
  const logout = useCallback(() => {
    clearAuth();
    window.location.replace("../../login.html?loggedout=1");
  }, []);
  // Keep `user` in sync when other tabs/pages update localStorage, or when the
  // current page dispatches "cbs:user-updated" (e.g. after avatar upload).
  useEffect(() => {
    const onStorage = (ev) => {
      if (ev.key === AUTH_KEYS.user) {
        try { setUser(ev.newValue ? JSON.parse(ev.newValue) : null); } catch (_) {}
      }
    };
    const onUserUpdated = (ev) => {
      if (ev && ev.detail) setUser(ev.detail);
      else setUser(getCurrentUser());
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("cbs:user-updated", onUserUpdated);
    // Backfill avatar/phone from /api/profile if missing on cached user.
    // This makes the topbar picture appear right after a fresh sign-in even
    // when /api/auth/login doesn't return avatar_url yet.
    if (typeof window.cbsBackfillProfile === "function") {
      window.cbsBackfillProfile().then(u => { if (u) setUser(u); }).catch(() => {});
    }
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("cbs:user-updated", onUserUpdated);
    };
  }, []);
  return { user, setUser, refreshUser, toasts, pushToast, requireAuth, logout };
};

/* ---------- Helpers ---------- */
function initials(name) {
  return (name || "").split(" ").map(p => p[0]).filter(Boolean).slice(0,2).join("").toUpperCase() || "U";
}
function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms/1000); if (s < 60) return s + "s ago";
  const m = Math.floor(s/60);   if (m < 60) return m + "m ago";
  const h = Math.floor(m/60);   if (h < 24) return h + "h ago";
  const d = Math.floor(h/24);   if (d < 7)  return d + "d ago";
  return new Date(iso).toLocaleDateString("en-AU", { day:"numeric", month:"short" });
}

/* ---------- Avatar circle ---------- */
function Avatar({ user, size = 42, square = false }) {
  const name = user?.full_name || user?.name || "User";
  const url = user?.avatar_url ? user.avatar_url : null;
  const style = { width: size, height: size, fontSize: Math.max(12, size * 0.36), borderRadius: square ? "16px" : "50%" };
  if (url) return <span className="cbs-avatar cbs-avatar-img" style={style}><img src={url} alt={name}/></span>;
  return <span className="cbs-avatar" style={style}>{initials(name)}</span>;
}
window.CbsAvatar = Avatar;

/* ---------- Notification Dropdown (DB-backed, with loading/error states) ---------- */
function NotifPanel({ items, loading, error, onMarkAll, onClickItem, onRetry }) {
  const kindIcon = { success: <UserIcons.check/>, info: <UserIcons.info/>, warning: <UserIcons.alert/>, error: <UserIcons.alert/> };
  const unreadCount = items.filter(n => !n.is_read).length;
  return (
    <div className="cbs-notif-panel" onClick={e => e.stopPropagation()} data-testid="notif-panel">
      <div className="cbs-notif-head">
        <h3>Notifications</h3>
        {!loading && !error && unreadCount > 0 && (
          <button className="cbs-notif-mark" onClick={onMarkAll} data-testid="notif-mark-all">Mark all as read</button>
        )}
      </div>
      <div className="cbs-notif-list">
        {loading && (
          <div className="cbs-notif-loading" data-testid="notif-loading">
            <div className="cbs-notif-spin"/>
            <div>Loading notifications…</div>
          </div>
        )}
        {!loading && error && (
          <div className="cbs-notif-error" data-testid="notif-error">
            Could not load notifications.
            <div style={{marginTop:8}}>
              <button className="cbs-notif-mark" onClick={onRetry}>Try again</button>
            </div>
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <div className="cbs-notif-empty">You're all caught up.</div>
        )}
        {!loading && !error && items.map(n => (
          <div key={n.id} className={"cbs-notif-item " + (n.is_read ? "" : "unread") + " kind-" + (n.kind || "info")}
               onClick={() => onClickItem(n)} data-testid={`notif-${n.id}`}>
            <div className={"cbs-notif-icon kind-" + (n.kind || "info")}>{kindIcon[n.kind] || <UserIcons.info/>}</div>
            <div className="cbs-notif-body">
              <div className="cbs-notif-title">{n.title}</div>
              {n.message && <div className="cbs-notif-text">{n.message}</div>}
              <div className="cbs-notif-time">{timeAgo(n.created_at)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Profile Dropdown ---------- */
function UserMenu({ user, onAction, onLogout }) {
  const role = (user?.role || "student").toUpperCase();
  return (
    <div className="cbs-user-panel" onClick={e => e.stopPropagation()} data-testid="user-panel">
      <div className="cbs-user-head">
        <Avatar user={user} size={52}/>
        <div style={{minWidth:0, flex:1}}>
          <div className="name" data-testid="user-name">{user?.full_name || "User"}</div>
          <div className="email" data-testid="user-email">{user?.email || "—"}</div>
          <span className="role-pill">{role}</span>
        </div>
      </div>
      <div className="cbs-user-list">
        <button onClick={() => onAction("profile")} data-testid="menu-profile"><span className="ico"><UserIcons.person/></span>View Profile</button>
        <button onClick={() => onAction("settings")} data-testid="menu-settings"><span className="ico"><UserIcons.settings/></span>Account Settings</button>
        <button onClick={() => onAction("help")} data-testid="menu-help"><span className="ico"><UserIcons.help/></span>Help &amp; Support</button>
      </div>
      <div className="cbs-user-foot">
        <button onClick={onLogout} data-testid="menu-logout"><span className="ico"><UserIcons.logout/></span>Sign Out</button>
      </div>
    </div>
  );
}

/* ---------- Topbar (matches dashboard exactly) ---------- */
function UserTopbar({ active, user, onLogout, pushToast, refreshUser }) {
  const [notifs, setNotifs] = useState([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifError, setNotifError] = useState(false);
  const [unread, setUnread] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);

  // Refs let us close ONLY when the click was truly outside that specific panel
  const notifWrapRef = useRef(null);
  const userWrapRef  = useRef(null);

  const loadNotifs = useCallback(async () => {
    if (!getAuthToken()) return;
    setNotifLoading(true);
    setNotifError(false);
    try {
      const d = await window.cbsApi("/api/notifications");
      const list = d.notifications || [];
      setNotifs(list);
      setUnread(list.filter(n => !n.is_read).length);
    } catch (e) {
      setNotifError(true);
    } finally {
      setNotifLoading(false);
    }
  }, []);

  // Initial + periodic refresh of notifications, plus react to cross-tab and
  // same-tab "cbs:notifications-changed" events so the bell stays in sync.
  useEffect(() => {
    loadNotifs();
    const t = setInterval(loadNotifs, 30000);
    const onChanged = () => loadNotifs();
    window.addEventListener("cbs:notifications-changed", onChanged);
    return () => {
      clearInterval(t);
      window.removeEventListener("cbs:notifications-changed", onChanged);
    };
  }, [loadNotifs]);

  // Close dropdowns when clicking outside (uses ref-aware mousedown to be reliable)
  useEffect(() => {
    if (!notifOpen && !userOpen) return;
    const onDown = (ev) => {
      if (notifOpen && notifWrapRef.current && !notifWrapRef.current.contains(ev.target)) setNotifOpen(false);
      if (userOpen  && userWrapRef.current  && !userWrapRef.current.contains(ev.target))  setUserOpen(false);
    };
    const onEsc = (ev) => { if (ev.key === "Escape") { setNotifOpen(false); setUserOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [notifOpen, userOpen]);

  const markAll = async () => {
    try {
      await window.cbsApi("/api/notifications/read-all", { method: "PATCH" });
      // optimistic UI update
      setNotifs(prev => prev.map(n => ({ ...n, is_read: true })));
      setUnread(0);
    } catch (e) {
      pushToast && pushToast("Error", e.message, "error");
    }
  };
  const clickItem = async (n) => {
    if (!n.is_read) {
      setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, is_read: true } : x));
      setUnread(u => Math.max(0, u - 1));
      try { await window.cbsApi(`/api/notifications/${n.id}/read`, { method: "PATCH" }); } catch (_) {}
    }
  };

  const onMenuAction = (a) => {
    setUserOpen(false);
    if (a === "profile")  window.location.href = "User_profile.html";
    if (a === "settings") window.location.href = "User_account_settings.html";
    if (a === "help")     window.location.href = "User_need_help.html";
  };

  return (
    <header className="cbs-topbar" data-testid="cbs-topbar">
      <a href="User_dashboard.html" className="cbs-brand" data-testid="topbar-brand">
        <span className="cbs-brand-logo"><UserIcons.logo/></span>
        <span className="cbs-brand-name">Campus <span className="accent">Bike Sharing</span></span>
      </a>
      <nav className="cbs-nav">
        <a className={"cbs-nav-item" + (active === "home" ? " active" : "")} href="User_dashboard.html" data-testid="topbar-home">
          <UserIcons.home/><span className="cbs-nav-text">Home</span>
        </a>
        <a className={"cbs-nav-item" + (active === "bookings" ? " active" : "")} href="User_my_bookings.html" data-testid="topbar-bookings">
          <UserIcons.calendar/><span className="cbs-nav-text">My Bookings</span>
        </a>
        <div className="cbs-notif-wrap" ref={notifWrapRef}>
          <button className="cbs-icon-btn" onClick={(e) => { e.stopPropagation(); setNotifOpen(v => !v); setUserOpen(false); if (!notifOpen) loadNotifs(); }} title="Notifications" data-testid="topbar-bell" aria-label="Notifications">
            <UserIcons.bell/>
            {unread > 0 && <span className="cbs-badge" data-testid="notif-badge">{unread > 9 ? "9+" : unread}</span>}
          </button>
          {notifOpen && (
            <NotifPanel
              items={notifs}
              loading={notifLoading}
              error={notifError}
              onMarkAll={markAll}
              onClickItem={clickItem}
              onRetry={loadNotifs}
            />
          )}
        </div>
        <div className="cbs-user-wrap" ref={userWrapRef}>
          <button className={"cbs-user-btn" + (userOpen ? " open" : "")}
                  onClick={(e) => { e.stopPropagation(); setUserOpen(v => !v); setNotifOpen(false); }}
                  title="Account" data-testid="topbar-avatar" aria-label="Account menu">
            <Avatar user={user}/>
          </button>
          {userOpen && <UserMenu user={user} onAction={onMenuAction} onLogout={onLogout}/>}
        </div>
      </nav>
    </header>
  );
}
window.UserTopbar = UserTopbar;
window.StudentTopbar = UserTopbar; // legacy alias

/* ---------- Sidebar ---------- */
function UserSidebar({ active }) {
  return (
    <aside className="cbs-sidebar" data-testid="cbs-sidebar">
      <a className={"cbs-side-btn" + (active === "home" ? " active" : "")} href="User_dashboard.html" title="Dashboard" data-testid="side-home"><UserIcons.map/></a>
      <a className={"cbs-side-btn" + (active === "bookings" ? " active" : "")} href="User_my_bookings.html" title="My Bookings" data-testid="side-bookings"><UserIcons.calendar s={20}/></a>
      <a className={"cbs-side-btn" + (active === "rides" ? " active" : "")} href="User_ride_history.html" title="Ride History" data-testid="side-rides"><UserIcons.bike s={20}/></a>
      <a className={"cbs-side-btn" + (active === "profile" ? " active" : "")} href="User_profile.html" title="Profile" data-testid="side-profile"><UserIcons.person s={20}/></a>
      <a className={"cbs-side-btn" + (active === "help" ? " active" : "")} href="User_need_help.html" title="Help &amp; Support" data-testid="side-help"><UserIcons.help s={20}/></a>
    </aside>
  );
}
window.UserSidebar = UserSidebar;
window.StudentSidebar = UserSidebar; // legacy alias

/* ---------- Toasts ---------- */
function UserToastStack({ toasts }) {
  if (!toasts || !toasts.length) return null;
  return (
    <div className="cbs-toast-wrap" data-testid="toast-stack">
      {toasts.map(t => (
        <div key={t.id} className={"cbs-toast" + (t.type === "error" ? " error" : "")}>
          <div className="ico">{t.type === "error" ? <UserIcons.alert/> : <UserIcons.check/>}</div>
          <div className="body">
            <div className="title">{t.title}</div>
            {t.text && <div className="text">{t.text}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
window.UserToastStack = UserToastStack;
