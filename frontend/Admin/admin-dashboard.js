(function () {
  "use strict";

  const API_BASE_URL = window.API_BASE_URL || "/api";
  function apiUrl(path) {
    if (window.cbsApiUrl) return window.cbsApiUrl(path);
    if (typeof path === "string" && (path === "/api" || path.startsWith("/api/"))) {
      return API_BASE_URL + path.slice(4);
    }
    return path;
  }

  const ICONS = {
    "layout-dashboard": '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="8" height="8" rx="2" stroke="currentColor" stroke-width="2"/><rect x="13" y="3" width="8" height="8" rx="2" stroke="currentColor" stroke-width="2"/><rect x="3" y="13" width="8" height="8" rx="2" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="8" rx="2" stroke="currentColor" stroke-width="2"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    "chevron-down": '<svg viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    "chevron-right": '<svg viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 2v4M16 2v4M3 10h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    "credit-card": '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="14" rx="2" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M7 15h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    wallet: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="14" rx="3" stroke="currentColor" stroke-width="2"/><path d="M16 13h2M3 9c0-1.6 1.2-3 3-3h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    bike: '<svg viewBox="0 0 24 24" fill="none"><circle cx="18.5" cy="17.5" r="3.5" stroke="currentColor" stroke-width="2"/><circle cx="5.5" cy="17.5" r="3.5" stroke="currentColor" stroke-width="2"/><path d="M12 17.5V14l-3-3 4-3 2 3h2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="15" cy="5" r="1.2" fill="currentColor"/></svg>',
    "map-pin": '<svg viewBox="0 0 24 24" fill="none"><path d="M12 22s7-7.5 7-13a7 7 0 0 0-14 0c0 5.5 7 13 7 13z" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="9" r="2.5" stroke="currentColor" stroke-width="2"/></svg>',
    wrench: '<svg viewBox="0 0 24 24" fill="none"><path d="M14.7 6.3a5 5 0 0 0 6.6 6.6L12 22l-4-4 9.3-9.3a5 5 0 0 1-2.6-2.4z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    "bar-chart": '<svg viewBox="0 0 24 24" fill="none"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    gauge: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 15a8 8 0 0 1 16 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 15l4-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 15h.01M17 15h.01" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
    "help-circle": '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M9.5 9a2.8 2.8 0 0 1 5.2 1.4c0 2-2.7 2.4-2.7 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 18h.01" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.4 17l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.3a1.7 1.7 0 0 0 1.5-1A1.7 1.7 0 0 0 4.5 7l-.1-.1A2 2 0 1 1 7.2 4l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1A2 2 0 1 1 19.6 7l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1h.3a2 2 0 0 1 0 4h-.3a1.7 1.7 0 0 0-1.3 1.1z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none"><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M15 8l4 4-4 4M19 12H9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    headphones: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 13a8 8 0 0 1 16 0v5a2 2 0 0 1-2 2h-2v-7h4M4 13h4v7H6a2 2 0 0 1-2-2v-5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    dollar: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 6v12M15.5 8.5c-.7-1-1.8-1.5-3.2-1.5-1.8 0-3 .8-3 2.1 0 3.2 6.4 1.6 6.4 5.5 0 1.5-1.3 2.4-3.4 2.4-1.7 0-3-.6-3.8-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    "trending-up": '<svg viewBox="0 0 24 24" fill="none"><path d="M4 17l6-6 4 4 6-8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 7h5v5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 9v5M12 18h.01" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M10.3 3.8 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    message: '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="5" width="16" height="13" rx="3" stroke="currentColor" stroke-width="2"/><path d="M8 21l4-3h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    rotate: '<svg viewBox="0 0 24 24" fill="none"><path d="M20 6v5h-5M4 18v-5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 11a6.5 6.5 0 0 0-11-3M6 13a6.5 6.5 0 0 0 11 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    sparkles: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l1.6 4.2L18 9l-4.4 1.8L12 15l-1.6-4.2L6 9l4.4-1.8L12 3z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><path d="M18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><path d="M5 15l.7 1.6L7 17.3l-1.3.7L5 19.6l-.7-1.6L3 17.3l1.3-.7L5 15z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  };

  const READ_NOTIFICATIONS_KEY = "cbs_admin_notifications_read_ids";
  const ADMIN_NAV_LINKS = {
    Dashboard: "./Admin_dashboard.html",
    Bookings: "./Admin_bookings.html",
    Payments: "./Admin_payments.html",
    Bikes: "./Admin_bikes.html",
    Stations: "./Admin_stations.html",
    Maintenance: "./Admin_maintenance.html",
    Reports: "./Admin_reports.html",
    "Support Issues": "./Admin_support.html",
    "AI Assistant": "./Admin_ai.html",
    Settings: "./Admin_settings.html",
  };

  const state = {
    range: "today",
    charts: { revenue: null, booking: null },
    refreshTimer: null,
    fastRefreshTimer: null,
    latestActivity: [],
    latestAlerts: [],
    readNotificationIds: loadReadNotificationIds(),
    currentUser: null,
  };

  const moneyFmt = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
  const exactMoneyFmt = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const numberFmt = new Intl.NumberFormat("en-AU");

  function icon(name) {
    return ICONS[name] || ICONS["help-circle"];
  }

  function loadReadNotificationIds() {
    try {
      return new Set(JSON.parse(localStorage.getItem(READ_NOTIFICATIONS_KEY) || "[]"));
    } catch (_) {
      return new Set();
    }
  }

  function saveReadNotificationIds() {
    try {
      localStorage.setItem(READ_NOTIFICATIONS_KEY, JSON.stringify(Array.from(state.readNotificationIds).slice(-120)));
    } catch (_) {}
  }

  function hydrateIcons(root) {
    (root || document).querySelectorAll("[data-icon]").forEach((el) => {
      el.innerHTML = icon(el.getAttribute("data-icon"));
    });
  }
  window.__hydrateAdminIcons = hydrateIcons;

  const ADMIN_TOOLTIP_SELECTOR = [
    ".truncate-with-tooltip",
    ".ab-table th",
    ".ab-table td",
    ".bm-table th",
    ".bm-table td",
    ".mm-table th",
    ".mm-table td",
    ".rp-table th",
    ".rp-table td",
    ".sp-table th",
    ".sp-table td",
    ".ap-table th",
    ".ap-table td",
    ".as-table th",
    ".as-table td",
    ".ad-table-scroll th",
    ".ad-table-scroll td",
    ".ab-kpi-body strong",
    ".ad-kpi-card strong",
    ".ab-list-body strong",
    ".ab-list-body span",
    ".ad-compact-main strong",
    ".ad-compact-main small",
    ".ad-activity-body strong",
    ".ad-activity-body span",
    ".ad-status-row .lbl",
    ".bm-donut-row span:nth-child(2)",
    ".mm-donut-row span:nth-child(2)",
    ".rp-donut-row span:nth-child(2)",
    ".sp-donut-row span:nth-child(2)",
    ".rp-report-code",
    ".rp-quick-copy strong",
    ".rp-quick-copy span",
    ".aai-ticket-main strong",
    ".aai-ticket-main em",
    ".aai-ticket-main p",
    ".aai-insight strong"
  ].join(",");

  let tooltipObserverStarted = false;
  let tooltipTimer = null;

  function normaliseTooltipText(el) {
    return String(el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isTooltipCandidate(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (el.matches("button, input, select, textarea, svg, path")) return false;
    const text = normaliseTooltipText(el);
    if (!text || text.length < 4) return false;
    if (el.classList.contains("truncate-with-tooltip")) return true;
    const style = window.getComputedStyle(el);
    return style.textOverflow === "ellipsis" || el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
  }

  function applyAdminTextTooltips(root = document) {
    const scope = root instanceof HTMLElement || root === document ? root : document;
    window.requestAnimationFrame(() => {
      scope.querySelectorAll(ADMIN_TOOLTIP_SELECTOR).forEach((el) => {
        if (!isTooltipCandidate(el)) return;
        const text = normaliseTooltipText(el);
        if (!text) return;
        if (!el.getAttribute("title") || el.dataset.adminAutoTitle === "1") {
          el.setAttribute("title", text);
          el.dataset.adminAutoTitle = "1";
        }
      });
    });
  }
  window.__applyAdminTextTooltips = applyAdminTextTooltips;

  function bindAdminTextTooltips() {
    if (tooltipObserverStarted || !window.MutationObserver) return;
    tooltipObserverStarted = true;
    const schedule = () => {
      clearTimeout(tooltipTimer);
      tooltipTimer = setTimeout(() => applyAdminTextTooltips(document), 120);
    };
    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.addEventListener("resize", schedule);
  }

  function normalizeAdminNavigation() {
    const currentPage = window.location.pathname.split("/").pop() || "Admin_dashboard.html";
    document.querySelectorAll(".ad-brand").forEach((link) => {
      link.setAttribute("href", "./Admin_dashboard.html");
    });

    document.querySelectorAll(".ad-nav-item").forEach((link) => {
      const label = String(link.textContent || "").trim().replace(/\s+/g, " ");
      const href = ADMIN_NAV_LINKS[label];
      if (!href) return;
      const page = href.replace("./", "");
      link.setAttribute("href", href);
      link.setAttribute("data-page", page);
      link.classList.toggle("active", currentPage === page);
      link.removeAttribute("data-admin-menu-action");
    });

    const help = document.getElementById("admin-help-button");
    if (help && help.tagName === "A") {
      help.setAttribute("href", "./Admin_help.html");
    }
  }

  function getToken() {
    try {
      const token = localStorage.getItem("cbs_token") || localStorage.getItem("token");
      if (token && !localStorage.getItem("cbs_token")) localStorage.setItem("cbs_token", token);
      if (token && !localStorage.getItem("token")) localStorage.setItem("token", token);
      return token;
    } catch (_) { return null; }
  }

  function getUser() {
    try {
      const raw = localStorage.getItem("cbs_user") || localStorage.getItem("user") || "null";
      if (raw && raw !== "null") {
        if (!localStorage.getItem("cbs_user")) localStorage.setItem("cbs_user", raw);
        if (!localStorage.getItem("user")) localStorage.setItem("user", raw);
      }
      return JSON.parse(raw);
    } catch (_) { return null; }
  }

  function clearAuth() {
    try {
      localStorage.removeItem("cbs_token");
      localStorage.removeItem("cbs_user");
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      localStorage.removeItem("role");
      localStorage.removeItem(READ_NOTIFICATIONS_KEY);
    } catch (_) {}
  }

  function redirectToAdminLogin() {
    document.body.classList.add("ad-auth-pending");
    window.location.replace("/login.html?admin=1&next=" + encodeURIComponent(location.pathname));
  }

  function hasAdminSession() {
    const token = getToken();
    const user = getUser();
    if (!token || !user) {
      return false;
    }
    if ((user.role || "").toLowerCase() !== "admin") {
      clearAuth();
      return false;
    }
    return true;
  }

  async function verifyAdminSession() {
    if (!hasAdminSession()) {
      redirectToAdminLogin();
      return false;
    }
    try {
      const res = await fetch(apiUrl("/api/auth/me"), {
        headers: { Authorization: "Bearer " + getToken() },
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.user || (data.user.role || "").toLowerCase() !== "admin") {
        clearAuth();
        redirectToAdminLogin();
        return false;
      }
      state.currentUser = data.user;
      try {
        localStorage.setItem("cbs_user", JSON.stringify(data.user));
        localStorage.setItem("user", JSON.stringify(data.user));
        localStorage.setItem("role", String(data.user.role || "").toLowerCase());
      } catch (_) {}
      renderAdminProfile(data.user);
      document.body.classList.remove("ad-auth-pending");
      return true;
    } catch (_) {
      clearAuth();
      redirectToAdminLogin();
      return false;
    }
  }

  function renderAdminProfile(user) {
    const name = user.full_name || user.name || "Admin User";
    document.getElementById("admin-name").textContent = name;
    document.getElementById("admin-avatar").textContent = initials(name);
    document.getElementById("admin-menu-name").textContent = name;
    document.getElementById("admin-avatar-menu").textContent = initials(name);
    applyAdminAvatarImage();
  }

  function applyAdminAvatarImage() {
    let image = "";
    try { image = localStorage.getItem("cbs_admin_profile_image") || ""; } catch (_) {}
    ["admin-avatar", "admin-avatar-menu"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle("has-image", Boolean(image));
      el.style.backgroundImage = image ? `url("${image}")` : "";
    });
  }

  function initials(name) {
    return String(name || "Admin User").split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  }

  async function api(path) {
    const token = getToken();
    if (!token) {
      clearAuth();
      redirectToAdminLogin();
      throw new Error("Admin session expired.");
    }
    const res = await fetch(apiUrl(path), { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (res.status === 401 || res.status === 403) {
      clearAuth();
      window.location.replace("/login.html?next=" + encodeURIComponent(location.pathname));
      throw new Error("Admin session expired.");
    }
    if (!res.ok) throw new Error((data && data.error) || "Request failed.");
    return data || {};
  }

  function setError(message) {
    const el = document.getElementById("dashboard-error");
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = message;
  }

  function formatMoney(value, exact) {
    return (exact ? exactMoneyFmt : moneyFmt).format(Number(value || 0));
  }

  function formatDate(value) {
    if (!value) return "-";
    return new Date(value).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function timeAgo(value) {
    const ms = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(ms)) return "";
    const mins = Math.max(0, Math.floor(ms / 60000));
    if (mins < 1) return "now";
    if (mins < 60) return mins + " min ago";
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + " hr ago";
    return Math.floor(hours / 24) + " days ago";
  }

  function setKpi(id, value, trend) {
    const isMoney = ["totalRevenue", "totalExpenses", "netProfit"].includes(id);
    document.getElementById("kpi-" + id).textContent = isMoney ? formatMoney(value) : numberFmt.format(Number(value || 0));
    const trendEl = document.getElementById("trend-" + id);
    const pct = Number(trend || 0);
    const badWhenUp = ["totalExpenses", "maintenanceAlerts", "openIssues"].includes(id);
    const isBad = badWhenUp ? pct > 0 : pct < 0;
    trendEl.className = pct === 0 ? "neutral" : (isBad ? "down" : "");
    const sign = pct === 0 ? "" : (pct > 0 ? "+" : "-");
    trendEl.textContent = `${sign}${Math.abs(pct).toFixed(1)}% vs prev.`;
  }

  function renderOverview(data) {
    ["totalRevenue", "totalExpenses", "netProfit", "totalBookings", "activeRides", "availableBikes", "maintenanceAlerts", "openIssues"]
      .forEach((key) => setKpi(key, data[key], data.trends && data.trends[key]));
  }

  function renderFinancialSummary(data) {
    const rows = [
      ["Booking Income", data.bookingIncome, "positive"],
      ["Refunds", -Math.abs(Number(data.refunds || 0)), "negative"],
      ["Maintenance Cost", -Math.abs(Number(data.maintenanceCost || 0)), "negative"],
      ["Operational Expenses", -Math.abs(Number(data.operationalExpenses || 0)), "negative"],
      ["Net Balance", data.netBalance, Number(data.netBalance || 0) >= 0 ? "positive" : "negative"],
    ];
    document.getElementById("financial-summary-list").innerHTML = rows.map(([label, value, cls]) => (
      `<div class="ad-summary-row"><span>${label}</span><strong class="${cls}">${formatMoney(value, true)}</strong></div>`
    )).join("");
  }

  function badge(value, tone) {
    const text = String(value || "unknown").replace(/_/g, " ");
    return `<span class="ad-badge ${tone || badgeTone(text)}">${escapeHtml(text)}</span>`;
  }

  function badgeTone(value) {
    const v = String(value || "").toLowerCase();
    if (["paid", "completed", "resolved", "closed", "low"].includes(v)) return "green";
    if (["active", "open", "in progress", "in_progress"].includes(v)) return "blue";
    if (["pending", "medium", "reported"].includes(v)) return "amber";
    if (["failed", "urgent", "high", "critical", "cancelled"].includes(v)) return "red";
    if (["refunded"].includes(v)) return "purple";
    return "gray";
  }

  function td(value, html) {
    return `<td title="${escapeHtml(value)}">${html == null ? escapeHtml(value) : html}</td>`;
  }

  function labelText(value) {
    return String(value || "-").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function rowHref(kind, value) {
    const target = encodeURIComponent(String(value || ""));
    return kind === "maintenance"
      ? `./Admin_maintenance.html?bike=${target}`
      : `./Admin_support.html?ticket=${target}`;
  }

  function renderMaintenance(data) {
    const rows = (data.alerts || []).slice(0, 5);
    const body = document.getElementById("maintenance-alerts-body");
    body.innerHTML = rows.length ? rows.map((row) => `
      <button type="button"
        class="ad-compact-row ad-click-row"
        data-href="${escapeHtml(rowHref("maintenance", row.bike_id))}"
        title="Open maintenance details for ${escapeHtml(row.bike_id)} at ${escapeHtml(row.station_name)}. Issue: ${escapeHtml(labelText(row.issue_type))}. Severity: ${escapeHtml(row.severity)}. Status: ${escapeHtml(row.status)}.">
        <span class="ad-compact-main">
          <strong>${escapeHtml(row.bike_id)}</strong>
          <small>${escapeHtml(row.station_name || "Unassigned")}</small>
        </span>
        <span class="ad-compact-detail">${escapeHtml(labelText(row.issue_type))}</span>
        <span class="ad-compact-badges">
          ${badge(row.severity)}
          ${badge(row.status)}
        </span>
      </button>
    `).join("") : compactEmpty("No maintenance alerts.");
  }

  function renderIssues(data) {
    const rows = (data.issues || []).slice(0, 5);
    const body = document.getElementById("reported-issues-body");
    body.innerHTML = rows.length ? rows.map((row) => `
      <button type="button"
        class="ad-compact-row ad-click-row"
        data-href="${escapeHtml(rowHref("issue", row.ticket_id))}"
        title="Open support issue ${escapeHtml(row.ticket_id)} from ${escapeHtml(row.student_name)}. Issue: ${escapeHtml(row.issue)}. Priority: ${escapeHtml(row.priority)}. Status: ${escapeHtml(row.status)}.">
        <span class="ad-compact-main">
          <strong>${escapeHtml(row.ticket_id)}</strong>
          <small>${escapeHtml(row.student_name || "Student")}</small>
        </span>
        <span class="ad-compact-detail">${escapeHtml(row.issue || "Support issue")}</span>
        <span class="ad-compact-badges">
          ${badge(row.priority)}
          ${badge(row.status)}
        </span>
      </button>
    `).join("") : compactEmpty("No open support issues.");
  }

  function renderTransactions(data) {
    const rows = data.transactions || [];
    const body = document.getElementById("recent-transactions-body");
    body.innerHTML = rows.length ? rows.map((row) => `
      <tr>
        ${td(row.booking_id)}
        ${td(row.student_name)}
        ${td(row.station)}
        ${td(formatMoney(row.amount, true))}
        ${td(formatPaymentMethod(row.payment_method))}
        ${td(row.payment_status, badge(row.payment_status))}
        ${td(formatDate(row.date))}
      </tr>
    `).join("") : emptyRow(7, "No recent transactions.");
  }

  function renderActivity(data) {
    const rows = (data.activity || []).slice(0, 5);
    const root = document.getElementById("recent-activity-list");
    // The recent-activity-list element only lives on the dashboard page.
    // On other admin pages we still want to fetch activity (for the notification
    // badge) but skip rendering the list.
    if (!root) return;
    root.innerHTML = rows.length ? rows.map((item) => {
      const meta = activityMeta(item.activity_type);
      return `
        <div class="ad-activity-item">
          <span class="ad-activity-icon ${meta.tone}">${icon(meta.icon)}</span>
          <div class="ad-activity-body">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.description || "")}</span>
          </div>
          <span class="ad-activity-time">${escapeHtml(timeAgo(item.timestamp))}</span>
        </div>
      `;
    }).join("") : '<div class="ad-empty">No recent activity.</div>';
  }

  function renderAlerts(data) {
    const rows = [
      { icon: "alert", tone: "red", label: "bikes need urgent maintenance", value: data.urgentMaintenanceCount || 0, countTone: "" },
      { icon: "wallet", tone: "amber", label: "failed payments", value: data.failedPaymentsCount || 0, countTone: "" },
      { icon: "calendar", tone: "green", label: "new bookings today", value: data.newBookingsToday || 0, countTone: "green" },
      { icon: "map-pin", tone: "blue", label: "station has low bike availability", value: data.lowBikeAvailabilityStations || 0, countTone: "blue" },
      { icon: "message", tone: "purple", label: "support tickets waiting", value: data.waitingSupportTickets || 0, countTone: "purple" },
    ];
    state.latestAlerts = rows;
    // alerts-list only exists on the dashboard. We still want to keep the
    // alert numbers in state so the notification badge counts them on other
    // admin pages.
    const alertsListEl = document.getElementById("alerts-list");
    if (!alertsListEl) return;
    alertsListEl.innerHTML = rows.map((row) => `
      <div class="ad-alert-item">
        <span class="ad-alert-icon ${row.tone}">${icon(row.icon)}</span>
        <span class="ad-alert-title">${numberFmt.format(row.value)} ${escapeHtml(row.label)}</span>
        <span class="ad-alert-count ${row.countTone}">${numberFmt.format(row.value)}</span>
        <span>${icon("chevron-right")}</span>
      </div>
    `).join("");
  }

  function buildNotifications() {
    const activityItems = (state.latestActivity || []).map((item) => {
      const meta = activityMeta(item.activity_type);
      const timestamp = item.timestamp || new Date().toISOString();
      return {
        id: ["activity", item.activity_type, item.title, timestamp].join(":"),
        icon: meta.icon,
        tone: meta.tone,
        title: item.title || "Admin activity",
        description: item.description || "",
        timestamp,
      };
    });

    const alertItems = (state.latestAlerts || [])
      .filter((row) => Number(row.value || 0) > 0)
      .map((row) => ({
        id: ["alert", row.label, row.value].join(":"),
        icon: row.icon,
        tone: row.tone,
        title: `${numberFmt.format(row.value)} ${row.label}`,
        description: "Requires admin review",
        timestamp: new Date().toISOString(),
      }));

    return activityItems.concat(alertItems).slice(0, 10);
  }

  function renderNotificationMenu() {
    const notifications = buildNotifications();
    const unread = notifications.filter((item) => !state.readNotificationIds.has(item.id)).length;
    const badgeEl = document.getElementById("notification-badge");
    const unreadEl = document.getElementById("notification-unread-count");
    if (badgeEl) {
      badgeEl.textContent = unread > 9 ? "9+" : String(unread);
      badgeEl.classList.toggle("is-zero", unread === 0);
    }
    if (unreadEl) unreadEl.textContent = `${numberFmt.format(unread)} unread`;

    const list = document.getElementById("notification-list");
    if (!list) return;
    list.innerHTML = notifications.length ? notifications.map((item) => `
      <div class="ad-notification-item ${state.readNotificationIds.has(item.id) ? "" : "unread"}">
        <span class="ad-notification-icon ${item.tone}">${icon(item.icon)}</span>
        <div class="ad-notification-body">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.description)}</span>
        </div>
        <span class="ad-notification-time">${escapeHtml(timeAgo(item.timestamp))}</span>
      </div>
    `).join("") : '<div class="ad-empty">No admin notifications.</div>';
  }

  function markNotificationsRead() {
    buildNotifications().forEach((item) => state.readNotificationIds.add(item.id));
    saveReadNotificationIds();
    renderNotificationMenu();
  }

  function activityMeta(type) {
    const map = {
      booking_completed: { icon: "bike", tone: "green" },
      payment_received: { icon: "dollar", tone: "green" },
      bike_returned: { icon: "rotate", tone: "blue" },
      maintenance_flagged: { icon: "wrench", tone: "amber" },
      refund_requested: { icon: "alert", tone: "red" },
      support_ticket_received: { icon: "message", tone: "purple" },
    };
    return map[type] || { icon: "clock", tone: "blue" };
  }

  function emptyRow(colspan, message) {
    return `<tr><td colspan="${colspan}"><div class="ad-empty">${message}</div></td></tr>`;
  }

  function compactEmpty(message) {
    return `<div class="ad-empty compact">${escapeHtml(message)}</div>`;
  }

  function formatPaymentMethod(value) {
    return String(value || "-").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function compactAxisLabel(label) {
    const raw = String(label || "");
    if (state.range === "today") {
      const timeMatch = raw.match(/(\d{1,2})\s?(am|pm)$/i);
      if (timeMatch) return timeMatch[1] + timeMatch[2].toLowerCase();
    }
    return raw;
  }

  function renderRevenueChart(data) {
    if (!window.Chart) return;
    const ctx = document.getElementById("revenue-expenses-chart");
    const labels = data.labels || [];
    const showEvery = state.range === "today" ? 4 : 1;
    const chartData = {
      labels,
      datasets: [
        {
          label: "Revenue",
          data: data.revenue || [],
          borderColor: "#22C55E",
          backgroundColor: "rgba(34, 197, 94, .11)",
          fill: true,
          tension: .42,
          borderWidth: 2.5,
          pointRadius: labels.length > 16 ? 0 : 2,
          pointHoverRadius: 4,
          pointHitRadius: 10,
          pointBackgroundColor: "#22C55E",
        },
        {
          label: "Expenses",
          data: data.expenses || [],
          borderColor: "#F97316",
          backgroundColor: "rgba(249, 115, 22, .11)",
          fill: true,
          tension: .42,
          borderWidth: 2.5,
          pointRadius: labels.length > 16 ? 0 : 2,
          pointHoverRadius: 4,
          pointHitRadius: 10,
          pointBackgroundColor: "#F97316",
        },
      ],
    };
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 6, right: 8, bottom: 0, left: 2 } },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx2) => `${ctx2.dataset.label}: ${formatMoney(ctx2.parsed.y, true)}` } },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            autoSkip: state.range !== "today",
            maxTicksLimit: state.range === "today" ? 7 : 8,
            maxRotation: 0,
            minRotation: 0,
            color: "#475569",
            padding: 8,
            font: { size: 11, weight: "500" },
            callback(value, index) {
              if (state.range === "today" && index % showEvery !== 0 && index !== labels.length - 1) return "";
              return compactAxisLabel(this.getLabelForValue(value));
            },
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: "#E2E8F0", borderDash: [4, 4] },
          ticks: {
            maxTicksLimit: 5,
            color: "#475569",
            padding: 8,
            font: { size: 11, weight: "500" },
            callback: (v) => {
              const value = Number(v);
              if (Math.abs(value) < 1000) return "$" + value.toFixed(0);
              return "$" + Number(value / 1000).toFixed(value >= 10000 ? 0 : 1) + "K";
            },
          },
        },
      },
    };
    if (state.charts.revenue) {
      state.charts.revenue.data = chartData;
      state.charts.revenue.options = options;
      state.charts.revenue.update();
    } else {
      state.charts.revenue = new Chart(ctx, { type: "line", data: chartData, options });
    }
  }

  function renderBookingChart(data) {
    if (!window.Chart) return;
    const ctx = document.getElementById("booking-status-chart");
    const values = [
      Number(data.completed || 0),
      Number(data.active || 0),
      Number(data.cancelled || 0),
      Number(data.pending || 0),
    ];
    const labels = ["Completed", "Active", "Cancelled", "Pending"];
    const total = values.reduce((a, b) => a + b, 0);
    renderStatusList(labels, values, total);

    const centerText = {
      id: "centerText",
      beforeDraw(chart) {
        const { ctx: c, chartArea } = chart;
        if (!chartArea) return;
        const currentTotal = chart.data.datasets[0].data.reduce((sum, value) => sum + Number(value || 0), 0);
        c.save();
        c.textAlign = "center";
        c.fillStyle = "#0F172A";
        c.font = "700 20px Plus Jakarta Sans, Inter, sans-serif";
        c.fillText(numberFmt.format(currentTotal), (chartArea.left + chartArea.right) / 2, (chartArea.top + chartArea.bottom) / 2 - 2);
        c.fillStyle = "#64748B";
        c.font = "500 12px Inter, sans-serif";
        c.fillText("Total", (chartArea.left + chartArea.right) / 2, (chartArea.top + chartArea.bottom) / 2 + 18);
        c.restore();
      },
    };

    const chartData = {
      labels,
      datasets: [{ data: values, backgroundColor: ["#22C55E", "#3B82F6", "#EF4444", "#F97316"], borderWidth: 4, borderColor: "#FFFFFF", hoverOffset: 3 }],
    };
    const options = { responsive: true, maintainAspectRatio: false, cutout: "68%", plugins: { legend: { display: false }, tooltip: { enabled: true } } };
    if (state.charts.booking) {
      state.charts.booking.data = chartData;
      state.charts.booking.update();
    } else {
      state.charts.booking = new Chart(ctx, { type: "doughnut", data: chartData, options, plugins: [centerText] });
    }
  }

  function renderStatusList(labels, values, total) {
    const colors = ["#22C55E", "#3B82F6", "#EF4444", "#F97316"];
    document.getElementById("booking-status-list").innerHTML = labels.map((label, i) => {
      const pct = total ? ((values[i] / total) * 100).toFixed(1) : "0.0";
      return `
        <div class="ad-status-row">
          <i class="ad-status-dot" style="background:${colors[i]}"></i>
          <span>${label}</span>
          <small>${numberFmt.format(values[i])} (${pct}%)</small>
        </div>
      `;
    }).join("");
  }

  function rangeLabel(range) {
    return ({ today: "Hourly", week: "Weekly", month: "Monthly", year: "Yearly" })[range] || "Monthly";
  }

  async function loadMainData() {
    setError("");
    try {
      document.getElementById("chart-range-label").textContent = rangeLabel(state.range);
      const query = "?range=" + encodeURIComponent(state.range);
      const [overview, chart, bookingStatus, financial, maintenance, issues, transactions] = await Promise.all([
        api("/api/admin/overview" + query),
        api("/api/admin/revenue-expenses" + query),
        api("/api/admin/booking-status" + query),
        api("/api/admin/financial-summary" + query),
        api("/api/admin/maintenance-alerts"),
        api("/api/admin/reported-issues"),
        api("/api/admin/recent-transactions"),
      ]);
      renderOverview(overview);
      renderRevenueChart(chart);
      renderBookingChart(bookingStatus);
      renderFinancialSummary(financial);
      renderMaintenance(maintenance);
      renderIssues(issues);
      renderTransactions(transactions);
    } catch (err) {
      setError(err.message || "Could not load dashboard data.");
    }
  }

  async function loadFastData() {
    try {
      const [activity, alerts] = await Promise.all([
        api("/api/admin/recent-activity"),
        api("/api/admin/alerts"),
      ]);
      state.latestActivity = activity.activity || [];
      renderActivity(activity);
      renderAlerts(alerts);
      renderNotificationMenu();
    } catch (err) {
      setError(err.message || "Could not refresh activity data.");
    }
  }

  function bindRangeTabs() {
    if (!document.getElementById("dashboard-error")) return;
    document.querySelectorAll(".ad-range-tabs button").forEach((button) => {
      button.addEventListener("click", () => {
        state.range = button.getAttribute("data-range");
        document.querySelectorAll(".ad-range-tabs button").forEach((b) => b.classList.toggle("active", b === button));
        loadMainData();
      });
    });
  }

  function bindClickableRows() {
    document.addEventListener("click", (event) => {
      const row = event.target.closest(".ad-click-row");
      if (!row || !row.dataset.href) return;
      window.location.href = row.dataset.href;
    });
  }

  function toggleDropdown(menuId, buttonId) {
    const menu = document.getElementById(menuId);
    const button = document.getElementById(buttonId);
    const opening = menu.hidden;
    closeDropdowns();
    menu.hidden = !opening;
    button.classList.toggle("open", opening);
    button.setAttribute("aria-expanded", opening ? "true" : "false");
  }

  function closeDropdowns() {
    [
      ["notification-menu", "notification-button"],
      ["profile-menu", "profile-menu-button"],
    ].forEach(([menuId, buttonId]) => {
      const menu = document.getElementById(menuId);
      const button = document.getElementById(buttonId);
      if (!menu || !button) return;
      menu.hidden = true;
      button.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
    });
  }

  async function refreshDashboard(showMessage) {
    if (!document.getElementById("dashboard-error")) return;
    await Promise.all([loadMainData(), loadFastData()]);
    if (showMessage) showToast("Dashboard refreshed.");
  }

  function exportReport() {
    const rows = [
      ["Metric", "Value"],
      ["Total Revenue", document.getElementById("kpi-totalRevenue").textContent],
      ["Total Expenses", document.getElementById("kpi-totalExpenses").textContent],
      ["Net Profit", document.getElementById("kpi-netProfit").textContent],
      ["Total Bookings", document.getElementById("kpi-totalBookings").textContent],
      ["Active Rides", document.getElementById("kpi-activeRides").textContent],
      ["Available Bikes", document.getElementById("kpi-availableBikes").textContent],
      ["Maintenance Alerts", document.getElementById("kpi-maintenanceAlerts").textContent],
      ["Open Issues", document.getElementById("kpi-openIssues").textContent],
    ];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `admin-dashboard-${state.range}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Dashboard report exported.");
  }

  function logoutAdmin() {
    closeDropdowns();
    document.body.classList.add("ad-auth-pending");
    clearInterval(state.refreshTimer);
    clearInterval(state.fastRefreshTimer);
    clearAuth();
    window.location.replace("/login.html?admin=1");
  }

  function showToast(message) {
    const toast = document.getElementById("admin-toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.hidden = true;
      toast.textContent = "";
    }, 2600);
  }

  function bindAdminControls() {
    const notificationButton = document.getElementById("notification-button");
    const profileButton = document.getElementById("profile-menu-button");
    if (notificationButton) notificationButton.addEventListener("click", (event) => {
      event.stopPropagation();
      renderNotificationMenu();
      toggleDropdown("notification-menu", "notification-button");
    });
    if (profileButton) profileButton.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleDropdown("profile-menu", "profile-menu-button");
    });
    const notificationMenu = document.getElementById("notification-menu");
    const profileMenu = document.getElementById("profile-menu");
    const markRead = document.getElementById("mark-notifications-read");
    const logout = document.getElementById("admin-logout");
    const refresh = document.getElementById("refresh-dashboard");
    const exportBtn = document.getElementById("export-report");
    const help = document.getElementById("admin-help-button");
    if (notificationMenu) notificationMenu.addEventListener("click", (event) => event.stopPropagation());
    if (profileMenu) profileMenu.addEventListener("click", (event) => event.stopPropagation());
    if (markRead) markRead.addEventListener("click", markNotificationsRead);
    if (logout) logout.addEventListener("click", logoutAdmin);
    if (document.getElementById("dashboard-error")) {
      if (refresh) refresh.addEventListener("click", () => refreshDashboard(true));
      if (exportBtn) exportBtn.addEventListener("click", exportReport);
    }
    if (help) help.addEventListener("click", () => {
      window.location.href = "./Admin_help.html";
    });
    document.querySelectorAll("[data-admin-menu-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        closeDropdowns();
        window.location.href = button.dataset.adminMenuAction === "profile"
          ? "./Admin_settings.html?section=profile"
          : "./Admin_settings.html?section=platform";
      });
    });
    document.addEventListener("click", closeDropdowns);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeDropdowns();
    });
  }

  function startRefresh() {
    clearInterval(state.refreshTimer);
    clearInterval(state.fastRefreshTimer);
    // Heavy dashboard-only refresh (charts, KPIs, transactions).
    if (document.getElementById("dashboard-error")) {
      state.refreshTimer = setInterval(loadMainData, 30000);
    }
    // Notification feed runs on every admin page so the bell badge stays
    // in sync regardless of which screen the admin is on.
    state.fastRefreshTimer = setInterval(loadFastData, 30000);
  }

  async function init() {
    hydrateIcons(document);
    normalizeAdminNavigation();
    applyAdminTextTooltips(document);
    bindAdminTextTooltips();
    bindRangeTabs();
    bindClickableRows();
    bindAdminControls();
    if (!await verifyAdminSession()) return;
    if (document.getElementById("dashboard-error")) await refreshDashboard(false);
    // Always pull the latest activity + alerts so the notification badge
    // shows the right count on every admin page, not only the dashboard.
    loadFastData();
    startRefresh();
  }

  document.addEventListener("DOMContentLoaded", init);
  window.addEventListener("pageshow", () => {
    if (!hasAdminSession()) redirectToAdminLogin();
  });
})();
