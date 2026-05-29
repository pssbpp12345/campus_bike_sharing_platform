// /api/admin/reports/* - database-backed Admin Reports Management.
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const adminMetrics = require("../services/adminMetrics");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";
const BAD_VISIBLE_RE = /demo|seed|test|profit|loss/i;

const REPORT_TYPES = new Set(["rides", "revenue", "stations", "bikes", "maintenance", "support", "payments", "operations"]);
const REPORT_FORMATS = new Set(["csv", "pdf", "xlsx"]);
const REPORT_STATUSES = new Set(["ready", "scheduled", "processing", "failed", "draft"]);
const FREQUENCIES = new Set(["none", "daily", "weekly", "monthly"]);

let schemaReadyPromise = null;

function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Admin login required." });
    const payload = jwt.verify(token, JWT_SECRET);
    if ((payload.role || "").toLowerCase() !== "admin") return res.status(403).json({ error: "Administrator access required." });
    req.user = payload;
    next();
  } catch (_) {
    res.status(401).json({ error: "Invalid or expired admin session." });
  }
}

async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS admin_reports (
          id SERIAL PRIMARY KEY,
          report_code VARCHAR(30) UNIQUE,
          report_name VARCHAR(160) NOT NULL,
          report_type VARCHAR(40) NOT NULL,
          period_label VARCHAR(120),
          date_from DATE,
          date_to DATE,
          file_format VARCHAR(20) NOT NULL DEFAULT 'CSV',
          generated_by VARCHAR(120),
          status VARCHAR(30) NOT NULL DEFAULT 'ready',
          file_size VARCHAR(40),
          file_path TEXT,
          include_charts BOOLEAN NOT NULL DEFAULT TRUE,
          include_raw_data BOOLEAN NOT NULL DEFAULT FALSE,
          schedule_frequency VARCHAR(30) NOT NULL DEFAULT 'none',
          next_run_at TIMESTAMPTZ,
          last_downloaded_at TIMESTAMPTZ,
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS admin_report_activity (
          id SERIAL PRIMARY KEY,
          report_id INTEGER REFERENCES admin_reports(id) ON DELETE SET NULL,
          activity_type VARCHAR(60),
          title VARCHAR(160),
          description TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query("CREATE INDEX IF NOT EXISTS idx_admin_reports_type ON admin_reports(report_type)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_admin_reports_status ON admin_reports(status)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_admin_reports_created ON admin_reports(created_at DESC)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_admin_report_activity_created ON admin_report_activity(created_at DESC)");
      await db.query("UPDATE admin_reports SET report_code = 'RPT-' || LPAD(id::text, 4, '0') WHERE report_code IS NULL OR report_code = ''");
    })().catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }
  return schemaReadyPromise;
}

router.use(requireAdmin);
router.use(async (_req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (err) {
    console.error("[adminReports schema]", err);
    res.status(500).json({ error: "Could not prepare reports schema." });
  }
});

function cleanDisplay(value, fallback = "Not assigned") {
  const text = String(value == null ? "" : value).trim();
  if (!text || BAD_VISIBLE_RE.test(text)) return fallback;
  return text.replace(/\s+/g, " ");
}

function titleCase(value) {
  return cleanDisplay(value, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function reportCode(id) {
  return "RPT-" + String(id || 0).padStart(4, "0");
}

function reportTypeLabel(value) {
  const key = String(value || "").toLowerCase();
  if (key === "revenue" || key === "payments") return "Revenue & Payments";
  if (key === "bikes") return "Bike Fleet";
  if (key === "support") return "Support Issues";
  if (key === "operations") return "Full Operations";
  return titleCase(key || "rides");
}

function parsePositiveInt(value, fallback, max = 100) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function parseType(value, fallback = "rides") {
  const key = String(value || "").toLowerCase();
  return REPORT_TYPES.has(key) ? key : fallback;
}

function parseFormat(value) {
  const key = String(value || "csv").toLowerCase();
  return REPORT_FORMATS.has(key) ? key : "csv";
}

function parseStatus(value) {
  const key = String(value || "ready").toLowerCase();
  return REPORT_STATUSES.has(key) ? key : "ready";
}

function parseFrequency(value) {
  const key = String(value || "none").toLowerCase();
  return FREQUENCIES.has(key) ? key : "none";
}

function nextRunAt(frequency) {
  if (frequency === "none") return null;
  const d = new Date();
  d.setHours(8, 0, 0, 0);
  if (frequency === "daily") d.setDate(d.getDate() + 1);
  if (frequency === "weekly") d.setDate(d.getDate() + 7);
  if (frequency === "monthly") d.setMonth(d.getMonth() + 1);
  return d;
}

function periodLabel(dateFrom, dateTo, fallback = "Current period") {
  if (!dateFrom && !dateTo) return fallback;
  const fmt = new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "short", year: "numeric" });
  const from = dateFrom ? fmt.format(new Date(dateFrom)) : "Start";
  const to = dateTo ? fmt.format(new Date(dateTo)) : "Today";
  return `${from} - ${to}`;
}

