(function () {
  "use strict";

  const API_BASE = "/api/admin/reports";
  const BAD_VISIBLE_RE = /demo|seed|test|profit|loss/i;
  const REPORT_TYPES = {
    rides: {
      label: "Rides",
      title: "Ride Activity Report",
      icon: "bike",
      contents: ["booking summary", "completed rides", "active rides", "cancelled rides", "ride duration", "station usage"],
    },
    revenue: {
      label: "Revenue & Payments",
      title: "Revenue & Payments Report",
      icon: "dollar",
      contents: ["paid payments", "refunds", "failed payments", "payment methods", "net balance"],
    },
    stations: {
      label: "Stations",
      title: "Station Performance Report",
      icon: "map-pin",
      contents: ["station capacity", "available bikes", "low availability stations", "active stations"],
    },
    bikes: {
      label: "Bikes",
      title: "Bike Fleet Report",
      icon: "bike",
      contents: ["available bikes", "active bikes", "maintenance bikes", "low battery bikes", "bike usage"],
    },
    maintenance: {
      label: "Maintenance",
      title: "Maintenance Report",
      icon: "wrench",
      contents: ["open tasks", "urgent repairs", "completed repairs", "maintenance cost", "technician activity"],
    },
    support: {
      label: "Support Issues",
      title: "Support Issues Report",
      icon: "help-circle",
      contents: ["open tickets", "resolved tickets", "issue categories", "response status"],
    },
    operations: {
      label: "Full Operations Summary",
      title: "Full Operations Summary",
      icon: "bar-chart",
      contents: ["rides", "revenue", "stations", "bikes", "maintenance", "support"],
    },
  };

  const state = {
    range: "today",
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 1,
    filters: { search: "", type: "all", status: "all", format: "all", dateFrom: "", dateTo: "" },
    reports: [],
    selectedReport: null,
    modalMode: null,
    modalReportId: null,
    charts: { trend: null, type: null },
  };

  const $ = (id) => document.getElementById(id);
  const numberFmt = new Intl.NumberFormat("en-AU");
  const dateFmt = new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  function getToken() {
    try { return localStorage.getItem("cbs_token"); } catch (_) { return null; }
  }

  async function api(path, options = {}) {
    const token = getToken();
    if (!token) {
      window.location.replace("/login.html?admin=1&next=" + encodeURIComponent(location.pathname));
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
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        localStorage.removeItem("role");
      } catch (_) {}
      window.location.replace("/login.html?admin=1&next=" + encodeURIComponent(location.pathname));
      throw new Error("Admin session expired.");
    }
    if (!res.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  async function apiBlob(path) {
    const token = getToken();
    if (!token) {
      window.location.replace("/login.html?admin=1&next=" + encodeURIComponent(location.pathname));
      throw new Error("Admin login required.");
    }
    const res = await fetch(path, { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Download failed.");
    }
    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/i);
    return { blob: await res.blob(), filename: match ? match[1] : "report.csv" };
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

  function label(value, fallback = "Ready") {
    const key = String(value || "").toLowerCase();
    if (REPORT_TYPES[key]) return REPORT_TYPES[key].label;
    if (key === "payments") return "Revenue & Payments";
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
    const cls = String(key || "ready").toLowerCase().replace(/\s+/g, "_");
    return `<span class="ab-badge ${escapeHtml(cls)}">${escapeHtml(text || label(cls))}</span>`;
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
    }, 3000);
  }

  function rangeDates() {
    return datesForRange(state.range);
  }

  function datesForRange(rangeValue) {
    const now = new Date();
    const to = now.toISOString().slice(0, 10);
    const from = new Date(now);
    if (rangeValue === "today") {
      return { dateFrom: to, dateTo: to, label: "Today" };
    }
    if (rangeValue === "week") from.setDate(now.getDate() - 6);
    else if (rangeValue === "year") from.setMonth(0, 1);
    else from.setDate(1);
    return { dateFrom: from.toISOString().slice(0, 10), dateTo: to, label: rangeValue === "month" ? "This Month" : label(rangeValue) };
  }

  function iconForType(type) {
    const key = String(type || "").toLowerCase();
    return REPORT_TYPES[key]?.icon || (key === "payments" ? "dollar" : "bar-chart");
  }

  function reportNameFor(type, dateRange) {
    const date = new Date();
    const month = new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric" }).format(date);
    const typeTitle = REPORT_TYPES[type]?.title || `${label(type)} Report`;
    const suffix = dateRange === "today" ? "Today" : dateRange === "week" ? "This Week" : dateRange === "year" ? String(date.getFullYear()) : dateRange === "custom" ? "Custom Range" : month;
    return `${typeTitle} - ${suffix}`;
  }

  async function loadReportsOverview(range = state.range) {
    const data = await api(`${API_BASE}/overview?range=${encodeURIComponent(range)}`);
    const totals = data.totals || {};
    const trends = data.trends || {};
    [
      "reportsGenerated",
      "downloadsThisMonth",
      "scheduledReports",
      "failedExports",
      "pendingReports",
    ].forEach((key) => {
      const el = $("kpi-" + key);
      if (el) el.textContent = formatNumber(totals[key]);
      setTrend("trend-" + key, trends[key], key === "failedExports");
    });
    ["mostExportedType", "lastGeneratedReport", "averageFileSize"].forEach((key) => {
      const el = $("kpi-" + key);
      if (el) {
        const value = clean(totals[key], "Not available");
        el.textContent = value;
        el.title = value;
      }
      setTrend("trend-" + key, trends[key] || "");
    });
  }

  function chartLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    if (state.range === "today") return new Intl.DateTimeFormat("en-AU", { hour: "numeric" }).format(date);
    if (state.range === "year") return new Intl.DateTimeFormat("en-AU", { month: "short" }).format(date);
    return new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "short" }).format(date);
  }

  async function loadReportTrends(range = state.range) {
    const data = await api(`${API_BASE}/trends?range=${encodeURIComponent(range)}`);
    const labelEl = $("reports-trend-label");
    if (labelEl) labelEl.textContent = label(range);
    const ctx = $("reports-trend-chart");
    if (!ctx || !window.Chart) return;
    const config = {
      type: "line",
      data: {
        labels: (data.labels || []).map(chartLabel),
        datasets: [
          { label: "Ride Reports", data: data.rideReports || [], borderColor: "#16A34A", backgroundColor: "rgba(22,163,74,.10)", tension: .38, fill: true, pointRadius: 3, borderWidth: 2 },
          { label: "Revenue Reports", data: data.revenueReports || [], borderColor: "#3B82F6", backgroundColor: "rgba(59,130,246,.08)", tension: .38, fill: false, pointRadius: 3, borderWidth: 2 },
          { label: "Maintenance Reports", data: data.maintenanceReports || [], borderColor: "#F59E0B", backgroundColor: "rgba(245,158,11,.08)", tension: .38, fill: false, pointRadius: 3, borderWidth: 2 },
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
      id: "reportsCenterText",
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
        ctx.fillText("Reports", x, y + 16);
        ctx.restore();
      },
    };
  }

  async function loadReportTypeBreakdown(range = state.range) {
    const data = await api(`${API_BASE}/type-breakdown?range=${encodeURIComponent(range)}`);
    const rows = [
      ["rides", "Rides", data.rides || 0, "#16A34A"],
      ["revenue", "Revenue", data.revenue || 0, "#3B82F6"],
      ["stations", "Stations", data.stations || 0, "#8B5CF6"],
      ["bikes", "Bikes", data.bikes || 0, "#64748B"],
      ["maintenance", "Maintenance", data.maintenance || 0, "#F59E0B"],
      ["support", "Support", data.support || 0, "#EF4444"],
    ];
    const total = rows.reduce((sum, row) => sum + Number(row[2] || 0), 0);
    const legend = $("reports-type-legend");
    if (legend) {
      legend.innerHTML = rows.map((row) => {
        const pct = total ? ((Number(row[2]) / total) * 100).toFixed(1) : "0.0";
        return `<div class="rp-donut-row"><span class="rp-dot" style="background:${row[3]}"></span><span>${escapeHtml(row[1])}</span><strong>${formatNumber(row[2])} (${pct}%)</strong></div>`;
      }).join("");
    }
    const ctx = $("reports-type-chart");
    if (!ctx || !window.Chart) return;
    const config = {
      type: "doughnut",
      data: { labels: rows.map((r) => r[1]), datasets: [{ data: rows.map((r) => r[2]), backgroundColor: rows.map((r) => r[3]), borderWidth: 4, borderColor: "#FFFFFF", hoverOffset: 3 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: "68%", plugins: { legend: { display: false } } },
      plugins: [centerTextPlugin(total)],
    };
    if (state.charts.type) state.charts.type.destroy();
    state.charts.type = new Chart(ctx, config);
  }

  async function loadQuickExportOptions() {
    const data = await api(`${API_BASE}/quick-export-options`);
    const rows = data.options || [];
    const list = $("quick-export-list");
    const catalog = data.catalog || [];
    const grid = $("report-type-grid");
    if (grid) {
      grid.innerHTML = catalog.map((option) => `
        <article class="rp-report-type-card" title="${escapeHtml(option.description)}">
          <span class="rp-report-type-icon"><span data-icon="${iconForType(option.type)}"></span></span>
          <div class="rp-report-type-copy">
            <h3>${escapeHtml(option.name)}</h3>
            <p>${escapeHtml(option.description)}</p>
            <small>${option.latestGeneratedAt ? `Last generated ${escapeHtml(formatDate(option.latestGeneratedAt))}` : "No recent export"}</small>
          </div>
          <div class="rp-report-type-actions">
            <button class="ab-btn-primary" type="button" data-generate-type="${escapeHtml(option.type)}">Generate</button>
            <button class="ab-btn-secondary" type="button" data-download-latest="${escapeHtml(option.latestReportId || "")}" ${option.latestReportId ? "" : "disabled"}>Download latest</button>
          </div>
        </article>
      `).join("");
      hydrateIcons(grid);
    }
    if (list) {
      list.innerHTML = rows.map((option) => `
        <div class="rp-quick-row" title="${escapeHtml(option.description)}">
          <span class="rp-quick-icon"><span data-icon="${iconForType(option.type)}"></span></span>
          <span class="rp-quick-copy"><strong>${escapeHtml(option.name)}</strong><span>${escapeHtml(option.description)}</span></span>
          <button class="rp-export-mini" type="button" data-quick-export="${escapeHtml(option.type)}">Export</button>
        </div>
      `).join("");
      hydrateIcons(list);
    }
  }

  async function loadScheduledReports() {
    const data = await api(`${API_BASE}/scheduled?limit=5`);
    const rows = (data.reports || []).slice(0, 5);
    const list = $("scheduled-reports-list");
    if (!list) return;
    list.innerHTML = rows.length ? rows.map((report) => `
      <div class="rp-scheduled-row" title="${escapeHtml(report.reportName)}">
        <span class="rp-quick-icon"><span data-icon="calendar"></span></span>
        <span class="rp-scheduled-copy"><strong>${escapeHtml(report.reportName)}</strong><span>${escapeHtml(label(report.scheduleFrequency))} - ${escapeHtml(formatDate(report.nextRunAt))}</span></span>
        ${badge(report.status, report.statusLabel)}
      </div>
    `).join("") : `<div class="ab-empty">No scheduled reports.</div>`;
    hydrateIcons(list);
  }

  async function loadReportActivity() {
    const data = await api(`${API_BASE}/activity?limit=5`);
    const rows = (data.activity || []).slice(0, 5);
    const list = $("report-activity-list");
    if (!list) return;
    list.innerHTML = rows.length ? rows.map((item) => {
      const type = String(item.type || "");
      const tone = type.includes("failed") ? "red" : type.includes("scheduled") ? "blue" : type.includes("downloaded") ? "green" : "";
      const icon = type.includes("failed") ? "alert" : type.includes("scheduled") ? "calendar" : "bar-chart";
      return `
        <div class="ab-list-item" title="${escapeHtml(item.description)}">
          <span class="ab-list-ico ${tone}"><span data-icon="${icon}"></span></span>
          <div class="ab-list-body"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.description)}</span></div>
          <span class="ab-list-meta">${escapeHtml(formatRelative(item.timestamp))}</span>
        </div>`;
    }).join("") : `<div class="ab-empty">No report activity yet.</div>`;
    hydrateIcons(list);
  }

  function buildListQuery(extra = {}) {
    return new URLSearchParams({
      search: state.filters.search,
      type: state.filters.type,
      status: state.filters.status,
      format: state.filters.format,
      dateFrom: state.filters.dateFrom,
      dateTo: state.filters.dateTo,
      page: String(extra.page || state.page),
      limit: String(extra.limit || state.limit),
    }).toString();
  }

  async function loadReportsList(filters = {}) {
    state.filters = { ...state.filters, ...filters };
    const data = await api(`${API_BASE}/list?${buildListQuery()}`);
    state.reports = data.reports || [];
    state.total = Number(data.total || 0);
    state.page = Number(data.page || 1);
    state.limit = Number(data.limit || state.limit);
    state.totalPages = Number(data.totalPages || 1);
    renderReportsTable();
    renderPagination();
  }

  function renderReportsTable() {
    const totalEl = $("reports-total-count");
    const rowCount = $("reports-row-count");
    const body = $("reports-table-body");
    if (totalEl) totalEl.textContent = `(${formatNumber(state.total)})`;
    if (!body) return;
    if (!state.reports.length) {
      if (rowCount) rowCount.textContent = "No reports found";
      body.innerHTML = `<tr><td colspan="10" class="ab-table-empty">No reports match the current filters.</td></tr>`;
      return;
    }
    const start = (state.page - 1) * state.limit + 1;
    const end = Math.min(state.total, start + state.reports.length - 1);
    if (rowCount) rowCount.textContent = `Showing ${formatNumber(start)} to ${formatNumber(end)} of ${formatNumber(state.total)} reports`;
    body.innerHTML = state.reports.map((report) => `
      <tr data-report-id="${report.id}" title="View ${escapeHtml(report.reportId)} details">
        <td><span class="rp-report-code">${escapeHtml(report.reportId)}</span></td>
        <td title="${escapeHtml(report.reportName)}">${escapeHtml(report.reportName)}</td>
        <td>${escapeHtml(report.typeLabel)}</td>
        <td title="${escapeHtml(report.period)}">${escapeHtml(report.period)}</td>
        <td>${escapeHtml(report.format)}</td>
        <td title="${escapeHtml(report.generatedBy)}">${escapeHtml(report.generatedBy)}</td>
        <td>${badge(report.status, report.statusLabel)}</td>
        <td>${escapeHtml(formatDate(report.createdAt))}</td>
        <td>${escapeHtml(report.fileSize)}</td>
        <td>
          <span class="ab-row-actions">
            <button type="button" data-action="view" data-report-id="${report.id}" title="View details"><span data-icon="help-circle"></span></button>
            <button type="button" data-action="download" data-report-id="${report.id}" title="Download"><span data-icon="credit-card"></span></button>
            <button type="button" data-action="regenerate" data-report-id="${report.id}" title="Regenerate"><span data-icon="rotate"></span></button>
            <button type="button" data-action="schedule" data-report-id="${report.id}" title="Schedule"><span data-icon="calendar"></span></button>
            <button type="button" data-action="delete" data-report-id="${report.id}" title="Delete"><span data-icon="alert"></span></button>
          </span>
        </td>
      </tr>
    `).join("");
    hydrateIcons(body);
  }

  function renderPagination() {
    const wrap = $("reports-pagination");
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
      <section class="rp-detail-section">
        <h3>${escapeHtml(title)}</h3>
        ${rows.map(([key, value, wrap]) => `
          <div class="rp-detail-row">
            <span class="key">${escapeHtml(key)}</span>
            <span class="value ${wrap ? "wrap" : ""}" title="${escapeHtml(value)}">${escapeHtml(value)}</span>
          </div>
        `).join("")}
      </section>`;
  }

  function contentsSection(report) {
    const items = REPORT_TYPES[report.type]?.contents || REPORT_TYPES.rides.contents;
    return `
      <section class="rp-detail-section">
        <h3>Report Contents</h3>
        <ul class="rp-content-list">
          ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </section>`;
  }

  function renderDrawer(report) {
    const status = $("drawer-status");
    if (status) {
      status.textContent = report.statusLabel;
      status.className = `ab-status-badge ${escapeHtml(report.status)}`;
    }
    const body = $("report-drawer-body");
    if (!body) return;
    const dataIncluded = [
      report.includeCharts ? "Summary charts" : "",
      report.includeRawData ? "Raw table data" : "",
      report.notes && report.notes !== "No notes recorded." ? "Admin notes" : "",
    ].filter(Boolean).join(", ") || "Summary only";
    body.innerHTML = [
      detailSection("Report Information", [
        ["Report ID", report.reportId],
        ["Report Name", report.reportName, true],
        ["Report Type", report.typeLabel],
        ["Date Range", report.period],
        ["File Format", report.format],
        ["Generated By", report.generatedBy],
      ]),
      detailSection("Export Details", [
        ["Created Date", formatDate(report.createdAt)],
        ["Export Status", report.statusLabel],
        ["File Size", report.fileSize],
        ["Data Included", dataIncluded],
        ["Last Downloaded", formatDate(report.lastDownloadedAt, "Not downloaded")],
      ]),
      contentsSection(report),
      detailSection("Schedule & Notes", [
        ["Schedule", report.scheduleFrequency === "none" ? "Not scheduled" : `${label(report.scheduleFrequency)} - ${formatDate(report.nextRunAt)}`],
        ["Notes", report.notes, true],
      ]),
    ].join("");
  }

  async function openReportDrawer(reportId) {
    const data = await api(`${API_BASE}/${encodeURIComponent(reportId)}`);
    state.selectedReport = data.report;
    renderDrawer(state.selectedReport);
    $("report-drawer").hidden = false;
    document.body.classList.add("ab-drawer-open");
  }

  function closeReportDrawer() {
    $("report-drawer").hidden = true;
    document.body.classList.remove("ab-drawer-open");
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

  async function downloadReport(reportId) {
    const { blob, filename } = await apiBlob(`${API_BASE}/${encodeURIComponent(reportId)}/download`);
    downloadBlob(blob, filename);
    showToast("Report downloaded.");
    await Promise.all([loadReportsList(), loadReportActivity()]);
  }

  async function regenerateReport(reportId) {
    await api(`${API_BASE}/${encodeURIComponent(reportId)}/regenerate`, { method: "POST", body: JSON.stringify({}) });
    showToast("Report regenerated.");
    await refreshAll();
    if (state.selectedReport) await openReportDrawer(state.selectedReport.id);
  }

  async function scheduleReport(reportId, frequency) {
    await api(`${API_BASE}/${encodeURIComponent(reportId)}/schedule`, {
      method: "POST",
      body: JSON.stringify({ frequency }),
    });
    showToast("Report schedule updated.");
    closeModal();
    await refreshAll();
    if (state.selectedReport) await openReportDrawer(state.selectedReport.id);
  }

  async function deleteReport(reportId) {
    if (!window.confirm("Delete this report metadata? This will not remove operational data.")) return;
    await api(`${API_BASE}/${encodeURIComponent(reportId)}`, { method: "DELETE" });
    showToast("Report deleted.");
    closeReportDrawer();
    await refreshAll();
  }

  async function generateReport(payload, autoDownload = false) {
    const data = await api(`${API_BASE}/generate`, { method: "POST", body: JSON.stringify(payload) });
    const report = data.report;
    closeModal();
    await refreshAll();
    if (report.format !== "CSV") {
      showToast(`${report.format} export will be added in the next version. Report metadata was saved.`, "warning");
      return report;
    }
    showToast("Report generated.");
    if (autoDownload) await downloadReport(report.id);
    return report;
  }

  async function exportReportsCsv() {
    const data = await api(`${API_BASE}/list?${buildListQuery({ page: 1, limit: 1000 })}`);
    const rows = [["Report ID", "Report Name", "Type", "Date Range", "Format", "Generated By", "Status", "Created Date", "File Size"]];
    (data.reports || []).forEach((report) => rows.push([
      report.reportId,
      report.reportName,
      report.typeLabel,
      report.period,
      report.format,
      report.generatedBy,
      report.statusLabel,
      formatDate(report.createdAt),
      report.fileSize,
    ]));
    const csv = rows.map((row) => row.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(",")).join("\n");
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `reports_${state.range}_${new Date().toISOString().slice(0, 10)}.csv`);
    showToast("Reports list exported.");
  }

  function setModal(title, submitText, bodyHtml, mode, reportId = null) {
    state.modalMode = mode;
    state.modalReportId = reportId;
    $("report-modal-title").textContent = title;
    $("report-modal-submit").textContent = submitText;
    $("report-modal-body").innerHTML = bodyHtml;
    $("report-modal").hidden = false;
    hydrateIcons($("report-modal"));
  }

  function openGenerateReportModal(defaultType = "rides") {
    const dates = rangeDates();
    const typeOptions = [
      ["rides", "Rides"],
      ["revenue", "Revenue & Payments"],
      ["stations", "Stations"],
      ["bikes", "Bikes"],
      ["maintenance", "Maintenance"],
      ["support", "Support Issues"],
      ["operations", "Full Operations Summary"],
    ].map(([value, text]) => `<option value="${value}" ${defaultType === value ? "selected" : ""}>${text}</option>`).join("");
    setModal("Generate New Report", "Generate Report", `
      <div class="rp-modal-grid">
        <label>Report Type<select name="reportType">${typeOptions}</select></label>
        <label>Date Range<select name="dateRange"><option value="today" ${state.range === "today" ? "selected" : ""}>Today</option><option value="week" ${state.range === "week" ? "selected" : ""}>This Week</option><option value="month" ${state.range === "month" ? "selected" : ""}>This Month</option><option value="year" ${state.range === "year" ? "selected" : ""}>This Year</option><option value="custom">Custom Range</option></select></label>
        <label class="rp-custom-date">Date From<input type="date" name="dateFrom" value="${escapeHtml(dates.dateFrom)}" /></label>
        <label class="rp-custom-date">Date To<input type="date" name="dateTo" value="${escapeHtml(dates.dateTo)}" /></label>
        <label>File Format<select name="format"><option value="csv">CSV</option><option value="pdf">PDF</option><option value="xlsx">XLSX</option></select></label>
        <label>Schedule Report<select name="scheduleFrequency"><option value="none">No schedule</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
        <label class="full">Report Name<input name="reportName" required maxlength="160" value="${escapeHtml(reportNameFor(defaultType, state.range))}" /></label>
        <label class="check"><span><input type="checkbox" name="includeCharts" checked />Include Summary Charts</span></label>
        <label class="check"><span><input type="checkbox" name="includeRawData" checked />Include Raw Table Data</span></label>
        <label class="check"><span><input type="checkbox" name="includeAdminNotes" />Include Admin Notes</span></label>
        <label class="full rp-notes-field" hidden>Admin Notes<textarea name="notes" placeholder="Optional notes for this report."></textarea></label>
      </div>
    `, "generate");
    wireGenerateModalFields();
  }

  function wireGenerateModalFields() {
    const form = $("report-modal-form");
    if (!form) return;
    const type = form.elements.reportType;
    const dateRange = form.elements.dateRange;
    const dateFrom = form.elements.dateFrom;
    const dateTo = form.elements.dateTo;
    const reportName = form.elements.reportName;
    const includeNotes = form.elements.includeAdminNotes;
    const notesField = $("report-modal-body").querySelector(".rp-notes-field");
    const sync = () => {
      const selectedRange = dateRange.value;
      if (selectedRange !== "custom") {
        const dates = datesForRange(selectedRange);
        dateFrom.value = dates.dateFrom;
        dateTo.value = dates.dateTo;
      }
      document.querySelectorAll(".rp-custom-date").forEach((el) => { el.hidden = selectedRange !== "custom"; });
      if (reportName && (!reportName.dataset.touched || !reportName.value.trim())) {
        reportName.value = reportNameFor(type.value, selectedRange);
      }
      if (notesField) notesField.hidden = !includeNotes.checked;
    };
    reportName.addEventListener("input", () => { reportName.dataset.touched = "true"; });
    type.addEventListener("change", () => { reportName.dataset.touched = ""; sync(); });
    dateRange.addEventListener("change", () => { reportName.dataset.touched = ""; sync(); });
    includeNotes.addEventListener("change", sync);
    sync();
  }

  function openScheduleModal(reportId) {
    setModal("Schedule Report", "Save Schedule", `
      <label>Schedule Frequency<select name="frequency" required><option value="daily">Daily</option><option value="weekly" selected>Weekly</option><option value="monthly">Monthly</option><option value="none">None</option></select></label>
    `, "schedule", reportId);
  }

  function closeModal() {
    const modal = $("report-modal");
    if (modal) modal.hidden = true;
    const form = $("report-modal-form");
    if (form) form.reset();
    state.modalMode = null;
    state.modalReportId = null;
  }

  async function handleModalSubmit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      if (state.modalMode === "generate") {
        const includeAdminNotes = form.get("includeAdminNotes") === "on";
        await generateReport({
          reportType: form.get("reportType"),
          format: form.get("format"),
          dateFrom: form.get("dateFrom"),
          dateTo: form.get("dateTo"),
          includeCharts: form.get("includeCharts") === "on",
          includeRawData: form.get("includeRawData") === "on",
          scheduleFrequency: form.get("scheduleFrequency"),
          reportName: form.get("reportName") || `${label(form.get("reportType"))} Report`,
          notes: includeAdminNotes ? form.get("notes") : "",
        }, false);
      } else if (state.modalMode === "schedule") {
        await scheduleReport(state.modalReportId, form.get("frequency"));
      }
    } catch (err) {
      showToast(err.message || "Action failed.", "error");
    }
  }

  async function quickExport(type) {
    const dates = rangeDates();
    const report = await generateReport({
      reportType: type,
      format: "csv",
      dateFrom: dates.dateFrom,
      dateTo: dates.dateTo,
      includeCharts: true,
      includeRawData: true,
      scheduleFrequency: "none",
      reportName: reportNameFor(type, state.range),
      notes: `${dates.label} quick export`,
    }, false);
    await downloadReport(report.id);
  }

  async function refreshAll() {
    try {
      await Promise.all([
        loadReportsOverview(state.range),
        loadReportTrends(state.range),
        loadReportTypeBreakdown(state.range),
        loadQuickExportOptions(),
        loadScheduledReports(),
        loadReportActivity(),
        loadReportsList(),
      ]);
    } catch (err) {
      showToast(err.message || "Could not refresh Reports Management.", "error");
    }
  }

  function wireRangeTabs() {
    document.querySelectorAll(".ad-range-tabs button[data-range]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".ad-range-tabs button[data-range]").forEach((btn) => btn.classList.remove("active"));
        button.classList.add("active");
        state.range = button.dataset.range || "today";
        Promise.all([
          loadReportsOverview(state.range),
          loadReportTrends(state.range),
          loadReportTypeBreakdown(state.range),
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
          search: $("report-search").value.trim(),
          type: $("filter-type").value,
          status: $("filter-status").value,
          format: $("filter-format").value,
          dateFrom: $("filter-date-from").value,
          dateTo: $("filter-date-to").value,
        };
        loadReportsList().catch((err) => showToast(err.message, "error"));
      }, 180);
    };
    [["report-search", "input"], ["filter-type", "change"], ["filter-status", "change"], ["filter-format", "change"], ["filter-date-from", "change"], ["filter-date-to", "change"]].forEach(([id, event]) => {
      const el = $(id);
      if (el) el.addEventListener(event, apply);
    });
    $("reset-filters").addEventListener("click", () => {
      $("report-search").value = "";
      $("filter-type").value = "all";
      $("filter-status").value = "all";
      $("filter-format").value = "all";
      $("filter-date-from").value = "";
      $("filter-date-to").value = "";
      state.page = 1;
      state.filters = { search: "", type: "all", status: "all", format: "all", dateFrom: "", dateTo: "" };
      loadReportsList().catch((err) => showToast(err.message, "error"));
    });
    $("reports-page-size").addEventListener("change", (event) => {
      state.limit = Number(event.target.value || 10);
      state.page = 1;
      loadReportsList().catch((err) => showToast(err.message, "error"));
    });
  }

  function wireTable() {
    $("reports-table-body").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      const row = event.target.closest("tr[data-report-id]");
      const reportId = button?.dataset.reportId || row?.dataset.reportId;
      if (!reportId) return;
      if (button) {
        event.stopPropagation();
        const action = button.dataset.action;
        if (action === "download") return downloadReport(reportId).catch((err) => showToast(err.message, "error"));
        if (action === "regenerate") return regenerateReport(reportId).catch((err) => showToast(err.message, "error"));
        if (action === "schedule") return openScheduleModal(reportId);
        if (action === "delete") return deleteReport(reportId).catch((err) => showToast(err.message, "error"));
      }
      openReportDrawer(reportId).catch((err) => showToast(err.message, "error"));
    });
    $("reports-pagination").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-page]");
      if (!button || button.disabled) return;
      state.page = Math.max(1, Math.min(state.totalPages, Number(button.dataset.page || 1)));
      loadReportsList().catch((err) => showToast(err.message, "error"));
    });
  }

  function wireDrawer() {
    $("close-report-drawer").addEventListener("click", closeReportDrawer);
    document.querySelectorAll("[data-close-drawer]").forEach((el) => el.addEventListener("click", closeReportDrawer));
    $("report-drawer").addEventListener("click", (event) => {
      const button = event.target.closest("[data-drawer-action]");
      if (!button || !state.selectedReport) return;
      const id = state.selectedReport.id;
      const action = button.dataset.drawerAction;
      if (action === "download") downloadReport(id).catch((err) => showToast(err.message, "error"));
      if (action === "regenerate") regenerateReport(id).catch((err) => showToast(err.message, "error"));
      if (action === "schedule") openScheduleModal(id);
      if (action === "email") showToast("Email report delivery will be added in the next version.", "warning");
      if (action === "delete") deleteReport(id).catch((err) => showToast(err.message, "error"));
      if (action === "audit") exportReportsCsv().catch((err) => showToast(err.message, "error"));
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (!$("report-modal").hidden) closeModal();
        else if (!$("report-drawer").hidden) closeReportDrawer();
      }
    });
  }

  function wireTopButtons() {
    $("refresh-dashboard").addEventListener("click", () => {
      showToast("Refreshing reports...");
      refreshAll();
    });
    $("export-report").addEventListener("click", () => exportReportsCsv().catch((err) => showToast(err.message, "error")));
    $("export-all-button").addEventListener("click", () => exportReportsCsv().catch((err) => showToast(err.message, "error")));
    $("generate-report-button").addEventListener("click", () => openGenerateReportModal());
  }

  function wireCardsAndModal() {
    $("quick-export-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-quick-export]");
      if (button) quickExport(button.dataset.quickExport).catch((err) => showToast(err.message, "error"));
    });
    $("report-type-grid").addEventListener("click", (event) => {
      const generate = event.target.closest("[data-generate-type]");
      const download = event.target.closest("[data-download-latest]");
      if (generate) openGenerateReportModal(generate.dataset.generateType);
      if (download && download.dataset.downloadLatest) downloadReport(download.dataset.downloadLatest).catch((err) => showToast(err.message, "error"));
    });
    $("report-modal-form").addEventListener("submit", handleModalSubmit);
    document.querySelectorAll("[data-close-modal]").forEach((el) => el.addEventListener("click", closeModal));
  }

  async function initReportsPage() {
    wireRangeTabs();
    wireFilters();
    wireTable();
    wireDrawer();
    wireTopButtons();
    wireCardsAndModal();
    try {
      await refreshAll();
      hydrateIcons(document);
    } catch (err) {
      showToast(err.message || "Could not load Reports Management.", "error");
    }
  }

  window.initReportsPage = initReportsPage;
  window.loadReportsOverview = loadReportsOverview;
  window.loadReportTrends = loadReportTrends;
  window.loadReportTypeBreakdown = loadReportTypeBreakdown;
  window.loadQuickExportOptions = loadQuickExportOptions;
  window.loadScheduledReports = loadScheduledReports;
  window.loadReportActivity = loadReportActivity;
  window.loadReportsList = loadReportsList;
  window.openReportDrawer = openReportDrawer;
  window.closeReportDrawer = closeReportDrawer;
  window.openGenerateReportModal = openGenerateReportModal;
  window.generateReport = generateReport;
  window.downloadReport = downloadReport;
  window.regenerateReport = regenerateReport;
  window.scheduleReport = scheduleReport;
  window.deleteReport = deleteReport;
  window.exportReportsCsv = exportReportsCsv;
  window.showReportsToast = showToast;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initReportsPage);
  } else {
    initReportsPage();
  }
})();
