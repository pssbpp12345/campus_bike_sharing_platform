// /api/admin/support/* - database-backed Admin Support Issues Management.
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const adminMetrics = require("../services/adminMetrics");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";
const BAD_VISIBLE_RE = /demo|seed|test|profit|loss/i;

const OPEN_STATUSES = ["new", "open", "pending"];
const ACTIVE_STATUSES = ["new", "open", "pending", "in_progress", "waiting_student", "escalated"];
const CLOSED_STATUSES = ["resolved", "closed"];
const PRIORITIES = new Set(["low", "medium", "high", "urgent"]);
const STATUSES = new Set(["new", "open", "pending", "in_progress", "waiting_student", "escalated", "resolved", "closed"]);
const CATEGORIES = new Set(["booking", "payment", "billing", "refund", "bike", "bike_issue", "maintenance", "account", "station", "general", "other"]);

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
      await db.query("ALTER TYPE ticket_status ADD VALUE IF NOT EXISTS 'new'");
      await db.query("ALTER TYPE ticket_status ADD VALUE IF NOT EXISTS 'pending'");
      await db.query("ALTER TYPE ticket_status ADD VALUE IF NOT EXISTS 'waiting_student'");
      await db.query("ALTER TYPE ticket_status ADD VALUE IF NOT EXISTS 'escalated'");
      await db.query("ALTER TYPE ticket_category ADD VALUE IF NOT EXISTS 'bike_issue'");
      await db.query("ALTER TYPE ticket_category ADD VALUE IF NOT EXISTS 'maintenance'");
      await db.query("ALTER TYPE ticket_category ADD VALUE IF NOT EXISTS 'general'");
      await db.query("ALTER TYPE ticket_category ADD VALUE IF NOT EXISTS 'billing'");
      await db.query("ALTER TYPE ticket_category ADD VALUE IF NOT EXISTS 'refund'");
      await db.query(`
        ALTER TABLE support_tickets
          ADD COLUMN IF NOT EXISTS ticket_code VARCHAR(30),
          ADD COLUMN IF NOT EXISTS student_name VARCHAR(120),
          ADD COLUMN IF NOT EXISTS message TEXT,
          ADD COLUMN IF NOT EXISTS assigned_to VARCHAR(120),
          ADD COLUMN IF NOT EXISTS bike_id INTEGER REFERENCES bikes(id) ON DELETE SET NULL,
          ADD COLUMN IF NOT EXISTS station_id INTEGER REFERENCES stations(id) ON DELETE SET NULL,
          ADD COLUMN IF NOT EXISTS payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS support_ticket_messages (
          id SERIAL PRIMARY KEY,
          ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
          sender_type VARCHAR(20) NOT NULL,
          sender_name VARCHAR(120),
          message TEXT NOT NULL,
          is_internal BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS admin_support_activity (
          id SERIAL PRIMARY KEY,
          ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE SET NULL,
          activity_type VARCHAR(60),
          title VARCHAR(160),
          description TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query("CREATE INDEX IF NOT EXISTS idx_support_tickets_created ON support_tickets(created_at DESC)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON support_tickets(priority)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_ticket_messages(ticket_id, created_at)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_admin_support_activity_created ON admin_support_activity(created_at DESC)");
      await db.query("UPDATE support_tickets SET ticket_code = 'TK-' || LPAD(id::text, 4, '0') WHERE ticket_code IS NULL OR ticket_code = '' OR ticket_code ILIKE '%demo%' OR ticket_code ILIKE '%seed%' OR ticket_code ILIKE '%test%' OR ticket_code ILIKE '%profit%' OR ticket_code ILIKE '%loss%'");
      await db.query("UPDATE support_tickets st SET student_name = u.full_name FROM users u WHERE st.user_id = u.id AND (st.student_name IS NULL OR st.student_name = '' OR st.student_name ILIKE '%demo%' OR st.student_name ILIKE '%seed%' OR st.student_name ILIKE '%test%')");
      await db.query("UPDATE support_tickets SET message = COALESCE(NULLIF(message, ''), description) WHERE message IS NULL OR message = ''");
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
    console.error("[adminSupport schema]", err);
    res.status(500).json({ error: "Could not prepare support schema." });
  }
});

function cleanDisplay(value, fallback = "Not assigned") {
  const text = String(value == null ? "" : value).trim();
  if (!text || BAD_VISIBLE_RE.test(text)) return fallback;
  return text.replace(/\s+/g, " ");
}

function ticketCode(row) {
  return cleanDisplay(row.ticket_code, "TK-" + String(row.id || 0).padStart(4, "0"));
}

function titleCase(value) {
  return cleanDisplay(value, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function parsePositiveInt(value, fallback, max = 100) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function parsePriority(value, fallback = "medium") {
  const key = String(value || "").toLowerCase();
  return PRIORITIES.has(key) ? key : fallback;
}

function parseStatus(value, fallback = "open") {
  const key = String(value || "").toLowerCase();
  return STATUSES.has(key) ? key : fallback;
}

function parseCategory(value, fallback = "general") {
  const key = String(value || "").toLowerCase();
  if (key === "bike_issue") return "bike_issue";
  if (key === "damaged_bike") return "bike_issue";
  if (CATEGORIES.has(key)) return key;
  return fallback;
}

function categoryLabel(value) {
  const key = String(value || "").toLowerCase();
  if (key === "bike" || key === "bike_issue") return "Bike Issue";
  if (key === "payment" || key === "billing" || key === "refund") return "Payment";
  if (key === "other" || key === "general") return "General";
  return titleCase(key || "general");
}

function waitLabel(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Not set";
  const mins = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (mins < 60) return `${mins || 1} min waiting`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr waiting`;
  return `${Math.floor(hrs / 24)} day waiting`;
}