function fileSizeLabel(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function parseFileSizeBytes(value) {
  const text = String(value || "");
  const amount = Number((text.match(/[\d.]+/) || [0])[0]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (/mb/i.test(text)) return amount * 1024 * 1024;
  if (/kb/i.test(text)) return amount * 1024;
  return amount;
}

function csvEscape(value) {
  return `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;
}

function rowsToCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  rows.forEach((row) => lines.push(headers.map((h) => csvEscape(row[h])).join(",")));
  return lines.join("\n");
}

function mapReport(row) {
  return {
    id: Number(row.id),
    reportId: cleanDisplay(row.report_code, reportCode(row.id)),
    reportName: cleanDisplay(row.report_name, "Operational report"),
    type: cleanDisplay(row.report_type, "rides").toLowerCase(),
    typeLabel: reportTypeLabel(row.report_type || "rides"),
    period: cleanDisplay(row.period_label, "Current period"),
    dateFrom: row.date_from,
    dateTo: row.date_to,
    format: cleanDisplay(row.file_format, "CSV").toUpperCase(),
    generatedBy: cleanDisplay(row.generated_by, "Admin User"),
    status: cleanDisplay(row.status, "ready").toLowerCase(),
    statusLabel: titleCase(row.status || "ready"),
    fileSize: cleanDisplay(row.file_size, "Not generated"),
    includeCharts: Boolean(row.include_charts),
    includeRawData: Boolean(row.include_raw_data),
    scheduleFrequency: cleanDisplay(row.schedule_frequency, "none").toLowerCase(),
    nextRunAt: row.next_run_at,
    lastDownloadedAt: row.last_downloaded_at,
    notes: cleanDisplay(row.notes, "No notes recorded."),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function logActivity(reportId, type, title, description) {
  await db.query(
    `INSERT INTO admin_report_activity (report_id, activity_type, title, description, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [reportId || null, type, title, description]
  ).catch((err) => console.warn("[adminReports activity]", err.message));
}

function buildFilters(query) {
  const params = [];
  const where = [];
  const push = (value) => {
    params.push(value);
    return "$" + params.length;
  };
  if (query.search) {
    const p = push("%" + String(query.search).trim() + "%");
    where.push(`(report_code ILIKE ${p} OR report_name ILIKE ${p} OR report_type ILIKE ${p} OR generated_by ILIKE ${p})`);
  }
  if (query.type && query.type !== "all") where.push(`report_type = ${push(parseType(query.type))}`);
  if (query.status && query.status !== "all") where.push(`status = ${push(parseStatus(query.status))}`);
  if (query.format && query.format !== "all") where.push(`LOWER(file_format) = ${push(parseFormat(query.format))}`);
  if (query.dateFrom) where.push(`created_at >= ${push(query.dateFrom)}::date`);
  if (query.dateTo) where.push(`created_at < (${push(query.dateTo)}::date + INTERVAL '1 day')`);
  return { params, clause: where.length ? " WHERE " + where.join(" AND ") : "" };
}

router.get("/overview", async (req, res) => {
  try {
    const range = adminMetrics.parseRange(req.query.range);
    const result = await db.query(
      `
      WITH cur AS (
        SELECT
          COUNT(*)::int AS reports_generated,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_exports
        FROM admin_reports
        WHERE created_at >= $1 AND created_at < $2
      ),
      prev AS (
        SELECT
          COUNT(*)::int AS reports_generated,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_exports
        FROM admin_reports
        WHERE created_at >= $3 AND created_at < $4
      ),
      downloads AS (
        SELECT
          COUNT(*) FILTER (
            WHERE last_downloaded_at >= date_trunc('month', NOW())
              AND last_downloaded_at < date_trunc('month', NOW()) + INTERVAL '1 month'
          )::int AS downloads_this_month,
          COUNT(*) FILTER (
            WHERE last_downloaded_at >= date_trunc('month', NOW()) - INTERVAL '1 month'
              AND last_downloaded_at < date_trunc('month', NOW())
          )::int AS prev_downloads_this_month
        FROM admin_reports
      ),
      status_totals AS (
        SELECT
          COUNT(*) FILTER (WHERE schedule_frequency <> 'none')::int AS scheduled_reports,
          COUNT(*) FILTER (WHERE status IN ('processing','draft','scheduled'))::int AS pending_reports
        FROM admin_reports
      ),
      top_type AS (
        SELECT report_type, COUNT(*)::int AS report_count
        FROM admin_reports
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY report_type
        ORDER BY report_count DESC, report_type
        LIMIT 1
      ),
      latest AS (
        SELECT report_name, created_at
        FROM admin_reports
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      )
      SELECT cur.*, prev.reports_generated AS prev_reports_generated, prev.failed_exports AS prev_failed_exports,
             downloads.downloads_this_month, downloads.prev_downloads_this_month,
             status_totals.scheduled_reports, status_totals.pending_reports,
             top_type.report_type AS most_exported_type, top_type.report_count AS most_exported_count,
             latest.report_name AS last_generated_report, latest.created_at AS last_generated_at
      FROM cur, prev, downloads, status_totals
      LEFT JOIN top_type ON TRUE
      LEFT JOIN latest ON TRUE
      `,
      [range.currentStart, range.currentEnd, range.prevStart, range.prevEnd]
    );
    const row = result.rows[0] || {};
    const fileSizes = await db.query(
      `SELECT file_size
         FROM admin_reports
        WHERE created_at >= $1 AND created_at < $2
          AND file_size IS NOT NULL
          AND file_size ~ '[0-9]'`,
      [range.currentStart, range.currentEnd]
    );
    const sizeBytes = fileSizes.rows.map((r) => parseFileSizeBytes(r.file_size)).filter((n) => n > 0);
    const averageFileSize = sizeBytes.length ? fileSizeLabel(sizeBytes.reduce((sum, n) => sum + n, 0) / sizeBytes.length) : "Not available";
    const totals = {
      reportsGenerated: Number(row.reports_generated || 0),
      downloadsThisMonth: Number(row.downloads_this_month || 0),
      scheduledReports: Number(row.scheduled_reports || 0),
      failedExports: Number(row.failed_exports || 0),
      mostExportedType: reportTypeLabel(row.most_exported_type || "rides"),
      lastGeneratedReport: cleanDisplay(row.last_generated_report, "No reports yet"),
      averageFileSize,
      pendingReports: Number(row.pending_reports || 0),
    };
    res.json({
      range: range.key,
      totals,
      trends: {
        reportsGenerated: adminMetrics.pctTrend(totals.reportsGenerated, row.prev_reports_generated),
        downloadsThisMonth: adminMetrics.pctTrend(totals.downloadsThisMonth, row.prev_downloads_this_month),
        scheduledReports: "Active schedules",
        failedExports: adminMetrics.pctTrend(totals.failedExports, row.prev_failed_exports),
        mostExportedType: `${Number(row.most_exported_count || 0)} generated`,
        lastGeneratedReport: row.last_generated_at ? periodLabel(row.last_generated_at, row.last_generated_at, "Latest export") : "No activity yet",
        averageFileSize: sizeBytes.length ? "Based on generated files" : "No completed files",
        pendingReports: "Processing, draft, or scheduled",
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/reports/overview]", err);
    res.status(500).json({ error: "Could not load reports overview." });
  }
});

router.get("/trends", async (req, res) => {
  try {
    const range = adminMetrics.parseRange(req.query.range);
    const unit = range.key === "today" ? "hour" : range.key === "year" ? "month" : "day";
    const count = range.key === "today" ? 7 : range.key === "year" ? 12 : range.key === "month" ? 30 : 7;
    const result = await db.query(
      `
      WITH buckets AS (
        SELECT generate_series(date_trunc($3, $1::timestamptz), date_trunc($3, $2::timestamptz), ('1 ' || $3)::interval) AS bucket_start
      ),
      limited AS (
        SELECT bucket_start, bucket_start + ('1 ' || $3)::interval AS bucket_end FROM buckets ORDER BY bucket_start DESC LIMIT $4
      )
      SELECT l.bucket_start,
             COUNT(r.id) FILTER (WHERE r.report_type = 'rides')::int AS ride_reports,
             COUNT(r.id) FILTER (WHERE r.report_type IN ('revenue','payments'))::int AS revenue_reports,
             COUNT(r.id) FILTER (WHERE r.report_type = 'maintenance')::int AS maintenance_reports
      FROM limited l
      LEFT JOIN admin_reports r ON r.created_at >= l.bucket_start AND r.created_at < l.bucket_end
      GROUP BY l.bucket_start
      ORDER BY l.bucket_start ASC
      `,
      [range.currentStart, range.currentEnd, unit, count]
    );
    res.json({
      labels: result.rows.map((r) => r.bucket_start),
      rideReports: result.rows.map((r) => Number(r.ride_reports || 0)),
      revenueReports: result.rows.map((r) => Number(r.revenue_reports || 0)),
      maintenanceReports: result.rows.map((r) => Number(r.maintenance_reports || 0)),
    });
  } catch (err) {
    console.error("[GET /api/admin/reports/trends]", err);
    res.status(500).json({ error: "Could not load report trends." });
  }
});

router.get("/type-breakdown", async (req, res) => {
  try {
    const range = adminMetrics.parseRange(req.query.range);
    const result = await db.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE report_type = 'rides')::int AS rides,
        COUNT(*) FILTER (WHERE report_type IN ('revenue','payments'))::int AS revenue,
        COUNT(*) FILTER (WHERE report_type = 'stations')::int AS stations,
        COUNT(*) FILTER (WHERE report_type = 'bikes')::int AS bikes,
        COUNT(*) FILTER (WHERE report_type = 'maintenance')::int AS maintenance,
        COUNT(*) FILTER (WHERE report_type = 'support')::int AS support
      FROM admin_reports
      WHERE created_at >= $1 AND created_at < $2
      `,
      [range.currentStart, range.currentEnd]
    );
    const row = result.rows[0] || {};
    res.json({
      rides: Number(row.rides || 0),
      revenue: Number(row.revenue || 0),
      stations: Number(row.stations || 0),
      bikes: Number(row.bikes || 0),
      maintenance: Number(row.maintenance || 0),
      support: Number(row.support || 0),
    });
  } catch (err) {
    console.error("[GET /api/admin/reports/type-breakdown]", err);
    res.status(500).json({ error: "Could not load report type breakdown." });
  }
});

router.get("/quick-export-options", async (_req, res) => {
  try {
    const quick = [
      { type: "rides", name: "Ride Summary", description: "Bookings, ride duration, stations, and fare totals." },
      { type: "revenue", name: "Revenue Summary", description: "Paid payments, refunds, failed payments, and methods." },
      { type: "stations", name: "Station Usage", description: "Station capacity, active stations, and bike availability." },
      { type: "maintenance", name: "Maintenance Snapshot", description: "Open repairs, urgent tasks, repair costs, and completion." },
      { type: "support", name: "Support Trends", description: "Open issues, categories, priorities, and response status." },
    ];
    const catalog = [
      { type: "rides", name: "Ride Activity Report", description: "Bookings, active rides, completed rides, cancelled rides, ride duration, and station usage." },
      { type: "revenue", name: "Revenue & Payments Report", description: "Paid payments, refunds, failed payments, net revenue, and payment methods." },
      { type: "stations", name: "Station Performance Report", description: "Station capacity, available bikes, low availability, full stations, and active stations." },
      { type: "bikes", name: "Bike Fleet Report", description: "Available bikes, active bikes, maintenance bikes, low battery bikes, and bike usage." },
      { type: "maintenance", name: "Maintenance Report", description: "Open repairs, completed repairs, urgent tasks, repair costs, and technician activity." },
      { type: "support", name: "Support Issues Report", description: "Support tickets, issue categories, open issues, resolved issues, and response trends." },
    ];
    const latest = await db.query(
      `WITH normalised AS (
         SELECT CASE WHEN report_type = 'payments' THEN 'revenue' ELSE report_type END AS report_type,
                report_code, report_name, created_at
           FROM admin_reports
          WHERE report_type IN ('rides','revenue','payments','stations','bikes','maintenance','support')
       )
       SELECT DISTINCT ON (report_type) report_type, report_code, report_name, created_at
         FROM normalised
        ORDER BY report_type, created_at DESC`
    );
    const latestByType = new Map(latest.rows.map((row) => [row.report_type, row]));
    res.json({
      options: quick,
      catalog: catalog.map((item) => {
        const row = latestByType.get(item.type);
        return {
          ...item,
          latestReportId: row ? cleanDisplay(row.report_code, "") : "",
          latestGeneratedAt: row ? row.created_at : null,
          latestReportName: row ? cleanDisplay(row.report_name, item.name) : "",
        };
      }),
    });
  } catch (err) {
    console.error("[GET /api/admin/reports/quick-export-options]", err);
    res.status(500).json({ error: "Could not load report export options." });
  }
});

router.get("/scheduled", async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 5, 20);
    const result = await db.query(
      `SELECT * FROM admin_reports
       WHERE status = 'scheduled' OR schedule_frequency <> 'none'
       ORDER BY next_run_at NULLS LAST, updated_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ reports: result.rows.map(mapReport) });
  } catch (err) {
    console.error("[GET /api/admin/reports/scheduled]", err);
    res.status(500).json({ error: "Could not load scheduled reports." });
  }
});

router.get("/activity", async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 5, 20);
    const result = await db.query(
      `SELECT a.*, r.report_code
         FROM admin_report_activity a
         LEFT JOIN admin_reports r ON r.id = a.report_id
        ORDER BY a.created_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json({
      activity: result.rows.map((r) => ({
        id: Number(r.id),
        reportId: cleanDisplay(r.report_code, r.report_id ? reportCode(r.report_id) : ""),
        type: cleanDisplay(r.activity_type, "report_activity"),
        title: cleanDisplay(r.title, "Report activity"),
        description: cleanDisplay(r.description, "Report update"),
        timestamp: r.created_at,
      })),
    });
  } catch (err) {
    console.error("[GET /api/admin/reports/activity]", err);
    res.status(500).json({ error: "Could not load report activity." });
  }
});

router.get("/list", async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, 100000);
    const limit = parsePositiveInt(req.query.limit, 10, 100);
    const offset = (page - 1) * limit;
    const filters = buildFilters(req.query);
    const countResult = await db.query(`SELECT COUNT(*)::int AS total FROM admin_reports${filters.clause}`, filters.params);
    const total = Number(countResult.rows[0]?.total || 0);
    const params = [...filters.params, limit, offset];
    const result = await db.query(
      `SELECT * FROM admin_reports${filters.clause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ reports: result.rows.map(mapReport), total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    console.error("[GET /api/admin/reports/list]", err);
    res.status(500).json({ error: "Could not load reports." });
  }
});

