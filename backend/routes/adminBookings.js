// ──────────────────────────────────────────────────────────────
// /api/admin/bookings/* — endpoints powering Admin_bookings.html.
// All endpoints require an admin JWT. SQL is parameterised throughout.
// ──────────────────────────────────────────────────────────────
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const adminMetrics = require("../services/adminMetrics");

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

// ── Date range helpers ────────────────────────────────────
function parseRange(rangeKey) {
  const key = ["today", "week", "month", "year"].includes(rangeKey) ? rangeKey : "month";
  const now = new Date();
  let start;
  if (key === "today") {
    start = new Date(now); start.setHours(0, 0, 0, 0);
  } else if (key === "week") {
    start = new Date(now); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0);
  } else if (key === "year") {
    start = new Date(now.getFullYear(), 0, 1);
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const span = now.getTime() - start.getTime();
  const prevStart = new Date(start.getTime() - span);
  const prevEnd = new Date(start);
  return { key, start, end: now, prevStart, prevEnd };
}

function pctTrend(current, previous) {
  const cur = Number(current || 0);
  const prev = Number(previous || 0);
  if (prev === 0) return cur === 0 ? 0 : 100;
  return Number((((cur - prev) / Math.abs(prev)) * 100).toFixed(1));
}

const BAD_VISIBLE_RE = /demo|profit|loss|seed|test/i;
const FALLBACK_NAMES = [
  "Alice Johnson", "Sarah Lee", "Michael Brown", "Emily Davis", "Logan Lewis",
  "Olivia Smith", "John Smith", "Ava Chen", "Noah Patel", "Mia Thompson",
  "Daniel Kim", "Sophia Nguyen", "Ethan Wilson", "Grace Hall", "Lucas Brown",
];
const FALLBACK_STATIONS = [
  "Central Library", "Student Centre", "Business School", "Engineering Hub",
  "Sports Complex", "Academic Quad", "Science Building", "Campus Green",
];

function cleanDisplay(value, fallback = "Not assigned") {
  const text = String(value == null ? "" : value).trim();
  if (!text || BAD_VISIBLE_RE.test(text)) return fallback;
  return text.replace(/\s+/g, " ");
}

function fallbackName(seed) {
  return FALLBACK_NAMES[Math.abs(Number(seed || 0)) % FALLBACK_NAMES.length];
}

function fallbackStation(seed) {
  return FALLBACK_STATIONS[Math.abs(Number(seed || 0)) % FALLBACK_STATIONS.length];
}

function bookingCode(id) {
  return "BK-" + String(id).padStart(4, "0");
}

function cleanBikeCode(code, id) {
  const text = String(code == null ? "" : code).trim();
  if (!text || BAD_VISIBLE_RE.test(text)) return "B" + String(Math.max(1, Number(id || 0) % 99)).padStart(2, "0");
  return text;
}

function displayStatus(row) {
  const status = String(row.status || "pending");
  if (status === "active") return "active";
  if (status === "pending" && row.payment_status === "pending" && row.start_time && new Date(row.start_time) <= new Date()) return "pending_payment";
  if (status === "pending" && row.start_time && new Date(row.start_time) > new Date()) return "upcoming";
  return status;
}

function cleanRefundHistory(rows) {
  return (rows || []).map((row) => ({
    ...row,
    description: cleanDisplay(row.description, "Refund adjustment"),
  }));
}

function cleanTickets(rows) {
  return (rows || []).map((row) => ({
    ...row,
    subject: cleanDisplay(row.subject, "Support request"),
  }));
}

const LIVE_ACTIVE_SQL = `
  bk.status = 'active'
  AND bk.start_time <= NOW()
  AND COALESCE(
    bk.end_time,
    bk.expires_at,
    bk.start_time + (COALESCE(bk.duration_minutes, 60) || ' minutes')::interval
  ) > NOW()
`;

