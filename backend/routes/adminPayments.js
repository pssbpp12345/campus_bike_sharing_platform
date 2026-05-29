// ──────────────────────────────────────────────────────────────
// /api/admin/payments/* — endpoints powering Admin_payments.html.
// All endpoints require an admin JWT. SQL is parameterised throughout.
// Pulls real values from the payments + bookings + users tables;
// nothing is hard-coded.
// ──────────────────────────────────────────────────────────────
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const adminMetrics = require("../services/adminMetrics");
const { ensureRefundSchema } = require("../utils/refundRequests");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";

function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Admin login required." });
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== "admin") return res.status(403).json({ error: "Administrator access required." });
    req.user = payload;
    next();
  } catch (_) {
    res.status(401).json({ error: "Invalid or expired admin session." });
  }
}

// ── Range + helpers ──────────────────────────────────────────
function parseRange(rangeKey) {
  const key = ["today", "week", "month", "year"].includes(rangeKey) ? rangeKey : "month";
  const now = new Date();
  let start;
  if (key === "today")      { start = new Date(now); start.setHours(0, 0, 0, 0); }
  else if (key === "week")  { start = new Date(now); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0); }
  else if (key === "year")  { start = new Date(now.getFullYear(), 0, 1); }
  else                      { start = new Date(now.getFullYear(), now.getMonth(), 1); }
  const span = now.getTime() - start.getTime();
  const prevStart = new Date(start.getTime() - span);
  const prevEnd   = new Date(start);
  return { key, start, end: now, prevStart, prevEnd };
}
function pctTrend(current, previous) {
  const cur = Number(current || 0), prev = Number(previous || 0);
  if (prev === 0) return cur === 0 ? 0 : 100;
  return Number((((cur - prev) / Math.abs(prev)) * 100).toFixed(1));
}
function money(v) { return Number(Number(v || 0).toFixed(2)); }