async function findReport(rawId) {
  const value = String(rawId || "").trim();
  const numeric = Number.parseInt(value.replace(/^RPT-/i, ""), 10);
  const result = await db.query(
    `SELECT * FROM admin_reports WHERE id = $1 OR report_code = $2 LIMIT 1`,
    [Number.isFinite(numeric) ? numeric : 0, value.toUpperCase()]
  );
  return result.rows[0] || null;
}

router.get("/:reportId", async (req, res) => {
  try {
    const report = await findReport(req.params.reportId);
    if (!report) return res.status(404).json({ error: "Report not found." });
    res.json({ report: mapReport(report) });
  } catch (err) {
    console.error("[GET /api/admin/reports/:reportId]", err);
    res.status(500).json({ error: "Could not load report details." });
  }
});

router.post("/generate", async (req, res) => {
  try {
    const type = parseType(req.body.reportType || req.body.type);
    const format = parseFormat(req.body.format);
    const frequency = parseFrequency(req.body.scheduleFrequency);
    const status = frequency === "none" ? "ready" : "scheduled";
    const name = cleanDisplay(req.body.reportName, `${titleCase(type)} Report`).slice(0, 160);
    const dateFrom = req.body.dateFrom || null;
    const dateTo = req.body.dateTo || null;
    const nextRun = nextRunAt(frequency);
    const generatedBy = cleanDisplay(req.user.full_name || req.user.name || "Admin User", "Admin User").slice(0, 120);
    const inserted = await db.query(
      `INSERT INTO admin_reports
        (report_name, report_type, period_label, date_from, date_to, file_format, generated_by, status, file_size,
         include_charts, include_raw_data, schedule_frequency, next_run_at, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
       RETURNING id`,
      [
        name,
        type,
        periodLabel(dateFrom, dateTo, "Selected period"),
        dateFrom,
        dateTo,
        format.toUpperCase(),
        generatedBy,
        status,
        format === "csv" ? "Ready for export" : "Format queued",
        req.body.includeCharts !== false,
        Boolean(req.body.includeRawData),
        frequency,
        nextRun,
        cleanDisplay(req.body.notes, ""),
      ]
    );
    const result = await db.query(
      `UPDATE admin_reports
          SET report_code = 'RPT-' || LPAD(id::text, 4, '0'), updated_at = NOW()
        WHERE id = $1
      RETURNING *`,
      [inserted.rows[0].id]
    );
    const report = result.rows[0];
    await logActivity(report.id, status === "scheduled" ? "report_scheduled" : "report_generated", `${reportTypeLabel(type)} report ${status === "scheduled" ? "scheduled" : "generated"}`, name);
    res.status(201).json({ report: mapReport(report) });
  } catch (err) {
    console.error("[POST /api/admin/reports/generate]", err);
    res.status(500).json({ error: "Could not generate report." });
  }
});