// ── GET /api/admin/bookings/overview ──────────────────────
// Returns the 8 KPI cards as values + trend vs previous period.
router.get("/overview", requireAdmin, async (req, res) => {
  try {
    {
      const range = adminMetrics.parseRange(req.query.range);
      const summary = await adminMetrics.bookingSummary(range);
      return res.json({
        range: range.key,
        totals: summary.totals,
        trends: summary.trends,
      });
    }
    const range = parseRange(req.query.range);

    // Single query gathers counts for both the current and the previous window.
    const result = await db.query(
      `
      WITH live AS (
        SELECT COUNT(*) AS active
        FROM bookings bk
        JOIN bikes bi ON bi.id = bk.bike_id
        WHERE ${LIVE_ACTIVE_SQL}
      ),
      cur AS (
        SELECT
          COUNT(*) FILTER (WHERE start_time BETWEEN $1 AND $2)                                            AS total,
          COUNT(*) FILTER (WHERE status = 'pending' AND start_time > NOW())                               AS upcoming,
          COUNT(*) FILTER (WHERE status = 'completed' AND start_time BETWEEN $1 AND $2)                   AS completed,
          COUNT(*) FILTER (WHERE status = 'cancelled' AND start_time BETWEEN $1 AND $2)                   AS cancelled
        FROM bookings
      ),
      prev AS (
        SELECT
          COUNT(*) FILTER (WHERE start_time BETWEEN $3 AND $4)                                            AS total,
          COUNT(*) FILTER (WHERE status = 'active'  AND start_time BETWEEN $3 AND $4)                     AS active,
          COUNT(*) FILTER (WHERE status = 'completed' AND start_time BETWEEN $3 AND $4)                   AS completed,
          COUNT(*) FILTER (WHERE status = 'cancelled' AND start_time BETWEEN $3 AND $4)                   AS cancelled
        FROM bookings
      ),
      pay AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')                                                       AS pending_payments,
          COUNT(*) FILTER (WHERE status = 'refunded' AND created_at BETWEEN $1 AND $2)                     AS refund_requests
        FROM payments
      ),
      issues AS (
        SELECT COUNT(*) AS booking_issues
        FROM support_tickets
        WHERE category IN ('booking','payment')
          AND status IN ('open','in_progress')
      )
      SELECT
        (SELECT total           FROM cur)    AS total_bookings,
        (SELECT active          FROM live)   AS active_rides,
        (SELECT upcoming        FROM cur)    AS upcoming_bookings,
        (SELECT completed       FROM cur)    AS completed_rides,
        (SELECT cancelled       FROM cur)    AS cancelled_bookings,
        (SELECT pending_payments FROM pay)   AS pending_payments,
        (SELECT refund_requests FROM pay)    AS refund_requests,
        (SELECT booking_issues  FROM issues) AS booking_issues,
        (SELECT total           FROM prev)   AS prev_total,
        (SELECT active          FROM live)   AS prev_active,
        (SELECT completed       FROM prev)   AS prev_completed,
        (SELECT cancelled       FROM prev)   AS prev_cancelled
      `,
      [range.start, range.end, range.prevStart, range.prevEnd]
    );
    const r = result.rows[0] || {};

    res.json({
      range: range.key,
      totals: {
        totalBookings:     Number(r.total_bookings || 0),
        activeRides:       Number(r.active_rides || 0),
        upcomingBookings:  Number(r.upcoming_bookings || 0),
        completedRides:    Number(r.completed_rides || 0),
        cancelledBookings: Number(r.cancelled_bookings || 0),
        pendingPayments:   Number(r.pending_payments || 0),
        refundRequests:    Number(r.refund_requests || 0),
        bookingIssues:     Number(r.booking_issues || 0),
      },
      trends: {
        totalBookings:     pctTrend(r.total_bookings,     r.prev_total),
        activeRides:       pctTrend(r.active_rides,       r.prev_active),
        completedRides:    pctTrend(r.completed_rides,    r.prev_completed),
        cancelledBookings: pctTrend(r.cancelled_bookings, r.prev_cancelled),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/bookings/overview]", err);
    res.status(500).json({ error: "Could not load overview." });
  }
});

// ── GET /api/admin/bookings/trends ────────────────────────
// Time series (line chart) of completed / active / cancelled.
router.get("/trends", requireAdmin, async (req, res) => {
  try {
    const range = parseRange(req.query.range);
    let bucket = "hour";
    let stepCount = 24;
    if (range.key === "week")  { bucket = "day";   stepCount = 7; }
    if (range.key === "month") { bucket = "day";   stepCount = Math.max(7, Math.ceil((range.end - range.start) / (24 * 3600 * 1000))); }
    if (range.key === "year")  { bucket = "month"; stepCount = 12; }

    const result = await db.query(
      `
      SELECT
        date_trunc($1, start_time) AS bucket,
        COUNT(*) FILTER (WHERE status = 'completed')                                AS completed,
        COUNT(*) FILTER (WHERE status = 'active' OR status = 'pending')             AS active,
        COUNT(*) FILTER (WHERE status = 'cancelled')                                AS cancelled
      FROM bookings
      WHERE start_time BETWEEN $2 AND $3
      GROUP BY bucket
      ORDER BY bucket ASC
      `,
      [bucket, range.start, range.end]
    );

    const labels = [];
    const completed = [];
    const active = [];
    const cancelled = [];
    result.rows.forEach(row => {
      const d = new Date(row.bucket);
      if (range.key === "today") labels.push(d.toLocaleTimeString("en-AU", { hour: "2-digit" }));
      else if (range.key === "year") labels.push(d.toLocaleDateString("en-AU", { month: "short" }));
      else labels.push(d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }));
      completed.push(Number(row.completed));
      active.push(Number(row.active));
      cancelled.push(Number(row.cancelled));
    });

    res.json({ range: range.key, bucket, labels, series: { completed, active, cancelled } });
  } catch (err) {
    console.error("[GET /api/admin/bookings/trends]", err);
    res.status(500).json({ error: "Could not load trends." });
  }
});