function etaLabel(value) {
  if (!value) return "Recently updated";
  const mins = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (mins < 60) return `${mins || 1} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)} hr ago`;
  return `${Math.floor(mins / 1440)} day ago`;
}

function durationLabel(minutes) {
  const n = Number(minutes || 0);
  if (!n) return "Not available";
  if (n < 60) return `${Math.round(n)} min`;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function baseSql() {
  return `
    SELECT
      st.id,
      st.ticket_code,
      st.user_id,
      COALESCE(st.student_name, u.full_name) AS student_name,
      u.email AS student_email,
      u.phone AS student_phone,
      st.category::text AS category,
      st.subject,
      st.description,
      COALESCE(st.message, st.description) AS message,
      st.priority::text AS priority,
      st.status::text AS status,
      st.booking_id,
      COALESCE(st.booking_id, p.booking_id) AS related_booking_id,
      st.bike_id,
      COALESCE(st.bike_id, bk.bike_id) AS related_bike_id,
      bi.bike_code,
      st.station_id,
      COALESCE(st.station_id, bk.pickup_station_id) AS related_station_id,
      s.station_name,
      st.payment_id,
      p.transaction_reference,
      st.assigned_to,
      st.admin_response,
      st.resolved_at,
      st.created_at,
      st.updated_at,
      ml.id AS maintenance_task_id
    FROM support_tickets st
    JOIN users u ON u.id = st.user_id
    LEFT JOIN LATERAL (
      SELECT p.*
      FROM payments p
      WHERE p.id = st.payment_id OR (st.payment_id IS NULL AND p.booking_id = st.booking_id)
      ORDER BY COALESCE(p.paid_at, p.updated_at, p.created_at) DESC, p.id DESC
      LIMIT 1
    ) p ON TRUE
    LEFT JOIN bookings bk ON bk.id = COALESCE(st.booking_id, p.booking_id)
    LEFT JOIN bikes bi ON bi.id = COALESCE(st.bike_id, bk.bike_id)
    LEFT JOIN stations s ON s.id = COALESCE(st.station_id, bk.pickup_station_id)
    LEFT JOIN LATERAL (
      SELECT ml.id
      FROM maintenance_logs ml
      WHERE ml.support_ticket_id = st.id
      ORDER BY COALESCE(ml.updated_at, ml.reported_at, ml.created_at) DESC, ml.id DESC
      LIMIT 1
    ) ml ON TRUE
  `;
}

function mapTicket(row) {
  return {
    id: Number(row.id),
    ticketId: ticketCode(row),
    studentName: cleanDisplay(row.student_name, "Student"),
    studentEmail: cleanDisplay(row.student_email, "Not available"),
    studentPhone: cleanDisplay(row.student_phone, "Not available"),
    userId: Number(row.user_id),
    category: cleanDisplay(row.category, "general").toLowerCase(),
    categoryLabel: categoryLabel(row.category),
    subject: cleanDisplay(row.subject, "Support issue"),
    description: cleanDisplay(row.description || row.message, "No description provided."),
    message: cleanDisplay(row.message || row.description, "No message provided."),
    priority: cleanDisplay(row.priority, "medium").toLowerCase(),
    priorityLabel: titleCase(row.priority || "medium"),
    status: cleanDisplay(row.status, "open").toLowerCase(),
    statusLabel: titleCase(row.status || "open"),
    bookingId: row.related_booking_id ? "BK-" + String(row.related_booking_id).padStart(4, "0") : "Not linked",
    rawBookingId: row.related_booking_id ? Number(row.related_booking_id) : null,
    bikeId: row.related_bike_id
      ? cleanDisplay(row.bike_code, "BIKE-" + String(row.related_bike_id).padStart(3, "0"))
      : "Not linked",
    rawBikeId: row.related_bike_id ? Number(row.related_bike_id) : null,
    station: cleanDisplay(row.station_name, ""),
    paymentReference: cleanDisplay(row.transaction_reference, ""),
    maintenanceTaskId: row.maintenance_task_id ? "MT-" + String(row.maintenance_task_id).padStart(4, "0") : "",
    assignedTo: cleanDisplay(row.assigned_to, "Unassigned"),
    adminResponse: cleanDisplay(row.admin_response, ""),
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    waiting: waitLabel(row.created_at),
    lastUpdate: etaLabel(row.updated_at),
  };
}

async function logActivity(ticketId, type, title, description) {
  await db.query(
    `INSERT INTO admin_support_activity (ticket_id, activity_type, title, description, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [ticketId || null, type, title, description]
  ).catch((err) => console.warn("[adminSupport activity]", err.message));
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
    where.push(`(st.ticket_code ILIKE ${p} OR st.subject ILIKE ${p} OR st.description ILIKE ${p} OR COALESCE(st.student_name, u.full_name) ILIKE ${p} OR u.email ILIKE ${p} OR bi.bike_code ILIKE ${p} OR COALESCE(st.booking_id, p.booking_id)::text ILIKE ${p} OR ('BK-' || LPAD(COALESCE(st.booking_id, p.booking_id)::text, 4, '0')) ILIKE ${p})`);
  }
  if (query.status && query.status !== "all") where.push(`st.status::text = ${push(parseStatus(query.status))}`);
  if (query.priority && query.priority !== "all") where.push(`st.priority::text = ${push(parsePriority(query.priority))}`);
  if (query.category && query.category !== "all") {
    const cat = parseCategory(query.category);
    if (cat === "payment") where.push(`st.category::text IN ('payment','billing','refund')`);
    else if (cat === "bike_issue") where.push(`st.category::text IN ('bike','bike_issue')`);
    else where.push(`st.category::text = ${push(cat)}`);
  }
  if (query.assignedTo && query.assignedTo !== "all") {
    if (query.assignedTo === "unassigned") where.push(`(st.assigned_to IS NULL OR st.assigned_to = '')`);
    else where.push(`st.assigned_to = ${push(query.assignedTo)}`);
  }
  if (query.dateFrom) where.push(`st.created_at >= ${push(query.dateFrom)}::date`);
  if (query.dateTo) where.push(`st.created_at < (${push(query.dateTo)}::date + INTERVAL '1 day')`);
  return { params, clause: where.length ? " WHERE " + where.join(" AND ") : "" };
}

router.get("/overview", async (req, res) => {
  try {
    const range = adminMetrics.parseRange(req.query.range);
    const result = await db.query(
      `
      WITH all_tickets AS (
        SELECT st.*,
               EXISTS (SELECT 1 FROM maintenance_logs ml WHERE ml.support_ticket_id = st.id) AS linked_maintenance
          FROM support_tickets st
      ),
      cur AS (
        SELECT
          COUNT(*) FILTER (WHERE status::text = ANY($5::text[]))::int AS open_tickets,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()) AND created_at < date_trunc('day', NOW()) + INTERVAL '1 day')::int AS new_today,
          COUNT(*) FILTER (WHERE (status::text = 'in_progress' OR assigned_to IS NOT NULL) AND status::text <> ALL($6::text[]))::int AS in_progress,
          COUNT(*) FILTER (WHERE priority::text IN ('high','urgent') AND status::text <> ALL($6::text[]))::int AS urgent_issues,
          COUNT(*) FILTER (WHERE status::text = ANY($6::text[]) AND COALESCE(resolved_at, updated_at) >= $1 AND COALESCE(resolved_at, updated_at) < $2)::int AS resolved_tickets,
          COUNT(*) FILTER (WHERE category::text IN ('payment','billing','refund') AND created_at >= $1 AND created_at < $2)::int AS payment_issues,
          COUNT(*) FILTER (WHERE (category::text IN ('bike','bike_issue','maintenance') OR linked_maintenance) AND created_at >= $1 AND created_at < $2)::int AS maintenance_reports,
          AVG(EXTRACT(EPOCH FROM (COALESCE(resolved_at, updated_at) - created_at)) / 60) FILTER (WHERE status::text IN ('in_progress','waiting_student','resolved','closed')) AS avg_response_minutes
        FROM all_tickets
      ),
      prev AS (
        SELECT
          COUNT(*) FILTER (WHERE created_at >= $3 AND created_at < $4)::int AS total_prev,
          COUNT(*) FILTER (WHERE status::text = ANY($6::text[]) AND COALESCE(resolved_at, updated_at) >= $3 AND COALESCE(resolved_at, updated_at) < $4)::int AS resolved_prev,
          COUNT(*) FILTER (WHERE category::text IN ('payment','billing','refund') AND created_at >= $3 AND created_at < $4)::int AS payment_prev,
          COUNT(*) FILTER (WHERE (category::text IN ('bike','bike_issue','maintenance') OR linked_maintenance) AND created_at >= $3 AND created_at < $4)::int AS maintenance_prev
        FROM all_tickets
      ),
      current_created AS (
        SELECT COUNT(*)::int AS total_current FROM support_tickets WHERE created_at >= $1 AND created_at < $2
      )
      SELECT cur.*, prev.*, current_created.total_current
      FROM cur, prev, current_created
      `,
      [range.currentStart, range.currentEnd, range.prevStart, range.prevEnd, OPEN_STATUSES, CLOSED_STATUSES]
    );
    const row = result.rows[0] || {};
    const totals = {
      openTickets: Number(row.open_tickets || 0),
      newToday: Number(row.new_today || 0),
      inProgress: Number(row.in_progress || 0),
      urgentIssues: Number(row.urgent_issues || 0),
      resolvedTickets: Number(row.resolved_tickets || 0),
      paymentIssues: Number(row.payment_issues || 0),
      maintenanceReports: Number(row.maintenance_reports || 0),
      averageResponseTime: durationLabel(row.avg_response_minutes),
    };
    res.json({
      range: range.key,
      totals,
      trends: {
        openTickets: adminMetrics.pctTrend(row.total_current, row.total_prev),
        newToday: "Created today",
        inProgress: "Assigned or active",
        urgentIssues: "Needs attention",
        resolvedTickets: adminMetrics.pctTrend(totals.resolvedTickets, row.resolved_prev),
        paymentIssues: adminMetrics.pctTrend(totals.paymentIssues, row.payment_prev),
        maintenanceReports: adminMetrics.pctTrend(totals.maintenanceReports, row.maintenance_prev),
        averageResponseTime: "First update estimate",
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/support/overview]", err);
    res.status(500).json({ error: "Could not load support overview." });
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
             COUNT(st.id) FILTER (WHERE st.created_at >= l.bucket_start AND st.created_at < l.bucket_end)::int AS new_tickets,
             COUNT(st.id) FILTER (WHERE st.status::text IN ('resolved','closed') AND COALESCE(st.resolved_at, st.updated_at) >= l.bucket_start AND COALESCE(st.resolved_at, st.updated_at) < l.bucket_end)::int AS resolved_tickets,
             COUNT(st.id) FILTER (WHERE st.priority::text IN ('high','urgent') AND st.created_at >= l.bucket_start AND st.created_at < l.bucket_end)::int AS urgent_tickets
      FROM limited l
      LEFT JOIN support_tickets st ON st.created_at >= l.bucket_start AND st.created_at < l.bucket_end
        OR (st.status::text IN ('resolved','closed') AND COALESCE(st.resolved_at, st.updated_at) >= l.bucket_start AND COALESCE(st.resolved_at, st.updated_at) < l.bucket_end)
      GROUP BY l.bucket_start
      ORDER BY l.bucket_start ASC
      `,
      [range.currentStart, range.currentEnd, unit, count]
    );
    res.json({
      labels: result.rows.map((r) => r.bucket_start),
      newTickets: result.rows.map((r) => Number(r.new_tickets || 0)),
      resolvedTickets: result.rows.map((r) => Number(r.resolved_tickets || 0)),
      urgentTickets: result.rows.map((r) => Number(r.urgent_tickets || 0)),
    });
  } catch (err) {
    console.error("[GET /api/admin/support/trends]", err);
    res.status(500).json({ error: "Could not load support trends." });
  }
});

