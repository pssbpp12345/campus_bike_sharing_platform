(function () {
  "use strict";

  const API_BASE = "/api/admin/help";
  const LOCAL_KEY = "cbs_admin_help_requests";
  const AUDIT_KEY = "cbs_admin_help_audit";

  const GUIDES = [
    ["dashboard", "Dashboard Guide", ["Read revenue, bookings, alerts, and recent activity from the top-level cards.", "Use KPI trends to compare the selected date range with the previous period.", "Use Refresh when student bookings or payments were just created."]],
    ["bookings", "Booking Management Guide", ["Use Admin Bookings to view active, upcoming, completed, and cancelled bookings.", "Open a booking row to inspect bike, station, payment, and timing details.", "Refund requests should be checked against payment status before action."]],
    ["payments", "Payment & Refund Guide", ["Paid payments increase revenue, failed and pending payments do not.", "Review failed payments from Admin Payments before changing booking status.", "Refunds should be recorded once so dashboard and payments totals remain aligned."]],
    ["bikes", "Bike & Station Guide", ["Available bikes are bikes with available status and no active reservation.", "Assign bikes to real stations only, then refresh Bikes and Stations pages.", "Send damaged or low battery bikes to maintenance so availability stays accurate."]],
    ["maintenance", "Maintenance Guide", ["Create maintenance tasks for damaged bikes, station dock faults, and urgent repairs.", "Assign a technician and update status as work moves through repair.", "Mark completed repairs only when the bike or station is safe to return to service."]],
    ["reports", "Reports Guide", ["Generate CSV reports from real operational data.", "Ride, revenue, station, bike, maintenance, payment, and support reports each use their source tables.", "Use Report History to download or regenerate previous exports."]],
    ["support", "Support Issues Guide", ["Student Need Help submissions appear in Admin Support Issues.", "Assign, reply, escalate, resolve, and close student tickets from the drawer.", "Maintenance-related tickets can be linked to maintenance tasks."]],
    ["settings", "Settings Guide", ["Pricing rules store unlock and per-minute fee settings.", "Notification thresholds control low bike and low battery alerts.", "Access Control defines which admin roles can use each area."]],
  ];

  const TROUBLESHOOTING = [
    ["Student booking is not showing in admin", ["Confirm booking was created after payment.", "Check the payments table for the linked booking.", "Refresh Admin Bookings.", "Check backend terminal errors."]],
    ["Revenue does not match payments", ["Check paid, refunded, failed, and pending payment status.", "Avoid double-counting refunds.", "Confirm Dashboard and Payments use the same API logic."]],
    ["Bike availability is wrong", ["Check bike status.", "Check active or upcoming bookings.", "Check unresolved maintenance status.", "Refresh Bikes and Stations dashboards."]],
    ["Support ticket not showing", ["Check Student Need Help form submission.", "Check support_tickets table.", "Check Admin Support API.", "Refresh Support Issues page."]],
  ];

  const $ = (id) => document.getElementById(id);

  function getToken() {
    try { return localStorage.getItem("cbs_token"); } catch (_) { return null; }
  }

  async function api(path, options = {}) {
    const token = getToken();
    if (!token) {
      window.location.replace("../../login.html?admin=1&next=" + encodeURIComponent(location.pathname));
      throw new Error("Admin login required.");
    }
    const res = await fetch(path, {
      ...options,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      try {
        localStorage.removeItem("cbs_token");
        localStorage.removeItem("cbs_user");
      } catch (_) {}
      window.location.replace("../../login.html?admin=1&next=" + encodeURIComponent(location.pathname));
      throw new Error("Admin session expired.");
    }
    if (!res.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function hydrateIcons(root = document) {
    if (window.__hydrateAdminIcons) window.__hydrateAdminIcons(root);
  }

  function showToast(message, type = "success") {
    const toast = $("admin-toast");
    if (!toast) return;
    clearTimeout(showToast.timer);
    clearTimeout(showToast.hideTimer);
    toast.classList.remove("ah-toast-show");
    toast.textContent = message;
    toast.dataset.type = type;
    toast.hidden = false;
    void toast.offsetWidth;
    toast.classList.add("ah-toast-show");
    showToast.timer = setTimeout(() => {
      toast.classList.remove("ah-toast-show");
      showToast.hideTimer = setTimeout(() => {
        toast.hidden = true;
        toast.textContent = "";
        delete toast.dataset.type;
      }, 190);
    }, 3000);
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  function logLocalAction(title, description, type = "action") {
    const rows = readJson(AUDIT_KEY, []);
    rows.unshift({
      title,
      description,
      type,
      createdAt: new Date().toISOString(),
      page: window.location.pathname.split("/").pop() || "Admin_help.html",
    });
    writeJson(AUDIT_KEY, rows.slice(0, 30));
  }

  function statusLabel(value) {
    const key = String(value || "not_configured").toLowerCase();
    if (key === "online") return "Online";
    if (key === "connected") return "Connected";
    if (key === "offline") return "Offline";
    return "Not configured";
  }

  function statusClass(value) {
    const key = String(value || "").toLowerCase();
    if (key === "online" || key === "connected") return key;
    if (key === "offline") return "offline";
    return "not-configured";
  }

  async function loadSystemStatus() {
    const grid = $("system-status-grid");
    if (!grid) return;
    try {
      const data = await api(`${API_BASE}/status`);
      const rows = [
        ["Backend API", data.backend],
        ["Database", data.database],
        ["Stripe Payments", data.stripe],
        ["Email SMTP", data.smtp],
        ["Google Maps", data.maps],
      ];
      grid.innerHTML = rows.map(([label, value]) => `
        <article class="ah-status-card">
          <strong>${escapeHtml(label)}</strong>
          <span class="ah-badge ${escapeHtml(statusClass(value))}">${escapeHtml(statusLabel(value))}</span>
        </article>
      `).join("");
    } catch (err) {
      grid.innerHTML = `<div class="ah-empty">Could not load system status. ${escapeHtml(err.message)}</div>`;
      showToast(err.message || "Could not load system status.", "error");
    }
  }

  function renderGuides() {
    const list = $("guide-list");
    if (!list) return;
    list.innerHTML = GUIDES.map((guide, index) => `
      <article class="ah-guide-item ${index === 0 ? "open" : ""}" data-guide-id="${escapeHtml(guide[0])}" data-topic-text="${escapeHtml([guide[1], ...guide[2]].join(" ").toLowerCase())}">
        <button class="ah-guide-toggle" type="button" aria-expanded="${index === 0 ? "true" : "false"}">
          <span>${escapeHtml(guide[1])}</span><span data-icon="chevron-right"></span>
        </button>
        <div class="ah-guide-body"><ul>${guide[2].map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>
      </article>
    `).join("");
    hydrateIcons(list);
  }

  function renderTroubleshooting() {
    const list = $("troubleshooting-list");
    if (!list) return;
    list.innerHTML = TROUBLESHOOTING.map((item) => `
      <article class="ah-trouble-card" data-topic-text="${escapeHtml([item[0], ...item[1]].join(" ").toLowerCase())}">
        <h3>${escapeHtml(item[0])}</h3>
        <ul>${item[1].map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ul>
      </article>
    `).join("");
  }

  function filterHelpTopics() {
    const query = ($("help-search")?.value || "").trim().toLowerCase();
    document.querySelectorAll("[data-topic-text]").forEach((el) => {
      const match = !query || String(el.dataset.topicText || "").includes(query);
      el.hidden = !match;
    });
  }

  function toggleGuideAccordion(event) {
    const button = event.target.closest(".ah-guide-toggle");
    if (!button) return;
    const item = button.closest(".ah-guide-item");
    const opening = !item.classList.contains("open");
    item.classList.toggle("open", opening);
    button.setAttribute("aria-expanded", opening ? "true" : "false");
  }

  function saveLocalRequest(payload) {
    const rows = readJson(LOCAL_KEY, []);
    rows.unshift({ ...payload, createdAt: new Date().toISOString() });
    writeJson(LOCAL_KEY, rows.slice(0, 25));
  }

  async function submitSupportRequest(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    const payload = {
      title: String(fd.get("title") || "").trim(),
      category: String(fd.get("category") || "Other"),
      priority: String(fd.get("priority") || "Medium"),
      affectedPage: String(fd.get("affectedPage") || "Dashboard"),
      description: String(fd.get("description") || "").trim(),
      screenshotName: fd.get("screenshot")?.name || "",
    };
    if (payload.title.length < 4 || payload.description.length < 12) {
      showToast("Please enter a clear title and description.", "error");
      return;
    }
    try {
      const data = await api(`${API_BASE}/support-request`, { method: "POST", body: JSON.stringify(payload) });
      logLocalAction("Technical support request submitted", `${payload.title} (${data.request?.requestCode || "saved"})`, "support_request");
      showToast(`Support request ${data.request?.requestCode || ""} submitted.`);
      form.reset();
    } catch (err) {
      saveLocalRequest(payload);
      logLocalAction("Technical support request saved locally", payload.title, "support_request");
      showToast("Support request saved locally for admin review.", "warning");
      form.reset();
    }
  }

  async function refreshSystemData() {
    await loadSystemStatus();
    filterHelpTopics();
    logLocalAction("System data refreshed", "Admin Help Center status cards and help filters were refreshed.");
    showToast("System data refreshed.");
  }

  function makeDateStamp(date = new Date()) {
    return date.toISOString().slice(0, 10).replace(/-/g, "");
  }

  function downloadTextFile(filename, contents, type = "text/plain;charset=utf-8") {
    const blob = new Blob([contents], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function exportErrorLog() {
    const localRequests = readJson(LOCAL_KEY, []);
    const auditRows = readJson(AUDIT_KEY, []);
    const statusText = $("system-status-grid")?.innerText?.trim() || "System status not loaded.";
    const contents = [
      "Campus Bike Sharing - Admin Help Center Error Log",
      `Timestamp: ${new Date().toISOString()}`,
      `Current Page: ${window.location.href}`,
      `User Agent: ${navigator.userAgent}`,
      `Local Help Requests Count: ${localRequests.length}`,
      `Local Audit Entries Count: ${auditRows.length}`,
      "",
      "System Status Snapshot:",
      statusText,
      "",
      "Note: Backend/server log export is not connected here. This file captures frontend context for technical review.",
    ].join("\n");
    downloadTextFile(`admin_error_log_${makeDateStamp()}.txt`, contents);
    logLocalAction("Error log exported", "Frontend/system context file was downloaded for review.");
    showToast("Error log exported.");
  }

  function auditRows() {
    const actions = readJson(AUDIT_KEY, []);
    const requests = readJson(LOCAL_KEY, []).map((row) => ({
      title: row.title || "Local support request",
      description: `${row.category || "Other"} - ${row.affectedPage || "Unknown page"}`,
      type: "support_request",
      createdAt: row.createdAt,
    }));
    return [...actions, ...requests]
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 5);
  }

  function formatAuditDate(value) {
    if (!value) return "Just now";
    return new Date(value).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  function renderAuditLog() {
    const list = $("audit-log-list");
    if (!list) return;
    const rows = auditRows();
    if (!rows.length) {
      list.innerHTML = `<div class="ah-empty">No audit activity recorded yet.</div>`;
      return;
    }
    list.innerHTML = rows.map((row) => `
      <article class="ah-audit-item">
        <span class="ah-audit-dot" data-icon="${row.type === "support_request" ? "message" : "clock"}"></span>
        <div>
          <strong>${escapeHtml(row.title || "Admin action")}</strong>
          <p>${escapeHtml(row.description || "Recorded from Admin Help Center.")}</p>
          <p>${escapeHtml(formatAuditDate(row.createdAt))}</p>
        </div>
      </article>
    `).join("");
    hydrateIcons(list);
  }

  function openAuditLog() {
    renderAuditLog();
    const modal = $("audit-modal");
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add("ah-modal-open");
    hydrateIcons(modal);
    logLocalAction("Audit log opened", "Admin reviewed recent local Help Center activity.");
  }

  function closeAuditLog() {
    const modal = $("audit-modal");
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove("ah-modal-open");
  }

  function exportAuditLog() {
    const rows = auditRows();
    const contents = rows.length
      ? rows.map((row) => `[${formatAuditDate(row.createdAt)}] ${row.title}\n${row.description || ""}`).join("\n\n")
      : "No audit activity recorded yet.";
    downloadTextFile(`admin_audit_log_${makeDateStamp()}.txt`, contents);
    showToast("Audit log exported.");
  }

  function handleQuickAction(action) {
    if (action === "refresh") {
      refreshSystemData().catch((err) => showToast(err.message || "Could not refresh system data.", "error"));
      return;
    }
    if (action === "export-error-log") {
      exportErrorLog();
      return;
    }
    if (action === "audit-log") {
      openAuditLog();
      return;
    }
    if (action === "settings") {
      window.location.href = "./Admin_settings.html";
      return;
    }
    showToast("Action unavailable.", "warning");
  }

  function runQuickAction(action) {
    const normalized = action === "error-log" ? "export-error-log" : action === "audit" ? "audit-log" : action;
    handleQuickAction(normalized);
  }

  function exportGuideSummary() {
    const rows = [["Guide", "Summary"], ...GUIDES.map((guide) => [guide[1], guide[2].join(" ")])];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "admin-help-guide.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Help guide exported.");
  }

  function scrollToSection(id) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function bindQuickActions() {
    document.querySelectorAll("[data-action], [data-quick-action]").forEach((button) => {
      if (button.dataset.helpActionBound === "true") return;
      button.dataset.helpActionBound = "true";
      button.addEventListener("click", () => handleQuickAction(button.dataset.action || button.dataset.quickAction));
    });
  }

  function wireEvents() {
    $("help-search")?.addEventListener("input", filterHelpTopics);
    $("guide-list")?.addEventListener("click", toggleGuideAccordion);
    $("contact-support-button")?.addEventListener("click", () => scrollToSection("support-form"));
    $("refresh-status")?.addEventListener("click", () => loadSystemStatus());
    $("admin-help-form")?.addEventListener("submit", submitSupportRequest);
    $("refresh-dashboard")?.addEventListener("click", () => refreshSystemData().then(() => showToast("Help Center refreshed.")).catch((err) => showToast(err.message || "Refresh failed.", "error")));
    $("export-report")?.addEventListener("click", exportGuideSummary);
    $("export-audit-log")?.addEventListener("click", exportAuditLog);
    $("audit-modal")?.addEventListener("click", (event) => {
      if (event.target === $("audit-modal")) closeAuditLog();
    });
    document.querySelectorAll("[data-modal-close]").forEach((button) => {
      button.addEventListener("click", closeAuditLog);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("audit-modal")?.hidden) closeAuditLog();
    });
    document.querySelectorAll("[data-scroll-section]").forEach((button) => {
      button.addEventListener("click", () => scrollToSection(button.dataset.scrollSection));
    });
    document.querySelectorAll("[data-scroll-topic]").forEach((button) => {
      button.addEventListener("click", () => {
        scrollToSection("guides");
        const item = document.querySelector(`[data-guide-id="${button.dataset.scrollTopic}"]`);
        item?.classList.add("open");
        item?.querySelector(".ah-guide-toggle")?.setAttribute("aria-expanded", "true");
      });
    });
    bindQuickActions();
  }

  async function initAdminHelpPage() {
    renderGuides();
    renderTroubleshooting();
    wireEvents();
    hydrateIcons(document);
    await loadSystemStatus();
  }

  window.initAdminHelpPage = initAdminHelpPage;
  window.bindQuickActions = bindQuickActions;
  window.handleQuickAction = handleQuickAction;
  window.refreshSystemData = refreshSystemData;
  window.exportErrorLog = exportErrorLog;
  window.openAuditLog = openAuditLog;
  window.filterHelpTopics = filterHelpTopics;
  window.toggleGuideAccordion = toggleGuideAccordion;
  window.loadSystemStatus = loadSystemStatus;
  window.submitSupportRequest = submitSupportRequest;
  window.runQuickAction = runQuickAction;
  window.showToast = showToast;
  window.showHelpToast = showToast;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAdminHelpPage);
  } else {
    initAdminHelpPage();
  }
})();