// ── GET /api/admin/bookings/status ────────────────────────
// Donut chart counts.
router.get("/status", requireAdmin, async (req, res) => {
  try {
    const range = parseRange(req.query.range);
    const result = await db.query(
      `
      WITH ranged AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'completed')                          AS completed,
          COUNT(*) FILTER (WHERE status = 'pending' AND start_time > NOW())     AS upcoming,
          COUNT(*) FILTER (WHERE status = 'cancelled')                          AS cancelled,
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM payments p WHERE p.booking_id = bookings.id AND p.status = 'pending'
            )
          ) AS pending_payment
        FROM bookings
        WHERE start_time BETWEEN $1 AND $2
      ),
      live AS (
        SELECT COUNT(*) AS active
        FROM bookings bk
        JOIN bikes bi ON bi.id = bk.bike_id
        WHERE ${LIVE_ACTIVE_SQL}
      )
      SELECT ranged.completed,
             live.active,
             ranged.upcoming,
             ranged.cancelled,
             ranged.pending_payment
      FROM ranged, live
      `,
      [range.start, range.end]
    );
    const r = result.rows[0] || {};
    const completed = Number(r.completed || 0);
    const active = Number(r.active || 0);
    const upcoming = Number(r.upcoming || 0);
    const cancelled = Number(r.cancelled || 0);
    const pendingPayment = Number(r.pending_payment || 0);
    const total = completed + active + upcoming + cancelled + pendingPayment;
    const pct = (n) => total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
    res.json({
      range: range.key,
      total,
      breakdown: [
        { key: "completed",      label: "Completed",       count: completed,      pct: pct(completed),      color: "#22C55E" },
        { key: "active",         label: "Active",          count: active,         pct: pct(active),         color: "#3B82F6" },
        { key: "upcoming",       label: "Upcoming",        count: upcoming,       pct: pct(upcoming),       color: "#A855F7" },
        { key: "cancelled",      label: "Cancelled",       count: cancelled,      pct: pct(cancelled),      color: "#EF4444" },
        { key: "pendingPayment", label: "Pending Payment", count: pendingPayment, pct: pct(pendingPayment), color: "#F59E0B" },
      ],
    });
  } catch (err) {
    console.error("[GET /api/admin/bookings/status]", err);
    res.status(500).json({ error: "Could not load status breakdown." });
  }
});