// ── GET /api/admin/payments/overview ─────────────────────────
router.get("/overview", requireAdmin, async (req, res) => {
  try {
    {
      const range = adminMetrics.parseRange(req.query.range);
      const financial = await adminMetrics.financialOverview(range);
      const cur = financial.current;
      return res.json({
        range: range.key,
        totals: {
          totalRevenue: cur.totalRevenue,
          successfulPayments: cur.successfulPayments,
          pendingPayments: cur.pendingPayments,
          failedPayments: cur.failedPayments,
          refundsProcessed: cur.refundsProcessed,
          refundRequests: cur.refundedPayments,
          averagePayment: cur.averagePayment,
          netPaymentBalance: cur.netPaymentBalance,
        },
        trends: {
          totalRevenue: financial.trends.totalRevenue,
          successfulPayments: financial.trends.successfulPayments,
          pendingPayments: financial.trends.pendingPayments,
          failedPayments: financial.trends.failedPayments,
          refundsProcessed: financial.trends.refundsProcessed,
          refundRequests: financial.trends.refundRequests,
          averagePayment: financial.trends.averagePayment,
          netPaymentBalance: financial.trends.netPaymentBalance,
        },
      });
    }
    const r = parseRange(req.query.range);
    const result = await db.query(
      `
      WITH cur AS (
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE status='paid'      AND created_at BETWEEN $1 AND $2), 0)   AS revenue,
          COUNT(*)              FILTER (WHERE status='paid'      AND created_at BETWEEN $1 AND $2)       AS successful,
          COUNT(*)              FILTER (WHERE status='pending'   AND created_at BETWEEN $1 AND $2)       AS pending,
          COUNT(*)              FILTER (WHERE status='failed'    AND created_at BETWEEN $1 AND $2)       AS failed,
          COALESCE(SUM(amount)  FILTER (WHERE status='refunded' AND created_at BETWEEN $1 AND $2), 0)    AS refunded_amount,
          COUNT(*)              FILTER (WHERE status='refunded' AND created_at BETWEEN $1 AND $2)        AS refund_requests,
          COALESCE(AVG(amount)  FILTER (WHERE status='paid'      AND created_at BETWEEN $1 AND $2), 0)   AS avg_payment
        FROM payments
      ),
      prev AS (
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE status='paid'     AND created_at BETWEEN $3 AND $4), 0)    AS revenue,
          COUNT(*)              FILTER (WHERE status='paid'     AND created_at BETWEEN $3 AND $4)       AS successful,
          COUNT(*)              FILTER (WHERE status='pending'  AND created_at BETWEEN $3 AND $4)       AS pending,
          COUNT(*)              FILTER (WHERE status='failed'   AND created_at BETWEEN $3 AND $4)       AS failed,
          COALESCE(SUM(amount) FILTER (WHERE status='refunded' AND created_at BETWEEN $3 AND $4), 0)    AS refunded_amount,
          COUNT(*)              FILTER (WHERE status='refunded' AND created_at BETWEEN $3 AND $4)       AS refund_requests,
          COALESCE(AVG(amount) FILTER (WHERE status='paid'     AND created_at BETWEEN $3 AND $4), 0)    AS avg_payment
        FROM payments
      )
      SELECT
        (SELECT revenue          FROM cur)  AS revenue,
        (SELECT successful       FROM cur)  AS successful,
        (SELECT pending          FROM cur)  AS pending,
        (SELECT failed           FROM cur)  AS failed,
        (SELECT refunded_amount  FROM cur)  AS refunded_amount,
        (SELECT refund_requests  FROM cur)  AS refund_requests,
        (SELECT avg_payment      FROM cur)  AS avg_payment,
        (SELECT revenue          FROM prev) AS prev_revenue,
        (SELECT successful       FROM prev) AS prev_successful,
        (SELECT pending          FROM prev) AS prev_pending,
        (SELECT failed           FROM prev) AS prev_failed,
        (SELECT refunded_amount  FROM prev) AS prev_refunded_amount,
        (SELECT refund_requests  FROM prev) AS prev_refund_requests,
        (SELECT avg_payment      FROM prev) AS prev_avg_payment
      `,
      [r.start, r.end, r.prevStart, r.prevEnd]
    );
    const row = result.rows[0] || {};
    const revenue          = money(row.revenue);
    const refundedAmount   = money(row.refunded_amount);
    const netBalance       = money(revenue - refundedAmount);
    const prevRevenue      = money(row.prev_revenue);
    const prevRefunded     = money(row.prev_refunded_amount);
    const prevNetBalance   = money(prevRevenue - prevRefunded);
    let pendingRefundRequests = Number(row.refund_requests || 0);
    try {
      await ensureRefundSchema();
      const rr = await db.query("SELECT COUNT(*)::int AS count FROM refund_requests WHERE status = 'pending_review'");
      pendingRefundRequests = Number(rr.rows[0]?.count || pendingRefundRequests);
    } catch (_) {}

    res.json({
      range: r.key,
      totals: {
        totalRevenue:        revenue,
        successfulPayments:  Number(row.successful || 0),
        pendingPayments:     Number(row.pending || 0),
        failedPayments:      Number(row.failed || 0),
        refundsProcessed:    refundedAmount,
        refundRequests:      pendingRefundRequests,
        averagePayment:      money(row.avg_payment),
        netPaymentBalance:   netBalance,
      },
      trends: {
        totalRevenue:        pctTrend(revenue,                  prevRevenue),
        successfulPayments:  pctTrend(row.successful,           row.prev_successful),
        pendingPayments:     pctTrend(row.pending,              row.prev_pending),
        failedPayments:      pctTrend(row.failed,               row.prev_failed),
        refundsProcessed:    pctTrend(refundedAmount,           prevRefunded),
        refundRequests:      pctTrend(pendingRefundRequests,    row.prev_refund_requests),
        averagePayment:      pctTrend(row.avg_payment,          row.prev_avg_payment),
        netPaymentBalance:   pctTrend(netBalance,               prevNetBalance),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/payments/overview]", err);
    res.status(500).json({ error: "Could not load overview." });
  }
});

// ── GET /api/admin/payments/trends ───────────────────────────
// Time series of revenue (paid) vs refunds (refunded amount), bucketed.
router.get("/trends", requireAdmin, async (req, res) => {
  try {
    const r = parseRange(req.query.range);
    let bucket = "hour";
    if (r.key === "week")  bucket = "day";
    if (r.key === "month") bucket = "day";
    if (r.key === "year")  bucket = "month";

    const result = await db.query(
      `
      SELECT
        date_trunc($1, created_at) AS bucket,
        COALESCE(SUM(amount) FILTER (WHERE status='paid'),     0) AS revenue,
        COALESCE(SUM(amount) FILTER (WHERE status='refunded'), 0) AS refunds
      FROM payments
      WHERE created_at BETWEEN $2 AND $3
      GROUP BY bucket
      ORDER BY bucket ASC
      `,
      [bucket, r.start, r.end]
    );

    const labels = [], revenue = [], refunds = [];
    result.rows.forEach(row => {
      const d = new Date(row.bucket);
      if (r.key === "today") labels.push(d.toLocaleTimeString("en-AU", { hour: "2-digit" }));
      else if (r.key === "year") labels.push(d.toLocaleDateString("en-AU", { month: "short" }));
      else labels.push(d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }));
      revenue.push(money(row.revenue));
      refunds.push(money(row.refunds));
    });
    res.json({ range: r.key, bucket, labels, series: { revenue, refunds } });
  } catch (err) {
    console.error("[GET /api/admin/payments/trends]", err);
    res.status(500).json({ error: "Could not load trends." });
  }
});

