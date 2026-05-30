(function () {
  "use strict";

  const API_BASE = "/api/admin/maintenance";
  const BAD_VISIBLE_RE = /demo|seed|test|profit|loss/i;

  const state = {
    range: "today",
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 1,
    filters: {
      search: "",
      status: "all",
      priority: "all",
      type: "all",
      technician: "all",
      dateFrom: "",
      dateTo: "",
    },
    technicians: [],
    bikes: [],
    stations: [],
    tasks: [],
    selectedTask: null,
    modalMode: null,
    modalTaskId: null,
    charts: { trend: null, status: null },
  };

  const $ = (id) => document.getElementById(id);
  const numberFmt = new Intl.NumberFormat("en-AU");
  const moneyFmt = new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const compactMoneyFmt = new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  });
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
    return clean(value, fallback)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatNumber(value) {
    return numberFmt.format(Number(value || 0));
  }

  function formatMoney(value, compact = false) {
    return (compact ? compactMoneyFmt : moneyFmt).format(Number(value || 0));
  }

  function formatDate(value, fallback = "Not set") {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return dateFmt.format(date);
  }

  function formatHours(value) {
    const totalMinutes = Math.round(Number(value || 0) * 60);
    if (totalMinutes <= 0) return "0h";
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!hours) return `${minutes}m`;
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
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

  function iconForTask(task) {
    const type = String(task.type || task.issue || "").toLowerCase();
    if (type.includes("battery")) return "alert";
    if (type.includes("gps") || type.includes("dock")) return "map-pin";
    if (type.includes("brake") || type.includes("chain")) return "wrench";
    return task.assetType === "station" ? "map-pin" : "bike";
  }

  function toneForPriority(priority) {
    const key = String(priority || "").toLowerCase();
    if (key === "urgent" || key === "high") return "red";
    if (key === "medium") return "amber";
    return "green";
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

  async function loadMaintenanceOverview(range = state.range) {
    const data = await api(`${API_BASE}/overview?range=${encodeURIComponent(range)}`);
    const totals = data.totals || {};
    const trends = data.trends || {};
    const fields = [
      "openTasks",
      "bikesInMaintenance",
      "stationIssues",
      "urgentRepairs",
      "completedRepairs",
      "pendingInspection",
    ];
    fields.forEach((key) => {
      const el = $("kpi-" + key);
      if (el) el.textContent = formatNumber(totals[key]);
      setTrend("trend-" + key, trends[key], ["openTasks", "urgentRepairs", "pendingInspection"].includes(key));
    });
    if ($("kpi-maintenanceCost")) $("kpi-maintenanceCost").textContent = formatMoney(totals.maintenanceCost, true);
    if ($("kpi-averageRepairTime")) $("kpi-averageRepairTime").textContent = formatHours(totals.averageRepairTime);
    setTrend("trend-maintenanceCost", trends.maintenanceCost, true);
    setTrend("trend-averageRepairTime", trends.averageRepairTime, true);
  }

  function chartLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    if (state.range === "today") return new Intl.DateTimeFormat("en-AU", { hour: "numeric" }).format(date);
    if (state.range === "year") return new Intl.DateTimeFormat("en-AU", { month: "short" }).format(date);
    return new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "short" }).format(date);
  }

  async function loadMaintenanceTrends(range = state.range) {
    const data = await api(`${API_BASE}/trends?range=${encodeURIComponent(range)}`);
    const labelEl = $("maintenance-trend-label");
    if (labelEl) labelEl.textContent = label(range);
    const ctx = $("maintenance-trend-chart");
    if (!ctx || !window.Chart) return;
    const config = {
      type: "line",
      data: {
        labels: (data.labels || []).map(chartLabel),
        datasets: [
          {
            label: "Open Tasks",
            data: data.openTasks || [],
            borderColor: "#2563EB",
            backgroundColor: "rgba(37, 99, 235, .10)",
            tension: 0.38,
            fill: true,
            pointRadius: 3,
            borderWidth: 2,
            yAxisID: "y",
          },
          {
            label: "Completed Repairs",
            data: data.completedRepairs || [],
            borderColor: "#16A34A",
            backgroundColor: "rgba(22, 163, 74, .08)",
            tension: 0.38,
            fill: false,
            pointRadius: 3,
            borderWidth: 2,
            yAxisID: "y",
          },
          {
            type: "bar",
            label: "Maintenance Cost",
            data: data.maintenanceCost || [],
            borderColor: "#F59E0B",
            backgroundColor: "rgba(245, 158, 11, .42)",
            borderRadius: 6,
            yAxisID: "y1",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: "index",
            intersect: false,
            callbacks: {
              label(ctx) {
                if (ctx.dataset.yAxisID === "y1") return `${ctx.dataset.label}: ${formatMoney(ctx.parsed.y)}`;
                return `${ctx.dataset.label}: ${formatNumber(ctx.parsed.y)}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: "#64748B", maxTicksLimit: 7, font: { size: 11 } } },
          y: { beginAtZero: true, grid: { color: "#E2E8F0" }, ticks: { color: "#64748B", precision: 0, font: { size: 11 } } },
          y1: {
            beginAtZero: true,
            position: "right",
            grid: { drawOnChartArea: false },
            ticks: { color: "#64748B", font: { size: 11 }, callback: (value) => formatMoney(value, true) },
          },
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
      id: "maintenanceCenterText",
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
        ctx.fillText("Total Tasks", x, y + 16);
        ctx.restore();
      },
    };
  }

  async function loadMaintenanceStatusBreakdown(range = state.range) {
    const data = await api(`${API_BASE}/status-breakdown?range=${encodeURIComponent(range)}`);
    const rows = [
      ["open", "Open", data.open || 0, "#3B82F6"],
      ["in_progress", "In Progress", data.inProgress || 0, "#F97316"],
      ["waiting_parts", "Waiting Parts", data.waitingParts || 0, "#8B5CF6"],
      ["completed", "Completed", data.completed || 0, "#16A34A"],
      ["urgent", "Urgent", data.urgent || 0, "#EF4444"],
    ];
    const total = rows.reduce((sum, row) => sum + Number(row[2] || 0), 0);
    const legend = $("maintenance-status-legend");
    if (legend) {
      legend.innerHTML = rows.map((row) => {
        const pct = total ? ((Number(row[2]) / total) * 100).toFixed(1) : "0.0";
        return `<div class="mm-donut-row"><span class="mm-dot" style="background:${row[3]}"></span><span>${escapeHtml(row[1])}</span><strong>${formatNumber(row[2])} (${pct}%)</strong></div>`;
      }).join("");
    }
    const ctx = $("maintenance-status-chart");
    if (!ctx || !window.Chart) return;
    const config = {
      type: "doughnut",
      data: {
        labels: rows.map((row) => row[1]),
        datasets: [{ data: rows.map((row) => row[2]), backgroundColor: rows.map((row) => row[3]), borderWidth: 4, borderColor: "#FFFFFF", hoverOffset: 3 }],
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: "68%", plugins: { legend: { display: false } } },
      plugins: [centerTextPlugin(total)],
    };
    if (state.charts.status) state.charts.status.destroy();
    state.charts.status = new Chart(ctx, config);
  }

  async function loadMaintenanceAlerts() {
    const data = await api(`${API_BASE}/alerts`);
    const rows = (data.alerts || []).slice(0, 5);
    const list = $("maintenance-alerts-list");
    if (!list) return;
    list.innerHTML = rows.length ? rows.map((task) => {
      const tone = toneForPriority(task.priority);
      return `
        <div class="ab-list-item" title="${escapeHtml(task.description)}">
          <span class="ab-list-ico ${tone}"><span data-icon="${iconForTask(task)}"></span></span>
          <div class="ab-list-body"><strong>${escapeHtml(clean(task.asset, "Maintenance task"))}</strong><span>${escapeHtml(task.issue)} at ${escapeHtml(task.location)}</span></div>
          ${badge(task.priority, label(task.priority))}
        </div>`;
    }).join("") : `<div class="ab-empty">No urgent maintenance alerts.</div>`;
    hydrateIcons(list);
  }

  async function loadTechnicianTasks() {
    const data = await api(`${API_BASE}/technician-tasks`);
    const rows = (data.tasks || []).slice(0, 5);
    const list = $("technician-tasks-list");
    if (!list) return;
    list.innerHTML = rows.length ? `
      <div class="mm-tech-head"><span>Technician</span><span>Task</span><span>Asset</span><span>Status</span><span>ETA</span></div>
      ${rows.map((task) => `
        <div class="mm-tech-row" title="${escapeHtml(task.taskId)} - ${escapeHtml(task.description)}">
          <strong>${escapeHtml(task.technician)}</strong>
          <span>${escapeHtml(task.type)}</span>
          <span>${escapeHtml(task.asset)}</span>
          ${badge(task.status, task.statusLabel)}
          <span class="eta">${escapeHtml(task.eta)}</span>
        </div>
      `).join("")}
    ` : `<div class="ab-empty">No technician tasks assigned.</div>`;
  }

  async function loadMaintenanceActivity() {
    const data = await api(`${API_BASE}/activity?limit=5`);
    const rows = (data.activity || []).slice(0, 5);
    const list = $("maintenance-activity-list");
    if (!list) return;
    list.innerHTML = rows.length ? rows.map((item) => {
      const key = String(item.type || "");
      const tone = key.includes("completed") ? "green" : key.includes("assigned") ? "blue" : key.includes("flagged") ? "amber" : "";
      const icon = key.includes("completed") ? "check" : key.includes("assigned") ? "help-circle" : key.includes("station") ? "map-pin" : "wrench";
      return `
        <div class="ab-list-item" title="${escapeHtml(item.description)}">
          <span class="ab-list-ico ${tone}"><span data-icon="${icon}"></span></span>
          <div class="ab-list-body"><strong>${escapeHtml(clean(item.title, "Maintenance activity"))}</strong><span>${escapeHtml(clean(item.description, "Maintenance update"))}</span></div>
          <span class="ab-list-meta">${escapeHtml(formatRelative(item.timestamp))}</span>
        </div>`;
    }).join("") : `<div class="ab-empty">No recent maintenance activity.</div>`;
    hydrateIcons(list);
  }

  function buildListQuery(extra = {}) {
    const params = new URLSearchParams({
      search: state.filters.search,
      status: state.filters.status,
      priority: state.filters.priority,
      type: state.filters.type,
      technician: state.filters.technician,
      dateFrom: state.filters.dateFrom,
      dateTo: state.filters.dateTo,
      page: String(extra.page || state.page),
      limit: String(extra.limit || state.limit),
    });
    return params.toString();
  }

  async function loadMaintenanceList(filters = {}) {
    state.filters = { ...state.filters, ...filters };
    const data = await api(`${API_BASE}/list?${buildListQuery()}`);
    state.tasks = data.tasks || [];
    state.total = Number(data.total || 0);
    state.page = Number(data.page || 1);
    state.limit = Number(data.limit || state.limit);
    state.totalPages = Number(data.totalPages || 1);
    renderMaintenanceTable();
    renderPagination();
  }

  function renderMaintenanceTable() {
    const totalEl = $("maintenance-total-count");
    const rowCount = $("maintenance-row-count");
    const body = $("maintenance-table-body");
    if (totalEl) totalEl.textContent = `(${formatNumber(state.total)})`;
    if (!body) return;
    if (!state.tasks.length) {
      if (rowCount) rowCount.textContent = "No maintenance tasks found";
      body.innerHTML = `<tr><td colspan="11" class="ab-table-empty">No maintenance tasks match the current filters.</td></tr>`;
      return;
    }
    const start = (state.page - 1) * state.limit + 1;
    const end = Math.min(state.total, start + state.tasks.length - 1);
    if (rowCount) rowCount.textContent = `Showing ${formatNumber(start)} to ${formatNumber(end)} of ${formatNumber(state.total)} tasks`;
    body.innerHTML = state.tasks.map((task) => `
      <tr data-task-id="${task.id}" title="View ${escapeHtml(task.taskId)} details">
        <td><span class="task-code">${escapeHtml(task.taskId)}</span></td>
        <td title="${escapeHtml(task.asset)}">${escapeHtml(task.asset)}</td>
        <td title="${escapeHtml(task.type)}">${escapeHtml(task.type)}</td>
        <td title="${escapeHtml(task.description)}">${escapeHtml(task.issue)}</td>
        <td title="${escapeHtml(task.location)}">${escapeHtml(task.location)}</td>
        <td>${badge(task.priority, label(task.priority))}</td>
        <td>${badge(task.status, task.statusLabel)}</td>
        <td title="${escapeHtml(task.technician)}">${escapeHtml(task.technician)}</td>
        <td>${escapeHtml(formatMoney(task.cost))}</td>
        <td>${escapeHtml(formatDate(task.reportedDate))}</td>
        <td>
          <span class="ab-row-actions">
            <button type="button" data-action="view" data-task-id="${task.id}" title="View details"><span data-icon="help-circle"></span></button>
            <button type="button" data-action="assign" data-task-id="${task.id}" title="Assign technician"><span data-icon="help-circle"></span></button>
            <button type="button" data-action="complete" data-task-id="${task.id}" title="Complete task"><span data-icon="check"></span></button>
            <button type="button" data-action="more" data-task-id="${task.id}" title="More actions"><span data-icon="chevron-right"></span></button>
          </span>
        </td>
      </tr>
    `).join("");
    hydrateIcons(body);
  }

  function renderPagination() {
    const wrap = $("maintenance-pagination");
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
      <section class="mm-detail-section">
        <h3>${escapeHtml(title)}</h3>
        ${rows.map(([key, value, wrap]) => `
          <div class="mm-detail-row">
            <span class="key">${escapeHtml(key)}</span>
            <span class="value ${wrap ? "wrap" : ""}" title="${escapeHtml(value)}">${escapeHtml(value)}</span>
          </div>
        `).join("")}
      </section>`;
  }

  function renderDrawer(task) {
    const status = $("drawer-status");
    if (status) {
      status.textContent = task.statusLabel || label(task.status);
      status.className = `ab-status-badge ${escapeHtml(task.status)}`;
    }
    const body = $("maintenance-drawer-body");
    if (!body) return;
    const assetId = task.assetType === "bike" ? (task.bikeCode || task.asset) : task.asset;
    body.innerHTML = [
      detailSection("Task Information", [
        ["Task ID", task.taskId],
        ["Asset Type", label(task.assetType)],
        ["Asset ID", assetId],
        ["Issue Type", task.type],
        ["Priority", label(task.priority)],
        ["Status", task.statusLabel],
      ]),
      detailSection("Location & Assignment", [
        ["Location", task.location],
        ["Assigned Technician", task.technician],
        ["Reported Date", formatDate(task.reportedDate)],
        ["Estimated Completion", formatDate(task.estimatedCompletion)],
        ["Last Updated", formatDate(task.lastUpdated)],
      ]),
      detailSection("Cost & Ticket", [
        ["Repair Cost", formatMoney(task.cost)],
        ["Linked Support Ticket", task.supportTicket],
        ["Notes", task.notes && task.notes !== "No maintenance notes recorded." ? task.notes : task.description, true],
      ]),
    ].join("");
  }

  async function openMaintenanceDrawer(taskId) {
    const data = await api(`${API_BASE}/${encodeURIComponent(taskId)}`);
    state.selectedTask = data.task;
    renderDrawer(state.selectedTask);
    $("maintenance-drawer").hidden = false;
    document.body.classList.add("ab-drawer-open");
  }

  function closeMaintenanceDrawer() {
    const drawer = $("maintenance-drawer");
    if (drawer) drawer.hidden = true;
    document.body.classList.remove("ab-drawer-open");
  }

  async function updateMaintenanceStatus(taskId, status) {
    await api(`${API_BASE}/${encodeURIComponent(taskId)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    showToast(`Maintenance task marked ${label(status)}.`);
    await refreshAll();
    if (state.selectedTask) await openMaintenanceDrawer(state.selectedTask.id);
  }

  async function assignTechnician(taskId, technicianName) {
    await api(`${API_BASE}/${encodeURIComponent(taskId)}/assign-technician`, {
      method: "PATCH",
      body: JSON.stringify({ technicianName }),
    });
    showToast("Technician assigned.");
    closeModal();
    await refreshAll();
    if (state.selectedTask) await openMaintenanceDrawer(state.selectedTask.id);
  }

  async function addRepairCost(taskId, cost, notes = "") {
    await api(`${API_BASE}/${encodeURIComponent(taskId)}/cost`, {
      method: "PATCH",
      body: JSON.stringify({ cost, notes }),
    });
    showToast("Repair cost updated.");
    closeModal();
    await refreshAll();
    if (state.selectedTask) await openMaintenanceDrawer(state.selectedTask.id);
  }

  async function completeMaintenanceTask(taskId, payload = {}) {
    await api(`${API_BASE}/${encodeURIComponent(taskId)}/complete`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    showToast("Maintenance task completed.");
    closeModal();
    await refreshAll();
    if (state.selectedTask) await openMaintenanceDrawer(state.selectedTask.id);
  }

  async function createMaintenanceTask(payload) {
    await api(`${API_BASE}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    showToast("Maintenance task created.");
    closeModal();
    await refreshAll();
  }

  async function exportMaintenanceReport() {
    const data = await api(`${API_BASE}/list?${buildListQuery({ page: 1, limit: 1000 })}`);
    const rows = [["Task ID", "Asset", "Type", "Issue", "Location", "Priority", "Status", "Technician", "Cost", "Reported Date"]];
    (data.tasks || []).forEach((task) => rows.push([
      task.taskId,
      task.asset,
      task.type,
      task.issue,
      task.location,
      label(task.priority),
      task.statusLabel,
      task.technician,
      formatMoney(task.cost),
      formatDate(task.reportedDate),
    ]));
    const csv = rows.map((row) => row.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `maintenance_${state.range}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Maintenance report exported.");
  }

  function technicianOptions(selected = "") {
    return state.technicians.map((name) => `<option value="${escapeHtml(name)}" ${name === selected ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
  }

  function bikeOptions(selected = "") {
    return state.bikes.map((bike) => `<option value="${bike.id}" ${String(bike.id) === String(selected) ? "selected" : ""}>${escapeHtml(bike.code)}</option>`).join("");
  }

  function stationOptions(selected = "") {
    return state.stations.map((station) => `<option value="${station.id}" ${String(station.id) === String(selected) ? "selected" : ""}>${escapeHtml(station.name)}</option>`).join("");
  }

  function setModal(title, submitText, bodyHtml, mode, taskId = null) {
    state.modalMode = mode;
    state.modalTaskId = taskId;
    $("maintenance-modal-title").textContent = title;
    $("maintenance-modal-submit").textContent = submitText;
    $("maintenance-modal-body").innerHTML = bodyHtml;
    $("maintenance-modal").hidden = false;
    hydrateIcons($("maintenance-modal"));
  }

  function syncAssetFields() {
    const asset = $("modal-asset-type");
    const bikeField = $("modal-bike-field");
    const stationField = $("modal-station-field");
    if (!asset || !bikeField || !stationField) return;
    const isStation = asset.value === "station";
    bikeField.hidden = isStation;
    stationField.hidden = !isStation;
    const bike = bikeField.querySelector("select");
    const station = stationField.querySelector("select");
    if (bike) {
      bike.required = !isStation;
      bike.disabled = isStation;
    }
    if (station) {
      station.required = isStation;
      station.disabled = !isStation;
    }
  }

  function openAddMaintenanceModal() {
    setModal("Add Maintenance Task", "Create Task", `
      <div class="mm-modal-grid">
        <label>Asset Type<select name="assetType" id="modal-asset-type"><option value="bike">Bike</option><option value="station">Station</option></select></label>
        <label id="modal-bike-field">Bike<select name="bikeId">${bikeOptions()}</select></label>
        <label id="modal-station-field" hidden>Station<select name="stationId">${stationOptions()}</select></label>
        <label>Issue Type<select name="issueType"><option value="brake_issue">Brake issue</option><option value="battery_failure">Battery failure</option><option value="dock_issue">Station dock issue</option><option value="gps_offline">GPS offline</option><option value="capacity_dock_fault">Capacity dock fault</option><option value="general_service">General service</option></select></label>
        <label>Priority<select name="priority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
        <label>Technician<select name="technicianName"><option value="">Unassigned</option>${technicianOptions()}</select></label>
        <label>Estimated Completion<input type="datetime-local" name="estimatedCompletion" /></label>
        <label>Initial Cost<input type="number" name="cost" min="0" step="0.01" value="0" /></label>
        <label>Linked Support Ticket<input type="number" name="supportTicketId" min="1" placeholder="Optional" /></label>
        <label class="full">Issue Description<textarea name="description" required placeholder="Describe the fault and what needs attention."></textarea></label>
      </div>
    `, "add");
    $("modal-asset-type").addEventListener("change", syncAssetFields);
    syncAssetFields();
  }

  function openAssignModal(taskId) {
    const selected = state.selectedTask?.technician || "";
    setModal("Assign Technician", "Assign Technician", `
      <label>Technician<select name="technicianName" required>${technicianOptions(selected)}</select></label>
    `, "assign", taskId);
  }

  function openCostModal(taskId) {
    const cost = state.selectedTask?.cost || 0;
    setModal("Add Repair Cost", "Save Cost", `
      <label>Repair Cost<input type="number" name="cost" min="0" step="0.01" value="${escapeHtml(cost)}" required /></label>
      <label>Maintenance Notes<textarea name="notes" placeholder="Optional notes about parts or labour."></textarea></label>
    `, "cost", taskId);
  }

  function openCompleteModal(taskId) {
    const cost = state.selectedTask?.cost || 0;
    setModal("Mark Completed", "Complete Task", `
      <label>Final Repair Cost<input type="number" name="cost" min="0" step="0.01" value="${escapeHtml(cost)}" /></label>
      <label>Completion Notes<textarea name="notes" placeholder="Summarise the repair completed."></textarea></label>
    `, "complete", taskId);
  }

  function closeModal() {
    const modal = $("maintenance-modal");
    if (modal) modal.hidden = true;
    const form = $("maintenance-modal-form");
    if (form) form.reset();
    state.modalMode = null;
    state.modalTaskId = null;
  }

  async function handleModalSubmit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      if (state.modalMode === "add") {
        await createMaintenanceTask({
          assetType: form.get("assetType"),
          bikeId: form.get("bikeId"),
          stationId: form.get("stationId"),
          issueType: form.get("issueType"),
          description: form.get("description"),
          priority: form.get("priority"),
          technicianName: form.get("technicianName"),
          estimatedCompletion: form.get("estimatedCompletion"),
          cost: form.get("cost"),
          supportTicketId: form.get("supportTicketId"),
        });
      } else if (state.modalMode === "assign") {
        await assignTechnician(state.modalTaskId, form.get("technicianName"));
      } else if (state.modalMode === "cost") {
        await addRepairCost(state.modalTaskId, form.get("cost"), form.get("notes"));
      } else if (state.modalMode === "complete") {
        await completeMaintenanceTask(state.modalTaskId, { cost: form.get("cost"), notes: form.get("notes") });
      }
    } catch (err) {
      showToast(err.message || "Action failed.", "error");
    }
  }

  async function loadFilterOptions() {
    const data = await api(`${API_BASE}/filters`);
    state.technicians = data.technicians || [];
    state.bikes = data.bikes || [];
    state.stations = data.stations || [];
    const tech = $("filter-technician");
    if (tech) {
      tech.innerHTML = `<option value="all">All</option>${state.technicians.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}`;
    }
  }

  async function refreshAll() {
    try {
      await Promise.all([
        loadMaintenanceOverview(state.range),
        loadMaintenanceTrends(state.range),
        loadMaintenanceStatusBreakdown(state.range),
        loadMaintenanceAlerts(),
        loadTechnicianTasks(),
        loadMaintenanceActivity(),
        loadMaintenanceList(),
      ]);
    } catch (err) {
      showToast(err.message || "Could not refresh Maintenance Management.", "error");
    }
  }

  function wireRangeTabs() {
    document.querySelectorAll(".ad-range-tabs button[data-range]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".ad-range-tabs button[data-range]").forEach((btn) => btn.classList.remove("active"));
        button.classList.add("active");
        state.range = button.dataset.range || "today";
        Promise.all([
          loadMaintenanceOverview(state.range),
          loadMaintenanceTrends(state.range),
          loadMaintenanceStatusBreakdown(state.range),
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
          search: $("maintenance-search").value.trim(),
          status: $("filter-status").value,
          priority: $("filter-priority").value,
          type: $("filter-type").value,
          technician: $("filter-technician").value,
          dateFrom: $("filter-date-from").value,
          dateTo: $("filter-date-to").value,
        };
        loadMaintenanceList().catch((err) => showToast(err.message, "error"));
      }, 180);
    };
    [
      ["maintenance-search", "input"],
      ["filter-status", "change"],
      ["filter-priority", "change"],
      ["filter-type", "change"],
      ["filter-technician", "change"],
      ["filter-date-from", "change"],
      ["filter-date-to", "change"],
    ].forEach(([id, event]) => {
      const el = $(id);
      if (el) el.addEventListener(event, apply);
    });
    $("reset-filters").addEventListener("click", () => {
      $("maintenance-search").value = "";
      $("filter-status").value = "all";
      $("filter-priority").value = "all";
      $("filter-type").value = "all";
      $("filter-technician").value = "all";
      $("filter-date-from").value = "";
      $("filter-date-to").value = "";
      state.page = 1;
      state.filters = { search: "", status: "all", priority: "all", type: "all", technician: "all", dateFrom: "", dateTo: "" };
      loadMaintenanceList().catch((err) => showToast(err.message, "error"));
    });
    $("maintenance-page-size").addEventListener("change", (event) => {
      state.limit = Number(event.target.value || 10);
      state.page = 1;
      loadMaintenanceList().catch((err) => showToast(err.message, "error"));
    });
  }

  function wireTable() {
    $("maintenance-table-body").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      const row = event.target.closest("tr[data-task-id]");
      const taskId = button?.dataset.taskId || row?.dataset.taskId;
      if (!taskId) return;
      if (button) {
        event.stopPropagation();
        const action = button.dataset.action;
        if (action === "assign") return openAssignModal(taskId);
        if (action === "complete") return openCompleteModal(taskId);
      }
      openMaintenanceDrawer(taskId).catch((err) => showToast(err.message, "error"));
    });
    $("maintenance-pagination").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-page]");
      if (!button || button.disabled) return;
      state.page = Math.max(1, Math.min(state.totalPages, Number(button.dataset.page || 1)));
      loadMaintenanceList().catch((err) => showToast(err.message, "error"));
    });
  }

  function wireDrawer() {
    $("close-maintenance-drawer").addEventListener("click", closeMaintenanceDrawer);
    document.querySelectorAll("[data-close-drawer]").forEach((el) => el.addEventListener("click", closeMaintenanceDrawer));
    $("maintenance-drawer").addEventListener("click", (event) => {
      const button = event.target.closest("[data-drawer-action]");
      if (!button || !state.selectedTask) return;
      const id = state.selectedTask.id;
      try {
        if (button.dataset.drawerAction === "assign") openAssignModal(id);
        if (button.dataset.drawerAction === "progress") updateMaintenanceStatus(id, "in_progress").catch((err) => showToast(err.message, "error"));
        if (button.dataset.drawerAction === "cost") openCostModal(id);
        if (button.dataset.drawerAction === "complete") openCompleteModal(id);
        if (button.dataset.drawerAction === "contact") window.location.href = "./Admin_support.html";
        if (button.dataset.drawerAction === "export") exportMaintenanceReport().catch((err) => showToast(err.message, "error"));
      } catch (err) {
        showToast(err.message || "Action failed.", "error");
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (!$("maintenance-modal").hidden) closeModal();
        else if (!$("maintenance-drawer").hidden) closeMaintenanceDrawer();
      }
    });
  }

  function wireModal() {
    $("add-maintenance-button").addEventListener("click", openAddMaintenanceModal);
    $("maintenance-modal-form").addEventListener("submit", handleModalSubmit);
    document.querySelectorAll("[data-close-modal]").forEach((el) => el.addEventListener("click", closeModal));
  }

  function wireTopButtons() {
    $("refresh-dashboard").addEventListener("click", () => {
      showToast("Refreshing maintenance data...");
      refreshAll();
    });
    $("export-report").addEventListener("click", () => exportMaintenanceReport().catch((err) => showToast(err.message, "error")));
  }

  async function initMaintenancePage() {
    wireRangeTabs();
    wireFilters();
    wireTable();
    wireDrawer();
    wireModal();
    wireTopButtons();
    try {
      await loadFilterOptions();
      await refreshAll();
      hydrateIcons(document);
    } catch (err) {
      showToast(err.message || "Could not load Maintenance Management.", "error");
    }
  }

  window.initMaintenancePage = initMaintenancePage;
  window.loadMaintenanceOverview = loadMaintenanceOverview;
  window.loadMaintenanceTrends = loadMaintenanceTrends;
  window.loadMaintenanceStatusBreakdown = loadMaintenanceStatusBreakdown;
  window.loadMaintenanceAlerts = loadMaintenanceAlerts;
  window.loadTechnicianTasks = loadTechnicianTasks;
  window.loadMaintenanceActivity = loadMaintenanceActivity;
  window.loadMaintenanceList = loadMaintenanceList;
  window.openMaintenanceDrawer = openMaintenanceDrawer;
  window.closeMaintenanceDrawer = closeMaintenanceDrawer;
  window.openAddMaintenanceModal = openAddMaintenanceModal;
  window.createMaintenanceTask = createMaintenanceTask;
  window.assignTechnician = assignTechnician;
  window.updateMaintenanceStatus = updateMaintenanceStatus;
  window.addRepairCost = addRepairCost;
  window.completeMaintenanceTask = completeMaintenanceTask;
  window.exportMaintenanceReport = exportMaintenanceReport;
  window.showMaintenanceToast = showToast;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initMaintenancePage);
  } else {
    initMaintenancePage();
  }
})();