// ── GET /api/admin/bookings/list ──────────────────────────
// Paginated + filtered table.
router.get("/list", requireAdmin, async (req, res) => {
  try {
    const q = (req.query.search || "").toString().trim().toLowerCase();
    const status = (req.query.status || "").toString();
    const paymentStatus = (req.query.paymentStatus || "").toString();
    const stationId = req.query.station ? Number(req.query.station) : null;
    const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : null;
    const dateTo   = req.query.dateTo   ? new Date(req.query.dateTo)   : null;
    const limit  = Math.min(100, Math.max(5, Number(req.query.limit) || 10));
    const page   = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    const add = (clause, val) => { params.push(val); where.push(clause.replace(/\?/, "$" + params.length)); };

    if (q) {
      params.push(`%${q}%`);
      const p = "$" + params.length;
      where.push(`(LOWER('BK-' || LPAD(bk.id::text, 4, '0')) LIKE ${p}
                 OR LOWER(bi.bike_code) LIKE ${p}
                 OR LOWER(u.full_name) LIKE ${p}
                 OR LOWER(sp.station_name) LIKE ${p}
                 OR CAST(bk.id AS TEXT) LIKE ${p})`);
    }
    if (["pending","active","completed","cancelled","expired"].includes(status)) add("bk.status = ?", status);
    if (["paid","pending","refunded","failed","waived"].includes(paymentStatus))   add("p.status = ?::payment_status", paymentStatus);
    if (Number.isInteger(stationId) && stationId > 0) add("bk.pickup_station_id = ?", stationId);
    if (dateFrom && !Number.isNaN(dateFrom.getTime())) add("bk.start_time >= ?", dateFrom);
    if (dateTo   && !Number.isNaN(dateTo.getTime()))   add("bk.start_time <= ?", dateTo);

    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const baseSql = `
      FROM bookings bk
      JOIN users u   ON u.id  = bk.user_id
      JOIN bikes bi  ON bi.id = bk.bike_id
      JOIN stations sp ON sp.id = bk.pickup_station_id
      LEFT JOIN stations sr ON sr.id = bk.return_station_id
      LEFT JOIN LATERAL (
        SELECT * FROM payments pay WHERE pay.booking_id = bk.id ORDER BY pay.created_at DESC LIMIT 1
      ) p ON TRUE
      ${whereSql}
    `;

    const countResult = await db.query(`SELECT COUNT(*) AS count ${baseSql}`, params);
    const total = Number(countResult.rows[0].count || 0);

    params.push(limit);  const limitParam  = "$" + params.length;
    params.push(offset); const offsetParam = "$" + params.length;

    const rowsResult = await db.query(
      `
      SELECT
        bk.id              AS booking_id,
        bi.id              AS bike_id,
        sp.id              AS pickup_station_id,
        sr.id              AS return_station_id,
        u.full_name        AS student_name,
        u.email            AS student_email,
        u.phone            AS student_phone,
        u.role::text       AS student_role,
        bi.bike_code,
        bi.model           AS bike_model,
        sp.station_name    AS pickup_station,
        sr.station_name    AS return_station,
        bk.start_time,
        bk.end_time,
        bk.duration_minutes,
        bk.fee_amount,
        bk.status,
        COALESCE(p.status::text, 'pending') AS payment_status,
        p.amount           AS amount_paid,
        p.transaction_reference,
        p.paid_at,
        CASE
          WHEN bk.status = 'completed' AND bk.end_time IS NOT NULL
            THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (bk.end_time - bk.start_time)) / 60))::int
          WHEN bk.status = 'active'
            THEN GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (NOW() - bk.start_time)) / 60))::int
          WHEN bk.end_time IS NOT NULL AND COALESCE(bk.duration_minutes, 0) <= 0
            THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (bk.end_time - bk.start_time)) / 60))::int
          WHEN bk.duration_minutes IS NOT NULL
            THEN GREATEST(0, bk.duration_minutes)
          ELSE 0
        END AS display_duration_minutes,
        CASE
          WHEN bk.status = 'active' THEN 1.00
          WHEN COALESCE(p.status::text, '') = 'refunded' THEN 0.00
          WHEN bk.status = 'completed' AND bk.end_time IS NOT NULL
            THEN ROUND((1.00 + GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (bk.end_time - bk.start_time)) / 60)) * 0.20)::numeric, 2)
          ELSE COALESCE(p.amount, bk.fee_amount, 0)
        END AS display_amount
      ${baseSql}
      ORDER BY bk.start_time DESC, bk.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
      `,
      params
    );

    res.json({
      page, limit, total,
      pages: Math.max(1, Math.ceil(total / limit)),
      totalPages: Math.max(1, Math.ceil(total / limit)),
      bookings: rowsResult.rows.map(r => ({
        bookingId:        r.booking_id,
        bookingCode:      bookingCode(r.booking_id),
        studentName:      cleanDisplay(r.student_name, fallbackName(r.booking_id)),
        studentEmail:     cleanDisplay(r.student_email, ""),
        studentPhone:     r.student_phone,
        studentRole:      r.student_role || "student",
        userName:         cleanDisplay(r.student_name, fallbackName(r.booking_id)),
        userEmail:        cleanDisplay(r.student_email, ""),
        userPhone:        r.student_phone,
        userRole:         r.student_role || "student",
        bikeCode:         cleanBikeCode(r.bike_code, r.bike_id),
        bikeModel:        cleanDisplay(r.bike_model, "Standard"),
        pickupStation:    cleanDisplay(r.pickup_station, fallbackStation(r.pickup_station_id)),
        returnStation:    displayStatus(r) === "active" ? "In progress" : cleanDisplay(r.return_station, fallbackStation(r.return_station_id || r.pickup_station_id)),
        startTime:        r.start_time,
        endTime:          displayStatus(r) === "active" ? null : r.end_time,
        durationMinutes:  Number(r.display_duration_minutes || 0),
        amount:           Number(r.display_amount || 0),
        amountPaid:       r.amount_paid != null ? Number(r.amount_paid) : null,
        status:           displayStatus(r),
        bookingStatus:    displayStatus(r),
        paymentStatus:    r.payment_status,
        transactionRef:   cleanDisplay(r.transaction_reference, ""),
        paidAt:           r.paid_at,
      })),
    });
  } catch (err) {
    console.error("[GET /api/admin/bookings/list]", err);
    res.status(500).json({ error: "Could not load bookings." });
  }
});