// ── GET /api/admin/payments/breakdown ────────────────────────
router.get("/breakdown", requireAdmin, async (req, res) => {
  try {
    const r = parseRange(req.query.range);
    const result = await db.query(
      `
      SELECT status::text AS status, COUNT(*) AS count
      FROM payments
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY status
      `,
      [r.start, r.end]
    );
    const palette = {
      paid:     "#22C55E",
      pending:  "#F59E0B",
      failed:   "#EF4444",
      refunded: "#8B5CF6",
      waived:   "#3B82F6",
    };
    const labelOf = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const counts = { paid: 0, pending: 0, failed: 0, refunded: 0, waived: 0 };
    result.rows.forEach(r => { if (counts[r.status] != null) counts[r.status] = Number(r.count || 0); });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const pct = (n) => total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
    res.json({
      range: r.key,
      total,
      breakdown: Object.keys(counts).map(key => ({
        key, label: labelOf(key), count: counts[key], pct: pct(counts[key]), color: palette[key],
      })),
    });
  } catch (err) {
    console.error("[GET /api/admin/payments/breakdown]", err);
    res.status(500).json({ error: "Could not load breakdown." });
  }
});

// ── GET /api/admin/payments/activity ─────────────────────────
router.get("/activity", requireAdmin, async (req, res) => {
  try {
    const r = parseRange(req.query.range);
    const result = await db.query(
      `
      SELECT
        p.id AS payment_id,
        p.booking_id,
        u.full_name  AS student_name,
        u.role::text AS student_role,
        p.amount,
        p.status::text AS status,
        p.payment_method::text AS payment_method,
        COALESCE(p.paid_at, p.created_at) AS occurred_at
      FROM payments p
      JOIN users u ON u.id = p.user_id
      WHERE COALESCE(p.paid_at, p.created_at) BETWEEN $1 AND $2
      ORDER BY occurred_at DESC
      LIMIT 12
      `,
      [r.start, r.end]
    );
    res.json({
      range: r.key,
      activity: result.rows.map(row => ({
        paymentId:     row.payment_id,
        paymentCode:   "PM-" + String(row.payment_id).padStart(4, "0"),
        bookingId:     row.booking_id,
        bookingCode:   "BK-" + String(row.booking_id).padStart(4, "0"),
        studentName:   row.student_name,
        studentRole:   row.student_role || "student",
        userName:      row.student_name,
        userRole:      row.student_role || "student",
        amount:        money(row.amount),
        status:        row.status,
        paymentMethod: row.payment_method,
        occurredAt:    row.occurred_at,
      })),
    });
  } catch (err) {
    console.error("[GET /api/admin/payments/activity]", err);
    res.status(500).json({ error: "Could not load activity." });
  }
});