async function reportData(type, dateFrom, dateTo) {
  if (type === "rides") {
    const result = await db.query(
      `SELECT 'BK-' || LPAD(bk.id::text, 4, '0') AS "Booking ID",
              u.full_name AS "Student",
              bi.bike_code AS "Bike",
              ps.station_name AS "Pickup Station",
              COALESCE(rs.station_name, 'In progress') AS "Return Station",
              bk.status::text AS "Status",
              bk.start_time AS "Start Time",
              bk.end_time AS "End Time",
              COALESCE(bk.duration_minutes, 0) AS "Duration Minutes",
              bk.fee_amount AS "Amount"
         FROM bookings bk
         JOIN users u ON u.id = bk.user_id
         JOIN bikes bi ON bi.id = bk.bike_id
         JOIN stations ps ON ps.id = bk.pickup_station_id
         LEFT JOIN stations rs ON rs.id = bk.return_station_id
        WHERE ($1::date IS NULL OR bk.start_time >= $1::date)
          AND ($2::date IS NULL OR bk.start_time < ($2::date + INTERVAL '1 day'))
        ORDER BY bk.start_time DESC
        LIMIT 1000`,
      [dateFrom, dateTo]
    );
    return { headers: ["Booking ID", "Student", "Bike", "Pickup Station", "Return Station", "Status", "Start Time", "End Time", "Duration Minutes", "Amount"], rows: result.rows };
  }
  if (type === "revenue" || type === "payments") {
    const result = await db.query(
      `SELECT 'PM-' || LPAD(p.id::text, 4, '0') AS "Payment ID",
              'BK-' || LPAD(p.booking_id::text, 4, '0') AS "Booking ID",
              u.full_name AS "Student",
              p.amount AS "Amount",
              p.currency AS "Currency",
              p.payment_method::text AS "Method",
              p.status::text AS "Status",
              COALESCE(p.transaction_reference, '') AS "Reference",
              COALESCE(p.paid_at, p.created_at) AS "Payment Date"
         FROM payments p
         JOIN users u ON u.id = p.user_id
        WHERE ($1::date IS NULL OR COALESCE(p.paid_at, p.created_at) >= $1::date)
          AND ($2::date IS NULL OR COALESCE(p.paid_at, p.created_at) < ($2::date + INTERVAL '1 day'))
        ORDER BY COALESCE(p.paid_at, p.created_at) DESC
        LIMIT 1000`,
      [dateFrom, dateTo]
    );
    return { headers: ["Payment ID", "Booking ID", "Student", "Amount", "Currency", "Method", "Status", "Reference", "Payment Date"], rows: result.rows };
  }
  if (type === "stations") {
    const result = await db.query(
      `SELECT s.station_name AS "Station",
              COALESCE(s.campus_zone, '') AS "Zone",
              s.capacity AS "Capacity",
              COUNT(DISTINCT b.id) FILTER (WHERE b.status::text = 'available') AS "Available Bikes",
              COUNT(DISTINCT bk.id) AS "Bookings",
              s.status AS "Status"
         FROM stations s
         LEFT JOIN bikes b ON b.station_id = s.id
         LEFT JOIN bookings bk ON bk.pickup_station_id = s.id
          AND ($1::date IS NULL OR bk.start_time >= $1::date)
          AND ($2::date IS NULL OR bk.start_time < ($2::date + INTERVAL '1 day'))
        GROUP BY s.id
        ORDER BY "Bookings" DESC, s.station_name
        LIMIT 1000`,
      [dateFrom, dateTo]
    );
    return { headers: ["Station", "Zone", "Capacity", "Available Bikes", "Bookings", "Status"], rows: result.rows };
  }
  if (type === "bikes") {
    const result = await db.query(
      `SELECT b.bike_code AS "Bike ID",
              COALESCE(b.model, 'Standard') AS "Type",
              COALESCE(s.station_name, 'Unassigned') AS "Current Station",
              b.status::text AS "Status",
              COALESCE(b.battery_level, 100) AS "Battery Level",
              COALESCE(b.condition, 'good') AS "Condition",
              COALESCE(b.gps_status, 'online') AS "GPS Status",
              COALESCE(b.total_rides, 0) AS "Total Rides",
              b.last_used_at AS "Last Used",
              b.last_maintenance_at AS "Last Maintenance"
         FROM bikes b
         LEFT JOIN stations s ON s.id = b.station_id
        ORDER BY b.bike_code
        LIMIT 1000`
    );
    return { headers: ["Bike ID", "Type", "Current Station", "Status", "Battery Level", "Condition", "GPS Status", "Total Rides", "Last Used", "Last Maintenance"], rows: result.rows };
  }
  if (type === "maintenance") {
    const result = await db.query(
      `SELECT 'MT-' || LPAD(ml.id::text, 4, '0') AS "Task ID",
              CASE WHEN ml.asset_type = 'station' THEN 'Station' ELSE 'Bike' END AS "Asset Type",
              COALESCE(b.bike_code, s.station_name, '') AS "Asset",
              ml.issue_type AS "Issue",
              ml.priority AS "Priority",
              ml.status::text AS "Status",
              ml.cost AS "Cost",
              ml.reported_at AS "Reported At",
              COALESCE(ml.completed_at, ml.resolved_at) AS "Completed At"
         FROM maintenance_logs ml
         LEFT JOIN bikes b ON b.id = ml.bike_id
         LEFT JOIN stations s ON s.id = ml.station_id
        WHERE ($1::date IS NULL OR ml.reported_at >= $1::date)
          AND ($2::date IS NULL OR ml.reported_at < ($2::date + INTERVAL '1 day'))
        ORDER BY ml.reported_at DESC
        LIMIT 1000`,
      [dateFrom, dateTo]
    );
    return { headers: ["Task ID", "Asset Type", "Asset", "Issue", "Priority", "Status", "Cost", "Reported At", "Completed At"], rows: result.rows };
  }
  if (type === "operations") {
    const result = await db.query(
      `WITH booking_summary AS (
         SELECT COUNT(*)::int AS total_bookings,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_rides,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active_rides,
                COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_rides
           FROM bookings
          WHERE ($1::date IS NULL OR start_time >= $1::date)
            AND ($2::date IS NULL OR start_time < ($2::date + INTERVAL '1 day'))
       ),
       payment_summary AS (
         SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)::numeric AS paid_revenue,
                COALESCE(SUM(amount) FILTER (WHERE status = 'refunded'), 0)::numeric AS refunded_amount,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_payments
           FROM payments
          WHERE ($1::date IS NULL OR COALESCE(paid_at, created_at) >= $1::date)
            AND ($2::date IS NULL OR COALESCE(paid_at, created_at) < ($2::date + INTERVAL '1 day'))
       ),
       bike_summary AS (
         SELECT COUNT(*)::int AS total_bikes,
                COUNT(*) FILTER (WHERE status::text = 'available')::int AS available_bikes,
                COUNT(*) FILTER (WHERE status::text IN ('active','in_use'))::int AS active_bikes,
                COUNT(*) FILTER (WHERE status::text = 'maintenance')::int AS maintenance_bikes
           FROM bikes
       ),
       station_summary AS (
         SELECT COUNT(*)::int AS total_stations,
                COUNT(*) FILTER (WHERE COALESCE(status::text, 'active') = 'active' OR is_active = TRUE)::int AS active_stations
           FROM stations
       ),
       maintenance_summary AS (
         SELECT COUNT(*) FILTER (WHERE status::text NOT IN ('completed','resolved'))::int AS open_tasks,
                COALESCE(SUM(cost), 0)::numeric AS maintenance_cost
           FROM maintenance_logs
          WHERE ($1::date IS NULL OR COALESCE(reported_at, created_at) >= $1::date)
            AND ($2::date IS NULL OR COALESCE(reported_at, created_at) < ($2::date + INTERVAL '1 day'))
       ),
       support_summary AS (
         SELECT COUNT(*) FILTER (WHERE status::text NOT IN ('resolved','closed'))::int AS open_tickets,
                COUNT(*) FILTER (WHERE status::text IN ('resolved','closed'))::int AS resolved_tickets
           FROM support_tickets
          WHERE ($1::date IS NULL OR created_at >= $1::date)
            AND ($2::date IS NULL OR created_at < ($2::date + INTERVAL '1 day'))
       )
       SELECT 'Rides' AS "Area", 'Total bookings' AS "Metric", total_bookings::text AS "Value" FROM booking_summary
       UNION ALL SELECT 'Rides', 'Completed rides', completed_rides::text FROM booking_summary
       UNION ALL SELECT 'Rides', 'Active rides', active_rides::text FROM booking_summary
       UNION ALL SELECT 'Rides', 'Cancelled rides', cancelled_rides::text FROM booking_summary
       UNION ALL SELECT 'Payments', 'Paid revenue', paid_revenue::text FROM payment_summary
       UNION ALL SELECT 'Payments', 'Refunded amount', refunded_amount::text FROM payment_summary
       UNION ALL SELECT 'Payments', 'Failed payments', failed_payments::text FROM payment_summary
       UNION ALL SELECT 'Bikes', 'Total bikes', total_bikes::text FROM bike_summary
       UNION ALL SELECT 'Bikes', 'Available bikes', available_bikes::text FROM bike_summary
       UNION ALL SELECT 'Bikes', 'Active bikes', active_bikes::text FROM bike_summary
       UNION ALL SELECT 'Bikes', 'Maintenance bikes', maintenance_bikes::text FROM bike_summary
       UNION ALL SELECT 'Stations', 'Total stations', total_stations::text FROM station_summary
       UNION ALL SELECT 'Stations', 'Active stations', active_stations::text FROM station_summary
       UNION ALL SELECT 'Maintenance', 'Open tasks', open_tasks::text FROM maintenance_summary
       UNION ALL SELECT 'Maintenance', 'Maintenance cost', maintenance_cost::text FROM maintenance_summary
       UNION ALL SELECT 'Support', 'Open tickets', open_tickets::text FROM support_summary
       UNION ALL SELECT 'Support', 'Resolved tickets', resolved_tickets::text FROM support_summary`,
      [dateFrom, dateTo]
    );
    return { headers: ["Area", "Metric", "Value"], rows: result.rows };
  }
  const result = await db.query(
    `SELECT COALESCE(st.ticket_code, 'TK-' || LPAD(st.id::text, 4, '0')) AS "Ticket ID",
            COALESCE(st.student_name, u.full_name) AS "Student",
            st.category::text AS "Category",
            st.subject AS "Subject",
            st.priority::text AS "Priority",
            st.status::text AS "Status",
            st.created_at AS "Created At",
            COALESCE(st.resolved_at, NULL) AS "Resolved At"
       FROM support_tickets st
       LEFT JOIN users u ON u.id = st.user_id
      WHERE ($1::date IS NULL OR st.created_at >= $1::date)
        AND ($2::date IS NULL OR st.created_at < ($2::date + INTERVAL '1 day'))
      ORDER BY st.created_at DESC
      LIMIT 1000`,
    [dateFrom, dateTo]
  );
  return { headers: ["Ticket ID", "Student", "Category", "Subject", "Priority", "Status", "Created At", "Resolved At"], rows: result.rows };
}