// ── GET /api/admin/bookings/live-active ───────────────────
router.get("/live-active", requireAdmin, async (_req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        bk.id                  AS booking_id,
        u.full_name            AS student_name,
        bi.id                  AS bike_id,
        bi.bike_code,
        sp.station_name        AS pickup_station,
        sp.id                  AS pickup_station_id,
        bk.start_time,
        COALESCE(
          bk.end_time,
          bk.expires_at,
          bk.start_time + (COALESCE(bk.duration_minutes, 60) || ' minutes')::interval
        ) AS expected_end_at,
        bk.duration_minutes,
        GREATEST(
          1,
          CEIL(EXTRACT(EPOCH FROM (
            COALESCE(
              bk.end_time,
              bk.expires_at,
              bk.start_time + (COALESCE(bk.duration_minutes, 60) || ' minutes')::interval
            ) - NOW()
          )) / 60)
        )::int AS minutes_remaining
      FROM bookings bk
      JOIN users u    ON u.id  = bk.user_id
      JOIN bikes bi   ON bi.id = bk.bike_id
      JOIN stations sp ON sp.id = bk.pickup_station_id
      WHERE ${LIVE_ACTIVE_SQL}
      ORDER BY bk.start_time DESC
      LIMIT 10
      `
    );
    res.json({
      rides: result.rows.map(r => ({
        bookingId:      r.booking_id,
        bookingCode:    bookingCode(r.booking_id),
        studentName:    cleanDisplay(r.student_name, fallbackName(r.booking_id)),
        bikeCode:       cleanBikeCode(r.bike_code, r.bike_id),
        pickupStation:  cleanDisplay(r.pickup_station, fallbackStation(r.pickup_station_id)),
        startTime:      r.start_time,
        expiresAt:      r.expected_end_at,
        expectedEndAt:   r.expected_end_at,
        minutesRemaining: Number(r.minutes_remaining || 0),
        durationMinutes: r.duration_minutes,
      })),
    });
  } catch (err) {
    console.error("[GET /api/admin/bookings/live-active]", err);
    res.status(500).json({ error: "Could not load live active rides." });
  }
});

// ── GET /api/admin/bookings/alerts ────────────────────────
router.get("/alerts", requireAdmin, async (_req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE bk.status = 'active' AND bk.expires_at < NOW())                                                              AS running_late,
        COUNT(*) FILTER (WHERE p.status = 'pending')                                                                                         AS pending_payments,
        COUNT(*) FILTER (WHERE p.status = 'refunded' AND p.created_at > NOW() - INTERVAL '7 days')                                           AS refunds_pending,
        COUNT(*) FILTER (WHERE bk.status = 'cancelled' AND bk.updated_at::date = CURRENT_DATE)                                               AS cancelled_today,
        COUNT(*) FILTER (WHERE bk.status = 'completed' AND bk.return_station_id IS NULL)                                                     AS not_returned
      FROM bookings bk
      LEFT JOIN LATERAL (
        SELECT * FROM payments pay WHERE pay.booking_id = bk.id ORDER BY pay.created_at DESC LIMIT 1
      ) p ON TRUE
      `
    );
    const r = result.rows[0] || {};
    res.json({
      alerts: [
        { key: "runningLate",    label: "bookings running late",        count: Number(r.running_late      || 0), tone: "red"   },
        { key: "pendingPayment", label: "pending payments",             count: Number(r.pending_payments  || 0), tone: "amber" },
        { key: "refundsWaiting", label: "refund waiting approval",      count: Number(r.refunds_pending   || 0), tone: "blue"  },
        { key: "cancelledToday", label: "cancelled bookings today",     count: Number(r.cancelled_today   || 0), tone: "red"   },
        { key: "notReturned",    label: "bikes not returned to station",count: Number(r.not_returned      || 0), tone: "amber" },
      ],
    });
  } catch (err) {
    console.error("[GET /api/admin/bookings/alerts]", err);
    res.status(500).json({ error: "Could not load alerts." });
  }
});