// ── GET /api/admin/payments/insights ─────────────────────────
router.get("/insights", requireAdmin, async (req, res) => {
  try {
    const r = parseRange(req.query.range);
    const [topStudent, topMethod, highValue] = await Promise.all([
      db.query(
        `SELECT u.full_name AS name, COALESCE(SUM(p.amount), 0) AS total
           FROM payments p JOIN users u ON u.id = p.user_id
          WHERE p.status = 'paid' AND p.created_at BETWEEN $1 AND $2
          GROUP BY u.id, u.full_name
          ORDER BY total DESC LIMIT 1`,
        [r.start, r.end]
      ),
      db.query(
        `SELECT payment_method::text AS method, COUNT(*) AS count
           FROM payments
          WHERE status='paid' AND created_at BETWEEN $1 AND $2
          GROUP BY payment_method
          ORDER BY count DESC LIMIT 1`,
        [r.start, r.end]
      ),
      db.query(
        `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
           FROM payments
          WHERE status='paid' AND amount >= 10
            AND created_at BETWEEN $1 AND $2`,
        [r.start, r.end]
      ),
    ]);
    const methodLabel = (m) => ({
      credit_card: "Credit Card",
      campus_card: "Campus Card",
      wallet:      "Wallet",
      waived:      "Waived",
    })[m] || m || "—";
    res.json({
      range: r.key,
      insights: {
        highValueTotal:   money(highValue.rows[0] && highValue.rows[0].total),
        highValueCount:   Number(highValue.rows[0] && highValue.rows[0].count || 0),
        topPayingStudent: (topStudent.rows[0] && topStudent.rows[0].name) || "—",
        topPayingTotal:   money(topStudent.rows[0] && topStudent.rows[0].total),
        topMethodKey:     (topMethod.rows[0] && topMethod.rows[0].method) || null,
        topMethod:        methodLabel(topMethod.rows[0] && topMethod.rows[0].method),
        topMethodCount:   Number(topMethod.rows[0] && topMethod.rows[0].count || 0),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/payments/insights]", err);
    res.status(500).json({ error: "Could not load insights." });
  }
});

// ── GET /api/admin/payments/list ─────────────────────────────
router.get("/list", requireAdmin, async (req, res) => {
  try {
    const q = (req.query.search || "").toString().trim().toLowerCase();
    const status   = (req.query.status || "").toString();
    const method   = (req.query.method || "").toString();
    const amountRange = (req.query.amountRange || "").toString();
    const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : null;
    const dateTo   = req.query.dateTo   ? new Date(req.query.dateTo)   : null;
    const limit  = Math.min(100, Math.max(5, Number(req.query.limit) || 10));
    const page   = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    const add = (clauseFn, val) => {
      params.push(val);
      where.push(clauseFn("$" + params.length));
    };

    if (q) {
      params.push(`%${q}%`);
      const p = "$" + params.length;
      where.push(`(LOWER(u.full_name) LIKE ${p}
                 OR LOWER(bi.bike_code) LIKE ${p}
                 OR LOWER(sp.station_name) LIKE ${p}
                 OR CAST(p.id AS TEXT) LIKE ${p}
                 OR CAST(p.booking_id AS TEXT) LIKE ${p}
                 OR LOWER(COALESCE(p.transaction_reference,'')) LIKE ${p})`);
    }
    if (["paid","pending","refunded","failed","waived"].includes(status)) {
      add((p) => `p.status = ${p}::payment_status`, status);
    }
    if (["credit_card","campus_card","wallet","waived"].includes(method)) {
      add((p) => `p.payment_method = ${p}::payment_method`, method);
    }
    if (dateFrom && !Number.isNaN(dateFrom.getTime())) add((p) => `p.created_at >= ${p}`, dateFrom);
    if (dateTo   && !Number.isNaN(dateTo.getTime()))   add((p) => `p.created_at <= ${p}`, dateTo);

    if (amountRange) {
      const ranges = {
        "lt5":     { min: 0, max: 5 },
        "5to20":   { min: 5, max: 20 },
        "20to50":  { min: 20, max: 50 },
        "gt50":    { min: 50, max: 999999 },
      };
      if (ranges[amountRange]) {
        const r = ranges[amountRange];
        add((p) => `p.amount >= ${p}`, r.min);
        add((p) => `p.amount <  ${p}`, r.max);
      }
    }

    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const baseSql = `
      FROM payments p
      JOIN users u    ON u.id  = p.user_id
      JOIN bookings bk ON bk.id = p.booking_id
      JOIN bikes bi   ON bi.id = bk.bike_id
      JOIN stations sp ON sp.id = bk.pickup_station_id
      ${whereSql}
    `;

    const countResult = await db.query(`SELECT COUNT(*) AS count ${baseSql}`, params);
    const total = Number(countResult.rows[0].count || 0);

    params.push(limit);  const limitParam  = "$" + params.length;
    params.push(offset); const offsetParam = "$" + params.length;

    const rowsResult = await db.query(
      `
      SELECT
        p.id           AS payment_id,
        p.booking_id,
        u.full_name    AS student_name,
        u.role::text   AS student_role,
        bi.bike_code,
        sp.station_name AS station,
        p.amount,
        p.payment_method::text AS payment_method,
        p.status::text AS status,
        p.transaction_reference,
        COALESCE(p.paid_at, p.created_at) AS payment_date,
        bk.status::text AS booking_status
      ${baseSql}
      ORDER BY payment_date DESC, p.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
      `,
      params
    );

    res.json({
      page, limit, total,
      pages: Math.max(1, Math.ceil(total / limit)),
      totalPages: Math.max(1, Math.ceil(total / limit)),
      payments: rowsResult.rows.map(r => ({
        paymentId:        r.payment_id,
        paymentCode:      "PM-" + String(r.payment_id).padStart(4, "0"),
        bookingId:        r.booking_id,
        bookingCode:      "BK-" + String(r.booking_id).padStart(4, "0"),
        studentName:      r.student_name,
        studentRole:      r.student_role || "student",
        userName:         r.student_name,
        userRole:         r.student_role || "student",
        bikeCode:         r.bike_code,
        station:          r.station,
        amount:           money(r.amount),
        paymentMethod:    r.payment_method,
        status:           r.status,
        transactionRef:   r.transaction_reference,
        paymentDate:      r.payment_date,
        bookingStatus:    r.booking_status,
      })),
    });
  } catch (err) {
    console.error("[GET /api/admin/payments/list]", err);
    res.status(500).json({ error: "Could not load payments." });
  }
});

// ── GET /api/admin/payments/:id ──────────────────────────────
router.get("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid payment id." });
    const result = await db.query(
      `
      SELECT
        p.id           AS payment_id,
        p.booking_id,
        u.full_name    AS student_name,
        u.email        AS student_email,
        u.phone        AS student_phone,
        u.role::text   AS student_role,
        bi.bike_code,
        sp.station_name AS station,
        bk.status::text AS booking_status,
        bk.start_time  AS booking_start,
        bk.end_time    AS booking_end,
        bk.fee_amount  AS booking_amount,
        p.amount,
        p.currency,
        p.payment_method::text AS payment_method,
        p.status::text AS status,
        p.transaction_reference,
        p.paid_at,
        p.created_at
      FROM payments p
      JOIN users u    ON u.id  = p.user_id
      JOIN bookings bk ON bk.id = p.booking_id
      JOIN bikes bi   ON bi.id = bk.bike_id
      JOIN stations sp ON sp.id = bk.pickup_station_id
      WHERE p.id = $1
      `,
      [id]
    );
    const r = result.rows[0];
    if (!r) return res.status(404).json({ error: "Payment not found." });

    const refundEligible = r.status === "paid" && ["completed","cancelled"].includes(r.booking_status);

    res.json({
      payment: {
        paymentId:      r.payment_id,
        paymentCode:    "PM-" + String(r.payment_id).padStart(4, "0"),
        bookingId:      r.booking_id,
        bookingCode:    "BK-" + String(r.booking_id).padStart(4, "0"),
        studentName:    r.student_name,
        studentEmail:   r.student_email,
        studentPhone:   r.student_phone,
        studentRole:    r.student_role || "student",
        userName:       r.student_name,
        userEmail:      r.student_email,
        userPhone:      r.student_phone,
        userRole:       r.student_role || "student",
        bikeCode:       r.bike_code,
        station:        r.station,
        bookingStatus:  r.booking_status,
        bookingStart:   r.booking_start,
        bookingEnd:     r.booking_end,
        bookingAmount:  money(r.booking_amount),
        amount:         money(r.amount),
        currency:       r.currency,
        paymentMethod:  r.payment_method,
        status:         r.status,
        transactionRef: r.transaction_reference,
        paidAt:         r.paid_at,
        createdAt:      r.created_at,
        refundEligible,
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/payments/:id]", err);
    res.status(500).json({ error: "Could not load payment." });
  }
});