router.get("/category-breakdown", async (req, res) => {
  try {
    const range = adminMetrics.parseRange(req.query.range);
    const result = await db.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE category::text = 'booking')::int AS booking,
        COUNT(*) FILTER (WHERE category::text IN ('payment','billing','refund'))::int AS payment,
        COUNT(*) FILTER (WHERE category::text IN ('bike','bike_issue'))::int AS bike_issue,
        COUNT(*) FILTER (WHERE category::text = 'maintenance')::int AS maintenance,
        COUNT(*) FILTER (WHERE category::text = 'account')::int AS account,
        COUNT(*) FILTER (WHERE category::text IN ('general','other','station'))::int AS general
      FROM support_tickets
      WHERE created_at >= $1 AND created_at < $2
      `,
      [range.currentStart, range.currentEnd]
    );
    const row = result.rows[0] || {};
    res.json({
      booking: Number(row.booking || 0),
      payment: Number(row.payment || 0),
      bikeIssue: Number(row.bike_issue || 0),
      maintenance: Number(row.maintenance || 0),
      account: Number(row.account || 0),
      general: Number(row.general || 0),
    });
  } catch (err) {
    console.error("[GET /api/admin/support/category-breakdown]", err);
    res.status(500).json({ error: "Could not load category breakdown." });
  }
});

router.get("/alerts", async (_req, res) => {
  try {
    const result = await db.query(
      `${baseSql()}
       WHERE st.priority::text IN ('high','urgent') AND st.status::text <> ALL($1::text[])
       ORDER BY st.priority::text DESC, st.created_at ASC
       LIMIT 5`,
      [CLOSED_STATUSES]
    );
    res.json({ alerts: result.rows.map(mapTicket) });
  } catch (err) {
    console.error("[GET /api/admin/support/alerts]", err);
    res.status(500).json({ error: "Could not load support alerts." });
  }
});

router.get("/assigned-tasks", async (_req, res) => {
  try {
    const result = await db.query(
      `${baseSql()}
       WHERE st.assigned_to IS NOT NULL AND st.assigned_to <> '' AND st.status::text <> ALL($1::text[])
       ORDER BY st.updated_at DESC, st.created_at DESC
       LIMIT 5`,
      [CLOSED_STATUSES]
    );
    res.json({ tasks: result.rows.map(mapTicket) });
  } catch (err) {
    console.error("[GET /api/admin/support/assigned-tasks]", err);
    res.status(500).json({ error: "Could not load assigned support tasks." });
  }
});

router.get("/activity", async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 5, 20);
    const result = await db.query(
      `WITH feed AS (
         SELECT asa.id, asa.ticket_id, asa.activity_type, asa.title, asa.description, asa.created_at
           FROM admin_support_activity asa
         UNION ALL
         SELECT -st.id AS id, st.id AS ticket_id, 'ticket_created' AS activity_type,
                'New ticket submitted' AS title, st.subject AS description, st.created_at
           FROM support_tickets st
       )
       SELECT feed.*, st.ticket_code
       FROM feed
       LEFT JOIN support_tickets st ON st.id = feed.ticket_id
       ORDER BY feed.created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({
      activity: result.rows.map((row) => ({
        id: Number(row.id),
        ticketId: cleanDisplay(row.ticket_code, row.ticket_id ? "TK-" + String(row.ticket_id).padStart(4, "0") : ""),
        type: cleanDisplay(row.activity_type, "support_activity"),
        title: cleanDisplay(row.title, "Support activity"),
        description: cleanDisplay(row.description, "Support ticket update"),
        timestamp: row.created_at,
      })),
    });
  } catch (err) {
    console.error("[GET /api/admin/support/activity]", err);
    res.status(500).json({ error: "Could not load support activity." });
  }
});