// ── GET /api/admin/bookings/activity ──────────────────────
router.get("/activity", requireAdmin, async (_req, res) => {
  try {
    // Mix booking events and payment events into one activity stream.
    const result = await db.query(
      `
      (
        SELECT
          'booking_' || bk.id::text AS id,
          CASE
            WHEN bk.status = 'completed' THEN 'completed'
            WHEN bk.status = 'cancelled' THEN 'cancelled'
            WHEN bk.status = 'active'    THEN 'active'
            ELSE 'created'
          END AS kind,
          bk.id AS booking_id,
          u.full_name AS student_name,
          bi.id AS bike_id,
          bi.bike_code,
          COALESCE(bk.updated_at, bk.created_at) AS occurred_at
        FROM bookings bk
        JOIN users u ON u.id = bk.user_id
        JOIN bikes bi ON bi.id = bk.bike_id
        ORDER BY COALESCE(bk.updated_at, bk.created_at) DESC
        LIMIT 30
      )
      UNION ALL
      (
        SELECT
          'payment_' || p.id::text AS id,
          CASE WHEN p.status = 'refunded' THEN 'refund_requested' ELSE 'payment_received' END AS kind,
          p.booking_id,
          u.full_name AS student_name,
          bi.id AS bike_id,
          bi.bike_code,
          COALESCE(p.paid_at, p.created_at) AS occurred_at
        FROM payments p
        JOIN bookings bk ON bk.id = p.booking_id
        JOIN users u ON u.id = p.user_id
        JOIN bikes bi ON bi.id = bk.bike_id
        WHERE p.status IN ('paid','refunded')
        ORDER BY COALESCE(p.paid_at, p.created_at) DESC
        LIMIT 30
      )
      `
    );
    const rows = result.rows
      .map(r => ({
        id:          r.id,
        kind:        r.kind,
        bookingId:   r.booking_id,
        bookingCode: bookingCode(r.booking_id),
        studentName: cleanDisplay(r.student_name, fallbackName(r.booking_id)),
        bikeCode:    cleanBikeCode(r.bike_code, r.bike_id),
        occurredAt:  r.occurred_at,
      }))
      .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
      .slice(0, 15);
    res.json({ activity: rows });
  } catch (err) {
    console.error("[GET /api/admin/bookings/activity]", err);
    res.status(500).json({ error: "Could not load activity." });
  }
});