router.get("/:reportId/download", async (req, res) => {
  try {
    const report = await findReport(req.params.reportId);
    if (!report) return res.status(404).json({ error: "Report not found." });
    if (String(report.file_format || "CSV").toLowerCase() !== "csv") {
      return res.status(400).json({ error: `${String(report.file_format).toUpperCase()} export will be added in the next version. CSV download is available now.` });
    }
    const data = await reportData(report.report_type, report.date_from, report.date_to);
    const csv = rowsToCsv(data.headers, data.rows);
    const bytes = Buffer.byteLength(csv, "utf8");
    await db.query("UPDATE admin_reports SET last_downloaded_at = NOW(), file_size = $1, updated_at = NOW() WHERE id = $2", [fileSizeLabel(bytes), report.id]);
    await logActivity(report.id, "report_downloaded", `${reportTypeLabel(report.report_type)} report downloaded`, cleanDisplay(report.report_name, "Report"));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${cleanDisplay(report.report_code, reportCode(report.id)).toLowerCase()}-${report.report_type}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error("[GET /api/admin/reports/:reportId/download]", err);
    res.status(500).json({ error: "Could not download report." });
  }
});

router.post("/:reportId/regenerate", async (req, res) => {
  try {
    const report = await findReport(req.params.reportId);
    if (!report) return res.status(404).json({ error: "Report not found." });
    const result = await db.query(
      `UPDATE admin_reports
          SET status = 'ready', file_size = CASE WHEN LOWER(file_format) = 'csv' THEN 'Ready for export' ELSE file_size END, updated_at = NOW()
        WHERE id = $1
      RETURNING *`,
      [report.id]
    );
    await logActivity(report.id, "report_regenerated", `${reportTypeLabel(report.report_type)} report regenerated`, cleanDisplay(report.report_name, "Report"));
    res.json({ report: mapReport(result.rows[0]) });
  } catch (err) {
    console.error("[POST /api/admin/reports/:reportId/regenerate]", err);
    res.status(500).json({ error: "Could not regenerate report." });
  }
});

