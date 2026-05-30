(function () {
  "use strict";

  const API_BASE = "/api/admin/bikes";
  const BAD_VISIBLE_RE = /demo|seed|test|profit|loss/i;
  const state = {
    range: "today",
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 1,
    filters: { search: "", status: "all", station: "all", type: "all", battery: "all" },
    stations: [],
    types: [],
    bikes: [],
    selectedBike: null,
    modalMode: null,
    charts: { trends: null, status: null },
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
      throw new Error("Not authenticated.");
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

  function formatNumber(value) {
    return numberFmt.format(Number(value || 0));
  }

  function formatDate(value, fallback = "Not used yet") {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return dateFmt.format(date);
  }

  function label(value) {
    return clean(value, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()) || "Available";
  }

  function trendText(value) {
    const n = Number(value || 0);
    const sign = n >= 0 ? "▲" : "▼";
    return `${sign} ${Math.abs(n).toFixed(1)}% vs prev.`;
  }

  function setTrend(id, value) {
    const el = $(id);
    if (!el) return;
    const n = Number(value || 0);
    el.textContent = trendText(n);
    el.classList.toggle("up", n >= 0);
    el.classList.toggle("down", n < 0);
  }

  function batteryTone(level) {
    const n = Number(level || 0);
    if (n < 25) return "low";
    if (n < 60) return "medium";
    return "high";
  }

  function batteryHtml(level) {
    const n = Math.max(0, Math.min(100, Number(level || 0)));
    return `<span class="bm-battery ${batteryTone(n)}"><span class="bm-battery-track"><span class="bm-battery-fill" style="width:${n}%"></span></span>${n}%</span>`;
  }

  function badge(status, text) {
    const key = String(status || "available").toLowerCase().replace(/\s+/g, "_");
    return `<span class="ab-badge ${escapeHtml(key)}">${escapeHtml(text || label(key))}</span>`;
  }

  function timeRemaining(minutes) {
    const total = Number(minutes || 0);
    if (total <= 0) return "Overdue";
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h <= 0) return `${m} min remaining`;
    return `${h}h ${String(m).padStart(2, "0")}m remaining`;
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
    }, 2800);
  }

  async function loadBikeOverview(range = state.range) {
    const data = await api(`${API_BASE}/overview?range=${encodeURIComponent(range)}`);
    const totals = data.totals || {};
    const trends = data.trends || {};
    [
      "totalBikes",
      "availableBikes",
      "activeBikes",
      "reservedBikes",
      "maintenanceBikes",
      "offlineBikes",
      "lowBatteryBikes",
      "damagedBikes",
    ].forEach((key) => {
      const el = $("kpi-" + key);
      if (el) el.textContent = formatNumber(totals[key]);
      setTrend("trend-" + key, trends[key]);
    });
  }

  function chartLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    if (state.range === "today") {
      return new Intl.DateTimeFormat("en-AU", { hour: "numeric" }).format(date);
    }
    if (state.range === "year") {
      return new Intl.DateTimeFormat("en-AU", { month: "short" }).format(date);
    }
    return new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "short" }).format(date);
  }

  async function loadBikeTrends(range = state.range) {
    const data = await api(`${API_BASE}/trends?range=${encodeURIComponent(range)}`);
    const labels = (data.labels || []).map(chartLabel);
    $("bike-trends-range-label").textContent = label(range);
    const ctx = $("bike-trends-chart");
    if (!ctx || !window.Chart) return;
    const cfg = {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Available", data: data.available || [], borderColor: "#16A34A", backgroundColor: "rgba(22,163,74,.10)", tension: .38, fill: true, pointRadius: 3, borderWidth: 2 },
          { label: "Active", data: data.active || [], borderColor: "#3B82F6", backgroundColor: "rgba(59,130,246,.08)", tension: .38, fill: false, pointRadius: 3, borderWidth: 2 },
          { label: "Maintenance", data: data.maintenance || [], borderColor: "#F97316", backgroundColor: "rgba(249,115,22,.08)", tension: .38, fill: false, pointRadius: 3, borderWidth: 2 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { color: "#64748B", maxTicksLimit: 7, font: { size: 11 } } },
          y: { beginAtZero: true, grid: { color: "#E2E8F0" }, ticks: { color: "#64748B", font: { size: 11 } } },
        },
      },
    };
    if (state.charts.trends) {
      state.charts.trends.data = cfg.data;
      state.charts.trends.options = cfg.options;
      state.charts.trends.update();
    } else {
      state.charts.trends = new Chart(ctx, cfg);
    }
  }

  function centerTextPlugin(total) {
    return {
      id: "bikeCenterText",
      beforeDraw(chart) {
        const meta = chart.getDatasetMeta(0);
        if (!meta?.data?.length) return;
        const x = meta.data[0].x;
        const y = meta.data[0].y;
        const ctx = chart.ctx;
        ctx.save();
        ctx.textAlign = "center";
        ctx.fillStyle = "#0F172A";
        ctx.font = "700 22px Inter, sans-serif";
        ctx.fillText(formatNumber(total), x, y - 4);
        ctx.fillStyle = "#64748B";
        ctx.font = "600 12px Inter, sans-serif";
        ctx.fillText("Total Bikes", x, y + 16);
        ctx.restore();
      },
    };
  }

  async function loadBikeStatusBreakdown() {
    const data = await api(`${API_BASE}/status-breakdown`);
    const rows = [
      ["available", "Available", data.available || 0, "#16A34A"],
      ["active", "Active", data.active || 0, "#3B82F6"],
      ["reserved", "Reserved", data.reserved || 0, "#8B5CF6"],
      ["maintenance", "Maintenance", data.maintenance || 0, "#F97316"],
      ["offline", "Offline", data.offline || 0, "#94A3B8"],
      ["damaged", "Damaged", data.damaged || 0, "#EF4444"],
    ];
    const total = Number(data.total || rows.reduce((sum, row) => sum + Number(row[2] || 0), 0));
    $("bike-status-legend").innerHTML = rows.map((row) => {
      const pct = total ? ((Number(row[2]) / total) * 100).toFixed(1) : "0.0";
      return `<div class="bm-donut-row"><span class="bm-dot" style="background:${row[3]}"></span><span>${escapeHtml(row[1])}</span><strong>${formatNumber(row[2])} (${pct}%)</strong></div>`;
    }).join("");
    const ctx = $("bike-status-chart");
    if (!ctx || !window.Chart) return;
    const cfg = {
      type: "doughnut",
      data: {
        labels: rows.map((row) => row[1]),
        datasets: [{ data: rows.map((row) => row[2]), backgroundColor: rows.map((row) => row[3]), borderWidth: 4, borderColor: "#FFFFFF", hoverOffset: 3 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "68%",
        plugins: { legend: { display: false } },
      },
      plugins: [centerTextPlugin(total)],
    };
    if (state.charts.status) {
      state.charts.status.destroy();
    }
    state.charts.status = new Chart(ctx, cfg);
  }

  async function loadBikeAlerts() {
    const data = await api(`${API_BASE}/alerts`);
    const a = data.alerts || {};
    const rows = [
      ["red", "Damaged bikes need review", a.damaged || 0],
      ["amber", "Bikes have low battery", a.lowBattery || 0],
      ["slate", "Bikes are offline", a.offline || 0],
      ["amber", "Bikes are in maintenance", a.maintenance || 0],
      ["purple", "Bikes not returned to station", a.notReturned || 0],
    ];
    $("bike-alerts-list").innerHTML = rows.map((row) => `
      <div class="bm-alert-row">
        <span class="bm-alert-icon ${row[0]}"><span data-icon="${row[0] === "slate" ? "bell" : "alert"}"></span></span>
        <span>${escapeHtml(row[1])}</span>
        <span class="bm-alert-count">${formatNumber(row[2])}</span>
      </div>
    `).join("");
    if (window.__hydrateAdminIcons) window.__hydrateAdminIcons(document);
  }

  function buildListQuery(extra = {}) {
    const params = new URLSearchParams({
      search: state.filters.search,
      status: state.filters.status,
      station: state.filters.station,
      type: state.filters.type,
      battery: state.filters.battery,
      page: String(extra.page || state.page),
      limit: String(extra.limit || state.limit),
    });
    return params.toString();
  }

  async function loadBikeList(filters = state.filters) {
    state.filters = { ...state.filters, ...filters };
    const data = await api(`${API_BASE}/list?${buildListQuery()}`);
    state.bikes = data.bikes || [];
    state.total = Number(data.total || 0);
    state.page = Number(data.page || 1);
    state.limit = Number(data.limit || state.limit);
    state.totalPages = Number(data.totalPages || 1);
    renderBikeTable();
    renderPagination();
  }

  function renderBikeTable() {
    $("bike-total-count").textContent = `(${formatNumber(state.total)})`;
    if (!state.bikes.length) {
      $("bike-row-count").textContent = "No bikes found";
      $("bike-table-body").innerHTML = `<tr><td colspan="10" class="ab-table-empty">No bikes match the current filters.</td></tr>`;
      return;
    }
    const start = (state.page - 1) * state.limit + 1;
    const end = Math.min(state.total, start + state.bikes.length - 1);
    $("bike-row-count").textContent = `Showing ${formatNumber(start)} to ${formatNumber(end)} of ${formatNumber(state.total)} bikes`;
    $("bike-table-body").innerHTML = state.bikes.map((bike) => `
      <tr data-bike-id="${bike.id}" title="View ${escapeHtml(bike.bikeId)} details">
        <td><span class="bike-code">${escapeHtml(bike.bikeId)}</span></td>
        <td>${escapeHtml(clean(bike.type, "Standard"))}</td>
        <td title="${escapeHtml(bike.currentStation)}">${escapeHtml(bike.currentStation)}</td>
        <td>${badge(bike.status, bike.statusLabel)}</td>
        <td>${batteryHtml(bike.batteryLevel)}</td>
        <td>${escapeHtml(formatDate(bike.lastUsed))}</td>
        <td title="${escapeHtml(bike.currentRider)}">${escapeHtml(clean(bike.currentRider, "None"))}</td>
        <td>${badge(String(bike.condition).toLowerCase().includes("good") ? "good" : "warning", bike.condition)}</td>
        <td>${badge(String(bike.maintenance).toLowerCase().includes("no issue") ? "good" : "warning", bike.maintenance)}</td>
        <td>
          <span class="ab-row-actions">
            <button type="button" data-action="view" data-bike-id="${bike.id}" title="View details"><span data-icon="help-circle"></span></button>
            <button type="button" data-action="assign" data-bike-id="${bike.id}" title="Assign station"><span data-icon="map-pin"></span></button>
            <button type="button" data-action="maintenance" data-bike-id="${bike.id}" title="Send to maintenance"><span data-icon="wrench"></span></button>
            <button type="button" data-action="more" data-bike-id="${bike.id}" title="More actions"><span data-icon="chevron-right"></span></button>
          </span>
        </td>
      </tr>
    `).join("");
    if (window.__hydrateAdminIcons) window.__hydrateAdminIcons(document);
  }

  function renderPagination() {
    const wrap = $("bike-pagination");
    const buttons = [];
    buttons.push(`<button type="button" data-page="${state.page - 1}" ${state.page <= 1 ? "disabled" : ""}>‹</button>`);
    const start = Math.max(1, state.page - 2);
    const end = Math.min(state.totalPages, start + 4);
    for (let page = start; page <= end; page += 1) {
      buttons.push(`<button type="button" data-page="${page}" class="${page === state.page ? "active" : ""}">${page}</button>`);
    }
    buttons.push(`<button type="button" data-page="${state.page + 1}" ${state.page >= state.totalPages ? "disabled" : ""}>›</button>`);
    wrap.innerHTML = buttons.join("");
  }

  async function loadLiveActiveBikes() {
    const data = await api(`${API_BASE}/live-active`);
    const bikes = data.bikes || [];
    $("live-active-bikes").innerHTML = bikes.length ? bikes.map((bike) => `
      <div class="ab-list-item ab-live-ride">
        <span class="ab-list-ico blue"><span data-icon="bike"></span></span>
        <div class="ab-list-body"><strong>${escapeHtml(bike.bikeId)} · ${escapeHtml(clean(bike.rider, "Student rider"))}</strong><span>${escapeHtml(clean(bike.route, "Campus route"))}</span></div>
        <span class="ab-list-meta">${escapeHtml(timeRemaining(bike.timeRemainingMinutes))}</span>
        <button class="ab-list-action" type="button" data-bike-id="${bike.id}">View</button>
      </div>
    `).join("") : `<div class="ab-empty">No bikes are currently in use.</div>`;
    if (window.__hydrateAdminIcons) window.__hydrateAdminIcons(document);
  }

  async function loadBikeActivity() {
    const data = await api(`${API_BASE}/activity?limit=5`);
    const rows = (data.activity || []).slice(0, 5);
    $("bike-activity-list").innerHTML = rows.length ? rows.map((item) => {
      const tone = item.type === "maintenance_flagged" ? "amber" : item.type === "battery_warning" ? "amber" : item.type === "bike_checked_out" ? "blue" : "";
      const icon = item.type === "maintenance_flagged" ? "wrench" : item.type === "battery_warning" ? "alert" : item.type === "bike_checked_out" ? "bike" : "check";
      return `
        <div class="ab-list-item">
          <span class="ab-list-ico ${tone}"><span data-icon="${icon}"></span></span>
          <div class="ab-list-body"><strong>${escapeHtml(clean(item.title, "Bike activity"))}</strong><span>${escapeHtml(clean(item.description, "Bike operation update"))}</span></div>
          <span class="ab-list-meta">${escapeHtml(formatDate(item.timestamp, ""))}</span>
        </div>
      `;
    }).join("") : `<div class="ab-empty">No recent bike activity.</div>`;
    if (window.__hydrateAdminIcons) window.__hydrateAdminIcons(document);
  }

  function renderDrawer(bike) {
    $("drawer-status").textContent = bike.statusLabel || label(bike.status);
    $("drawer-status").className = `ab-status-badge ${bike.status}`;
    const detailRows = [
      ["bike", "Bike ID", bike.bikeId],
      ["bike", "Bike Type", bike.type],
      ["map-pin", "Current Station", bike.currentStation],
      ["check", "Current Status", bike.statusLabel],
      ["wallet", "Battery Level", `${bike.batteryLevel}%`],
      ["clock", "Last Used", formatDate(bike.lastUsed)],
      ["help-circle", "Current Rider", bike.currentRider],
      ["bar-chart", "Total Rides", formatNumber(bike.totalRides)],
      ["map-pin", "Total Distance", `${Number(bike.totalDistance || 0).toFixed(1)} km`],
      ["check", "Condition", bike.condition],
      ["wrench", "Maintenance Status", bike.maintenance],
      ["calendar", "Last Maintenance Date", formatDate(bike.lastMaintenanceDate, "No maintenance yet")],
      ["bell", "GPS Status", label(bike.gpsStatus)],
    ];
    $("bike-drawer-body").innerHTML = detailRows.map(([icon, key, value]) => {
      if (key === "Battery Level") {
        const tone = batteryTone(bike.batteryLevel);
        return `<div class="bm-detail-row"><span class="ico" data-icon="${icon}"></span><span class="key">${key}</span><span class="value bm-detail-battery"><span>${escapeHtml(value)}</span><span class="bm-progress ${tone}"><span style="width:${Math.max(0, Math.min(100, Number(bike.batteryLevel || 0)))}%"></span></span></span></div>`;
      }
      return `<div class="bm-detail-row"><span class="ico" data-icon="${icon}"></span><span class="key">${escapeHtml(key)}</span><span class="value" title="${escapeHtml(value)}">${escapeHtml(value)}</span></div>`;
    }).join("");
    if (window.__hydrateAdminIcons) window.__hydrateAdminIcons(document);
  }

  async function openBikeDrawer(bikeId) {
    const data = await api(`${API_BASE}/${encodeURIComponent(bikeId)}`);
    state.selectedBike = data.bike;
    renderDrawer(state.selectedBike);
    $("bike-drawer").hidden = false;
    document.body.classList.add("ab-drawer-open");
  }

  function closeBikeDrawer() {
    $("bike-drawer").hidden = true;
    document.body.classList.remove("ab-drawer-open");
  }

  async function updateBikeStatus(bikeId, status) {
    await api(`${API_BASE}/${encodeURIComponent(bikeId)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    showToast(`Bike marked ${label(status)}.`);
    await refreshAll();
    if (state.selectedBike) await openBikeDrawer(state.selectedBike.id);
  }

  async function assignBikeStation(bikeId, stationId) {
    await api(`${API_BASE}/${encodeURIComponent(bikeId)}/assign-station`, {
      method: "PATCH",
      body: JSON.stringify({ stationId }),
    });
    showToast("Bike station updated.");
    await refreshAll();
    if (state.selectedBike) await openBikeDrawer(state.selectedBike.id);
  }

  async function sendBikeToMaintenance(bikeId, payload) {
    await api(`${API_BASE}/${encodeURIComponent(bikeId)}/maintenance`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    showToast("Bike sent to maintenance.");
    await refreshAll();
    if (state.selectedBike) await openBikeDrawer(state.selectedBike.id);
  }

  async function disableBike(bikeId) {
    if (!window.confirm("Disable this bike and remove it from active service?")) return;
    await api(`${API_BASE}/${encodeURIComponent(bikeId)}/disable`, { method: "PATCH", body: JSON.stringify({}) });
    showToast("Bike disabled.");
    await refreshAll();
    if (state.selectedBike) await openBikeDrawer(state.selectedBike.id);
  }

  async function addNewBike(payload) {
    await api(`${API_BASE}`, { method: "POST", body: JSON.stringify(payload) });
    showToast("New bike added.");
    closeModal();
    await refreshAll();
  }

  async function exportBikeReport() {
    const data = await api(`${API_BASE}/list?${buildListQuery({ page: 1, limit: 1000 })}`);
    const rows = [["Bike ID", "Type", "Current Station", "Status", "Battery", "Last Used", "Current Rider", "Condition", "Maintenance"]];
    (data.bikes || []).forEach((bike) => rows.push([
      bike.bikeId,
      bike.type,
      bike.currentStation,
      bike.statusLabel,
      `${bike.batteryLevel}%`,
      formatDate(bike.lastUsed),
      bike.currentRider,
      bike.condition,
      bike.maintenance,
    ]));
    const csv = rows.map((row) => row.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `bikes_${state.range}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Bike report exported.");
  }

  function stationOptions(selected = "") {
    return state.stations.map((station) => `<option value="${station.id}" ${String(station.id) === String(selected) ? "selected" : ""}>${escapeHtml(station.name)}</option>`).join("");
  }

  function openAddBikeModal() {
    state.modalMode = "add";
    $("bike-modal-title").textContent = "Add New Bike";
    $("bike-modal-submit").textContent = "Add Bike";
    $("bike-modal-body").innerHTML = `
      <div class="bm-modal-grid">
        <label>Bike ID<input name="bikeCode" required maxlength="20" placeholder="B24" /></label>
        <label>Bike Type<select name="model"><option>Standard</option><option>Electric</option></select></label>
        <label class="full">Assigned Station<select name="stationId" required>${stationOptions()}</select></label>
        <label>Battery Level<input name="batteryLevel" type="number" min="0" max="100" value="100" /></label>
      </div>
    `;
    $("bike-modal").hidden = false;
  }

  function openAssignModal(bikeId) {
    state.modalMode = "assign";
    state.modalBikeId = bikeId;
    $("bike-modal-title").textContent = "Assign Station";
    $("bike-modal-submit").textContent = "Assign";
    $("bike-modal-body").innerHTML = `
      <label>Station<select name="stationId" required>${stationOptions(state.selectedBike?.stationId)}</select></label>
    `;
    $("bike-modal").hidden = false;
  }

  function openMaintenanceModal(bikeId) {
    state.modalMode = "maintenance";
    state.modalBikeId = bikeId;
    $("bike-modal-title").textContent = "Send to Maintenance";
    $("bike-modal-submit").textContent = "Create Maintenance Log";
    $("bike-modal-body").innerHTML = `
      <div class="bm-modal-grid">
        <label>Issue Type<select name="issueType"><option value="brake_issue">Brake issue</option><option value="battery_check">Battery check</option><option value="chain_problem">Chain problem</option><option value="frame_damage">Frame damage</option><option value="tyre_pressure">Tyre pressure</option><option value="general_service">General service</option></select></label>
        <label>Severity<select name="severity"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
        <label class="full">Description<textarea name="description" required placeholder="Describe what needs attention."></textarea></label>
      </div>
    `;
    $("bike-modal").hidden = false;
  }

  function closeModal() {
    $("bike-modal").hidden = true;
    $("bike-modal-form").reset();
    state.modalMode = null;
    state.modalBikeId = null;
  }

  async function handleModalSubmit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      if (state.modalMode === "add") {
        await addNewBike({
          bikeCode: form.get("bikeCode"),
          model: form.get("model"),
          stationId: form.get("stationId"),
          batteryLevel: form.get("batteryLevel"),
        });
      } else if (state.modalMode === "assign") {
        await assignBikeStation(state.modalBikeId, form.get("stationId"));
        closeModal();
      } else if (state.modalMode === "maintenance") {
        await sendBikeToMaintenance(state.modalBikeId, {
          issueType: form.get("issueType"),
          severity: form.get("severity"),
          description: form.get("description"),
        });
        closeModal();
      }
    } catch (err) {
      showToast(err.message || "Action failed.", "error");
    }
  }

  async function loadFilterOptions() {
    const data = await api(`${API_BASE}/filters`);
    state.stations = data.stations || [];
    state.types = data.types || ["Standard", "Electric"];
    $("filter-station").innerHTML = `<option value="all">All Stations</option>${state.stations.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}`;
    $("filter-type").innerHTML = `<option value="all">All Types</option>${state.types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("")}`;
  }

  async function refreshAll() {
    try {
      await Promise.all([
        loadBikeOverview(state.range),
        loadBikeTrends(state.range),
        loadBikeStatusBreakdown(),
        loadBikeAlerts(),
        loadBikeList(),
        loadLiveActiveBikes(),
        loadBikeActivity(),
      ]);
    } catch (err) {
      showToast(err.message || "Could not refresh Bike Management.", "error");
    }
  }

  function wireRangeTabs() {
    document.querySelectorAll(".ad-range-tabs button[data-range]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".ad-range-tabs button[data-range]").forEach((btn) => btn.classList.remove("active"));
        button.classList.add("active");
        state.range = button.dataset.range || "today";
        loadBikeOverview(state.range).catch((err) => showToast(err.message, "error"));
        loadBikeTrends(state.range).catch((err) => showToast(err.message, "error"));
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
          search: $("bike-search").value.trim(),
          status: $("filter-status").value,
          station: $("filter-station").value,
          type: $("filter-type").value,
          battery: $("filter-battery").value,
        };
        loadBikeList().catch((err) => showToast(err.message, "error"));
      }, 180);
    };
    ["bike-search", "filter-status", "filter-station", "filter-type", "filter-battery"].forEach((id) => {
      const el = $(id);
      el.addEventListener(id === "bike-search" ? "input" : "change", apply);
    });
    $("reset-filters").addEventListener("click", () => {
      $("bike-search").value = "";
      $("filter-status").value = "all";
      $("filter-station").value = "all";
      $("filter-type").value = "all";
      $("filter-battery").value = "all";
      state.page = 1;
      state.filters = { search: "", status: "all", station: "all", type: "all", battery: "all" };
      loadBikeList().catch((err) => showToast(err.message, "error"));
    });
    $("bike-page-size").addEventListener("change", (event) => {
      state.limit = Number(event.target.value || 10);
      state.page = 1;
      loadBikeList().catch((err) => showToast(err.message, "error"));
    });
  }

  function wireTable() {
    $("bike-table-body").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      const row = event.target.closest("tr[data-bike-id]");
      const bikeId = button?.dataset.bikeId || row?.dataset.bikeId;
      if (!bikeId) return;
      if (button) {
        event.stopPropagation();
        const action = button.dataset.action;
        if (action === "assign") return openAssignModal(bikeId);
        if (action === "maintenance") return openMaintenanceModal(bikeId);
        return openBikeDrawer(bikeId).catch((err) => showToast(err.message, "error"));
      }
      openBikeDrawer(bikeId).catch((err) => showToast(err.message, "error"));
    });
    $("bike-pagination").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-page]");
      if (!button || button.disabled) return;
      state.page = Math.max(1, Math.min(state.totalPages, Number(button.dataset.page || 1)));
      loadBikeList().catch((err) => showToast(err.message, "error"));
    });
    $("live-active-bikes").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-bike-id]");
      if (button) openBikeDrawer(button.dataset.bikeId).catch((err) => showToast(err.message, "error"));
    });
  }

  function wireDrawer() {
    $("close-bike-drawer").addEventListener("click", closeBikeDrawer);
    document.querySelectorAll("[data-close-drawer]").forEach((el) => el.addEventListener("click", closeBikeDrawer));
    $("bike-drawer").addEventListener("click", async (event) => {
      const button = event.target.closest("[data-drawer-action]");
      if (!button || !state.selectedBike) return;
      const id = state.selectedBike.id;
      try {
        if (button.dataset.drawerAction === "available") await updateBikeStatus(id, "available");
        if (button.dataset.drawerAction === "maintenance") openMaintenanceModal(id);
        if (button.dataset.drawerAction === "assign") openAssignModal(id);
        if (button.dataset.drawerAction === "history") window.location.href = `./Admin_bookings.html?bike=${encodeURIComponent(state.selectedBike.bikeId)}`;
        if (button.dataset.drawerAction === "disable") await disableBike(id);
      } catch (err) {
        showToast(err.message || "Action failed.", "error");
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (!$("bike-modal").hidden) closeModal();
        else if (!$("bike-drawer").hidden) closeBikeDrawer();
      }
    });
  }

  function wireModal() {
    $("add-bike-button").addEventListener("click", openAddBikeModal);
    $("bike-modal-form").addEventListener("submit", handleModalSubmit);
    document.querySelectorAll("[data-close-modal]").forEach((el) => el.addEventListener("click", closeModal));
  }

  function wireTopButtons() {
    $("refresh-dashboard").addEventListener("click", () => {
      showToast("Refreshing bike data...");
      refreshAll();
    });
    $("export-report").addEventListener("click", () => exportBikeReport().catch((err) => showToast(err.message, "error")));
  }

  async function initBikeManagementPage() {
    wireRangeTabs();
    wireFilters();
    wireTable();
    wireDrawer();
    wireModal();
    wireTopButtons();
    try {
      await loadFilterOptions();
      await refreshAll();
    } catch (err) {
      showToast(err.message || "Could not load Bike Management.", "error");
    }
  }

  window.initBikeManagementPage = initBikeManagementPage;
  window.loadBikeOverview = loadBikeOverview;
  window.loadBikeTrends = loadBikeTrends;
  window.loadBikeStatusBreakdown = loadBikeStatusBreakdown;
  window.loadBikeAlerts = loadBikeAlerts;
  window.loadBikeList = loadBikeList;
  window.loadLiveActiveBikes = loadLiveActiveBikes;
  window.loadBikeActivity = loadBikeActivity;
  window.openBikeDrawer = openBikeDrawer;
  window.updateBikeStatus = updateBikeStatus;
  window.assignBikeStation = assignBikeStation;
  window.sendBikeToMaintenance = sendBikeToMaintenance;
  window.exportBikeReport = exportBikeReport;
  window.showBikeToast = showToast;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initBikeManagementPage);
  } else {
    initBikeManagementPage();
  }
})();
