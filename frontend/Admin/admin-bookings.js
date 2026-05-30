// ──────────────────────────────────────────────────────────────
// Admin Bookings page — wires up KPIs, charts, table, drawer.
// Auth (token) + topbar/sidebar behaviour comes from admin-dashboard.js
// which loads before this file. We just talk to /api/admin/bookings/*.
// ──────────────────────────────────────────────────────────────
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const BAD_VISIBLE_RE = /demo|profit|loss|seed|test/i;
  const fmtMoney = (n) => "$" + Number(n || 0).toFixed(2);
  const fmtDate = (s) => s ? new Date(s).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—";
  const fmtTime = (s) => s ? new Date(s).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" }) : "—";
  const fmtDt   = (s) => s ? new Date(s).toLocaleString("en-AU",   { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
  const fmtDuration = (mins) => {
    if (mins == null || mins === "") return "Not set";
    const safe = Math.max(0, Number(mins || 0));
    const h = Math.floor(safe / 60);
    const m = safe % 60;
    if (h === 0 && m === 0) return "0m";
    return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  };

  // ── State ──
  const fmtRemaining = (mins) => {
    const safe = Math.max(1, Number(mins || 0));
    const h = Math.floor(safe / 60);
    const m = safe % 60;
    return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m left` : `${safe} min left`;
  };
  const escapeHtml = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
  const cleanText = (value, fallback = "Not assigned") => {
    const text = String(value == null ? "" : value).trim();
    if (!text || BAD_VISIBLE_RE.test(text)) return fallback;
    return text.replace(/\s+/g, " ");
  };
  const labelize = (value, fallback = "Pending") => cleanText(value, fallback)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
  const statusClass = (value) => cleanText(value, "pending").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
  const displayEnd = (b) => b.status === "active" ? "In progress" : (b.status === "cancelled" && !b.endTime ? "Cancelled" : fmtDt(b.endTime));
  const displayReturn = (b) => b.status === "active" ? "In progress" : cleanText(b.returnStation, "Not assigned");
  const displayDuration = (b) => b.status === "active" ? `${fmtDuration(b.durationMinutes)} elapsed` : fmtDuration(b.durationMinutes);

  const state = {
    range: "today",
    page: 1,
    limit: 10,
    filters: { search: "", status: "", paymentStatus: "", station: "", dateFrom: "", dateTo: "" },
    stations: [],
    bookings: [],
    total: 0,
    pages: 1,
    charts: { trends: null, status: null },
  };

  function getToken() {
    try { return localStorage.getItem("cbs_token"); } catch (_) { return null; }
  }

  function showToast(message, tone) {
    const el = $("admin-toast");
    if (!el) return;
    el.textContent = message;
    el.className = "ad-toast" + (tone ? " ad-toast--" + tone : "");
    el.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { el.hidden = true; }, 3200);
  }

  function showError(message) {
    const el = $("page-error");
    if (!el) return;
    if (!message) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = message;
    el.hidden = false;
  }

  async function api(path) {
    const token = getToken();
    if (!token) {
      window.location.replace("/login.html?admin=1&next=" + encodeURIComponent(location.pathname));
      throw new Error("Not authenticated.");
    }
    const res = await fetch(path, {
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) {
      window.location.replace("/login.html?admin=1&next=" + encodeURIComponent(location.pathname));
      throw new Error("Admin session expired.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
    return data;
  }
  async function apiSend(path, method, body) {
    const token = getToken();
    if (!token) {
      window.location.replace("/login.html?admin=1&next=" + encodeURIComponent(location.pathname));
      throw new Error("Not authenticated.");
    }
    const res = await fetch(path, {
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
    return data;
  }

  // ────────────────────────────────────────────────────────────
  // KPI overview
  // ────────────────────────────────────────────────────────────
  function renderTrend(elId, value) {
    const el = $(elId);
    if (!el) return;
    if (value == null || isNaN(value)) { el.textContent = ""; el.className = ""; return; }
    const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "•";
    const tone  = value > 0 ? "up" : value < 0 ? "down" : "";
    el.textContent = `${arrow} ${Math.abs(value).toFixed(1)}% vs prev.`;
    el.className = tone;
  }

  async function loadOverview() {
    try {
      const data = await api(`/api/admin/bookings/overview?range=${state.range}`);
      const t = data.totals || {};
      const tr = data.trends || {};
      $("kpi-totalBookings").textContent     = t.totalBookings;
      $("kpi-activeRides").textContent       = t.activeRides;
      $("kpi-upcomingBookings").textContent  = t.upcomingBookings;
      $("kpi-completedRides").textContent    = t.completedRides;
      $("kpi-cancelledBookings").textContent = t.cancelledBookings;
      $("kpi-pendingPayments").textContent   = t.pendingPayments;
      $("kpi-refundRequests").textContent    = t.refundRequests;
      $("kpi-bookingIssues").textContent     = t.bookingIssues;
      renderTrend("trend-totalBookings",     tr.totalBookings);
      renderTrend("trend-activeRides",       tr.activeRides);
      renderTrend("trend-completedRides",    tr.completedRides);
      renderTrend("trend-cancelledBookings", tr.cancelledBookings);
    } catch (err) {
      showError(err.message || "Could not load overview.");
    }
  }

  // ────────────────────────────────────────────────────────────
  // Trends chart (line)
  // ────────────────────────────────────────────────────────────
  async function loadTrends() {
    try {
      const data = await api(`/api/admin/bookings/trends?range=${state.range}`);
      const ctx = $("trends-chart").getContext("2d");
      const ds = (label, color, values, fill) => ({
        label, data: values,
        borderColor: color,
        backgroundColor: color + "22",
        borderWidth: 2.4, tension: .35, pointRadius: 2.5, pointHoverRadius: 5,
        fill: !!fill,
      });
      const cfg = {
        type: "line",
        data: {
          labels: data.labels,
          datasets: [
            ds("Completed", "#22C55E", data.series.completed, true),
            ds("Active",    "#3B82F6", data.series.active,    false),
            ds("Cancelled", "#EF4444", data.series.cancelled, false),
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
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
    } catch (err) {
      showError(err.message || "Could not load trends.");
    }
  }

  // ────────────────────────────────────────────────────────────
  // Status donut
  // ────────────────────────────────────────────────────────────
  function centerTextPlugin(total, label) {
    return {
      id: "bookingsCenterText",
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

  async function loadStatus() {
    try {
      const data = await api(`/api/admin/bookings/status?range=${state.range}`);
      const ctx = $("status-chart").getContext("2d");
      const labels = data.breakdown.map(b => b.label);
      const values = data.breakdown.map(b => b.count);
      const colors = data.breakdown.map(b => b.color);
      const cfg = {
        type: "doughnut",
        data: {
          labels,
          datasets: [{ data: values, backgroundColor: colors, borderColor: "#FFFFFF", borderWidth: 3, hoverOffset: 6 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: "65%",
          plugins: { legend: { display: false } },
        },
      };
      if (state.charts.status) state.charts.status.destroy();
      state.charts.status = new Chart(ctx, { ...cfg, plugins: [centerTextPlugin(data.total, "Total")] });

      const list = $("status-breakdown");
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
    } catch (err) {
      showError(err.message || "Could not load status breakdown.");
    }
  }

  // ────────────────────────────────────────────────────────────
  // Right rail: live rides, alerts, activity
  // ────────────────────────────────────────────────────────────
  function renderLiveRides(rides) {
    const el = $("live-active-list");
    const current = (rides || []).filter(r => {
      const mins = Number(r.minutesRemaining || 0) || Math.floor((new Date(r.expectedEndAt || r.expiresAt) - Date.now()) / 60000);
      return mins > 0;
    });
    if (!current.length) { el.innerHTML = '<div class="ab-empty">No active rides right now.</div>'; return; }
    el.innerHTML = "";
    current.slice(0, 5).forEach(r => {
      const mins = Number(r.minutesRemaining || 0) || Math.floor((new Date(r.expectedEndAt || r.expiresAt) - Date.now()) / 60000);
      const bike = cleanText(r.bikeCode, "Not assigned");
      const student = cleanText(r.studentName, "Not assigned");
      const station = cleanText(r.pickupStation, "Not assigned");
      const row = document.createElement("div");
      row.className = "ab-list-item ab-live-ride";
      row.innerHTML = `
        <span class="ab-list-ico blue"><span data-icon="bike"></span></span>
        <span class="ab-list-body">
          <strong title="${escapeHtml(bike + " - " + student)}">${escapeHtml(bike)} - ${escapeHtml(student)}</strong>
          <span title="${escapeHtml(station)}">${escapeHtml(station)}</span>
        </span>
        <span class="ab-list-meta">${escapeHtml(fmtRemaining(mins))}</span>
        <button class="ab-list-action" type="button">View</button>`;
      row.addEventListener("click", () => openDrawer(r.bookingId));
      row.style.cursor = "pointer";
      el.appendChild(row);
    });
    if (window.AdminUI && window.AdminUI.hydrateIcons) window.AdminUI.hydrateIcons(el);
  }
  async function loadLiveRides() {
    try {
      const data = await api("/api/admin/bookings/live-active");
      renderLiveRides(data.rides || []);
    } catch (_) {
      $("live-active-list").innerHTML = '<div class="ab-empty">Could not load live rides.</div>';
    }
  }

  function renderAlerts(alerts) {
    const el = $("alerts-list");
    if (!alerts || !alerts.length) { el.innerHTML = '<div class="ab-empty">All clear - no alerts.</div>'; return; }
    el.innerHTML = "";
    alerts.forEach(a => {
      const row = document.createElement("div");
      row.className = "ab-list-item";
      row.innerHTML = `
        <span class="ab-list-ico ${a.tone}"><span data-icon="alert"></span></span>
        <span class="ab-list-body">
          <strong>${escapeHtml(a.count + " " + cleanText(a.label, "alerts"))}</strong>
        </span>
        <span class="ab-list-meta">${a.count}</span>`;
      el.appendChild(row);
    });
    if (window.AdminUI && window.AdminUI.hydrateIcons) window.AdminUI.hydrateIcons(el);
  }
  async function loadAlerts() {
    try { renderAlerts((await api("/api/admin/bookings/alerts")).alerts || []); }
    catch (_) { $("alerts-list").innerHTML = '<div class="ab-empty">Could not load alerts.</div>'; }
  }

  function activityLabel(kind) {
    return ({
      completed: "Booking completed",
      cancelled: "Ride cancelled",
      active:    "Booking active",
      created:   "New booking created",
      payment_received: "Payment received",
      refund_requested: "Refund requested",
    })[kind] || "Activity";
  }
  function activityTone(kind) {
    return ({
      completed: "",
      cancelled: "red",
      active:    "blue",
      created:   "",
      payment_received: "",
      refund_requested: "amber",
    })[kind] || "";
  }
  function renderActivity(rows) {
    const el = $("activity-list");
    if (!rows || !rows.length) { el.innerHTML = '<div class="ab-empty">No recent booking activity.</div>'; return; }
    el.innerHTML = "";
    rows.slice(0, 6).forEach(a => {
      const when = new Date(a.occurredAt);
      const diff = Math.max(1, Math.floor((Date.now() - when.getTime()) / 60000));
      const ago = diff < 60 ? `${diff}m ago` : diff < 1440 ? `${Math.floor(diff/60)}h ago` : `${Math.floor(diff/1440)}d ago`;
      const row = document.createElement("div");
      row.className = "ab-list-item";
      row.innerHTML = `
        <span class="ab-list-ico ${activityTone(a.kind)}"><span data-icon="calendar"></span></span>
        <span class="ab-list-body">
          <strong>${escapeHtml(activityLabel(a.kind))}</strong>
          <span>${escapeHtml(cleanText(a.bookingCode, "Booking"))} - ${escapeHtml(cleanText(a.studentName, "Not assigned"))}</span>
        </span>
        <span class="ab-list-meta">${ago}</span>`;
      row.addEventListener("click", () => openDrawer(a.bookingId));
      row.style.cursor = "pointer";
      el.appendChild(row);
    });
    if (window.AdminUI && window.AdminUI.hydrateIcons) window.AdminUI.hydrateIcons(el);
  }
  async function loadActivity() {
    try { renderActivity((await api("/api/admin/bookings/activity")).activity || []); }
    catch (_) { $("activity-list").innerHTML = '<div class="ab-empty">Could not load activity.</div>'; }
  }

  // ────────────────────────────────────────────────────────────
  // Bookings table
  // ────────────────────────────────────────────────────────────
  function rowHtml(b) {
    return `
      <td><strong>${b.bookingCode}</strong></td>
      <td>${escapeHtml(b.studentName || "—")}${b.studentRole ? ` <span class="ab-role-pill ${(b.studentRole||"").toLowerCase()}">${b.studentRole.charAt(0).toUpperCase()+b.studentRole.slice(1)}</span>` : ""}</td>
      <td>${b.bikeCode}</td>
      <td>${b.pickupStation}</td>
      <td>${b.returnStation || "—"}</td>
      <td>${fmtDt(b.startTime)}</td>
      <td>${fmtDt(b.endTime)}</td>
      <td>${fmtDuration(b.durationMinutes)}</td>
      <td>${fmtMoney(b.amount)}</td>
      <td><span class="ab-badge ${b.paymentStatus}">${b.paymentStatus}</span></td>
      <td><span class="ab-badge ${b.status}">${b.status}</span></td>
      <td>
        <span class="ab-row-actions">
          <button title="View details" data-action="view"  data-id="${b.bookingId}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg></button>
          <button title="View receipt" data-action="receipt" data-id="${b.bookingId}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></button>
          <button title="Refund" data-action="refund" data-id="${b.bookingId}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/></svg></button>
          <button title="Cancel booking" class="danger" data-action="cancel" data-id="${b.bookingId}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        </span>
      </td>`;
  }

  function rowHtmlClean(b) {
    const bookingCodeText = cleanText(b.bookingCode, `BK-${String(b.bookingId).padStart(4, "0")}`);
    const studentText = cleanText(b.studentName, "Not assigned");
    const bikeText = cleanText(b.bikeCode, "Not assigned");
    const pickupText = cleanText(b.pickupStation, "Not assigned");
    const returnText = displayReturn(b);
    const paymentStatus = statusClass(b.paymentStatus);
    const bookingStatus = statusClass(b.status);
    return `
      <td><strong>${escapeHtml(bookingCodeText)}</strong></td>
      <td title="${escapeHtml(studentText)}">${escapeHtml(studentText)}</td>
      <td title="${escapeHtml(bikeText)}">${escapeHtml(bikeText)}</td>
      <td title="${escapeHtml(pickupText)}">${escapeHtml(pickupText)}</td>
      <td title="${escapeHtml(returnText)}">${escapeHtml(returnText)}</td>
      <td>${fmtDt(b.startTime)}</td>
      <td>${escapeHtml(displayEnd(b))}</td>
      <td>${escapeHtml(displayDuration(b))}</td>
      <td>${fmtMoney(b.amount)}</td>
      <td><span class="ab-badge ${paymentStatus}">${escapeHtml(labelize(b.paymentStatus, "Pending"))}</span></td>
      <td><span class="ab-badge ${bookingStatus}">${escapeHtml(labelize(b.status, "Pending"))}</span></td>
      <td>
        <span class="ab-row-actions">
          <button title="View details" data-action="view"  data-id="${b.bookingId}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg></button>
          <button title="View receipt" data-action="receipt" data-id="${b.bookingId}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></button>
          <button title="Refund" data-action="refund" data-id="${b.bookingId}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/></svg></button>
          <button title="Cancel booking" class="danger" data-action="cancel" data-id="${b.bookingId}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        </span>
      </td>`;
  }

  function renderTable() {
    const tbody = $("bookings-tbody");
    if (!state.bookings.length) {
      tbody.innerHTML = '<tr><td colspan="12" class="ab-table-empty">No bookings match your filters.</td></tr>';
    } else {
      tbody.innerHTML = "";
      state.bookings.forEach(b => {
        const tr = document.createElement("tr");
        tr.dataset.id = b.bookingId;
        tr.innerHTML = rowHtmlClean(b);
        tbody.appendChild(tr);
      });
    }
    $("row-count").textContent = `${state.total} booking${state.total === 1 ? "" : "s"} found`;
    renderPagination();
  }

  function renderPagination() {
    const el = $("pagination");
    if (!el) return;
    el.innerHTML = "";
    const info = document.createElement("span");
    info.textContent = `Page ${state.page} of ${state.pages} — showing ${state.bookings.length} of ${state.total}`;
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
    const visible = [];
    const total = state.pages;
    if (total <= 7) {
      for (let i = 1; i <= total; i++) visible.push(i);
    } else {
      visible.push(1);
      if (state.page > 4) visible.push("…");
      for (let i = Math.max(2, state.page - 1); i <= Math.min(total - 1, state.page + 1); i++) visible.push(i);
      if (state.page < total - 3) visible.push("…");
      visible.push(total);
    }
    visible.forEach(p => {
      if (p === "…") {
        const e = document.createElement("button");
        e.textContent = "…"; e.disabled = true;
        pages.appendChild(e);
      } else {
        pages.appendChild(mkBtn(String(p), p, { active: p === state.page }));
      }
    });
    pages.appendChild(mkBtn("›", state.page + 1, { disabled: state.page >= state.pages }));
    el.appendChild(pages);
  }

  async function loadList() {
    try {
      const f = state.filters;
      const params = new URLSearchParams({
        page: state.page, limit: state.limit,
        search: f.search, status: f.status, paymentStatus: f.paymentStatus,
        station: f.station, dateFrom: f.dateFrom, dateTo: f.dateTo,
      });
      // Drop empty params
      for (const [k, v] of [...params.entries()]) if (v === "") params.delete(k);
      const data = await api("/api/admin/bookings/list?" + params.toString());
      state.bookings = data.bookings || [];
      state.total = data.total || 0;
      state.pages = data.totalPages || data.pages || 1;
      renderTable();
    } catch (err) {
      $("bookings-tbody").innerHTML = `<tr><td colspan="12" class="ab-table-empty">${err.message || "Could not load bookings."}</td></tr>`;
    }
  }

  // ────────────────────────────────────────────────────────────
  // Stations dropdown
  // ────────────────────────────────────────────────────────────
  async function loadStations() {
    try {
      // Reuse the existing stations endpoint
      const data = await api("/api/user/stations");
      state.stations = data.stations || [];
      const sel = $("f-station");
      sel.innerHTML = '<option value="">All stations</option>';
      state.stations.forEach(s => {
        const stationName = cleanText(s.station_name || s.name, "");
        if (!stationName) return;
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = stationName;
        sel.appendChild(opt);
      });
    } catch (_) { /* keep dropdown empty */ }
  }

  // ────────────────────────────────────────────────────────────
  // Detail drawer
  // ────────────────────────────────────────────────────────────
  let drawerBookingId = null;
  async function openDrawer(bookingId) {
    drawerBookingId = Number(bookingId);
    const drawer = $("booking-drawer");
    drawer.hidden = false;
    $("drawer-body").innerHTML = '<div class="ab-empty">Loading…</div>';
    $("drawer-status").textContent = "—";
    $("drawer-title").textContent = "Booking #" + bookingId;
    try {
      const data = await api("/api/admin/bookings/" + bookingId);
      const b = data.booking;
      drawerBookingId = b.bookingId;
      const bookingCodeText = cleanText(b.bookingCode, `BK-${String(b.bookingId).padStart(4, "0")}`);
      const studentText = cleanText(b.studentName, "Not assigned");
      const emailText = cleanText(b.studentEmail, "");
      const phoneText = cleanText(b.studentPhone, "Not provided");
      const bikeText = cleanText(b.bikeCode, "Not assigned");
      const bikeModelText = cleanText(b.bikeModel, "Standard");
      const pickupText = cleanText(b.pickupStation, "Not assigned");
      const returnText = displayReturn(b);
      const paymentStatus = statusClass(b.paymentStatus);
      const bookingStatus = statusClass(b.status);
      $("drawer-status").textContent = labelize(b.status, "Pending").toUpperCase();
      $("drawer-status").className = "ab-status-badge " + bookingStatus;
      $("drawer-title").textContent = bookingCodeText;
      // Show the role beside the name so admin can tell student vs staff
      // at a glance. studentRole comes from the admin bookings API and
      // mirrors users.role. Falls back to empty when missing.
      const roleLabel = (b.studentRole || b.userRole || "").toLowerCase();
      const roleBadge = roleLabel
        ? ` <span class="ab-role-pill ${roleLabel}">${roleLabel.charAt(0).toUpperCase() + roleLabel.slice(1)}</span>`
        : "";
      $("drawer-body").innerHTML = `
        <div class="ab-detail-row"><span class="k">User</span><span class="v">${escapeHtml(studentText)}${roleBadge}</span></div>
        <div class="ab-detail-row"><span class="k">Email</span><span class="v">${escapeHtml(emailText || "Not provided")}</span></div>
        <div class="ab-detail-row"><span class="k">Phone</span><span class="v">${escapeHtml(phoneText)}</span></div>
        <div class="ab-detail-row"><span class="k">Bike ID</span><span class="v">${escapeHtml(bikeText)} (${escapeHtml(bikeModelText)})</span></div>
        <div class="ab-detail-row"><span class="k">Pickup station</span><span class="v">${escapeHtml(pickupText)}</span></div>
        <div class="ab-detail-row"><span class="k">Return station</span><span class="v">${escapeHtml(returnText)}</span></div>
        <div class="ab-detail-row"><span class="k">Start time</span><span class="v">${fmtDt(b.startTime)}</span></div>
        <div class="ab-detail-row"><span class="k">End time</span><span class="v">${escapeHtml(displayEnd(b))}</span></div>
        <div class="ab-detail-row"><span class="k">Duration</span><span class="v">${escapeHtml(displayDuration(b))}</span></div>
        <div class="ab-detail-row"><span class="k">Booking type</span><span class="v">${escapeHtml(labelize(b.bookingType, "Standard"))}</span></div>
        <div class="ab-detail-row"><span class="k">Pricing mode</span><span class="v">${escapeHtml(labelize(b.pricingMode, "Standard"))}</span></div>
        <div class="ab-detail-row"><span class="k">Amount</span><span class="v">${fmtMoney(b.amount)}</span></div>
        <div class="ab-detail-row"><span class="k">Payment status</span><span class="v"><span class="ab-badge ${paymentStatus}">${escapeHtml(labelize(b.paymentStatus, "Pending"))}</span></span></div>
        <div class="ab-detail-row"><span class="k">Refund eligibility</span><span class="v">${b.refundEligible ? "Eligible" : "Not eligible"}</span></div>

        <div class="ab-detail-section">
          <h3>Linked support tickets</h3>
          ${
            (b.linkedTickets && b.linkedTickets.length)
              ? b.linkedTickets.map(t => `<div class="ab-detail-row"><span class="k">#${t.id} ${escapeHtml(cleanText(t.subject, "Support request"))}</span><span class="v">${escapeHtml(labelize(t.status, "Open"))}</span></div>`).join("")
              : '<div class="ab-empty">No tickets linked to this booking.</div>'
          }
        </div>

        <div class="ab-detail-section">
          <h3>Refund history</h3>
          ${
            (b.refundHistory && b.refundHistory.length)
              ? b.refundHistory.map(r => `<div class="ab-detail-row"><span class="k">${fmtDate(r.created_at)} — ${r.description || "Refund"}</span><span class="v">${fmtMoney(r.amount)}</span></div>`).join("")
              : '<div class="ab-empty">No refunds for this booking yet.</div>'
          }
        </div>
      `;

      // Toggle footer button availability
      $("drawer-refund").disabled = !b.refundEligible;
      $("drawer-cancel").disabled = !["pending","active"].includes(b.status);
      $("drawer-contact").onclick = () => {
        if (emailText) location.href = `mailto:${emailText}?subject=Booking ${bookingCodeText}`;
      };
      $("drawer-receipt").onclick = () => {
        // Receipt = a simple printable HTML view of the booking
        const w = window.open("", "_blank");
        if (!w) return;
        w.document.write(`
          <title>Receipt ${bookingCodeText}</title>
          <style>body{font-family:Inter,Arial;padding:32px;max-width:520px;color:#0F172A}h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;color:#64748B;margin:0 0 24px;font-weight:600}table{width:100%;border-collapse:collapse;font-size:14px}td{padding:8px 0;border-bottom:1px solid #E2E8F0}td:last-child{text-align:right;font-weight:700}</style>
          <h1>Receipt — ${b.bookingCode}</h1><h2>Campus Bike Sharing</h2>
          <table>
            <tr><td>User</td><td>${escapeHtml(b.studentName || "—")}${b.studentRole ? ` <span class="ab-role-pill ${(b.studentRole||"").toLowerCase()}">${b.studentRole.charAt(0).toUpperCase()+b.studentRole.slice(1)}</span>` : ""}</td></tr>
            <tr><td>Bike</td><td>${escapeHtml(bikeText)}</td></tr>
            <tr><td>Pickup</td><td>${escapeHtml(pickupText)}</td></tr>
            <tr><td>Return</td><td>${b.returnStation || "—"}</td></tr>
            <tr><td>Start</td><td>${fmtDt(b.startTime)}</td></tr>
            <tr><td>End</td><td>${escapeHtml(displayEnd(b))}</td></tr>
            <tr><td>Duration</td><td>${escapeHtml(displayDuration(b))}</td></tr>
            <tr><td>Status</td><td>${escapeHtml(labelize(b.status, "Pending"))}</td></tr>
            <tr><td>Payment</td><td>${escapeHtml(labelize(b.paymentStatus, "Pending"))}</td></tr>
            <tr><td><strong>Total</strong></td><td><strong>${fmtMoney(b.amount)}</strong></td></tr>
          </table>`);
        w.document.close();
      };
    } catch (err) {
      $("drawer-body").innerHTML = `<div class="ab-empty">${err.message || "Could not load booking."}</div>`;
    }
  }

  function closeDrawer() {
    $("booking-drawer").hidden = true;
    drawerBookingId = null;
  }

  // ────────────────────────────────────────────────────────────
  // Refund / cancel actions (table + drawer)
  // ────────────────────────────────────────────────────────────
  async function doRefund(bookingId) {
    const reason = prompt("Reason for refund? (Required, 6+ chars)");
    if (!reason || reason.trim().length < 6) { showToast("Refund cancelled — reason required.", "warn"); return; }
    try {
      await apiSend(`/api/admin/bookings/${bookingId}/refund`, "POST", { reason: reason.trim() });
      showToast("Refund processed.");
      await refreshAll();
      if (drawerBookingId === bookingId) openDrawer(bookingId);
    } catch (err) { showToast(err.message || "Refund failed.", "error"); }
  }
  async function doCancel(bookingId) {
    const reason = prompt("Reason for cancellation? (Required, 6+ chars)");
    if (!reason || reason.trim().length < 6) { showToast("Cancel aborted — reason required.", "warn"); return; }
    try {
      await apiSend(`/api/admin/bookings/${bookingId}/cancel`, "POST", { reason: reason.trim() });
      showToast("Booking cancelled.");
      await refreshAll();
      if (drawerBookingId === bookingId) openDrawer(bookingId);
    } catch (err) { showToast(err.message || "Cancel failed.", "error"); }
  }

  // ────────────────────────────────────────────────────────────
  // CSV export
  // ────────────────────────────────────────────────────────────
  async function exportCsv() {
    try {
      // Fetch up to 500 rows respecting current filters
      const f = state.filters;
      const params = new URLSearchParams({
        page: 1, limit: 500,
        search: f.search, status: f.status, paymentStatus: f.paymentStatus,
        station: f.station, dateFrom: f.dateFrom, dateTo: f.dateTo,
      });
      for (const [k, v] of [...params.entries()]) if (v === "") params.delete(k);
      const data = await api("/api/admin/bookings/list?" + params.toString());
      const rows = data.bookings || [];
      const header = ["Booking","Student","Email","Bike","Pickup","Return","Start","End","Duration","Amount","Payment","Status"];
      const lines = [header.join(",")];
      rows.forEach(b => {
        const bookingCodeText = cleanText(b.bookingCode, `BK-${String(b.bookingId).padStart(4, "0")}`);
        const studentText = cleanText(b.studentName, "");
        const emailText = cleanText(b.studentEmail, "");
        const bikeText = cleanText(b.bikeCode, "");
        const pickupText = cleanText(b.pickupStation, "");
        const returnText = displayReturn(b);
        lines.push([
          bookingCodeText, JSON.stringify(studentText), JSON.stringify(emailText),
          bikeText, JSON.stringify(pickupText), JSON.stringify(returnText),
          b.startTime || "", displayEnd(b), displayDuration(b),
          b.amount, labelize(b.paymentStatus, "Pending"), labelize(b.status, "Pending"),
        ].join(","));
      });
      const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `bookings_${state.range}_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast("CSV downloaded.");
    } catch (err) { showToast(err.message || "Export failed.", "error"); }
  }

  // ────────────────────────────────────────────────────────────
  // Wire up + load
  // ────────────────────────────────────────────────────────────
  async function refreshAll() {
    showError("");
    await Promise.all([
      loadOverview(), loadTrends(), loadStatus(),
      loadList(),     loadLiveRides(), loadAlerts(), loadActivity(),
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
    $("f-status").addEventListener("change", (e) => { state.filters.status = e.target.value; apply(); });
    $("f-payment").addEventListener("change", (e) => { state.filters.paymentStatus = e.target.value; apply(); });
    $("f-station").addEventListener("change", (e) => { state.filters.station = e.target.value; apply(); });
    $("f-from").addEventListener("change", (e) => { state.filters.dateFrom = e.target.value; apply(); });
    $("f-to").addEventListener("change", (e) => { state.filters.dateTo = e.target.value; apply(); });
    $("reset-filters").addEventListener("click", () => {
      state.filters = { search: "", status: "", paymentStatus: "", station: "", dateFrom: "", dateTo: "" };
      ["f-search","f-status","f-payment","f-station","f-from","f-to"].forEach(id => { const el = $(id); if (el) el.value = ""; });
      apply();
    });
  }

  function wireTableActions() {
    const tbody = $("bookings-tbody");
    tbody.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-action]");
      if (btn) {
        ev.stopPropagation();
        const id = Number(btn.dataset.id);
        const action = btn.dataset.action;
        if (action === "view")    openDrawer(id);
        if (action === "receipt") openDrawer(id);
        if (action === "refund")  doRefund(id);
        if (action === "cancel")  doCancel(id);
        return;
      }
      const tr = ev.target.closest("tr[data-id]");
      if (tr) openDrawer(Number(tr.dataset.id));
    });
  }

  function wireDrawer() {
    document.querySelectorAll("[data-close-drawer]").forEach(el => el.addEventListener("click", closeDrawer));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
    $("drawer-refund").addEventListener("click", () => drawerBookingId && doRefund(drawerBookingId));
    $("drawer-cancel").addEventListener("click", () => drawerBookingId && doCancel(drawerBookingId));
  }

  function wireManualModal() {
    const modal = $("manual-modal");
    const open  = () => { modal.hidden = false; };
    const close = () => { modal.hidden = true; };
    $("add-manual-booking").addEventListener("click", open);
    document.querySelectorAll("[data-close-manual]").forEach(el => el.addEventListener("click", close));
    $("manual-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      const body = {
        userId:           Number(form.userId.value),
        bikeId:           Number(form.bikeId.value),
        stationId:        Number(form.stationId.value),
        startTime:        new Date(form.startTime.value).toISOString(),
        durationMinutes:  Number(form.durationMinutes.value),
      };
      try {
        await apiSend("/api/admin/bookings/manual", "POST", body);
        close();
        showToast("Manual booking created.");
        refreshAll();
      } catch (err) { showToast(err.message || "Could not create booking.", "error"); }
    });
  }

  function wireTopButtons() {
    $("refresh-page").addEventListener("click", () => { showToast("Refreshing…"); refreshAll(); });
    $("export-bookings").addEventListener("click", exportCsv);
  }

  function init() {
    wireRangeTabs();
    wireFilters();
    wireTableActions();
    wireDrawer();
    wireManualModal();
    wireTopButtons();
    loadStations();
    refreshAll();
  }

  // Wait for admin-dashboard.js to finish auth bootstrap before we run.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