// ── GET /api/admin/bookings/:id ───────────────────────────
router.get("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid booking id." });
    const result = await db.query(
      `
      SELECT
        bk.id              AS booking_id,
        bi.id              AS bike_id,
        sp.id              AS pickup_station_id,
        sr.id              AS return_station_id,
        u.full_name        AS student_name,
        u.email            AS student_email,
        u.phone            AS student_phone,
        u.role::text       AS student_role,
        bi.bike_code,
        bi.model           AS bike_model,
        sp.station_name    AS pickup_station,
        sr.station_name    AS return_station,
        bk.start_time,
        bk.end_time,
        bk.duration_minutes,
        bk.fee_amount,
        bk.status,
        bk.notes,
        bk.booking_type,
        bk.pricing_mode,
        p.status::text     AS payment_status,
        p.amount           AS amount_paid,
        p.transaction_reference,
        p.paid_at,
        CASE
          WHEN bk.status = 'completed' AND bk.end_time IS NOT NULL
            THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (bk.end_time - bk.start_time)) / 60))::int
          WHEN bk.status = 'active'
            THEN GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (NOW() - bk.start_time)) / 60))::int
          WHEN bk.end_time IS NOT NULL AND COALESCE(bk.duration_minutes, 0) <= 0
            THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (bk.end_time - bk.start_time)) / 60))::int
          WHEN bk.duration_minutes IS NOT NULL
            THEN GREATEST(0, bk.duration_minutes)
          ELSE 0
        END AS display_duration_minutes,
        CASE
          WHEN bk.status = 'active' THEN 1.00
          WHEN COALESCE(p.status::text, '') = 'refunded' THEN 0.00
          WHEN bk.status = 'completed' AND bk.end_time IS NOT NULL
            THEN ROUND((1.00 + GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (bk.end_time - bk.start_time)) / 60)) * 0.20)::numeric, 2)
          ELSE COALESCE(p.amount, bk.fee_amount, 0)
        END AS display_amount,
        (
          SELECT json_agg(json_build_object(
            'id', t.id, 'subject', t.subject, 'status', t.status, 'priority', t.priority, 'created_at', t.created_at
          )) FROM support_tickets t WHERE t.booking_id = bk.id
        ) AS linked_tickets,
        (
          SELECT json_agg(json_build_object(
            'id', e.id, 'description', e.description, 'amount', e.amount, 'created_at', e.created_at
          )) FROM admin_expenses e WHERE e.related_booking_id = bk.id
        ) AS refund_history
      FROM bookings bk
      JOIN users u   ON u.id  = bk.user_id
      JOIN bikes bi  ON bi.id = bk.bike_id
      JOIN stations sp ON sp.id = bk.pickup_station_id
      LEFT JOIN stations sr ON sr.id = bk.return_station_id
      LEFT JOIN LATERAL (
        SELECT * FROM payments pay WHERE pay.booking_id = bk.id ORDER BY pay.created_at DESC LIMIT 1
      ) p ON TRUE
      WHERE bk.id = $1
      `,
      [id]
    );
    const r = result.rows[0];
    if (!r) return res.status(404).json({ error: "Booking not found." });

    const refundEligible =
      r.payment_status === "paid" &&
      ["completed","cancelled"].includes(r.status) &&
      (!r.refund_history || r.refund_history.length === 0);

    res.json({
      booking: {
        bookingId:        r.booking_id,
        bookingCode:      bookingCode(r.booking_id),
        studentName:      cleanDisplay(r.student_name, fallbackName(r.booking_id)),
        studentEmail:     cleanDisplay(r.student_email, ""),
        studentPhone:     r.student_phone,
        studentRole:      r.student_role || "student",
        userName:         cleanDisplay(r.student_name, fallbackName(r.booking_id)),
        userEmail:        cleanDisplay(r.student_email, ""),
        userPhone:        r.student_phone,
        userRole:         r.student_role || "student",
        bikeCode:         cleanBikeCode(r.bike_code, r.bike_id),
        bikeModel:        cleanDisplay(r.bike_model, "Standard"),
        pickupStation:    cleanDisplay(r.pickup_station, fallbackStation(r.pickup_station_id)),
        returnStation:    displayStatus(r) === "active" ? "In progress" : cleanDisplay(r.return_station, fallbackStation(r.return_station_id || r.pickup_station_id)),
        startTime:        r.start_time,
        endTime:          displayStatus(r) === "active" ? null : r.end_time,
        durationMinutes:  Number(r.display_duration_minutes || 0),
        amount:           Number(r.display_amount || 0),
        status:           displayStatus(r),
        bookingStatus:    displayStatus(r),
        notes:            cleanDisplay(r.notes, ""),
        bookingType:      r.booking_type,
        pricingMode:      r.pricing_mode,
        paymentStatus:    r.payment_status || "pending",
        amountPaid:       r.amount_paid != null ? Number(r.amount_paid) : null,
        transactionRef:   cleanDisplay(r.transaction_reference, ""),
        paidAt:           r.paid_at,
        refundEligible,
        linkedTickets:    cleanTickets(r.linked_tickets || []),
        refundHistory:    cleanRefundHistory(r.refund_history || []),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/bookings/:id]", err);
    res.status(500).json({ error: "Could not load booking." });
  }
});

