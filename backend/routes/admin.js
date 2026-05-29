const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const adminMetrics = require("../services/adminMetrics");
const settingsService = require("../services/settingsService");
const { ensureStudentSchema } = require("../utils/studentSchema");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";

const RANGE_CONFIG = {
  today: { unit: "hour", chartCount: 24 },
  week: { unit: "day", chartCount: 7 },
  month: { unit: "day", chartCount: 30 },
  year: { unit: "month", chartCount: 12 },
};

let schemaReady = null;

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

async function ensureAdminSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'admin_expense_type') THEN
          CREATE TYPE admin_expense_type AS ENUM ('maintenance', 'refund', 'operational', 'repair', 'other');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'admin_activity_type') THEN
          CREATE TYPE admin_activity_type AS ENUM (
            'booking_completed',
            'payment_received',
            'bike_returned',
            'maintenance_flagged',
            'refund_requested',
            'support_ticket_received'
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_status') THEN
          CREATE TYPE ticket_status AS ENUM ('open', 'in_progress', 'resolved', 'closed');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_priority') THEN
          CREATE TYPE ticket_priority AS ENUM ('low', 'medium', 'high', 'urgent');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_category') THEN
          CREATE TYPE ticket_category AS ENUM ('booking', 'bike', 'payment', 'account', 'station', 'other');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'maintenance_status') THEN
          CREATE TYPE maintenance_status AS ENUM ('reported', 'in_progress', 'resolved', 'closed');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'maintenance_severity') THEN
          CREATE TYPE maintenance_severity AS ENUM ('low', 'medium', 'high', 'critical');
        END IF;
      END $$;
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS admin_expenses (
        id                 SERIAL PRIMARY KEY,
        expense_type       admin_expense_type NOT NULL DEFAULT 'other',
        description        TEXT,
        amount             NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
        related_booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
        related_bike_id    INTEGER REFERENCES bikes(id) ON DELETE SET NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_admin_expenses_created ON admin_expenses(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_expenses_type ON admin_expenses(expense_type);
      CREATE INDEX IF NOT EXISTS idx_admin_expenses_booking ON admin_expenses(related_booking_id);

      CREATE TABLE IF NOT EXISTS admin_activity_log (
        id                 SERIAL PRIMARY KEY,
        activity_type      admin_activity_type NOT NULL,
        title              VARCHAR(180) NOT NULL,
        description        TEXT,
        related_booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
        related_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        related_bike_id    INTEGER REFERENCES bikes(id) ON DELETE SET NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_admin_activity_created ON admin_activity_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_activity_type ON admin_activity_log(activity_type);

      CREATE TABLE IF NOT EXISTS support_tickets (
        id              SERIAL PRIMARY KEY,
        ticket_code     VARCHAR(30),
        user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        student_name    VARCHAR(120),
        subject         VARCHAR(200) NOT NULL,
        category        ticket_category NOT NULL DEFAULT 'other',
        priority        ticket_priority NOT NULL DEFAULT 'medium',
        status          ticket_status NOT NULL DEFAULT 'open',
        message         TEXT,
        description     TEXT,
        booking_id      INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
        admin_response  TEXT,
        resolved_at     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ticket_code VARCHAR(30);
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS student_name VARCHAR(120);
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS message TEXT;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS admin_response TEXT;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

      UPDATE support_tickets
         SET message = COALESCE(message, description),
             ticket_code = COALESCE(ticket_code, 'TK-' || LPAD(id::text, 4, '0')),
             student_name = COALESCE(student_name, (SELECT full_name FROM users WHERE users.id = support_tickets.user_id))
       WHERE message IS NULL OR ticket_code IS NULL OR student_name IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_code ON support_tickets(ticket_code) WHERE ticket_code IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);
      CREATE INDEX IF NOT EXISTS idx_tickets_created ON support_tickets(created_at DESC);

      CREATE TABLE IF NOT EXISTS maintenance_logs (
        id                      SERIAL PRIMARY KEY,
        bike_id                 INTEGER REFERENCES bikes(id) ON DELETE CASCADE,
        station_id              INTEGER REFERENCES stations(id) ON DELETE SET NULL,
        reported_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        resolved_by_admin_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        issue_type              VARCHAR(80) NOT NULL DEFAULT 'other',
        description             TEXT,
        severity                maintenance_severity NOT NULL DEFAULT 'medium',
        status                  maintenance_status NOT NULL DEFAULT 'reported',
        cost                    NUMERIC(10,2) NOT NULL DEFAULT 0,
        reported_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at             TIMESTAMPTZ,
        resolution_notes        TEXT,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS station_id INTEGER REFERENCES stations(id) ON DELETE SET NULL;
      ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS cost NUMERIC(10,2) NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_maint_status ON maintenance_logs(status);
      CREATE INDEX IF NOT EXISTS idx_maint_severity ON maintenance_logs(severity);
      CREATE INDEX IF NOT EXISTS idx_maint_reported_desc ON maintenance_logs(reported_at DESC);
    `);
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

function asMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function pctTrend(current, previous) {
  const cur = Number(current || 0);
  const prev = Number(previous || 0);
  if (prev === 0) return cur === 0 ? 0 : 100;
  return Number((((cur - prev) / Math.abs(prev)) * 100).toFixed(1));
}

function parseRange(value) {
  const key = Object.prototype.hasOwnProperty.call(RANGE_CONFIG, value) ? value : "month";
  const now = new Date();
  let start;
  if (key === "today") {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
  } else if (key === "week") {
    start = new Date(now);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
  } else if (key === "year") {
    start = new Date(now.getFullYear(), 0, 1);
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const currentEnd = now;
  const durationMs = currentEnd.getTime() - start.getTime();
  const prevStart = new Date(start.getTime() - durationMs);
  const prevEnd = start;
  return { key, currentStart: start, currentEnd, prevStart, prevEnd };
}

async function one(sql, params = [], field = "value") {
  const result = await db.query(sql, params);
  return Number(result.rows[0] && result.rows[0][field] || 0);
}

async function revenueBetween(start, end) {
  return one(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS value
       FROM payments
      WHERE status = 'paid'
        AND COALESCE(paid_at, created_at) >= $1
        AND COALESCE(paid_at, created_at) < $2`,
    [start, end]
  );
}

async function expensesBetween(start, end) {
  return one(
    `WITH admin_part AS (
       SELECT COALESCE(SUM(amount), 0)::numeric AS total
         FROM admin_expenses
        WHERE created_at >= $1 AND created_at < $2
     ),
     maintenance_part AS (
       SELECT COALESCE(SUM(cost), 0)::numeric AS total
         FROM maintenance_logs
        WHERE COALESCE(reported_at, created_at) >= $1
          AND COALESCE(reported_at, created_at) < $2
          AND cost > 0
     ),
     refund_part AS (
       SELECT COALESCE(SUM(p.amount), 0)::numeric AS total
         FROM payments p
        WHERE p.status = 'refunded'
          AND COALESCE(p.updated_at, p.paid_at, p.created_at) >= $1
          AND COALESCE(p.updated_at, p.paid_at, p.created_at) < $2
          AND NOT EXISTS (
            SELECT 1
              FROM admin_expenses ae
             WHERE ae.expense_type = 'refund'
               AND ae.related_booking_id = p.booking_id
          )
     )
     SELECT (admin_part.total + maintenance_part.total + refund_part.total)::numeric AS value
       FROM admin_part, maintenance_part, refund_part`,
    [start, end]
  );
}

function periodWhere(alias, column, hasRange, start, end, params) {
  if (!hasRange) return "";
  params.push(start, end);
  return ` AND ${alias}.${column} >= $${params.length - 1} AND ${alias}.${column} < $${params.length}`;
}

router.get("/overview", requireAdmin, async (req, res) => {
  try {
    await ensureAdminSchema();
    {
      const range = adminMetrics.parseRange(String(req.query.range || "month"));
      const [
        financial,
        bookings,
        fleet,
        maintenanceAlerts,
        prevMaintenanceAlerts,
        openIssues,
        prevOpenIssues,
      ] = await Promise.all([
        adminMetrics.financialOverview(range),
        adminMetrics.bookingSummary(range),
        adminMetrics.fleetSummary(),
        one(
          `SELECT (
            (SELECT COUNT(*) FROM maintenance_logs
              WHERE status NOT IN ('resolved', 'closed')
                 OR severity IN ('high', 'critical'))
            + (SELECT COUNT(*) FROM bikes b
                 WHERE b.status = 'maintenance'
                   AND NOT EXISTS (
                     SELECT 1 FROM maintenance_logs ml
                      WHERE ml.bike_id = b.id
                        AND (ml.status NOT IN ('resolved', 'closed') OR ml.severity IN ('high', 'critical'))
                   ))
          )::int AS value`
        ),
        one(
          `SELECT COUNT(*)::int AS value
             FROM maintenance_logs
            WHERE reported_at >= $1 AND reported_at < $2
              AND (status NOT IN ('resolved', 'closed') OR severity IN ('high', 'critical'))`,
          [range.prevStart, range.prevEnd]
        ),
        one("SELECT COUNT(*)::int AS value FROM support_tickets WHERE status NOT IN ('resolved', 'closed')"),
        one(
          `SELECT COUNT(*)::int AS value
             FROM support_tickets
            WHERE created_at >= $1 AND created_at < $2
              AND status NOT IN ('resolved', 'closed')`,
          [range.prevStart, range.prevEnd]
        ),
      ]);

      return res.json({
        range: range.key,
        totalRevenue: adminMetrics.asMoney(financial.current.totalRevenue),
        totalExpenses: adminMetrics.asMoney(financial.current.totalExpenses),
        netProfit: adminMetrics.asMoney(financial.current.netProfit),
        totalBookings: bookings.totals.totalBookings,
        activeRides: bookings.totals.activeRides,
        availableBikes: fleet.availableBikes,
        maintenanceAlerts,
        openIssues,
        trends: {
          totalRevenue: financial.trends.totalRevenue,
          totalExpenses: financial.trends.totalExpenses,
          netProfit: financial.trends.netProfit,
          totalBookings: bookings.trends.totalBookings,
          activeRides: bookings.trends.activeRides,
          availableBikes: adminMetrics.pctTrend(fleet.availableBikes, Math.max(0, fleet.totalBikes - fleet.availableBikes)),
          maintenanceAlerts: adminMetrics.pctTrend(maintenanceAlerts, prevMaintenanceAlerts),
          openIssues: adminMetrics.pctTrend(openIssues, prevOpenIssues),
        },
      });
    }
    const range = parseRange(String(req.query.range || "month"));
    const revenue = await revenueBetween(range.currentStart, range.currentEnd);
    const prevRevenue = await revenueBetween(range.prevStart, range.prevEnd);
    const expenses = await expensesBetween(range.currentStart, range.currentEnd);
    const prevExpenses = await expensesBetween(range.prevStart, range.prevEnd);

    const [
      totalBookings,
      prevBookings,
      activeRides,
      prevActiveRides,
      availableBikes,
      totalBikes,
      maintenanceAlerts,
      prevMaintenanceAlerts,
      openIssues,
      prevOpenIssues,
    ] = await Promise.all([
      one("SELECT COUNT(*)::int AS value FROM bookings WHERE created_at >= $1 AND created_at < $2", [range.currentStart, range.currentEnd]),
      one("SELECT COUNT(*)::int AS value FROM bookings WHERE created_at >= $1 AND created_at < $2", [range.prevStart, range.prevEnd]),
      one(
        `SELECT COUNT(*)::int AS value
           FROM bookings bk
           JOIN bikes b ON b.id = bk.bike_id
          WHERE bk.status = 'active'
            AND b.status = 'in_use'
            AND start_time <= NOW()
            AND COALESCE(
              bk.end_time,
              bk.expires_at,
              bk.start_time + (COALESCE(bk.duration_minutes, 60) || ' minutes')::interval
            ) > NOW()`
      ),
      one(
        `SELECT COUNT(*)::int AS value
           FROM bookings bk
           JOIN bikes b ON b.id = bk.bike_id
          WHERE bk.status = 'active'
            AND b.status = 'in_use'
            AND start_time <= NOW()
            AND COALESCE(
              bk.end_time,
              bk.expires_at,
              bk.start_time + (COALESCE(bk.duration_minutes, 60) || ' minutes')::interval
            ) > NOW()`
      ),
      one(
        `SELECT COUNT(*)::int AS value
           FROM bikes b
          WHERE b.status = 'available'
            AND NOT EXISTS (
              SELECT 1 FROM bookings bk
               WHERE bk.bike_id = b.id
                 AND bk.status IN ('active', 'pending')
                 AND bk.start_time <= NOW()
                 AND COALESCE(bk.end_time, bk.expires_at) > NOW()
            )`
      ),
      one("SELECT COUNT(*)::int AS value FROM bikes"),
      one(
        `SELECT (
          (SELECT COUNT(*) FROM maintenance_logs
            WHERE status NOT IN ('resolved', 'closed')
               OR severity IN ('high', 'critical'))
          + (SELECT COUNT(*) FROM bikes b
               WHERE b.status = 'maintenance'
                 AND NOT EXISTS (
                   SELECT 1 FROM maintenance_logs ml
                    WHERE ml.bike_id = b.id
                      AND (ml.status NOT IN ('resolved', 'closed') OR ml.severity IN ('high', 'critical'))
                 ))
        )::int AS value`
      ),
      one(
        `SELECT COUNT(*)::int AS value
           FROM maintenance_logs
          WHERE reported_at >= $1 AND reported_at < $2
            AND (status NOT IN ('resolved', 'closed') OR severity IN ('high', 'critical'))`,
        [range.prevStart, range.prevEnd]
      ),
      one("SELECT COUNT(*)::int AS value FROM support_tickets WHERE status NOT IN ('resolved', 'closed')"),
      one(
        `SELECT COUNT(*)::int AS value
           FROM support_tickets
          WHERE created_at >= $1 AND created_at < $2
            AND status NOT IN ('resolved', 'closed')`,
        [range.prevStart, range.prevEnd]
      ),
    ]);

    const netProfit = revenue - expenses;
    const prevNetProfit = prevRevenue - prevExpenses;

    res.json({
      range: range.key,
      totalRevenue: asMoney(revenue),
      totalExpenses: asMoney(expenses),
      netProfit: asMoney(netProfit),
      totalBookings,
      activeRides,
      availableBikes,
      maintenanceAlerts,
      openIssues,
      trends: {
        totalRevenue: pctTrend(revenue, prevRevenue),
        totalExpenses: pctTrend(expenses, prevExpenses),
        netProfit: pctTrend(netProfit, prevNetProfit),
        totalBookings: pctTrend(totalBookings, prevBookings),
        activeRides: pctTrend(activeRides, prevActiveRides),
        availableBikes: pctTrend(availableBikes, Math.max(0, totalBikes - availableBikes)),
        maintenanceAlerts: pctTrend(maintenanceAlerts, prevMaintenanceAlerts),
        openIssues: pctTrend(openIssues, prevOpenIssues),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/overview]", err);
    res.status(500).json({ error: "Could not load admin overview." });
  }
});

router.get("/revenue-expenses", requireAdmin, async (req, res) => {
  try {
    await ensureAdminSchema();
    {
      const range = adminMetrics.parseRange(String(req.query.range || "month"));
      const series = await adminMetrics.revenueExpenseSeries(range);
      const labelOptions = range.key === "today"
        ? { hour: "numeric" }
        : range.key === "year"
          ? { month: "short" }
          : { day: "numeric", month: "short" };

      return res.json({
        range: range.key,
        labels: series.map((row) => new Date(row.bucketStart).toLocaleDateString("en-AU", labelOptions)),
        revenue: series.map((row) => row.revenue),
        expenses: series.map((row) => row.expenses),
      });
    }
    const range = parseRange(String(req.query.range || "month"));
    const config = RANGE_CONFIG[range.key];
    const result = await db.query(
      `WITH buckets AS (
         SELECT generate_series(
                  date_trunc($3, $1::timestamptz),
                  date_trunc($3, $2::timestamptz),
                  ('1 ' || $3)::interval
                ) AS bucket_start
       ),
       bucketed AS (
         SELECT bucket_start,
                bucket_start + ('1 ' || $3)::interval AS bucket_end
           FROM buckets
          ORDER BY bucket_start DESC
          LIMIT $4
       ),
       revenue AS (
         SELECT date_trunc($3, COALESCE(paid_at, created_at)) AS bucket_start,
                SUM(amount)::numeric AS value
           FROM payments
          WHERE status = 'paid'
            AND COALESCE(paid_at, created_at) >= $1
            AND COALESCE(paid_at, created_at) <= $2
          GROUP BY 1
       ),
       admin_exp AS (
         SELECT date_trunc($3, created_at) AS bucket_start,
                SUM(amount)::numeric AS value
           FROM admin_expenses
          WHERE created_at >= $1 AND created_at <= $2
          GROUP BY 1
       ),
       maint_exp AS (
         SELECT date_trunc($3, COALESCE(reported_at, created_at)) AS bucket_start,
                SUM(cost)::numeric AS value
           FROM maintenance_logs
          WHERE COALESCE(reported_at, created_at) >= $1
            AND COALESCE(reported_at, created_at) <= $2
            AND cost > 0
          GROUP BY 1
       ),
       refund_exp AS (
         SELECT date_trunc($3, COALESCE(updated_at, paid_at, created_at)) AS bucket_start,
                SUM(amount)::numeric AS value
           FROM payments
          WHERE status = 'refunded'
            AND COALESCE(updated_at, paid_at, created_at) >= $1
            AND COALESCE(updated_at, paid_at, created_at) <= $2
          GROUP BY 1
       )
       SELECT bucketed.bucket_start,
              COALESCE(revenue.value, 0)::numeric AS revenue,
              (COALESCE(admin_exp.value, 0) + COALESCE(maint_exp.value, 0) + COALESCE(refund_exp.value, 0))::numeric AS expenses
         FROM bucketed
         LEFT JOIN revenue   ON revenue.bucket_start = bucketed.bucket_start
         LEFT JOIN admin_exp ON admin_exp.bucket_start = bucketed.bucket_start
         LEFT JOIN maint_exp ON maint_exp.bucket_start = bucketed.bucket_start
         LEFT JOIN refund_exp ON refund_exp.bucket_start = bucketed.bucket_start
        ORDER BY bucketed.bucket_start ASC`,
      [range.currentStart, range.currentEnd, config.unit, config.chartCount]
    );

    const labelOptions = range.key === "today"
      ? { hour: "numeric" }
      : range.key === "year"
        ? { month: "short" }
        : { day: "numeric", month: "short" };

    res.json({
      range: range.key,
      labels: result.rows.map((row) => new Date(row.bucket_start).toLocaleDateString("en-AU", labelOptions)),
      revenue: result.rows.map((row) => asMoney(row.revenue)),
      expenses: result.rows.map((row) => asMoney(row.expenses)),
    });
  } catch (err) {
    console.error("[GET /api/admin/revenue-expenses]", err);
    res.status(500).json({ error: "Could not load revenue chart." });
  }
});

router.get("/booking-status", requireAdmin, async (req, res) => {
  try {
    await ensureAdminSchema();
    {
      const range = adminMetrics.parseRange(String(req.query.range || "month"));
      const summary = await adminMetrics.bookingSummary(range);
      return res.json({
        completed: summary.totals.completedRides,
        active: summary.totals.activeRides,
        cancelled: summary.totals.cancelledBookings,
        pending: summary.totals.upcomingBookings,
      });
    }
    const range = parseRange(String(req.query.range || "month"));
    const result = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
         (
           SELECT COUNT(*)::int
             FROM bookings live_bk
             JOIN bikes live_b ON live_b.id = live_bk.bike_id
            WHERE live_bk.status = 'active'
              AND live_b.status = 'in_use'
              AND live_bk.start_time <= NOW()
              AND COALESCE(
                live_bk.end_time,
                live_bk.expires_at,
                live_bk.start_time + (COALESCE(live_bk.duration_minutes, 60) || ' minutes')::interval
              ) > NOW()
         ) AS active,
         COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
         COUNT(*) FILTER (
           WHERE status = 'pending'
             AND start_time > NOW()
         )::int AS pending
       FROM bookings
       WHERE created_at >= $1 AND created_at < $2`,
      [range.currentStart, range.currentEnd]
    );
    const row = result.rows[0] || {};
    res.json({
      completed: Number(row.completed || 0),
      active: Number(row.active || 0),
      cancelled: Number(row.cancelled || 0),
      pending: Number(row.pending || 0),
    });
  } catch (err) {
    console.error("[GET /api/admin/booking-status]", err);
    res.status(500).json({ error: "Could not load booking status." });
  }
});

router.get("/financial-summary", requireAdmin, async (req, res) => {
  try {
    await ensureAdminSchema();
    {
      const range = adminMetrics.parseRange(String(req.query.range || "month"));
      const summary = await adminMetrics.financialSummaryBetween(range.currentStart, range.currentEnd);
      return res.json({
        bookingIncome: adminMetrics.asMoney(summary.bookingIncome),
        refunds: adminMetrics.asMoney(summary.refunds),
        maintenanceCost: adminMetrics.asMoney(summary.maintenanceCost),
        operationalExpenses: adminMetrics.asMoney(summary.operationalExpenses),
        netBalance: adminMetrics.asMoney(summary.netBalance),
      });
    }
    const range = parseRange(String(req.query.range || "month"));
    const result = await db.query(
      `WITH booking_income AS (
         SELECT COALESCE(SUM(amount), 0)::numeric AS value
           FROM payments
          WHERE status = 'paid'
            AND COALESCE(paid_at, created_at) >= $1
            AND COALESCE(paid_at, created_at) < $2
       ),
       refunds AS (
         SELECT (
           COALESCE((SELECT SUM(amount) FROM admin_expenses WHERE expense_type = 'refund' AND created_at >= $1 AND created_at < $2), 0)
           + COALESCE((SELECT SUM(amount) FROM payments WHERE status = 'refunded' AND COALESCE(updated_at, paid_at, created_at) >= $1 AND COALESCE(updated_at, paid_at, created_at) < $2), 0)
         )::numeric AS value
       ),
       maintenance AS (
         SELECT (
           COALESCE((SELECT SUM(cost) FROM maintenance_logs WHERE COALESCE(reported_at, created_at) >= $1 AND COALESCE(reported_at, created_at) < $2), 0)
           + COALESCE((SELECT SUM(amount) FROM admin_expenses WHERE expense_type IN ('maintenance','repair') AND created_at >= $1 AND created_at < $2), 0)
         )::numeric AS value
       ),
       operations AS (
         SELECT COALESCE(SUM(amount), 0)::numeric AS value
           FROM admin_expenses
          WHERE expense_type IN ('operational', 'other')
            AND created_at >= $1 AND created_at < $2
       )
       SELECT booking_income.value AS booking_income,
              refunds.value AS refunds,
              maintenance.value AS maintenance_cost,
              operations.value AS operational_expenses,
              (booking_income.value - refunds.value - maintenance.value - operations.value)::numeric AS net_balance
         FROM booking_income, refunds, maintenance, operations`,
      [range.currentStart, range.currentEnd]
    );
    const row = result.rows[0] || {};
    res.json({
      bookingIncome: asMoney(row.booking_income),
      refunds: asMoney(row.refunds),
      maintenanceCost: asMoney(row.maintenance_cost),
      operationalExpenses: asMoney(row.operational_expenses),
      netBalance: asMoney(row.net_balance),
    });
  } catch (err) {
    console.error("[GET /api/admin/financial-summary]", err);
    res.status(500).json({ error: "Could not load financial summary." });
  }
});

router.get("/maintenance-alerts", requireAdmin, async (_req, res) => {
  try {
    await ensureAdminSchema();
    const result = await db.query(
      `SELECT *
         FROM (
           SELECT ml.id,
                  COALESCE(b.bike_code, 'BIKE-' || LPAD(COALESCE(ml.bike_id, 0)::text, 3, '0')) AS bike_id,
                  COALESCE(s.station_name, sb.station_name, 'Unassigned') AS station_name,
                  ml.issue_type,
                  ml.severity::text AS severity,
                  ml.status::text AS status,
                  ml.reported_at
             FROM maintenance_logs ml
             LEFT JOIN bikes b ON b.id = ml.bike_id
             LEFT JOIN stations s ON s.id = ml.station_id
             LEFT JOIN stations sb ON sb.id = b.station_id
            WHERE ml.status NOT IN ('resolved', 'closed')
               OR ml.severity IN ('high', 'critical')
           UNION ALL
           SELECT NULL::integer AS id,
                  b.bike_code AS bike_id,
                  COALESCE(s.station_name, 'Unassigned') AS station_name,
                  'Bike marked maintenance' AS issue_type,
                  'medium' AS severity,
                  'reported' AS status,
                  COALESCE(b.last_maintenance_at, b.updated_at, b.created_at) AS reported_at
             FROM bikes b
             LEFT JOIN stations s ON s.id = b.station_id
            WHERE b.status = 'maintenance'
              AND NOT EXISTS (
                SELECT 1
                  FROM maintenance_logs ml
                 WHERE ml.bike_id = b.id
                   AND (ml.status NOT IN ('resolved', 'closed') OR ml.severity IN ('high', 'critical'))
              )
         ) alerts
        ORDER BY
          CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
          reported_at DESC
        LIMIT 6`
    );
    res.json({ alerts: result.rows });
  } catch (err) {
    console.error("[GET /api/admin/maintenance-alerts]", err);
    res.status(500).json({ error: "Could not load maintenance alerts." });
  }
});

router.get("/reported-issues", requireAdmin, async (_req, res) => {
  try {
    await ensureAdminSchema();
    const result = await db.query(
      `SELECT st.id,
              COALESCE(st.ticket_code, 'TK-' || LPAD(st.id::text, 4, '0')) AS ticket_id,
              COALESCE(st.student_name, u.full_name, 'Unknown Student') AS student_name,
              st.subject AS issue,
              st.category,
              st.priority,
              st.status,
              st.created_at
         FROM support_tickets st
         LEFT JOIN users u ON u.id = st.user_id
        WHERE st.status NOT IN ('resolved', 'closed')
        ORDER BY
          CASE st.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
          st.created_at DESC
        LIMIT 6`
    );
    res.json({ issues: result.rows });
  } catch (err) {
    console.error("[GET /api/admin/reported-issues]", err);
    res.status(500).json({ error: "Could not load reported issues." });
  }
});

router.get("/recent-transactions", requireAdmin, async (_req, res) => {
  try {
    await ensureAdminSchema();
    const result = await db.query(
      `SELECT p.id,
              'BK-' || LPAD(p.booking_id::text, 4, '0') AS booking_id,
              COALESCE(u.full_name, 'Unknown Student') AS student_name,
              COALESCE(s.station_name, 'Unknown Station') AS station,
              p.amount,
              p.currency,
              p.payment_method,
              p.status AS payment_status,
              COALESCE(p.paid_at, p.created_at) AS date
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
         LEFT JOIN users u ON u.id = p.user_id
         LEFT JOIN stations s ON s.id = b.pickup_station_id
        ORDER BY COALESCE(p.paid_at, p.created_at) DESC
        LIMIT 8`
    );
    res.json({ transactions: result.rows });
  } catch (err) {
    console.error("[GET /api/admin/recent-transactions]", err);
    res.status(500).json({ error: "Could not load transactions." });
  }
});

router.get("/recent-activity", requireAdmin, async (_req, res) => {
  try {
    await ensureAdminSchema();
    const result = await db.query(
      `SELECT activity_type, title, description, created_at AS timestamp
         FROM (
           SELECT activity_type::text, title, description, created_at
             FROM admin_activity_log
           UNION ALL
           SELECT 'payment_received',
                  'Payment received',
                  '$' || p.amount::text || ' from ' || COALESCE(u.full_name, 'student') || ' for booking #BK-' || LPAD(p.booking_id::text, 4, '0'),
                  COALESCE(p.paid_at, p.created_at)
             FROM payments p
             LEFT JOIN users u ON u.id = p.user_id
            WHERE p.status = 'paid'
           UNION ALL
           SELECT 'refund_requested',
                  'Refund recorded',
                  '$' || p.amount::text || ' refund for booking #BK-' || LPAD(p.booking_id::text, 4, '0'),
                  COALESCE(p.updated_at, p.created_at)
             FROM payments p
            WHERE p.status = 'refunded'
           UNION ALL
           SELECT 'booking_completed',
                  'Booking completed',
                  'Booking #BK-' || LPAD(b.id::text, 4, '0') || ' completed by ' || COALESCE(u.full_name, 'student'),
                  COALESCE(b.end_time, b.updated_at, b.created_at)
             FROM bookings b
             LEFT JOIN users u ON u.id = b.user_id
            WHERE b.status = 'completed'
           UNION ALL
           SELECT 'bike_returned',
                  'Bike returned',
                  COALESCE(bi.bike_code, 'Bike') || ' returned at ' || COALESCE(s.station_name, 'a station'),
                  COALESCE(b.end_time, b.updated_at, b.created_at)
             FROM bookings b
             LEFT JOIN bikes bi ON bi.id = b.bike_id
             LEFT JOIN stations s ON s.id = b.return_station_id
            WHERE b.status = 'completed'
           UNION ALL
           SELECT 'maintenance_flagged',
                  'Maintenance flagged',
                  COALESCE(bi.bike_code, 'Bike') || ' reported for ' || ml.issue_type,
                  ml.reported_at
             FROM maintenance_logs ml
             LEFT JOIN bikes bi ON bi.id = ml.bike_id
           UNION ALL
           SELECT 'support_ticket_received',
                  'Support ticket received',
                  COALESCE(st.ticket_code, 'TK-' || LPAD(st.id::text, 4, '0')) || ': ' || st.subject,
                  st.created_at
             FROM support_tickets st
         ) activity
        ORDER BY created_at DESC
        LIMIT 8`
    );
    res.json({ activity: result.rows });
  } catch (err) {
    console.error("[GET /api/admin/recent-activity]", err);
    res.status(500).json({ error: "Could not load recent activity." });
  }
});

router.get("/alerts", requireAdmin, async (_req, res) => {
  try {
    await ensureAdminSchema();
    const result = await db.query(
      `WITH station_availability AS (
         SELECT s.id, s.station_name, s.capacity,
                COUNT(b.id) FILTER (
                  WHERE b.status = 'available'
                    AND NOT EXISTS (
                      SELECT 1 FROM bookings bk
                       WHERE bk.bike_id = b.id
                         AND bk.status IN ('active', 'pending')
                         AND bk.start_time <= NOW()
                         AND COALESCE(bk.end_time, bk.expires_at) > NOW()
                    )
                )::int AS available_bikes
           FROM stations s
           LEFT JOIN bikes b ON b.station_id = s.id
          WHERE s.is_active = TRUE
          GROUP BY s.id
       )
       SELECT
         (SELECT COUNT(*) FROM maintenance_logs WHERE status NOT IN ('resolved','closed') AND severity IN ('high','critical'))::int AS urgent_maintenance_count,
         (SELECT COUNT(*) FROM payments WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '7 days')::int AS failed_payments_count,
         (SELECT COUNT(*) FROM bookings WHERE created_at >= date_trunc('day', NOW()) AND created_at < date_trunc('day', NOW()) + INTERVAL '1 day')::int AS new_bookings_today,
         (SELECT COUNT(*) FROM station_availability WHERE capacity > 0 AND available_bikes::numeric / capacity <= 0.2)::int AS low_bike_availability_stations,
         (SELECT COUNT(*) FROM support_tickets WHERE status IN ('open', 'in_progress'))::int AS waiting_support_tickets`
    );
    const row = result.rows[0] || {};
    res.json({
      urgentMaintenanceCount: Number(row.urgent_maintenance_count || 0),
      failedPaymentsCount: Number(row.failed_payments_count || 0),
      newBookingsToday: Number(row.new_bookings_today || 0),
      lowBikeAvailabilityStations: Number(row.low_bike_availability_stations || 0),
      waitingSupportTickets: Number(row.waiting_support_tickets || 0),
    });
  } catch (err) {
    console.error("[GET /api/admin/alerts]", err);
    res.status(500).json({ error: "Could not load alerts." });
  }
});

router.post("/notifications/clear-old", requireAdmin, async (req, res) => {
  try {
    await settingsService.ensureSettingsSchema();
    await ensureStudentSchema();
    const result = await db.query(
      `DELETE FROM notifications
        WHERE (is_read = TRUE AND created_at < NOW() - INTERVAL '7 days')
           OR created_at < NOW() - INTERVAL '60 days'
       RETURNING id`
    );
    await settingsService.logAudit(
      req,
      "notifications_cleared",
      { description: "Old notifications cleared.", clearedCount: result.rowCount },
      "notifications"
    );
    res.json({ ok: true, cleared: result.rowCount });
  } catch (err) {
    console.error("[POST /api/admin/notifications/clear-old]", err);
    res.status(500).json({ error: "Could not clear old notifications." });
  }
});

router.get("/audit-logs", requireAdmin, async (req, res) => {
  try {
    await settingsService.ensureSettingsSchema();
    const type = String(req.query.type || "settings").toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 80, 200);
    if (type === "logins") {
      const result = await db.query(
        `SELECT l.id, COALESCE(u.full_name, l.admin_email, 'Admin') AS admin_name,
                COALESCE(l.admin_email, u.email, 'N/A') AS admin_email,
                l.status, l.ip_address::text AS ip_address, l.user_agent, l.created_at
           FROM admin_login_logs l
           LEFT JOIN users u ON u.id = l.admin_id
          ORDER BY l.created_at DESC LIMIT $1`,
        [limit]
      );
      return res.json({ logs: result.rows, type });
    }
    if (type === "accounts") {
      const result = await db.query(
        `SELECT id, full_name, email, role::text AS role, is_active, created_at
           FROM users ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
      return res.json({ logs: result.rows, type });
    }
    const actionFilter = type === "system"
      ? "AND a.action IN ('data_exported','settings_reset','notifications_cleared','security_settings_updated')"
      : type === "settings" ? "AND a.entity_type = 'admin_settings'" : "";
    const result = await db.query(
      `SELECT a.id, COALESCE(u.full_name, 'Admin User') AS admin_name,
              COALESCE(u.email, 'N/A') AS admin_email,
              a.action, a.entity_type, a.details, a.ip_address::text AS ip_address,
              a.user_agent, a.created_at
         FROM admin_audit_log a
         LEFT JOIN users u ON u.id = a.admin_id
        WHERE 1=1 ${actionFilter}
        ORDER BY a.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ logs: result.rows, type });
  } catch (err) {
    console.error("[GET /api/admin/audit-logs]", err);
    res.status(500).json({ error: "Could not load audit logs." });
  }
});

router.get("/activity-logs", requireAdmin, async (_req, res) => {
  try {
    await settingsService.ensureSettingsSchema();
    const [logins, accounts, settings, system] = await Promise.all([
      db.query(`SELECT COALESCE(u.full_name, l.admin_email, 'Admin') AS name, COALESCE(l.admin_email, u.email, 'N/A') AS email, l.status, l.user_agent, l.created_at FROM admin_login_logs l LEFT JOIN users u ON u.id = l.admin_id ORDER BY l.created_at DESC LIMIT 6`),
      db.query(`SELECT full_name AS name, email, role::text AS role, is_active, created_at FROM users ORDER BY created_at DESC LIMIT 6`),
      db.query(`SELECT a.action, a.details, COALESCE(u.full_name, 'Admin User') AS admin_name, a.created_at FROM admin_audit_log a LEFT JOIN users u ON u.id = a.admin_id WHERE a.entity_type = 'admin_settings' ORDER BY a.created_at DESC LIMIT 6`),
      db.query(`SELECT action, details, created_at FROM admin_audit_log WHERE action IN ('data_exported','settings_reset','notifications_cleared','security_settings_updated') ORDER BY created_at DESC LIMIT 6`),
    ]);
    res.json({ logins: logins.rows, accounts: accounts.rows, settings: settings.rows, system: system.rows });
  } catch (err) {
    console.error("[GET /api/admin/activity-logs]", err);
    res.status(500).json({ error: "Could not load admin activity logs." });
  }
});

module.exports = router;
