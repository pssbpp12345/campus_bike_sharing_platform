// ──────────────────────────────────────────────────────────────
// Admin Stations page — KPIs, charts, table, drawer, modal.
// Talks to /api/admin/stations/*. Auth + topbar/sidebar wiring
// comes from admin-dashboard.js (loaded before this file).
// ──────────────────────────────────────────────────────────────
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const fmtInt = (n) => Number(n || 0).toLocaleString("en-AU");
  const fmtDt  = (s) => s ? new Date(s).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  const fmtAgo = (s) => {
    if (!s) return "—";
    const diff = Math.max(1, Math.floor((Date.now() - new Date(s).getTime()) / 60000));
    if (diff < 60) return `${diff} min ago`;
    if (diff < 1440) return `${Math.floor(diff/60)} hr ago`;
    return `${Math.floor(diff/1440)} days ago`;
  };
  const escapeHtml = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  const statusLabel = (eff) => ({
    normal: "Active", low: "Low Availability", full: "Full",
    maintenance: "Maintenance", offline: "Offline",
  })[eff] || "Active";

  // ── State ──
  const state = {
    range: "today",
    page: 1,
    limit: 10,
    filters: { search: "", status: "", availability: "", capacity: "", area: "" },
    stations: [],
    total: 0,
    pages: 1,
    areas: [],
    charts: { trends: null, capacity: null },
  };

  function getToken() { try { return localStorage.getItem("cbs_token"); } catch (_) { return null; } }
  function showToast(message, tone) {
    const el = $("admin-toast"); if (!el) return;
    el.textContent = message;
    el.className = "ad-toast" + (tone ? " ad-toast--" + tone : "");
    el.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { el.hidden = true; }, 3200);
  }
  function showError(message) {
    const el = $("page-error"); if (!el) return;
    if (!message) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = message; el.hidden = false;
  }
  async function api(path) {
    const token = getToken();
    if (!token) { window.location.replace("../../login.html?admin=1&next=" + encodeURIComponent(location.pathname)); throw new Error("Not authenticated."); }
    const res = await fetch(path, { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, cache: "no-store" });
    if (res.status === 401 || res.status === 403) {
      window.location.replace("../../login.html?admin=1&next=" + encodeURIComponent(location.pathname));
      throw new Error("Admin session expired.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
    return data;
  }
  async function apiSend(path, method, body) {
    const token = getToken();
    if (!token) { window.location.replace("../../login.html?admin=1&next=" + encodeURIComponent(location.pathname)); throw new Error("Not authenticated."); }
    const res = await fetch(path, {
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
    return data;
  }

  // ── KPI overview ──
  function renderTrend(elId, value) {
    const el = $(elId); if (!el) return;
    if (value == null || isNaN(value) || value === 0) { el.textContent = ""; el.className = ""; return; }
    const arrow = value > 0 ? "▲" : "▼";
    const tone  = value > 0 ? "up" : "down";
    el.textContent = `${arrow} ${Math.abs(value).toFixed(1)}% vs prev.`;
    el.className = tone;
  }
  async function loadOverview() {
    try {
      const data = await api(`/api/admin/stations/overview?range=${state.range}`);
      const t = data.totals || {};
      const tr = data.trends || {};
      $("kpi-totalStations").textContent           = fmtInt(t.totalStations);
      $("kpi-activeStations").textContent          = fmtInt(t.activeStations);
      $("kpi-availableBikes").textContent          = fmtInt(t.availableBikes);
      $("kpi-totalCapacity").textContent           = fmtInt(t.totalCapacity);
      $("kpi-lowAvailabilityStations").textContent = fmtInt(t.lowAvailabilityStations);
      $("kpi-fullStations").textContent            = fmtInt(t.fullStations);
      $("kpi-maintenanceStations").textContent     = fmtInt(t.maintenanceStations);
      $("kpi-offlineStations").textContent         = fmtInt(t.offlineStations);
      // Trends — most stations metrics don't have a meaningful "vs prev" so we
      // just show ride-volume trend on a couple of cards.
      renderTrend("trend-totalStations",      tr.bookingVolume);
      renderTrend("trend-activeStations",     tr.bookingVolume);
      renderTrend("trend-availableBikes",     null);
      renderTrend("trend-totalCapacity",      null);
      renderTrend("trend-lowAvailabilityStations", null);
      renderTrend("trend-fullStations",       null);
      renderTrend("trend-maintenanceStations",null);
      renderTrend("trend-offlineStations",    null);
    } catch (err) { showError(err.message || "Could not load station overview."); }
  }

  // ── Trends chart ──
  async function loadTrends() {
    try {
      const data = await api(`/api/admin/stations/trends?range=${state.range}`);
      const ctx = $("trends-chart").getContext("2d");
      const ds = (label, color, values) => ({
        label, data: values,
        borderColor: color, backgroundColor: color + "22",
        borderWidth: 2.4, tension: .35, pointRadius: 2.5, pointHoverRadius: 5, fill: false,
      });
      const cfg = {
        type: "line",
        data: { labels: data.labels, datasets: [
          ds("Available Bikes", "#22C55E", data.series.available),
          ds("Reserved/Active Bikes", "#3B82F6", data.series.reservedActive),
          ds("Maintenance Bikes", "#F59E0B", data.series.maintenance),
        ]},
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: "#64748B", font: { size: 11 } } },
            y: { beginAtZero: true, grid: { color: "#F1F5F9" }, ticks: { color: "#64748B", font: { size: 11 }, precision: 0 } },
          },
        },
      };
      if (state.charts.trends) state.charts.trends.destroy();
      state.charts.trends = new Chart(ctx, cfg);
      $("trends-range-label").textContent = state.range[0].toUpperCase() + state.range.slice(1);
    } catch (err) { showError(err.message || "Could not load trends."); }
  }

  // ── Capacity donut ──
  function centerTextPlugin(total, label) {
    return {
      id: "stationsCenterText",
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
        ctx.fillText(String(total ?? 0), x, y - 4);
        ctx.fillStyle = "#64748B";
        ctx.font = "600 12px Inter, sans-serif";
        ctx.fillText(label || "Total", x, y + 16);
        ctx.restore();
      },
    };
  }

  async function loadCapacityBreakdown() {
    try {
      const data = await api(`/api/admin/stations/capacity-breakdown`);
      const ctx = $("capacity-chart").getContext("2d");
      const labels = data.breakdown.map(b => b.label);
      const values = data.breakdown.map(b => b.count);
      const colors = data.breakdown.map(b => b.color);
      const cfg = {
        type: "doughnut",
        data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: "#FFFFFF", borderWidth: 3, hoverOffset: 6 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: "65%", plugins: { legend: { display: false } } },
      };
      if (state.charts.capacity) state.charts.capacity.destroy();
      state.charts.capacity = new Chart(ctx, { ...cfg, plugins: [centerTextPlugin(data.total, "Total")] });

      const list = $("capacity-breakdown");
      list.innerHTML = "";
      data.breakdown.forEach(b => {
        const row = document.createElement("div");
        row.className = "ad-status-row";
        row.innerHTML = `
          <span class="dot" style="background:${b.color}"></span>
          <span class="lbl">${b.label}</span>
          <span class="val">${b.count} (${b.pct}%)</span>`;
        list.appendChild(row);
      });
    } catch (err) { showError(err.message || "Could not load capacity breakdown."); }
  }

  // ── Alerts ──
  function renderAlerts(alerts) {
    const el = $("alerts-list");
    if (!alerts || !alerts.length) { el.innerHTML = '<div class="ab-empty">All clear — no alerts.</div>'; return; }
    el.innerHTML = "";
    alerts.slice(0, 5).forEach(a => {
      const row = document.createElement("div");
      row.className = "ab-list-item";
      row.innerHTML = `
        <span class="ab-list-ico ${a.tone}"><span data-icon="alert"></span></span>
        <span class="ab-list-body"><strong>${escapeHtml(a.label)}</strong></span>
        <span class="ab-list-meta">${a.count}</span>`;
      el.appendChild(row);
    });
    if (window.AdminUI && window.AdminUI.hydrateIcons) window.AdminUI.hydrateIcons(el);
  }
  async function loadAlerts() {
    try { renderAlerts((await api("/api/admin/stations/alerts")).alerts || []); }
    catch (_) { $("alerts-list").innerHTML = '<div class="ab-empty">Could not load alerts.</div>'; }
  }

  // ── Top Active Stations ──
  function utilClass(u) {
    if (u >= 90) return "full";
    if (u >= 60) return "high";
    if (u >= 30) return "medium";
    return "low";
  }
  function renderTopActive(stations) {
    const el = $("top-active-list");
    if (!stations || !stations.length) { el.innerHTML = '<div class="ab-empty">No station activity yet.</div>'; return; }
    el.innerHTML = `
      <div class="as-top-head">
        <span>Station</span><span class="area">Area/Suburb</span>
        <span class="avail">Rides</span><span class="avail">Avail</span><span>Util</span>
      </div>` +
      stations.slice(0, 5).map(s => `
        <div class="as-top-row" data-id="${s.id}">
          <span class="name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
          <span class="area" title="${escapeHtml(s.area)}">${escapeHtml(s.area)}</span>
          <span class="num avail">${fmtInt(s.rides)}</span>
          <span class="num avail">${fmtInt(s.available)}</span>
          <span class="util ${utilClass(s.utilisation)}">${s.utilisation}%</span>
        </div>
      `).join("");
    el.querySelectorAll(".as-top-row").forEach(row => {
      row.addEventListener("click", () => openDrawer(Number(row.dataset.id)));
    });
  }
  async function loadTopActive() {
    try { renderTopActive((await api(`/api/admin/stations/top-active?range=${state.range}`)).stations || []); }
    catch (_) { $("top-active-list").innerHTML = '<div class="ab-empty">Could not load top stations.</div>'; }
  }

  // ── Recent Station Activity ──
  function activityTitle(kind) {
    return ({ pickup: "Bike picked up", return: "Bike returned to station" })[kind] || "Station activity";
  }
  function activityTone(kind) {
    return ({ pickup: "blue", return: "" })[kind] || "";
  }
  function renderActivity(rows) {
    const el = $("activity-list");
    if (!rows || !rows.length) { el.innerHTML = '<div class="ab-empty">No recent station activity.</div>'; return; }
    el.innerHTML = "";
    rows.slice(0, 5).forEach(a => {
      const item = document.createElement("div");
      item.className = "ab-list-item"; item.style.cursor = "pointer";
      item.innerHTML = `
        <span class="ab-list-ico ${activityTone(a.kind)}"><span data-icon="map-pin"></span></span>
        <span class="ab-list-body">
          <strong>${activityTitle(a.kind)}</strong>
          <span>${escapeHtml(a.stationId)} - ${escapeHtml(a.stationName)}</span>
        </span>
        <span class="ab-list-meta">${fmtAgo(a.occurredAt)}</span>`;
      item.addEventListener("click", () => {
        const id = Number(String(a.stationId).replace(/^ST-0*/, ""));
        if (Number.isInteger(id) && id > 0) openDrawer(id);
      });
      el.appendChild(item);
    });
    if (window.AdminUI && window.AdminUI.hydrateIcons) window.AdminUI.hydrateIcons(el);
  }
  async function loadActivity() {
    try { renderActivity((await api("/api/admin/stations/activity?limit=5")).activity || []); }
    catch (_) { $("activity-list").innerHTML = '<div class="ab-empty">Could not load activity.</div>'; }
  }

  // ── Stations table ──
  function rowHtml(s) {
    const utilBarClass = s.utilisation >= 90 ? "bad" : s.utilisation >= 70 ? "warn" : "";
    return `
      <td><strong>${escapeHtml(s.stationId)}</strong></td>
      <td>${escapeHtml(s.stationName)}</td>
      <td>${escapeHtml(s.area)}</td>
      <td><span class="ab-badge ${s.effectiveStatus}">${escapeHtml(statusLabel(s.effectiveStatus))}</span></td>
      <td class="num">${fmtInt(s.availableBikes)}</td>
      <td class="num">${fmtInt(s.capacity)}</td>
      <td>
        <span class="util-bar ${utilBarClass}">
          <span class="bar"><i style="width:${s.utilisation}%"></i></span>
          <span class="pct">${s.utilisation}%</span>
        </span>
      </td>
      <td class="num">${fmtInt(s.activeRides)}</td>
      <td class="num">${fmtInt(s.maintenanceIssues)}</td>
      <td>${fmtDt(s.lastActivityAt)}</td>
      <td>
        <span class="ab-row-actions">
          <button title="View details" data-action="view" data-id="${s.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg></button>
          <button title="Assign bikes" data-action="assign" data-id="${s.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg></button>
          <button title="${s.effectiveStatus === 'offline' ? 'Mark online' : 'Mark offline'}" data-action="toggle" data-id="${s.id}" data-next="${s.effectiveStatus === 'offline' ? 'active' : 'offline'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5 5 L19 19"/></svg></button>
          <button title="Send maintenance" class="danger" data-action="maintenance" data-id="${s.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.7 5L4 16.5V20h3.5l5.2-5.2a4 4 0 0 0 5-5.7l-2.4 2.4-2.6-2.6 2.4-2.4z"/></svg></button>
        </span>
      </td>`;
  }
  function renderTable() {
    const tbody = $("stations-tbody");
    if (!state.stations.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="ab-table-empty">No stations match your filters.</td></tr>';
    } else {
      tbody.innerHTML = "";
      state.stations.forEach(s => {
        const tr = document.createElement("tr");
        tr.dataset.id = s.id;
        tr.innerHTML = rowHtml(s);
        tbody.appendChild(tr);
      });
    }
    $("row-count").textContent = `Showing ${state.stations.length} of ${state.total} ${state.total === 1 ? "station" : "stations"}`;
    renderPagination();
    // refresh area dropdown options based on stations seen so far
    refreshAreaDropdown(state.stations);
  }
  function renderPagination() {
    const el = $("pagination"); if (!el) return;
    el.innerHTML = "";
    const info = document.createElement("span");
    info.textContent = `Page ${state.page} of ${state.pages} — ${state.total} total`;
    el.appendChild(info);

    const pages = document.createElement("div");
    pages.className = "ab-pages";
    const mkBtn = (label, page, opts = {}) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (opts.active) b.classList.add("active");
      if (opts.disabled) b.disabled = true;
      if (!opts.disabled) b.addEventListener("click", () => { state.page = page; loadList(); });
      return b;
    };
    pages.appendChild(mkBtn("‹", state.page - 1, { disabled: state.page <= 1 }));
    const total = state.pages;
    const visible = [];
    if (total <= 7) for (let i = 1; i <= total; i++) visible.push(i);
    else {
      visible.push(1);
      if (state.page > 4) visible.push("…");
      for (let i = Math.max(2, state.page - 1); i <= Math.min(total - 1, state.page + 1); i++) visible.push(i);
      if (state.page < total - 3) visible.push("…");
      visible.push(total);
    }
    visible.forEach(p => {
      if (p === "…") { const e = document.createElement("button"); e.textContent = "…"; e.disabled = true; pages.appendChild(e); }
      else pages.appendChild(mkBtn(String(p), p, { active: p === state.page }));
    });
    pages.appendChild(mkBtn("›", state.page + 1, { disabled: state.page >= state.pages }));
    el.appendChild(pages);
  }
  async function loadList() {
    try {
      const f = state.filters;
      const params = new URLSearchParams({
        page: state.page, limit: state.limit,
        search: f.search, status: f.status, availability: f.availability,
        capacity: f.capacity, area: f.area,
      });
      for (const [k, v] of [...params.entries()]) if (v === "") params.delete(k);
      const data = await api("/api/admin/stations/list?" + params.toString());
      state.stations = data.stations || [];
      state.total = data.total || 0;
      state.pages = data.totalPages || 1;
      renderTable();
    } catch (err) {
      $("stations-tbody").innerHTML = `<tr><td colspan="11" class="ab-table-empty">${escapeHtml(err.message || "Could not load stations.")}</td></tr>`;
    }
  }

  function refreshAreaDropdown(stations) {
    const sel = $("f-area"); if (!sel) return;
    const seen = new Set(state.areas);
    stations.forEach(s => { if (s.area && s.area !== "—") seen.add(s.area); });
    if (seen.size === state.areas.length) return;
    state.areas = Array.from(seen).sort();
    const cur = sel.value;
    sel.innerHTML = '<option value="">All areas</option>' +
      state.areas.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
    sel.value = cur;
  }

  // ── Drawer ──
  let drawerStationId = null;
  async function openDrawer(stationId) {
    drawerStationId = Number(stationId);
    const drawer = $("station-drawer"); drawer.hidden = false;
    $("drawer-body").innerHTML = '<div class="ab-empty">Loading…</div>';
    $("drawer-status").textContent = "—";
    $("drawer-title").textContent = "Station #" + stationId;
    try {
      const data = await api(`/api/admin/stations/${stationId}`);
      const s = data.station;
      drawerStationId = s.id;
      $("drawer-status").textContent = statusLabel(s.effectiveStatus).toUpperCase();
      $("drawer-status").className = "ab-status-badge " + s.effectiveStatus;
      $("drawer-title").textContent = s.stationName;
      $("drawer-body").innerHTML = `
        <div class="ab-detail-row"><span class="k">Station ID</span><span class="v">${escapeHtml(s.stationId)}</span></div>
        <div class="ab-detail-row"><span class="k">Station Name</span><span class="v">${escapeHtml(s.stationName)}</span></div>
        <div class="ab-detail-row"><span class="k">Area/Suburb</span><span class="v">${escapeHtml(s.area)}</span></div>
        <div class="ab-detail-row"><span class="k">Address/Location</span><span class="v">${escapeHtml(s.address || "—")}</span></div>
        <div class="ab-detail-row"><span class="k">Capacity</span><span class="v">${fmtInt(s.capacity)}</span></div>
        <div class="ab-detail-row"><span class="k">Available Bikes</span><span class="v">${fmtInt(s.availableBikes)}</span></div>
        <div class="ab-detail-row"><span class="k">Reserved Bikes</span><span class="v">${fmtInt(s.reservedBikes)}</span></div>
        <div class="ab-detail-row"><span class="k">Active Bikes</span><span class="v">${fmtInt(s.activeBikes)}</span></div>
        <div class="ab-detail-row"><span class="k">Maintenance Bikes</span><span class="v">${fmtInt(s.maintenanceBikes)}</span></div>
        <div class="ab-detail-row"><span class="k">Opening Hours</span><span class="v">${escapeHtml(s.operatingHours)}</span></div>
        <div class="ab-detail-row"><span class="k">Last Activity</span><span class="v">${fmtDt(s.lastActivityAt)}</span></div>
        <div class="ab-detail-row"><span class="k">GPS / Map Status</span><span class="v">${escapeHtml(s.mapStatus)}</span></div>
        <div class="ab-detail-row"><span class="k">Maintenance Status</span><span class="v">${escapeHtml(s.maintenanceStatus)}</span></div>
        <div class="as-util-block">
          <div class="lbl">Utilisation</div>
          <div class="val">${s.utilisation}%</div>
          <div class="bar"><i style="width:${s.utilisation}%"></i></div>
        </div>`;
      $("drawer-active").disabled  = s.effectiveStatus === "normal" || s.effectiveStatus === "low" || s.effectiveStatus === "full";
      $("drawer-offline").disabled = s.effectiveStatus === "offline";
    } catch (err) {
      $("drawer-body").innerHTML = `<div class="ab-empty">${escapeHtml(err.message || "Could not load station.")}</div>`;
    }
  }
  function closeDrawer() { $("station-drawer").hidden = true; drawerStationId = null; }

  // ── Actions ──
  async function setStatus(id, next, label) {
    try {
      await apiSend(`/api/admin/stations/${id}/status`, "PATCH", { status: next });
      showToast(`Station ${label}.`);
      await refreshAll();
      if (drawerStationId === id) openDrawer(id);
    } catch (err) { showToast(err.message || "Could not update station.", "error"); }
  }
  async function assignBikes(id) {
    const input = prompt("Bike IDs to assign (comma separated):");
    if (!input) return;
    const ids = input.split(",").map(x => Number(x.trim())).filter(Number.isInteger);
    if (!ids.length) { showToast("No valid bike IDs provided.", "warn"); return; }
    try {
      await apiSend(`/api/admin/stations/${id}/assign-bikes`, "POST", { bikeIds: ids });
      showToast(`Moved ${ids.length} bike(s) to this station.`);
      await refreshAll();
      if (drawerStationId === id) openDrawer(id);
    } catch (err) { showToast(err.message || "Could not assign bikes.", "error"); }
  }
  async function flagMaintenance(id) {
    const desc = prompt("Describe the maintenance issue (optional):") || "";
    try {
      await apiSend(`/api/admin/stations/${id}/maintenance`, "POST", { description: desc });
      showToast("Maintenance team notified.");
      await refreshAll();
      if (drawerStationId === id) openDrawer(id);
    } catch (err) { showToast(err.message || "Could not flag maintenance.", "error"); }
  }

  // ── CSV export ──
  async function exportCsv() {
    try {
      const f = state.filters;
      const params = new URLSearchParams({
        page: 1, limit: 500,
        search: f.search, status: f.status, availability: f.availability,
        capacity: f.capacity, area: f.area,
      });
      for (const [k, v] of [...params.entries()]) if (v === "") params.delete(k);
      const data = await api("/api/admin/stations/list?" + params.toString());
      const rows = data.stations || [];
      const header = ["Station","Name","Area","Status","Available","Capacity","Utilisation","ActiveRides","MaintenanceIssues","LastActivity"];
      const lines = [header.join(",")];
      rows.forEach(s => {
        lines.push([
          s.stationId, JSON.stringify(s.stationName || ""), JSON.stringify(s.area || ""),
          s.effectiveStatus, s.availableBikes, s.capacity, s.utilisation + "%",
          s.activeRides, s.maintenanceIssues,
          s.lastActivityAt || "",
        ].join(","));
      });
      const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `stations_${state.range}_${new Date().toISOString().slice(0,10)}.csv`;
      a.click(); URL.revokeObjectURL(a.href);
      showToast("CSV downloaded.");
    } catch (err) { showToast(err.message || "Export failed.", "error"); }
  }

  // ── Refresh / wiring ──
  async function refreshAll() {
    showError("");
    await Promise.all([
      loadOverview(), loadTrends(), loadCapacityBreakdown(),
      loadList(), loadAlerts(), loadTopActive(), loadActivity(),
    ]);
  }

  function wireRangeTabs() {
    document.querySelectorAll(".ad-range-tabs button[data-range]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".ad-range-tabs button[data-range]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.range = btn.dataset.range;
        state.page = 1;
        refreshAll();
      });
    });
  }
  function wireFilters() {
    const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
    const apply = () => { state.page = 1; loadList(); };
    $("f-search").addEventListener("input", debounce((e) => { state.filters.search = e.target.value.trim(); apply(); }, 300));
    $("f-status").addEventListener("change",       (e) => { state.filters.status = e.target.value; apply(); });
    $("f-availability").addEventListener("change", (e) => { state.filters.availability = e.target.value; apply(); });
    $("f-capacity").addEventListener("change",     (e) => { state.filters.capacity = e.target.value; apply(); });
    $("f-area").addEventListener("change",         (e) => { state.filters.area = e.target.value; apply(); });
    $("reset-filters").addEventListener("click", () => {
      state.filters = { search: "", status: "", availability: "", capacity: "", area: "" };
      ["f-search","f-status","f-availability","f-capacity","f-area"].forEach(id => { const el = $(id); if (el) el.value = ""; });
      apply();
    });
  }
  function wireTableActions() {
    const tbody = $("stations-tbody");
    tbody.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-action]");
      if (btn) {
        ev.stopPropagation();
        const id = Number(btn.dataset.id);
        const action = btn.dataset.action;
        if (action === "view")        openDrawer(id);
        if (action === "assign")      assignBikes(id);
        if (action === "toggle")      setStatus(id, btn.dataset.next, btn.dataset.next === "offline" ? "marked offline" : "marked online");
        if (action === "maintenance") flagMaintenance(id);
        return;
      }
      const tr = ev.target.closest("tr[data-id]");
      if (tr) openDrawer(Number(tr.dataset.id));
    });
  }
  function wireDrawer() {
    document.querySelectorAll("[data-close-drawer]").forEach(el => el.addEventListener("click", closeDrawer));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
    $("drawer-assign").addEventListener("click",  () => drawerStationId && assignBikes(drawerStationId));
    $("drawer-active").addEventListener("click",  () => drawerStationId && setStatus(drawerStationId, "active",  "marked active"));
    $("drawer-offline").addEventListener("click", () => drawerStationId && setStatus(drawerStationId, "offline", "marked offline"));
    $("drawer-maint").addEventListener("click",   () => drawerStationId && flagMaintenance(drawerStationId));
    $("drawer-rides").addEventListener("click",   () => {
      if (!drawerStationId) return;
      window.location.href = "Admin_bookings.html?station=" + drawerStationId;
    });
    $("drawer-export").addEventListener("click", exportCsv);
  }
  function wireAddModal() {
    const modal = $("add-station-modal");
    const open  = () => { modal.hidden = false; };
    const close = () => { modal.hidden = true; };
    $("add-station-button").addEventListener("click", open);
    document.querySelectorAll("[data-close-add]").forEach(el => el.addEventListener("click", close));
    $("add-station-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      const body = {
        stationName:    form.stationName.value.trim(),
        area:           form.area.value.trim(),
        address:        form.address.value.trim(),
        capacity:       Number(form.capacity.value),
        operatingHours: form.operatingHours.value.trim() || "24/7",
        status:         form.status.value,
        latitude:       form.latitude.value,
        longitude:      form.longitude.value,
      };
      try {
        await apiSend("/api/admin/stations", "POST", body);
        close();
        showToast("Station created.");
        form.reset();
        refreshAll();
      } catch (err) { showToast(err.message || "Could not create station.", "error"); }
    });
  }
  function wireTopButtons() {
    $("refresh-page").addEventListener("click", () => { showToast("Refreshing…"); refreshAll(); });
    $("export-report").addEventListener("click", exportCsv);
  }

  function init() {
    wireRangeTabs();
    wireFilters();
    wireTableActions();
    wireDrawer();
    wireAddModal();
    wireTopButtons();
    refreshAll();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
