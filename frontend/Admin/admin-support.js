(function () {
  "use strict";

  const API_BASE = "/api/admin/support";
  const BAD_VISIBLE_RE = /demo|seed|test|profit|loss/i;

  const state = {
    range: "today",
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 1,
    filters: { search: "", status: "all", priority: "all", category: "all", assignedTo: "all", dateFrom: "", dateTo: "" },
    tickets: [],
    selectedTicket: null,
    selectedMessages: [],
    options: { students: [], staff: ["Admin User"], bikes: [], bookings: [] },
    modalMode: null,
    modalTicketId: null,
    charts: { trend: null, category: null },
  };

  const $ = (id) => document.getElementById(id);
  const numberFmt = new Intl.NumberFormat("en-AU");
  const dateFmt = new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

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

  async function apiBlob(path) {
    const token = getToken();
    if (!token) {
      window.location.replace("../../login.html?admin=1&next=" + encodeURIComponent(location.pathname));
      throw new Error("Admin login required.");
    }
    const res = await fetch(path, { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Export failed.");
    }
    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/i);
    return { blob: await res.blob(), filename: match ? match[1] : "support-tickets.csv" };
  }

  function clean(value, fallback = "Not assigned") {
    const text = String(value == null ? "" : value).trim();
    if (!text || BAD_VISIBLE_RE.test(text)) return fallback;
    return text.replace(/\s+/g, " ");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function label(value, fallback = "Open") {
    return clean(value, fallback).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatNumber(value) {
    return numberFmt.format(Number(value || 0));
  }

  function formatDate(value, fallback = "Not set") {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return dateFmt.format(date);
  }

  function formatRelative(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const diff = Math.max(0, Date.now() - date.getTime());
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hr ago`;
    const days = Math.floor(hrs / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  function trendText(value) {
    const n = Number(value || 0);
    const sign = n >= 0 ? "+" : "-";
    return `${sign}${Math.abs(n).toFixed(1)}% vs prev.`;
  }

  function setTrend(id, value, inverse = false) {
    const el = $(id);
    if (!el) return;
    if (typeof value === "string" && !Number.isFinite(Number(value))) {
      el.textContent = value;
      el.classList.remove("up", "down");
      return;
    }
    const n = Number(value || 0);
    el.textContent = trendText(n);
    const positive = inverse ? n <= 0 : n >= 0;
    el.classList.toggle("up", positive);
    el.classList.toggle("down", !positive);
  }

  function badge(key, text) {
    const cls = String(key || "open").toLowerCase().replace(/\s+/g, "_");
    return `<span class="ab-badge ${escapeHtml(cls)}">${escapeHtml(text || label(cls))}</span>`;
  }

  function relatedChip(value) {
    const text = clean(value, "Not linked");
    const isLinked = text && text !== "Not linked" && text !== "N/A";
    return `<span class="sp-related-chip ${isLinked ? "linked" : "empty"} truncate-with-tooltip" title="${escapeHtml(text)}">${escapeHtml(text)}</span>`;
  }

  function hydrateIcons(root = document) {
    if (window.__hydrateAdminIcons) window.__hydrateAdminIcons(root);
  }

  function showToast(message, type = "success") {
    const toast = $("admin-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.dataset.type = type;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.hidden = true;
      toast.textContent = "";
      delete toast.dataset.type;
    }, 3200);
  }

  function chartLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    if (state.range === "today") return new Intl.DateTimeFormat("en-AU", { hour: "numeric" }).format(date);
    if (state.range === "year") return new Intl.DateTimeFormat("en-AU", { month: "short" }).format(date);
    return new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "short" }).format(date);
  }

  async function loadSupportOverview(range = state.range) {
    const data = await api(`${API_BASE}/overview?range=${encodeURIComponent(range)}`);
    const totals = data.totals || {};
    const trends = data.trends || {};
    [
      "openTickets",
      "newToday",
      "inProgress",
      "urgentIssues",
      "resolvedTickets",
      "paymentIssues",
      "maintenanceReports",
    ].forEach((key) => {
      const el = $("kpi-" + key);
      if (el) el.textContent = formatNumber(totals[key]);
      setTrend("trend-" + key, trends[key], key === "urgentIssues");
    });
    $("kpi-averageResponseTime").textContent = clean(totals.averageResponseTime, "Not available");
    setTrend("trend-averageResponseTime", trends.averageResponseTime || "");
  }

  async function loadSupportTrends(range = state.range) {
    const data = await api(`${API_BASE}/trends?range=${encodeURIComponent(range)}`);
    const labelEl = $("support-trend-label");
    if (labelEl) labelEl.textContent = label(range);
    const ctx = $("support-trend-chart");
    if (!ctx || !window.Chart) return;
    const config = {
      type: "line",
      data: {
        labels: (data.labels || []).map(chartLabel),
        datasets: [
          { label: "New Tickets", data: data.newTickets || [], borderColor: "#16A34A", backgroundColor: "rgba(22,163,74,.10)", tension: .38, fill: true, pointRadius: 3, borderWidth: 2 },
          { label: "Resolved Tickets", data: data.resolvedTickets || [], borderColor: "#3B82F6", backgroundColor: "rgba(59,130,246,.08)", tension: .38, fill: false, pointRadius: 3, borderWidth: 2 },
          { label: "Urgent Tickets", data: data.urgentTickets || [], borderColor: "#EF4444", backgroundColor: "rgba(239,68,68,.08)", tension: .38, fill: false, pointRadius: 3, borderWidth: 2 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: "#64748B", maxTicksLimit: 7, font: { size: 11 } } },
          y: { beginAtZero: true, grid: { color: "#E2E8F0" }, ticks: { color: "#64748B", precision: 0, font: { size: 11 } } },
        },
      },
    };
    if (state.charts.trend) {
      state.charts.trend.data = config.data;
      state.charts.trend.options = config.options;
      state.charts.trend.update();
    } else {
      state.charts.trend = new Chart(ctx, config);
    }
  }

  function centerTextPlugin(total) {
    return {
      id: "supportCenterText",
      beforeDraw(chart) {
        const meta = chart.getDatasetMeta(0);
        if (!meta?.data?.length) return;
        const x = meta.data[0].x;
        const y = meta.data[0].y;
        const ctx = chart.ctx;
        ctx.save();
        ctx.textAlign = "center";
        ctx.fillStyle = "#0F172A";
        ctx.font = "700 21px Inter, sans-serif";
        ctx.fillText(formatNumber(total), x, y - 4);
        ctx.fillStyle = "#64748B";
        ctx.font = "600 12px Inter, sans-serif";
        ctx.fillText("Tickets", x, y + 16);
        ctx.restore();
      },
    };
  }

  async function loadSupportCategoryBreakdown(range = state.range) {
    const data = await api(`${API_BASE}/category-breakdown?range=${encodeURIComponent(range)}`);
    const rows = [
      ["booking", "Booking", data.booking || 0, "#16A34A"],
      ["payment", "Payment", data.payment || 0, "#3B82F6"],
      ["bikeIssue", "Bike Issue", data.bikeIssue || 0, "#8B5CF6"],
      ["maintenance", "Maintenance", data.maintenance || 0, "#F59E0B"],
      ["account", "Account", data.account || 0, "#64748B"],
      ["general", "General", data.general || 0, "#EF4444"],
    ];
    const total = rows.reduce((sum, row) => sum + Number(row[2] || 0), 0);
    const legend = $("support-category-legend");
    if (legend) {
      legend.innerHTML = rows.map((row) => {
        const pct = total ? ((Number(row[2]) / total) * 100).toFixed(1) : "0.0";
        return `<div class="sp-donut-row"><span class="sp-dot" style="background:${row[3]}"></span><span>${escapeHtml(row[1])}</span><strong>${formatNumber(row[2])} (${pct}%)</strong></div>`;
      }).join("");
    }
    const ctx = $("support-category-chart");
    if (!ctx || !window.Chart) return;
    const config = {
      type: "doughnut",
      data: { labels: rows.map((r) => r[1]), datasets: [{ data: rows.map((r) => r[2]), backgroundColor: rows.map((r) => r[3]), borderWidth: 4, borderColor: "#FFFFFF", hoverOffset: 3 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: "68%", plugins: { legend: { display: false } } },
      plugins: [centerTextPlugin(total)],
    };
    if (state.charts.category) state.charts.category.destroy();
    state.charts.category = new Chart(ctx, config);
  }

  async function loadSupportAlerts() {
    const data = await api(`${API_BASE}/alerts`);
    const rows = (data.alerts || []).slice(0, 5);
    const list = $("support-alerts-list");
    if (!list) return;
    list.innerHTML = rows.length ? rows.map((ticket) => `
      <div class="ab-list-item" title="${escapeHtml(ticket.subject)}">
        <span class="ab-list-ico red"><span data-icon="alert"></span></span>
        <div class="ab-list-body"><strong>${escapeHtml(ticket.ticketId)} - ${escapeHtml(ticket.subject)}</strong><span>${escapeHtml(ticket.studentName)} - ${escapeHtml(ticket.waiting)}</span></div>
        <span class="ab-list-meta">${badge(ticket.priority, ticket.priorityLabel)}</span>
      </div>
    `).join("") : `<div class="ab-empty">No urgent support alerts.</div>`;
    hydrateIcons(list);
  }

  async function loadAssignedSupportTasks() {
    const data = await api(`${API_BASE}/assigned-tasks`);
    const rows = (data.tasks || []).slice(0, 5);
    const list = $("assigned-support-list");
    if (!list) return;
    list.innerHTML = rows.length ? `
      <div class="sp-task-head"><span>Assigned To</span><span>Ticket</span><span>Category</span><span>Status</span><span>Last Update</span></div>
      ${rows.map((ticket) => `
        <div class="sp-task-row" title="${escapeHtml(ticket.subject)}">
          <strong>${escapeHtml(ticket.assignedTo)}</strong>
          <span>${escapeHtml(ticket.ticketId)}</span>
          <span>${escapeHtml(ticket.categoryLabel)}</span>
          ${badge(ticket.status, ticket.statusLabel)}
          <span>${escapeHtml(ticket.lastUpdate)}</span>
        </div>
      `).join("")}
    ` : `<div class="ab-empty">No assigned support tasks.</div>`;
  }

  async function loadSupportActivity() {
    const data = await api(`${API_BASE}/activity?limit=5`);
    const rows = (data.activity || []).slice(0, 5);
    const list = $("support-activity-list");
    if (!list) return;
    list.innerHTML = rows.length ? rows.map((item) => {
      const type = String(item.type || "");
      const tone = type.includes("resolved") ? "green" : type.includes("escalated") ? "red" : type.includes("assigned") ? "blue" : "";
      const icon = type.includes("resolved") ? "check" : type.includes("escalated") ? "alert" : type.includes("reply") ? "message" : "help-circle";
      return `
        <div class="ab-list-item" title="${escapeHtml(item.description)}">
          <span class="ab-list-ico ${tone}"><span data-icon="${icon}"></span></span>
          <div class="ab-list-body"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.ticketId)} - ${escapeHtml(item.description)}</span></div>
          <span class="ab-list-meta">${escapeHtml(formatRelative(item.timestamp))}</span>
        </div>`;
    }).join("") : `<div class="ab-empty">No support activity yet.</div>`;
    hydrateIcons(list);
  }

  function buildListQuery(extra = {}) {
    return new URLSearchParams({
      search: state.filters.search,
      status: state.filters.status,
      priority: state.filters.priority,
      category: state.filters.category,
      assignedTo: state.filters.assignedTo,
      dateFrom: state.filters.dateFrom,
      dateTo: state.filters.dateTo,
      page: String(extra.page || state.page),
      limit: String(extra.limit || state.limit),
    }).toString();
  }

  async function loadSupportList(filters = {}) {
    state.filters = { ...state.filters, ...filters };
    const data = await api(`${API_BASE}/list?${buildListQuery()}`);
    state.tickets = data.tickets || [];
    state.total = Number(data.total || 0);
    state.page = Number(data.page || 1);
    state.limit = Number(data.limit || state.limit);
    state.totalPages = Number(data.totalPages || 1);
    renderSupportTable();
    renderPagination();
  }

  function renderSupportTable() {
    const totalEl = $("support-total-count");
    const rowCount = $("support-row-count");
    const body = $("support-table-body");
    if (totalEl) totalEl.textContent = `(${formatNumber(state.total)})`;
    if (!body) return;
    if (!state.tickets.length) {
      if (rowCount) rowCount.textContent = "No support tickets found";
      body.innerHTML = `<tr><td colspan="11" class="ab-table-empty">No tickets match the current filters.</td></tr>`;
      return;
    }
    const start = (state.page - 1) * state.limit + 1;
    const end = Math.min(state.total, start + state.tickets.length - 1);
    if (rowCount) rowCount.textContent = `Showing ${formatNumber(start)} to ${formatNumber(end)} of ${formatNumber(state.total)} tickets`;
    body.innerHTML = state.tickets.map((ticket) => `
      <tr data-ticket-id="${ticket.id}" title="View ${escapeHtml(ticket.ticketId)} details">
        <td><span class="sp-ticket-code">${escapeHtml(ticket.ticketId)}</span></td>
        <td class="truncate-with-tooltip" title="${escapeHtml(ticket.studentName)}">${escapeHtml(ticket.studentName)}</td>
        <td class="truncate-with-tooltip" title="${escapeHtml(ticket.categoryLabel)}">${escapeHtml(ticket.categoryLabel)}</td>
        <td class="truncate-with-tooltip" title="${escapeHtml(ticket.subject)}">${escapeHtml(ticket.subject)}</td>
        <td>${relatedChip(ticket.bookingId)}</td>
        <td>${relatedChip(ticket.bikeId)}</td>
        <td>${badge(ticket.priority, ticket.priorityLabel)}</td>
        <td>${badge(ticket.status, ticket.statusLabel)}</td>
        <td title="${escapeHtml(ticket.assignedTo)}">${escapeHtml(ticket.assignedTo)}</td>
        <td>${escapeHtml(formatDate(ticket.createdAt))}</td>
        <td>
          <span class="ab-row-actions">
            <button type="button" data-action="view" data-ticket-id="${ticket.id}" title="View details"><span data-icon="help-circle"></span></button>
            <button type="button" data-action="assign" data-ticket-id="${ticket.id}" title="Assign"><span data-icon="help-circle"></span></button>
            <button type="button" data-action="reply" data-ticket-id="${ticket.id}" title="Reply"><span data-icon="message"></span></button>
            <button type="button" data-action="escalate" data-ticket-id="${ticket.id}" title="Escalate"><span data-icon="alert"></span></button>
            <button type="button" data-action="resolve" data-ticket-id="${ticket.id}" title="Resolve"><span data-icon="check"></span></button>
          </span>
        </td>
      </tr>
    `).join("");
    hydrateIcons(body);
    if (window.__applyAdminTextTooltips) window.__applyAdminTextTooltips(body);
  }

  function renderPagination() {
    const wrap = $("support-pagination");
    if (!wrap) return;
    const buttons = [];
    buttons.push(`<button type="button" data-page="${state.page - 1}" ${state.page <= 1 ? "disabled" : ""}>Prev</button>`);
    const start = Math.max(1, Math.min(state.page - 2, Math.max(1, state.totalPages - 4)));
    const end = Math.min(state.totalPages, start + 4);
    for (let page = start; page <= end; page += 1) {
      buttons.push(`<button type="button" data-page="${page}" class="${page === state.page ? "active" : ""}">${page}</button>`);
    }
    buttons.push(`<button type="button" data-page="${state.page + 1}" ${state.page >= state.totalPages ? "disabled" : ""}>Next</button>`);
    wrap.innerHTML = buttons.join("");
  }

  function detailSection(title, rows) {
    return `
      <section class="sp-detail-section">
        <h3>${escapeHtml(title)}</h3>
        ${rows.map(([key, value, wrap]) => `
          <div class="sp-detail-row">
            <span class="key">${escapeHtml(key)}</span>
            <span class="value ${wrap ? "wrap" : ""}" title="${escapeHtml(value)}">${escapeHtml(value || "-")}</span>
          </div>
        `).join("")}
      </section>`;
  }

  function messageSection(messages, ticket) {
    const rows = messages.length ? messages : [{ senderType: "student", senderName: ticket.studentName, message: ticket.message, createdAt: ticket.createdAt }];
    return `
      <section class="sp-detail-section">
        <h3>Conversation / Notes</h3>
        <div class="sp-message-list">
          ${rows.map((msg) => `
            <article class="sp-message">
              <strong>${escapeHtml(label(msg.senderType, "Student"))} - ${escapeHtml(msg.senderName)}</strong>
              <span>${escapeHtml(formatDate(msg.createdAt))}${msg.isInternal ? " - Internal note" : ""}</span>
              <p>${escapeHtml(msg.message)}</p>
            </article>
          `).join("")}
        </div>
      </section>`;
  }

  function renderDrawer(ticket, messages) {
    const status = $("drawer-status");
    if (status) {
      status.textContent = ticket.statusLabel;
      status.className = `ab-status-badge ${escapeHtml(ticket.status)}`;
    }
    const body = $("support-drawer-body");
    if (!body) return;
    body.innerHTML = [
      detailSection("Ticket Information", [
        ["Ticket ID", ticket.ticketId],
        ["Category", ticket.categoryLabel],
        ["Priority", ticket.priorityLabel],
        ["Issue Title", ticket.subject, true],
        ["Issue Description", ticket.description, true],
        ["Created Date", formatDate(ticket.createdAt)],
        ["Last Updated", formatDate(ticket.updatedAt)],
      ]),
      detailSection("Student Information", [
        ["Student Name", ticket.studentName],
        ["Email", ticket.studentEmail],
        ["Phone", ticket.studentPhone],
        ["User ID", String(ticket.userId)],
      ]),
      detailSection("Related Records", [
        ["Booking ID", ticket.bookingId || "-"],
        ["Bike ID", ticket.bikeId || "-"],
        ["Station", ticket.station || "-"],
        ["Payment Ref", ticket.paymentReference || "-"],
        ["Maintenance Task", ticket.maintenanceTaskId || "-"],
      ]),
      messageSection(messages, ticket),
    ].join("");
  }

  async function openSupportDrawer(ticketId) {
    const data = await api(`${API_BASE}/${encodeURIComponent(ticketId)}`);
    state.selectedTicket = data.ticket;
    state.selectedMessages = data.messages || [];
    renderDrawer(state.selectedTicket, state.selectedMessages);
    $("support-drawer").hidden = false;
    document.body.classList.add("ab-drawer-open");
  }

  function closeSupportDrawer() {
    $("support-drawer").hidden = true;
    document.body.classList.remove("ab-drawer-open");
  }

  async function loadOptions() {
    const data = await api(`${API_BASE}/options`);
    state.options = {
      students: data.students || [],
      staff: (data.staff && data.staff.length ? data.staff : ["Admin User"]),
      bikes: data.bikes || [],
      bookings: data.bookings || [],
    };
    const assigned = $("filter-assigned");
    if (assigned) {
      const current = assigned.value || "all";
      assigned.innerHTML = `<option value="all">All</option><option value="unassigned">Unassigned</option>` + state.options.staff.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
      assigned.value = current;
    }
  }

  function optionList(items, valueKey, labelFn, selected = "") {
    return items.map((item) => {
      const value = item[valueKey];
      return `<option value="${escapeHtml(value)}" ${String(value) === String(selected) ? "selected" : ""}>${escapeHtml(labelFn(item))}</option>`;
    }).join("");
  }

  function setModal(title, submitText, bodyHtml, mode, ticketId = null) {
    state.modalMode = mode;
    state.modalTicketId = ticketId;
    $("support-modal-title").textContent = title;
    $("support-modal-submit").textContent = submitText;
    $("support-modal-body").innerHTML = bodyHtml;
    $("support-modal").hidden = false;
    hydrateIcons($("support-modal"));
  }

  function openCreateTicketModal() {
    setModal("Create Ticket", "Create Ticket", `
      <div class="sp-modal-grid">
        <label class="full">Student<select name="userId" required><option value="">Select student</option>${optionList(state.options.students, "id", (u) => `${u.name} - ${u.email}`)}</select></label>
        <label>Category<select name="category"><option value="booking">Booking</option><option value="payment">Payment</option><option value="bike_issue">Bike Issue</option><option value="maintenance">Maintenance</option><option value="account">Account</option><option value="general">General</option></select></label>
        <label>Priority<select name="priority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
        <label class="full">Issue Title<input name="subject" required maxlength="200" placeholder="Brief title for the support issue" /></label>
        <label class="full">Issue Description<textarea name="description" required placeholder="Describe the student issue clearly."></textarea></label>
        <label>Related Booking<select name="bookingId"><option value="">None</option>${optionList(state.options.bookings, "id", (b) => b.code)}</select></label>
        <label>Related Bike<select name="bikeId"><option value="">None</option>${optionList(state.options.bikes, "id", (b) => b.code)}</select></label>
        <label class="full">Assign To<select name="assignedTo"><option value="">Unassigned</option>${state.options.staff.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}</select></label>
      </div>
    `, "create");
  }

  function openAssignModal(ticketId) {
    setModal("Assign Ticket", "Assign Ticket", `
      <label>Assign To<select name="assignedTo" required>${state.options.staff.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}</select></label>
    `, "assign", ticketId);
  }

  function openReplyModal(ticketId) {
    setModal("Reply to Student", "Save Reply", `
      <div class="sp-modal-grid">
        <label class="full">Message<textarea name="message" required placeholder="Write a clear reply for the student."></textarea></label>
        <label class="check full"><span><input type="checkbox" name="isInternal" />Save as internal note</span></label>
      </div>
    `, "reply", ticketId);
  }

  function openMaintenanceModal(ticketId) {
    setModal("Link Maintenance Task", "Create Maintenance Link", `
      <div class="sp-modal-grid">
        <label>Bike<select name="bikeId"><option value="">Use ticket bike</option>${optionList(state.options.bikes, "id", (b) => b.code)}</select></label>
        <label>Issue Type<input name="issueType" placeholder="Brake issue, battery low..." /></label>
        <label class="full">Description<textarea name="description" placeholder="Maintenance notes for this linked task."></textarea></label>
      </div>
    `, "maintenance", ticketId);
  }

  function closeModal() {
    const modal = $("support-modal");
    if (modal) modal.hidden = true;
    const form = $("support-modal-form");
    if (form) form.reset();
    state.modalMode = null;
    state.modalTicketId = null;
  }

  async function createTicket(payload) {
    await api(API_BASE, { method: "POST", body: JSON.stringify(payload) });
    showToast("Support ticket created.");
    closeModal();
    await refreshAll();
  }

  async function assignTicket(ticketId, assignedTo) {
    await api(`${API_BASE}/${encodeURIComponent(ticketId)}/assign`, { method: "PATCH", body: JSON.stringify({ assignedTo }) });
    showToast("Ticket assigned.");
    closeModal();
    await refreshAll();
    if (state.selectedTicket) await openSupportDrawer(ticketId);
  }

  async function replyToTicket(ticketId, message, isInternal) {
    await api(`${API_BASE}/${encodeURIComponent(ticketId)}/reply`, { method: "POST", body: JSON.stringify({ message, isInternal }) });
    showToast(isInternal ? "Internal note saved." : "Reply saved.");
    closeModal();
    await refreshAll();
    if (state.selectedTicket) await openSupportDrawer(ticketId);
  }

  async function escalateTicket(ticketId) {
    await api(`${API_BASE}/${encodeURIComponent(ticketId)}/escalate`, { method: "PATCH", body: JSON.stringify({}) });
    showToast("Ticket escalated.", "warning");
    await refreshAll();
    if (state.selectedTicket) await openSupportDrawer(ticketId);
  }

  async function resolveTicket(ticketId) {
    await api(`${API_BASE}/${encodeURIComponent(ticketId)}/resolve`, { method: "PATCH", body: JSON.stringify({}) });
    showToast("Ticket resolved.");
    await refreshAll();
    if (state.selectedTicket) await openSupportDrawer(ticketId);
  }

  async function closeTicket(ticketId) {
    await api(`${API_BASE}/${encodeURIComponent(ticketId)}/close`, { method: "PATCH", body: JSON.stringify({}) });
    showToast("Ticket closed.");
    await refreshAll();
    if (state.selectedTicket) await openSupportDrawer(ticketId);
  }

  async function linkMaintenanceTask(ticketId, payload = {}) {
    const data = await api(`${API_BASE}/${encodeURIComponent(ticketId)}/link-maintenance`, { method: "POST", body: JSON.stringify(payload) });
    showToast(`${data.taskId || "Maintenance task"} linked.`);
    closeModal();
    await refreshAll();
    if (state.selectedTicket) await openSupportDrawer(ticketId);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function exportSupportTickets() {
    const { blob, filename } = await apiBlob(`${API_BASE}/export/csv?${buildListQuery({ page: 1, limit: 5000 })}`);
    downloadBlob(blob, filename);
    showToast("Support tickets exported.");
  }

  async function handleModalSubmit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      if (state.modalMode === "create") {
        await createTicket({
          userId: form.get("userId"),
          category: form.get("category"),
          priority: form.get("priority"),
          subject: form.get("subject"),
          description: form.get("description"),
          bookingId: form.get("bookingId"),
          bikeId: form.get("bikeId"),
          assignedTo: form.get("assignedTo"),
        });
      } else if (state.modalMode === "assign") {
        await assignTicket(state.modalTicketId, form.get("assignedTo"));
      } else if (state.modalMode === "reply") {
        await replyToTicket(state.modalTicketId, form.get("message"), form.get("isInternal") === "on");
      } else if (state.modalMode === "maintenance") {
        await linkMaintenanceTask(state.modalTicketId, {
          bikeId: form.get("bikeId"),
          issueType: form.get("issueType"),
          description: form.get("description"),
        });
      }
    } catch (err) {
      showToast(err.message || "Action failed.", "error");
    }
  }

  async function refreshAll() {
    try {
      await Promise.all([
        loadSupportOverview(state.range),
        loadSupportTrends(state.range),
        loadSupportCategoryBreakdown(state.range),
        loadSupportAlerts(),
        loadAssignedSupportTasks(),
        loadSupportActivity(),
        loadSupportList(),
      ]);
    } catch (err) {
      showToast(err.message || "Could not refresh Support Issues.", "error");
    }
  }

  function wireRangeTabs() {
    document.querySelectorAll(".ad-range-tabs button[data-range]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".ad-range-tabs button[data-range]").forEach((btn) => btn.classList.remove("active"));
        button.classList.add("active");
        state.range = button.dataset.range || "today";
        Promise.all([
          loadSupportOverview(state.range),
          loadSupportTrends(state.range),
          loadSupportCategoryBreakdown(state.range),
        ]).catch((err) => showToast(err.message, "error"));
      });
    });
  }

  function wireFilters() {
    let timer = null;
    const apply = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.page = 1;
        state.filters = {
          search: $("support-search").value.trim(),
          status: $("filter-status").value,
          priority: $("filter-priority").value,
          category: $("filter-category").value,
          assignedTo: $("filter-assigned").value,
          dateFrom: $("filter-date-from").value,
          dateTo: $("filter-date-to").value,
        };
        loadSupportList().catch((err) => showToast(err.message, "error"));
      }, 180);
    };
    [["support-search", "input"], ["filter-status", "change"], ["filter-priority", "change"], ["filter-category", "change"], ["filter-assigned", "change"], ["filter-date-from", "change"], ["filter-date-to", "change"]].forEach(([id, event]) => {
      const el = $(id);
      if (el) el.addEventListener(event, apply);
    });
    $("reset-filters").addEventListener("click", () => {
      $("support-search").value = "";
      $("filter-status").value = "all";
      $("filter-priority").value = "all";
      $("filter-category").value = "all";
      $("filter-assigned").value = "all";
      $("filter-date-from").value = "";
      $("filter-date-to").value = "";
      state.page = 1;
      state.filters = { search: "", status: "all", priority: "all", category: "all", assignedTo: "all", dateFrom: "", dateTo: "" };
      loadSupportList().catch((err) => showToast(err.message, "error"));
    });
    $("support-page-size").addEventListener("change", (event) => {
      state.limit = Number(event.target.value || 10);
      state.page = 1;
      loadSupportList().catch((err) => showToast(err.message, "error"));
    });
  }

  function handleTicketAction(action, ticketId) {
    if (action === "download") return;
    if (action === "assign") return openAssignModal(ticketId);
    if (action === "reply") return openReplyModal(ticketId);
    if (action === "escalate") return escalateTicket(ticketId).catch((err) => showToast(err.message, "error"));
    if (action === "resolve") return resolveTicket(ticketId).catch((err) => showToast(err.message, "error"));
    if (action === "close") return closeTicket(ticketId).catch((err) => showToast(err.message, "error"));
    if (action === "maintenance") return openMaintenanceModal(ticketId);
    return openSupportDrawer(ticketId).catch((err) => showToast(err.message, "error"));
  }

  function wireTable() {
    $("support-table-body").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      const row = event.target.closest("tr[data-ticket-id]");
      const ticketId = button?.dataset.ticketId || row?.dataset.ticketId;
      if (!ticketId) return;
      if (button) {
        event.stopPropagation();
        return handleTicketAction(button.dataset.action, ticketId);
      }
      openSupportDrawer(ticketId).catch((err) => showToast(err.message, "error"));
    });
    $("support-pagination").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-page]");
      if (!button || button.disabled) return;
      state.page = Math.max(1, Math.min(state.totalPages, Number(button.dataset.page || 1)));
      loadSupportList().catch((err) => showToast(err.message, "error"));
    });
  }

  function wireDrawer() {
    $("close-support-drawer").addEventListener("click", closeSupportDrawer);
    document.querySelectorAll("[data-close-drawer]").forEach((el) => el.addEventListener("click", closeSupportDrawer));
    $("support-drawer").addEventListener("click", (event) => {
      const button = event.target.closest("[data-drawer-action]");
      if (!button || !state.selectedTicket) return;
      handleTicketAction(button.dataset.drawerAction, state.selectedTicket.id);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (!$("support-modal").hidden) closeModal();
        else if (!$("support-drawer").hidden) closeSupportDrawer();
      }
    });
  }

  function wireTopButtons() {
    $("refresh-dashboard").addEventListener("click", () => {
      showToast("Refreshing support tickets...");
      refreshAll();
    });
    $("export-report").addEventListener("click", () => exportSupportTickets().catch((err) => showToast(err.message, "error")));
    $("export-tickets-button").addEventListener("click", () => exportSupportTickets().catch((err) => showToast(err.message, "error")));
    $("create-ticket-button").addEventListener("click", openCreateTicketModal);
  }

  function wireModal() {
    $("support-modal-form").addEventListener("submit", handleModalSubmit);
    document.querySelectorAll("[data-close-modal]").forEach((el) => el.addEventListener("click", closeModal));
  }

  async function initSupportPage() {
    wireRangeTabs();
    wireFilters();
    wireTable();
    wireDrawer();
    wireTopButtons();
    wireModal();
    try {
      await loadOptions();
      await refreshAll();
      hydrateIcons(document);
    } catch (err) {
      showToast(err.message || "Could not load Support Issues.", "error");
    }
  }

  window.initSupportPage = initSupportPage;
  window.loadSupportOverview = loadSupportOverview;
  window.loadSupportTrends = loadSupportTrends;
  window.loadSupportCategoryBreakdown = loadSupportCategoryBreakdown;
  window.loadSupportAlerts = loadSupportAlerts;
  window.loadAssignedSupportTasks = loadAssignedSupportTasks;
  window.loadSupportActivity = loadSupportActivity;
  window.loadSupportList = loadSupportList;
  window.openSupportDrawer = openSupportDrawer;
  window.closeSupportDrawer = closeSupportDrawer;
  window.openCreateTicketModal = openCreateTicketModal;
  window.createTicket = createTicket;
  window.assignTicket = assignTicket;
  window.replyToTicket = replyToTicket;
  window.escalateTicket = escalateTicket;
  window.resolveTicket = resolveTicket;
  window.closeTicket = closeTicket;
  window.linkMaintenanceTask = linkMaintenanceTask;
  window.exportSupportTickets = exportSupportTickets;
  window.showSupportToast = showToast;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSupportPage);
  } else {
    initSupportPage();
  }
})();