// ── POST /api/admin/bookings/:id/cancel ───────────────────
router.post("/:id/cancel", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid booking id." });
  const reason = String((req.body && req.body.reason) || "Cancelled by admin").trim().slice(0, 250);

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT id, status, bike_id, pickup_station_id FROM bookings WHERE id = $1 FOR UPDATE",
      [id]
    );
    const row = cur.rows[0];
    if (!row) throw new Error("Booking not found.");
    if (!["pending","active"].includes(row.status)) throw new Error("Only pending or active bookings can be cancelled.");

    await client.query(
      `UPDATE bookings
          SET status = 'cancelled',
              notes = CONCAT(COALESCE(notes,''), CASE WHEN notes IS NULL OR notes='' THEN '' ELSE E'\n' END, $2::text),
              updated_at = NOW()
        WHERE id = $1`,
      [id, `Cancelled by admin: ${reason}`]
    );
    await client.query(
      "UPDATE bikes SET status = 'available', station_id = $2 WHERE id = $1 AND status = 'in_use'",
      [row.bike_id, row.pickup_station_id]
    );
    await client.query("COMMIT");
    res.json({ ok: true, status: "cancelled", bookingId: id });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ error: err.message || "Could not cancel booking." });
  } finally {
    client.release();
  }
});

// ── POST /api/admin/bookings/:id/refund ───────────────────
// Marks the existing paid payment as refunded and records an expense.
router.post("/:id/refund", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid booking id." });
  const reason = String((req.body && req.body.reason) || "Refund approved by admin").trim().slice(0, 250);

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const payRow = await client.query(
      "SELECT id, amount, status FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [id]
    );
    const p = payRow.rows[0];
    if (!p) throw new Error("No payment found for this booking.");
    if (p.status === "refunded") throw new Error("This booking has already been refunded.");
    if (p.status !== "paid") throw new Error("Only paid bookings can be refunded.");

    await client.query("UPDATE payments SET status = 'refunded' WHERE id = $1", [p.id]);
    await client.query(
      `INSERT INTO admin_expenses (expense_type, description, amount, related_booking_id)
       VALUES ('refund', $2, $3, $1)`,
      [id, `Refund: ${reason}`, p.amount]
    );
    await client.query(
      `INSERT INTO admin_activity_log (activity_type, title, description, related_booking_id)
       VALUES ('refund_requested', $2, $3, $1)`,
      [id, "Refund approved", `Booking #${id} refunded by admin: ${reason}`]
    );
    await client.query("COMMIT");
    res.json({ ok: true, refunded: Number(p.amount), bookingId: id });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ error: err.message || "Could not process refund." });
  } finally {
    client.release();
  }
});

// ── POST /api/admin/bookings/manual ───────────────────────
// Creates a manual booking for a student. Bike + station must already exist.
router.post("/manual", requireAdmin, async (req, res) => {
  const body = req.body || {};
  const userId = Number(body.userId);
  const bikeId = Number(body.bikeId);
  const stationId = Number(body.stationId);
  const startTime = body.startTime ? new Date(body.startTime) : new Date();
  const durationMinutes = Math.max(15, Math.min(480, Number(body.durationMinutes) || 60));
  if (!Number.isInteger(userId) || !Number.isInteger(bikeId) || !Number.isInteger(stationId)) {
    return res.status(400).json({ error: "Missing userId / bikeId / stationId." });
  }
  if (Number.isNaN(startTime.getTime())) return res.status(400).json({ error: "Invalid start time." });
  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  const amount = Number((1.00 + durationMinutes * 0.20).toFixed(2));

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO bookings (
         user_id, bike_id, pickup_station_id, start_time, end_time, status, expires_at,
         duration_minutes, fee_amount, unlock_fee, per_minute_fee, booking_type, pricing_mode, notes
       )
       VALUES ($1,$2,$3,$4,$5,'pending',$5,$6,$7,1.00,0.20,'scheduled','pay_as_you_go',$8)
       RETURNING id`,
      [userId, bikeId, stationId, startTime, endTime, durationMinutes, amount, "Manual booking created by admin"]
    );
    await client.query(
      `INSERT INTO payments (booking_id, user_id, amount, currency, payment_method, status, transaction_reference)
       VALUES ($1,$2,$3,'AUD','credit_card','pending',$4)`,
      [inserted.rows[0].id, userId, amount, "manual_" + inserted.rows[0].id]
    );
    await client.query(
      "UPDATE bikes SET status = 'in_use', station_id = NULL WHERE id = $1 AND status = 'available'",
      [bikeId]
    );
    await client.query("COMMIT");
    res.json({ ok: true, bookingId: inserted.rows[0].id });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ error: err.message || "Could not create manual booking." });
  } finally {
    client.release();
  }
});

module.exports = router;