router.get("/options", async (_req, res) => {
  try {
    const [users, staff, bikes, bookings] = await Promise.all([
      db.query("SELECT id, full_name, email FROM users WHERE role::text = 'student' ORDER BY full_name LIMIT 100"),
      db.query("SELECT full_name FROM users WHERE role::text = 'admin' ORDER BY full_name"),
      db.query("SELECT id, bike_code FROM bikes ORDER BY bike_code LIMIT 100"),
      db.query("SELECT id FROM bookings ORDER BY created_at DESC LIMIT 100"),
    ]);
    res.json({
      students: users.rows.map((u) => ({ id: Number(u.id), name: cleanDisplay(u.full_name, "Student"), email: cleanDisplay(u.email, "") })),
      staff: staff.rows.map((u) => cleanDisplay(u.full_name, "Admin User")),
      bikes: bikes.rows.map((b) => ({ id: Number(b.id), code: cleanDisplay(b.bike_code, "B" + String(b.id).padStart(2, "0")) })),
      bookings: bookings.rows.map((b) => ({ id: Number(b.id), code: "BK-" + String(b.id).padStart(4, "0") })),
    });
  } catch (err) {
    console.error("[GET /api/admin/support/options]", err);
    res.status(500).json({ error: "Could not load support options." });
  }
});