// ── POST /api/admin/payments/:id/refund ──────────────────────
router.post("/:id/refund", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid payment id." });
  const reason = String((req.body && req.body.reason) || "Refund approved by admin").trim().slice(0, 250);
  if (reason.length < 6) return res.status(400).json({ error: "Refund reason is required (6+ characters)." });

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT id, booking_id, amount, status FROM payments WHERE id = $1 FOR UPDATE",
      [id]
    );
    const p = cur.rows[0];
    if (!p) throw new Error("Payment not found.");
    if (p.status === "refunded") throw new Error("This payment has already been refunded.");
    if (p.status !== "paid") throw new Error("Only paid payments can be refunded.");

    await client.query("UPDATE payments SET status = 'refunded', updated_at = NOW() WHERE id = $1", [id]);
    // Mirror the refund as an admin expense + activity entry. Safe even if those
    // tables haven't been migrated yet (catch + continue).
    try {
      await client.query(
        `INSERT INTO admin_expenses (expense_type, description, amount, related_booking_id, created_at)
         VALUES ('refund', $1, $2, $3, NOW())`,
        [`Refund: ${reason}`, p.amount, p.booking_id]
      );
    } catch (_) { /* admin_expenses may not exist */ }
    try {
      await client.query(
        `INSERT INTO admin_activity_log (activity_type, title, description, related_booking_id)
         VALUES ('refund_requested', $2, $3, $1)`,
        [p.booking_id, "Refund approved", `Payment #${id} refunded by admin: ${reason}`]
      );
    } catch (_) { /* admin_activity_log may not exist */ }
    await client.query("COMMIT");
    res.json({ ok: true, refunded: money(p.amount), paymentId: id, bookingId: p.booking_id });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ error: err.message || "Could not process refund." });
  } finally {
    client.release();
  }
});

// ── POST /api/admin/payments/:id/review ──────────────────────
// Light-touch: just appends a note to transaction_reference so the admin
// has a way to flag "I looked at this". Does not change the payment status.
router.post("/:id/review", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid payment id." });
  try {
    await db.query("UPDATE payments SET updated_at = NOW() WHERE id = $1", [id]);
    res.json({ ok: true, paymentId: id });
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not mark as reviewed." });
  }
});

module.exports = router;