router.post("/:reportId/schedule", async (req, res) => {
  try {
    const report = await findReport(req.params.reportId);
    if (!report) return res.status(404).json({ error: "Report not found." });
    const frequency = parseFrequency(req.body.frequency || req.body.scheduleFrequency || "weekly");
    const result = await db.query(
      `UPDATE admin_reports
          SET schedule_frequency = $1::varchar, status = CASE WHEN $1::varchar = 'none' THEN 'ready' ELSE 'scheduled' END,
              next_run_at = $2, updated_at = NOW()
        WHERE id = $3
      RETURNING *`,
      [frequency, nextRunAt(frequency), report.id]
    );
    await logActivity(report.id, "report_scheduled", `${reportTypeLabel(report.report_type)} report scheduled`, `${cleanDisplay(report.report_name, "Report")} set to ${frequency}.`);
    res.json({ report: mapReport(result.rows[0]) });
  } catch (err) {
    console.error("[POST /api/admin/reports/:reportId/schedule]", err);
    res.status(500).json({ error: "Could not schedule report." });
  }
});

router.delete("/:reportId", async (req, res) => {
  try {
    const report = await findReport(req.params.reportId);
    if (!report) return res.status(404).json({ error: "Report not found." });
    await db.query("UPDATE admin_report_activity SET report_id = NULL WHERE report_id = $1", [report.id]);
    await db.query("DELETE FROM admin_reports WHERE id = $1", [report.id]);
    await logActivity(null, "report_deleted", "Report deleted", cleanDisplay(report.report_name, "Report"));
    res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/admin/reports/:reportId]", err);
    res.status(500).json({ error: "Could not delete report." });
  }
});

module.exports = router;