router.get("/list", async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, 100000);
    const limit = parsePositiveInt(req.query.limit, 10, 100);
    const offset = (page - 1) * limit;
    const filters = buildFilters(req.query);
    const countResult = await db.query(
      `SELECT COUNT(DISTINCT st.id)::int AS total
       FROM support_tickets st
       JOIN users u ON u.id = st.user_id
       LEFT JOIN LATERAL (
         SELECT p.*
         FROM payments p
         WHERE p.id = st.payment_id OR (st.payment_id IS NULL AND p.booking_id = st.booking_id)
         ORDER BY COALESCE(p.paid_at, p.updated_at, p.created_at) DESC, p.id DESC
         LIMIT 1
       ) p ON TRUE
       LEFT JOIN bookings bk ON bk.id = COALESCE(st.booking_id, p.booking_id)
       LEFT JOIN bikes bi ON bi.id = COALESCE(st.bike_id, bk.bike_id)
       ${filters.clause}`,
      filters.params
    );
    const total = Number(countResult.rows[0]?.total || 0);
    const params = [...filters.params, limit, offset];
    const result = await db.query(
      `${baseSql()}${filters.clause}
       ORDER BY st.created_at DESC, st.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ tickets: result.rows.map(mapTicket), total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    console.error("[GET /api/admin/support/list]", err);
    res.status(500).json({ error: "Could not load support tickets." });
  }
});

async function findTicket(rawId) {
  const value = String(rawId || "").trim();
  const numeric = Number.parseInt(value.replace(/^TK-/i, ""), 10);
  const result = await db.query(
    `${baseSql()} WHERE st.id = $1 OR UPPER(st.ticket_code) = UPPER($2) LIMIT 1`,
    [Number.isFinite(numeric) ? numeric : 0, value]
  );
  return result.rows[0] || null;
}

router.get("/:ticketId", async (req, res) => {
  try {
    const row = await findTicket(req.params.ticketId);
    if (!row) return res.status(404).json({ error: "Support ticket not found." });
    const messages = await db.query(
      `SELECT id, sender_type, sender_name, message, is_internal, created_at
       FROM support_ticket_messages
       WHERE ticket_id = $1
       ORDER BY created_at ASC`,
      [row.id]
    );
    res.json({
      ticket: mapTicket(row),
      messages: messages.rows.map((m) => ({
        id: Number(m.id),
        senderType: cleanDisplay(m.sender_type, "admin"),
        senderName: cleanDisplay(m.sender_name, "Support Team"),
        message: cleanDisplay(m.message, ""),
        isInternal: Boolean(m.is_internal),
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    console.error("[GET /api/admin/support/:ticketId]", err);
    res.status(500).json({ error: "Could not load support ticket details." });
  }
});

router.post("/", async (req, res) => {
  try {
    const userId = Number(req.body.userId || req.body.studentId);
    const category = parseCategory(req.body.category);
    const priority = parsePriority(req.body.priority);
    const subject = cleanDisplay(req.body.subject || req.body.title, "").slice(0, 200);
    const description = cleanDisplay(req.body.description || req.body.message, "").slice(0, 5000);
    if (!userId || subject.length < 3 || description.length < 10) return res.status(400).json({ error: "Student, issue title, and description are required." });
    const user = await db.query("SELECT id, full_name FROM users WHERE id = $1 AND role::text = 'student'", [userId]);
    if (!user.rowCount) return res.status(400).json({ error: "Selected student was not found." });
    const bookingId = req.body.bookingId ? Number(req.body.bookingId) : null;
    const bikeId = req.body.bikeId ? Number(req.body.bikeId) : null;
    const assignedTo = cleanDisplay(req.body.assignedTo, "");
    const result = await db.query(
      `INSERT INTO support_tickets
        (user_id, category, subject, description, priority, booking_id, status, ticket_code, student_name, message, assigned_to, bike_id, updated_at)
       VALUES ($1, $2::ticket_category, $3, $4, $5::ticket_priority, $6, $7::ticket_status, NULL, $8, $4, NULLIF($9, ''), $10, NOW())
       RETURNING *`,
      [userId, category, subject, description, priority, bookingId || null, assignedTo ? "in_progress" : "open", user.rows[0].full_name, assignedTo, bikeId || null]
    );
    const id = result.rows[0].id;
    await db.query("UPDATE support_tickets SET ticket_code = 'TK-' || LPAD(id::text, 4, '0') WHERE id = $1", [id]);
    await db.query(
      `INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_name, message, is_internal)
       VALUES ($1, 'admin', $2, $3, FALSE)`,
      [id, cleanDisplay(req.user.full_name || "Admin User", "Admin User"), description]
    );
    await logActivity(id, "ticket_created", "Ticket created by admin", subject);
    const full = await findTicket(String(id));
    res.status(201).json({ ticket: mapTicket(full) });
  } catch (err) {
    console.error("[POST /api/admin/support]", err);
    res.status(500).json({ error: "Could not create support ticket." });
  }
});

router.patch("/:ticketId/assign", async (req, res) => {
  try {
    const row = await findTicket(req.params.ticketId);
    if (!row) return res.status(404).json({ error: "Support ticket not found." });
    const assignedTo = cleanDisplay(req.body.assignedTo, "Admin User").slice(0, 120);
    const result = await db.query(
      `UPDATE support_tickets
          SET assigned_to = $1,
              status = CASE WHEN status::text IN ('new','open','pending') THEN 'in_progress'::ticket_status ELSE status END,
              updated_at = NOW()
        WHERE id = $2
      RETURNING *`,
      [assignedTo, row.id]
    );
    await logActivity(row.id, "ticket_assigned", "Ticket assigned", `${ticketCode(row)} assigned to ${assignedTo}.`);
    const full = await findTicket(String(result.rows[0].id));
    res.json({ ticket: mapTicket(full) });
  } catch (err) {
    console.error("[PATCH /api/admin/support/:ticketId/assign]", err);
    res.status(500).json({ error: "Could not assign ticket." });
  }
});

router.post("/:ticketId/reply", async (req, res) => {
  try {
    const row = await findTicket(req.params.ticketId);
    if (!row) return res.status(404).json({ error: "Support ticket not found." });
    const message = cleanDisplay(req.body.message, "").slice(0, 5000);
    if (message.length < 2) return res.status(400).json({ error: "Reply message is required." });
    const internal = Boolean(req.body.isInternal);
    await db.query(
      `INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_name, message, is_internal, created_at)
       VALUES ($1, 'admin', $2, $3, $4, NOW())`,
      [row.id, cleanDisplay(req.user.full_name || "Admin User", "Admin User"), message, internal]
    );
    const status = internal ? "in_progress" : "waiting_student";
    await db.query("UPDATE support_tickets SET admin_response = $1, status = $2::ticket_status, updated_at = NOW() WHERE id = $3", [message, status, row.id]);
    await logActivity(row.id, "admin_replied", internal ? "Internal note added" : "Admin replied", message.slice(0, 160));
    const full = await findTicket(String(row.id));
    res.json({ ticket: mapTicket(full) });
  } catch (err) {
    console.error("[POST /api/admin/support/:ticketId/reply]", err);
    res.status(500).json({ error: "Could not save reply." });
  }
});

router.patch("/:ticketId/escalate", async (req, res) => {
  try {
    const row = await findTicket(req.params.ticketId);
    if (!row) return res.status(404).json({ error: "Support ticket not found." });
    await db.query("UPDATE support_tickets SET priority = 'urgent'::ticket_priority, status = 'escalated'::ticket_status, updated_at = NOW() WHERE id = $1", [row.id]);
    await logActivity(row.id, "ticket_escalated", "Ticket escalated", ticketCode(row));
    const full = await findTicket(String(row.id));
    res.json({ ticket: mapTicket(full) });
  } catch (err) {
    console.error("[PATCH /api/admin/support/:ticketId/escalate]", err);
    res.status(500).json({ error: "Could not escalate ticket." });
  }
});

router.patch("/:ticketId/resolve", async (req, res) => {
  try {
    const row = await findTicket(req.params.ticketId);
    if (!row) return res.status(404).json({ error: "Support ticket not found." });
    await db.query("UPDATE support_tickets SET status = 'resolved'::ticket_status, resolved_at = NOW(), updated_at = NOW() WHERE id = $1", [row.id]);
    await logActivity(row.id, "ticket_resolved", "Ticket resolved", ticketCode(row));
    const full = await findTicket(String(row.id));
    res.json({ ticket: mapTicket(full) });
  } catch (err) {
    console.error("[PATCH /api/admin/support/:ticketId/resolve]", err);
    res.status(500).json({ error: "Could not resolve ticket." });
  }
});

router.patch("/:ticketId/close", async (req, res) => {
  try {
    const row = await findTicket(req.params.ticketId);
    if (!row) return res.status(404).json({ error: "Support ticket not found." });
    await db.query("UPDATE support_tickets SET status = 'closed'::ticket_status, resolved_at = COALESCE(resolved_at, NOW()), updated_at = NOW() WHERE id = $1", [row.id]);
    await logActivity(row.id, "ticket_closed", "Ticket closed", ticketCode(row));
    const full = await findTicket(String(row.id));
    res.json({ ticket: mapTicket(full) });
  } catch (err) {
    console.error("[PATCH /api/admin/support/:ticketId/close]", err);
    res.status(500).json({ error: "Could not close ticket." });
  }
});

router.post("/:ticketId/link-maintenance", async (req, res) => {
  try {
    const row = await findTicket(req.params.ticketId);
    if (!row) return res.status(404).json({ error: "Support ticket not found." });
    if (row.maintenance_task_id) return res.json({ taskId: "MT-" + String(row.maintenance_task_id).padStart(4, "0"), linked: true });
    const bikeId = Number(req.body.bikeId || row.related_bike_id || row.bike_id) || null;
    const stationId = Number(req.body.stationId || row.related_station_id || row.station_id) || null;
    const issueType = cleanDisplay(req.body.issueType || row.subject, "Support issue").slice(0, 80);
    const description = cleanDisplay(req.body.description || row.description, "Support issue linked from ticket.").slice(0, 5000);
    const priority = row.priority === "urgent" ? "urgent" : row.priority === "high" ? "high" : "medium";
    const result = await db.query(
      `INSERT INTO maintenance_logs
        (bike_id, station_id, issue_type, description, severity, status, reported_at, asset_type, priority, support_ticket_id, cost, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::maintenance_severity, 'reported'::maintenance_status, NOW(), $6, $7, $8, 0, NOW(), NOW())
       RETURNING id`,
      [bikeId, stationId, issueType, description, priority === "urgent" ? "critical" : priority, bikeId ? "bike" : "station", priority, row.id]
    );
    await db.query("UPDATE support_tickets SET status = 'in_progress'::ticket_status, updated_at = NOW() WHERE id = $1", [row.id]);
    await logActivity(row.id, "maintenance_linked", "Maintenance task linked", "MT-" + String(result.rows[0].id).padStart(4, "0"));
    res.json({ taskId: "MT-" + String(result.rows[0].id).padStart(4, "0"), linked: true });
  } catch (err) {
    console.error("[POST /api/admin/support/:ticketId/link-maintenance]", err);
    res.status(500).json({ error: "Could not link maintenance task." });
  }
});

router.get("/export/csv", async (req, res) => {
  try {
    const filters = buildFilters(req.query);
    const result = await db.query(
      `${baseSql()}${filters.clause} ORDER BY st.created_at DESC, st.id DESC LIMIT 5000`,
      filters.params
    );
    const headers = ["Ticket ID", "Student", "Email", "Category", "Issue", "Booking", "Bike", "Priority", "Status", "Assigned To", "Created Date"];
    const rows = result.rows.map((row) => {
      const t = mapTicket(row);
      return [t.ticketId, t.studentName, t.studentEmail, t.categoryLabel, t.subject, t.bookingId, t.bikeId, t.priorityLabel, t.statusLabel, t.assignedTo, t.createdAt];
    });
    const csv = [headers, ...rows].map((r) => r.map((cell) => `"${String(cell == null ? "" : cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="support-tickets-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error("[GET /api/admin/support/export/csv]", err);
    res.status(500).json({ error: "Could not export support tickets." });
  }
});

module.exports = router;
