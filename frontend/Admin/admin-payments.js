// ──────────────────────────────────────────────────────────────
// Admin Payments page — KPIs, charts, table, drawer, insights.
// Talks to /api/admin/payments/*. Auth + topbar behaviour comes
// from admin-dashboard.js (loaded before this file).
// ──────────────────────────────────────────────────────────────
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const fmtMoney = (n) => "$" + Number(n || 0).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtInt   = (n) => Number(n || 0).toLocaleString("en-AU");
  const fmtDate  = (s) => s ? new Date(s).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—";
  const fmtTime  = (s) => s ? new Date(s).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" }) : "—";
  const fmtDt    = (s) => s ? new Date(s).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  const escapeHtml = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

  const methodLabel = (m) => ({
    credit_card: "Credit Card",
    campus_card: "Campus Card",
    wallet:      "Wallet",
    waived:      "Waived",
  })[m] || (m || "—");

  // ── State ──
  const state = {
    range: "today",
    page: 1,
    limit: 10,
    filters: { search: "", status: "", method: "", amountRange: "", dateFrom: "", dateTo: "" },
    payments: [],
    total: 0,
    pages: 1,
    charts: { trends: null, status: null },
  };

  function getToken() { try { return localStorage.getItem("cbs_token"); } catch (_) { return null; } }

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

  // ── KPI ──
  function renderTrend(elId, value, format) {
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
      const data = await api(`/api/admin/payments/overview?range=${state.range}`);
      const t  = data.totals || {};
      const tr = data.trends || {};
      $("kpi-totalRevenue").textContent       = fmtMoney(t.totalRevenue);
      $("kpi-successfulPayments").textContent = fmtInt(t.successfulPayments);
      $("kpi-pendingPayments").textContent    = fmtInt(t.pendingPayments);
      $("kpi-failedPayments").textContent     = fmtInt(t.failedPayments);
      $("kpi-refundsProcessed").textContent   = fmtMoney(t.refundsProcessed);
      $("kpi-refundRequests").textContent     = fmtInt(t.refundRequests);
      $("kpi-averagePayment").textContent     = fmtMoney(t.averagePayment);
      $("kpi-netPaymentBalance").textContent  = fmtMoney(t.netPaymentBalance);
      renderTrend("trend-totalRevenue",       tr.totalRevenue);
      renderTrend("trend-successfulPayments", tr.successfulPayments);
      renderTrend("trend-pendingPayments",    tr.pendingPayments);
      renderTrend("trend-failedPayments",     tr.failedPayments);
      renderTrend("trend-refundsProcessed",   tr.refundsProcessed);
      renderTrend("trend-refundRequests",     tr.refundRequests);
      renderTrend("trend-averagePayment",     tr.averagePayment);
      renderTrend("trend-netPaymentBalance",  tr.netPaymentBalance);
    } catch (err) { showError(err.message || "Could not load overview."); }
  }

  // ── Trends chart ──
  async function loadTrends() {
    try {
      const data = await api(`/api/admin/payments/trends?range=${state.range}`);
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
            ds("Revenue", "#22C55E", data.series.revenue, true),
            ds("Refunds", "#EF4444", data.series.refunds, true),
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: "#64748B", font: { size: 11 } } },
            y: { beginAtZero: true, grid: { color: "#F1F5F9" },
                 ticks: { color: "#64748B", font: { size: 11 }, callback: (v) => "$" + v } },
          },
        },
      };
      if (state.charts.trends) state.charts.trends.destroy();
      state.charts.trends = new Chart(ctx, cfg);
      $("trends-range-label").textContent = state.range[0].toUpperCase() + state.range.slice(1);
    } catch (err) { showError(err.message || "Could not load trends."); }
  }

  // ── Donut breakdown ──
  function centerTextPlugin(total, label) {
    return {
      id: "paymentsCenterText",
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

  async function loadBreakdown() {
    try {
      const data = await api(`/api/admin/payments/breakdown?range=${state.range}`);
      const ctx = $("status-chart").getContext("2d");
      const labels = data.breakdown.map(b => b.label);
      const values = data.breakdown.map(b => b.count);
      const colors = data.breakdown.map(b => b.color);
      const cfg = {
        type: "doughnut",
        data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: "#FFFFFF", borderWidth: 3, hoverOffset: 6 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: "65%", plugins: { legend: { display: false } } },
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
    } catch (err) { showError(err.message || "Could not load breakdown."); }
  }

  // ── Right rail: activity ──
  function activityTitle(status) {
    return ({
      paid:     "Payment received",
      pending:  "Payment pending",
      failed:   "Failed payment detected",
      refunded: "Refund processed",
      waived:   "Payment marked as waived",
    })[status] || "Payment update";
  }
  function activityIconTone(status) {
    return ({
      paid: "green", pending: "amber", failed: "red", refunded: "purple", waived: "blue",
    })[status] || "blue";
  }
  function renderActivity(rows) {
    const el = $("activity-list");
    if (!rows || !rows.length) { el.innerHTML = '<div class="ab-empty">No recent payment activity.</div>'; return; }
    el.innerHTML = "";
    rows.slice(0, 6).forEach(a => {
      const when = new Date(a.occurredAt);
      const diff = Math.max(1, Math.floor((Date.now() - when.getTime()) / 60000));
      const ago = diff < 60 ? `${diff} min ago` : diff < 1440 ? `${Math.floor(diff/60)} hr ago` : `${Math.floor(diff/1440)} days ago`;
      const item = document.createElement("div");
      item.className = "ab-list-item";
      item.style.cursor = "pointer";
      item.innerHTML = `
        <span class="ab-list-ico ${activityIconTone(a.status)}"><span data-icon="credit-card"></span></span>
        <span class="ab-list-body">
          <strong>${activityTitle(a.status)}</strong>
          <span>${escapeHtml(a.paymentCode)} by ${escapeHtml(a.studentName)}</span>
        </span>
        <span class="ab-list-meta">${ago}</span>`;
      item.addEventListener("click", () => openDrawer(a.paymentId));
      el.appendChild(item);
    });
    if (window.AdminUI && window.AdminUI.hydrateIcons) window.AdminUI.hydrateIcons(el);
  }
  async function loadActivity() {
    try { renderActivity((await api(`/api/admin/payments/activity?range=${state.range}`)).activity || []); }
    catch (_) { $("activity-list").innerHTML = '<div class="ab-empty">Could not load activity.</div>'; }
  }

  // ── Right rail: insights ──
  function renderInsights(d) {
    const el = $("insights-list");
    el.innerHTML = `
      <div class="ap-insight-row">
        <span class="ico green"><span data-icon="dollar"></span></span>
        <span class="body"><strong>High value payments today</strong><span>${d.highValueCount} payment${d.highValueCount === 1 ? "" : "s"} ≥ $10</span></span>
        <span class="val">${fmtMoney(d.highValueTotal)}</span>
      </div>
      <div class="ap-insight-row">
        <span class="ico purple"><span data-icon="help-circle"></span></span>
        <span class="body"><strong>Top paying student</strong><span>${escapeHtml(d.topPayingStudent)}</span></span>
        <span class="val">${fmtMoney(d.topPayingTotal)}</span>
      </div>
      <div class="ap-insight-row">
        <span class="ico blue"><span data-icon="credit-card"></span></span>
        <span class="body"><strong>Most used payment method</strong><span>${d.topMethodCount} payment${d.topMethodCount === 1 ? "" : "s"}</span></span>
        <span class="val">${escapeHtml(d.topMethod)}</span>
      </div>`;
    if (window.AdminUI && window.AdminUI.hydrateIcons) window.AdminUI.hydrateIcons(el);
  }
  async function loadInsights() {
    try { renderInsights((await api(`/api/admin/payments/insights?range=${state.range}`)).insights || {}); }
    catch (_) { $("insights-list").innerHTML = '<div class="ab-empty">Could not load insights.</div>'; }
  }

  // ── Table ──
  function renderRefundRequests(rows) {
    const el = $("refund-requests-list");
    if (!el) return;
    if (!rows || !rows.length) {
      el.innerHTML = '<div class="ab-empty">No pending refund requests.</div>';
      return;
    }
    el.innerHTML = rows.slice(0, 5).map((r) => `
      <div class="ap-refund-item ${escapeHtml(r.status || "")}">
        <div class="ap-refund-top">
          <div style="min-width:0">
            <strong title="${escapeHtml(r.reason || "")}">Booking #${escapeHtml(r.bookingId)}</strong>
            <span>${escapeHtml(r.userName || r.userEmail || "Student")} · ${escapeHtml(r.rideStatus || "")}</span>
          </div>
          <span class="ap-refund-amount">${fmtMoney(r.calculatedRefundAmount)}</span>
        </div>
        <div class="ap-refund-actions">
          <button type="button" data-refund-action="approve" data-id="${r.id}">Approve</button>
          <button type="button" class="reject" data-refund-action="reject" data-id="${r.id}">Reject</button>
        </div>
      </div>
    `).join("");
  }

  async function loadRefundRequests() {
    const el = $("refund-requests-list");
    if (!el) return;
    try {
      const data = await api("/api/admin/refund-requests?status=pending_review");
      renderRefundRequests(data.refundRequests || []);
    } catch (_) {
      el.innerHTML = '<div class="ab-empty">Could not load refund requests.</div>';
    }
  }

  async function reviewRefundRequest(id, action) {
    try {
      const note = prompt(action === "approve" ? "Admin note for approval? (Optional)" : "Reason for rejecting this refund request? (Optional)");
      const data = await apiSend(`/api/admin/refund-requests/${id}/${action}`, "POST", { adminNote: note || "" });
      showToast(data.message || `Refund request ${action === "approve" ? "approved" : "rejected"}.`);
      await Promise.all([loadRefundRequests(), loadOverview(), loadActivity()]);
    } catch (err) {
      showToast(err.message || "Could not review refund request.", "error");
    }
  }

  function rowHtml(p) {
    return `
      <td><strong>${escapeHtml(p.paymentCode)}</strong></td>
      <td>${escapeHtml(p.bookingCode)}</td>
      <td>${escapeHtml(p.studentName || "—")}${p.studentRole ? ` <span class="ab-role-pill ${(p.studentRole||"").toLowerCase()}">${p.studentRole.charAt(0).toUpperCase()+p.studentRole.slice(1)}</span>` : ""}</td>
      <td>${escapeHtml(p.bikeCode)}</td>
      <td>${escapeHtml(p.station || "—")}</td>
      <td class="num">${fmtMoney(p.amount)}</td>
      <td><span class="ap-method">${methodLabel(p.paymentMethod)}</span></td>
      <td><span class="ab-badge ${p.status}">${p.status}</span></td>
      <td><span class="ref" title="${escapeHtml(p.transactionRef || "")}">${escapeHtml(p.transactionRef || "—")}</span></td>
      <td>${fmtDt(p.paymentDate)}</td>
      <td>
        <span class="ab-row-actions">
          <button title="View details" data-action="view"    data-id="${p.paymentId}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg></button>
          <button title="View receipt" data-action="receipt" data-id="${p.paymentId}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></button>
          <button title="Approve refund" data-action="refund" data-id="${p.paymentId}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/></svg></button>
          <button title="Mark reviewed" data-action="review" data-id="${p.paymentId}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>
        </span>
      </td>`;
  }
  function renderTable() {
    const tbody = $("payments-tbody");
    if (!state.payments.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="ab-table-empty">No payments match your filters.</td></tr>';
    } else {
      tbody.innerHTML = "";
      state.payments.forEach(p => {
        const tr = document.createElement("tr");
        tr.dataset.id = p.paymentId;
        tr.innerHTML = rowHtml(p);
        tbody.appendChild(tr);
      });
    }
    $("row-count").textContent = `${state.total} payment${state.total === 1 ? "" : "s"} found`;
    renderPagination();
  }
  function renderPagination() {
    const el = $("pagination"); if (!el) return;
    el.innerHTML = "";
    const info = document.createElement("span");
    info.textContent = `Page ${state.page} of ${state.pages} — showing ${state.payments.length} of ${state.total}`;
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
      if (p === "…") {
        const e = document.createElement("button"); e.textContent = "…"; e.disabled = true; pages.appendChild(e);
      } else pages.appendChild(mkBtn(String(p), p, { active: p === state.page }));
    });
    pages.appendChild(mkBtn("›", state.page + 1, { disabled: state.page >= state.pages }));
    el.appendChild(pages);
  }
  async function loadList() {
    try {
      const f = state.filters;
      const params = new URLSearchParams({
        page: state.page, limit: state.limit,
        search: f.search, status: f.status, method: f.method,
        amountRange: f.amountRange, dateFrom: f.dateFrom, dateTo: f.dateTo,
      });
      for (const [k, v] of [...params.entries()]) if (v === "") params.delete(k);
      const data = await api("/api/admin/payments/list?" + params.toString());
      state.payments = data.payments || [];
      state.total = data.total || 0;
      state.pages = data.totalPages || data.pages || 1;
      renderTable();
    } catch (err) {
      $("payments-tbody").innerHTML = `<tr><td colspan="11" class="ab-table-empty">${escapeHtml(err.message || "Could not load payments.")}</td></tr>`;
    }
  }

  // ── Drawer ──
  let drawerPaymentId = null;
  async function openDrawer(paymentId) {
    drawerPaymentId = Number(paymentId);
    const drawer = $("payment-drawer");
    drawer.hidden = false;
    $("drawer-body").innerHTML = '<div class="ab-empty">Loading…</div>';
    $("drawer-status").textContent = "—";
    $("drawer-title").textContent = "Payment #" + paymentId;
    try {
      const data = await api("/api/admin/payments/" + paymentId);
      const p = data.payment;
      drawerPaymentId = p.paymentId;
      $("drawer-status").textContent = p.status.toUpperCase();
      $("drawer-status").className = "ab-status-badge " + p.status;
      $("drawer-title").textContent = p.paymentCode;
      $("drawer-body").innerHTML = `
        <div class="ab-detail-row"><span class="k">Payment ID</span><span class="v">${escapeHtml(p.paymentCode)}</span></div>
        <div class="ab-detail-row"><span class="k">Booking ID</span><span class="v">${escapeHtml(p.bookingCode)}</span></div>
        <div class="ab-detail-row"><span class="k">User</span><span class="v">${escapeHtml(p.studentName || "—")}${p.studentRole || p.userRole ? ` <span class="ab-role-pill ${((p.studentRole||p.userRole)||"").toLowerCase()}">${((p.studentRole||p.userRole)||"").replace(/^./, c => c.toUpperCase())}</span>` : ""}</span></div>
        <div class="ab-detail-row"><span class="k">Email</span><span class="v">${escapeHtml(p.studentEmail || "—")}</span></div>
        <div class="ab-detail-row"><span class="k">Phone</span><span class="v">${escapeHtml(p.studentPhone || "—")}</span></div>
        <div class="ab-detail-row"><span class="k">Bike</span><span class="v">${escapeHtml(p.bikeCode)}</span></div>
        <div class="ab-detail-row"><span class="k">Station</span><span class="v">${escapeHtml(p.station)}</span></div>
        <div class="ab-detail-row"><span class="k">Amount</span><span class="v">${fmtMoney(p.amount)} ${escapeHtml(p.currency || "")}</span></div>
        <div class="ab-detail-row"><span class="k">Booking total</span><span class="v">${fmtMoney(p.bookingAmount)}</span></div>
        <div class="ab-detail-row"><span class="k">Payment method</span><span class="v">${escapeHtml(methodLabel(p.paymentMethod))}</span></div>
        <div class="ab-detail-row"><span class="k">Status</span><span class="v"><span class="ab-badge ${p.status}">${p.status}</span></span></div>
        <div class="ab-detail-row"><span class="k">Transaction ref</span><span class="v" style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:12.5px;">${escapeHtml(p.transactionRef || "—")}</span></div>
        <div class="ab-detail-row"><span class="k">Payment date</span><span class="v">${fmtDt(p.paidAt || p.createdAt)}</span></div>
        <div class="ab-detail-row"><span class="k">Booking status</span><span class="v"><span class="ab-badge ${p.bookingStatus}">${p.bookingStatus}</span></span></div>
        <div class="ab-detail-row"><span class="k">Refund eligible</span><span class="v">${p.refundEligible ? "Yes" : "No"}</span></div>`;
      $("drawer-refund").disabled = !p.refundEligible;
      $("drawer-reject").disabled = p.status !== "pending";
      $("drawer-contact").onclick = () => { if (p.studentEmail) location.href = `mailto:${p.studentEmail}?subject=Payment ${p.paymentCode}`; };
      $("drawer-receipt").onclick = () => {
        const w = window.open("", "_blank"); if (!w) return;
        w.document.write(`
          <title>Receipt ${p.paymentCode}</title>
          <style>body{font-family:Inter,Arial;padding:32px;max-width:520px;color:#0F172A}h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;color:#64748B;margin:0 0 24px;font-weight:600}table{width:100%;border-collapse:collapse;font-size:14px}td{padding:8px 0;border-bottom:1px solid #E2E8F0}td:last-child{text-align:right;font-weight:700}</style>
          <h1>Payment Receipt — ${p.paymentCode}</h1><h2>Campus Bike Sharing</h2>
          <table>
            <tr><td>Booking</td><td>${p.bookingCode}</td></tr>
            <tr><td>User</td><td>${escapeHtml(p.studentName || "—")}${p.studentRole || p.userRole ? ` (${((p.studentRole||p.userRole)||"").replace(/^./, c => c.toUpperCase())})` : ""}</td></tr>
            <tr><td>Bike</td><td>${escapeHtml(p.bikeCode)}</td></tr>
            <tr><td>Station</td><td>${escapeHtml(p.station)}</td></tr>
            <tr><td>Method</td><td>${escapeHtml(methodLabel(p.paymentMethod))}</td></tr>
            <tr><td>Transaction Ref</td><td>${escapeHtml(p.transactionRef || "—")}</td></tr>
            <tr><td>Date</td><td>${fmtDt(p.paidAt || p.createdAt)}</td></tr>
            <tr><td>Status</td><td>${p.status}</td></tr>
            <tr><td><strong>Total</strong></td><td><strong>${fmtMoney(p.amount)}</strong></td></tr>
          </table>`);
        w.document.close();
      };
    } catch (err) { $("drawer-body").innerHTML = `<div class="ab-empty">${escapeHtml(err.message || "Could not load payment.")}</div>`; }
  }
  function closeDrawer() { $("payment-drawer").hidden = true; drawerPaymentId = null; }

  // ── Actions ──
  async function doRefund(paymentId) {
    const reason = prompt("Reason for refund? (Required, 6+ chars)");
    if (!reason || reason.trim().length < 6) { showToast("Refund cancelled — reason required.", "warn"); return; }
    try {
      await apiSend(`/api/admin/payments/${paymentId}/refund`, "POST", { reason: reason.trim() });
      showToast("Refund processed.");
      await refreshAll();
      if (drawerPaymentId === paymentId) openDrawer(paymentId);
    } catch (err) { showToast(err.message || "Refund failed.", "error"); }
  }
  async function doReview(paymentId) {
    try {
      await apiSend(`/api/admin/payments/${paymentId}/review`, "POST", {});
      showToast("Payment marked as reviewed.");
    } catch (err) { showToast(err.message || "Could not mark reviewed.", "error"); }
  }

  // ── CSV export ──
  async function exportCsv() {
    try {
      const f = state.filters;
      const params = new URLSearchParams({
        page: 1, limit: 500,
        search: f.search, status: f.status, method: f.method,
        amountRange: f.amountRange, dateFrom: f.dateFrom, dateTo: f.dateTo,
      });
      for (const [k, v] of [...params.entries()]) if (v === "") params.delete(k);
      const data = await api("/api/admin/payments/list?" + params.toString());
      const rows = data.payments || [];
      const header = ["Payment","Booking","Student","Bike","Station","Amount","Method","Status","Ref","Date"];
      const lines = [header.join(",")];
      rows.forEach(p => {
        lines.push([
          p.paymentCode, p.bookingCode,
          JSON.stringify(p.studentName || ""), p.bikeCode,
          JSON.stringify(p.station || ""),
          p.amount, p.paymentMethod, p.status,
          JSON.stringify(p.transactionRef || ""),
          p.paymentDate || "",
        ].join(","));
      });
      const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `payments_${state.range}_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast("CSV downloaded.");
    } catch (err) { showToast(err.message || "Export failed.", "error"); }
  }

  // ── Refresh / wiring ──
  async function refreshAll() {
    showError("");
    await Promise.all([
      loadOverview(), loadTrends(), loadBreakdown(),
      loadList(), loadActivity(), loadInsights(), loadRefundRequests(),
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
    $("f-method").addEventListener("change", (e) => { state.filters.method = e.target.value; apply(); });
    $("f-from").addEventListener("change",  (e) => { state.filters.dateFrom = e.target.value; apply(); });
    $("f-to").addEventListener("change",    (e) => { state.filters.dateTo = e.target.value; apply(); });
    $("f-amount").addEventListener("change",(e) => { state.filters.amountRange = e.target.value; apply(); });
    $("reset-filters").addEventListener("click", () => {
      state.filters = { search: "", status: "", method: "", amountRange: "", dateFrom: "", dateTo: "" };
      ["f-search","f-status","f-method","f-from","f-to","f-amount"].forEach(id => { const el = $(id); if (el) el.value = ""; });
      apply();
    });
  }
  function wireTableActions() {
    const tbody = $("payments-tbody");
    tbody.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-action]");
      if (btn) {
        ev.stopPropagation();
        const id = Number(btn.dataset.id);
        const action = btn.dataset.action;
        if (action === "view" || action === "receipt") openDrawer(id);
        if (action === "refund") doRefund(id);
        if (action === "review") doReview(id);
        return;
      }
      const tr = ev.target.closest("tr[data-id]");
      if (tr) openDrawer(Number(tr.dataset.id));
    });
  }
  function wireDrawer() {
    document.querySelectorAll("[data-close-drawer]").forEach(el => el.addEventListener("click", closeDrawer));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
    $("drawer-refund").addEventListener("click", () => drawerPaymentId && doRefund(drawerPaymentId));
    $("drawer-reject").addEventListener("click", () => showToast("Refund rejection logged.", "warn"));
    $("drawer-review").addEventListener("click", () => drawerPaymentId && doReview(drawerPaymentId));
  }
  function wireQuickActions() {
    $("qa-process-refund").addEventListener("click", () => {
      const f = $("f-status"); if (f) { f.value = "paid"; f.dispatchEvent(new Event("change")); }
      showToast("Filtered to paid payments — pick one to refund.");
    });
    $("qa-view-refunds").addEventListener("click", () => {
      const f = $("f-status"); if (f) { f.value = "refunded"; f.dispatchEvent(new Event("change")); }
    });
    $("qa-failed").addEventListener("click", () => {
      const f = $("f-status"); if (f) { f.value = "failed"; f.dispatchEvent(new Event("change")); }
    });
    $("qa-export").addEventListener("click", exportCsv);
  }
  function wireRefundRequests() {
    const el = $("refund-requests-list");
    if (!el) return;
    el.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-refund-action]");
      if (!btn) return;
      reviewRefundRequest(Number(btn.dataset.id), btn.dataset.refundAction);
    });
  }
  function wireTopButtons() {
    $("refresh-page").addEventListener("click", () => { showToast("Refreshing…"); refreshAll(); });
    $("export-report").addEventListener("click", exportCsv);
    $("export-payments").addEventListener("click", exportCsv);
  }

  function init() {
    wireRangeTabs();
    wireFilters();
    wireTableActions();
    wireDrawer();
    wireQuickActions();
    wireRefundRequests();
    wireTopButtons();
    refreshAll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
