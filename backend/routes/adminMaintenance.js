// /api/admin/maintenance/* - database-backed Admin Maintenance Management.
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const adminMetrics = require("../services/adminMetrics");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";
const BAD_VISIBLE_RE = /demo|seed|test|profit|loss/i;
const UNRESOLVED_STATUSES = ["reported", "in_progress", "waiting_parts", "pending_inspection"];

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
      await db.query("ALTER TYPE maintenance_status ADD VALUE IF NOT EXISTS 'waiting_parts'");
      await db.query("ALTER TYPE maintenance_status ADD VALUE IF NOT EXISTS 'pending_inspection'");
      await db.query("ALTER TYPE admin_activity_type ADD VALUE IF NOT EXISTS 'maintenance_created'");
      await db.query("ALTER TYPE admin_activity_type ADD VALUE IF NOT EXISTS 'technician_assigned'");
      await db.query("ALTER TYPE admin_activity_type ADD VALUE IF NOT EXISTS 'repair_completed'");
      await db.query("ALTER TYPE admin_activity_type ADD VALUE IF NOT EXISTS 'repair_cost_added'");
      await db.query("ALTER TYPE bike_status ADD VALUE IF NOT EXISTS 'offline'");
      await db.query("ALTER TYPE bike_status ADD VALUE IF NOT EXISTS 'disabled'");
      await db.query("ALTER TABLE maintenance_logs ALTER COLUMN bike_id DROP NOT NULL");
      await db.query(`
        ALTER TABLE maintenance_logs
          ADD COLUMN IF NOT EXISTS asset_type VARCHAR(30) NOT NULL DEFAULT 'bike',
          ADD COLUMN IF NOT EXISTS priority VARCHAR(30) NOT NULL DEFAULT 'medium',
          ADD COLUMN IF NOT EXISTS technician_name VARCHAR(120),
          ADD COLUMN IF NOT EXISTS estimated_completion_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS support_ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE SET NULL,
          ADD COLUMN IF NOT EXISTS notes TEXT
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS technicians (
          id SERIAL PRIMARY KEY,
          full_name VARCHAR(120) NOT NULL UNIQUE,
          email VARCHAR(180),
          phone VARCHAR(40),
          status VARCHAR(30) NOT NULL DEFAULT 'active',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query("CREATE INDEX IF NOT EXISTS idx_maint_asset_status ON maintenance_logs(asset_type, status)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_maint_priority ON maintenance_logs(priority)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_maint_technician ON maintenance_logs(technician_name)");
      await db.query("UPDATE maintenance_logs SET asset_type = CASE WHEN station_id IS NOT NULL AND bike_id IS NULL THEN 'station' ELSE 'bike' END WHERE asset_type IS NULL OR asset_type = ''");
      await db.query("UPDATE maintenance_logs SET priority = CASE severity::text WHEN 'critical' THEN 'urgent' WHEN 'high' THEN 'high' WHEN 'low' THEN 'low' ELSE 'medium' END WHERE priority IS NULL OR priority = ''");
      await db.query("UPDATE maintenance_logs SET completed_at = resolved_at WHERE completed_at IS NULL AND status::text IN ('resolved','closed')");
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
    console.error("[adminMaintenance schema]", err);
    res.status(500).json({ error: "Could not prepare maintenance schema." });
  }
});

function cleanDisplay(value, fallback = "Not assigned") {
  const text = String(value == null ? "" : value).trim();
  if (!text || BAD_VISIBLE_RE.test(text)) return fallback;
  return text.replace(/\s+/g, " ");
}

function cleanBikeCode(value, id) {
  const text = String(value == null ? "" : value).trim();
  if (!text || BAD_VISIBLE_RE.test(text)) return "B" + String(Math.max(1, Number(id || 0) % 99)).padStart(2, "0");
  return text.replace(/\s+/g, "-").toUpperCase();
}

function taskCode(id) {
  return "MT-" + String(id || 0).padStart(4, "0");
}

function titleCase(value) {
  return cleanDisplay(value, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function displayStatus(row) {
  const status = String(row.status || "").toLowerCase();
  if (status === "resolved" || status === "closed") return "completed";
  if (status === "reported") return row.priority === "urgent" ? "urgent" : "open";
  return status || "open";
}

function dbStatus(status) {
  const key = String(status || "").toLowerCase().replace(/\s+/g, "_");
  if (key === "open" || key === "urgent") return "reported";
  if (key === "completed" || key === "complete") return "resolved";
  if (["reported", "in_progress", "waiting_parts", "pending_inspection", "resolved", "closed"].includes(key)) return key;
  return null;
}

function priorityToSeverity(priority) {
  const key = String(priority || "medium").toLowerCase();
  if (key === "urgent") return "critical";
  if (key === "high") return "high";
  if (key === "low") return "low";
  return "medium";
}

function parsePositiveInt(value, fallback, max = 100) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function parseRange(value) {
  return adminMetrics.parseRange(value);
}

function bucketConfig(rangeKey) {
  if (rangeKey === "today") return { unit: "hour", count: 7 };
  if (rangeKey === "week") return { unit: "day", count: 7 };
  if (rangeKey === "year") return { unit: "month", count: 12 };
  return { unit: "day", count: 7 };
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function etaLabel(value) {
  if (!value) return "Not set";
  const mins = Math.ceil((new Date(value).getTime() - Date.now()) / 60000);
  if (!Number.isFinite(mins)) return "Not set";
  if (mins < 0) return "Overdue";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function baseSql() {
  return `
    WITH base AS (
      SELECT
        ml.id,
        ml.asset_type,
        ml.bike_id,
        b.bike_code,
        ml.station_id,
        COALESCE(s.station_name, bs.station_name) AS station_name,
        ml.issue_type,
        ml.description,
        ml.severity::text AS severity,
        ml.priority,
        ml.status::text AS status,
        ml.technician_name,
        ml.cost,
        ml.reported_at,
        ml.estimated_completion_at,
        COALESCE(ml.completed_at, ml.resolved_at) AS completed_at,
        ml.resolved_at,
        ml.support_ticket_id,
        st.ticket_code,
        ml.notes,
        ml.resolution_notes,
        ml.created_at,
        ml.updated_at,
        CASE
          WHEN ml.status::text IN ('resolved','closed') THEN 'completed'
          WHEN ml.status::text = 'reported' AND ml.priority = 'urgent' THEN 'urgent'
          WHEN ml.status::text = 'reported' THEN 'open'
          ELSE ml.status::text
        END AS display_status,
        CASE
          WHEN ml.asset_type = 'station' THEN 'Station ' || COALESCE(s.station_name, 'Station')
          ELSE 'Bike ' || COALESCE(b.bike_code, 'Unassigned')
        END AS asset_label,
        CASE
          WHEN ml.asset_type = 'station' THEN COALESCE(s.station_name, 'Station')
          ELSE COALESCE(s.station_name, bs.station_name, 'Not assigned')
        END AS location_label
      FROM maintenance_logs ml
      LEFT JOIN bikes b ON b.id = ml.bike_id
      LEFT JOIN stations bs ON bs.id = b.station_id
      LEFT JOIN stations s ON s.id = ml.station_id
      LEFT JOIN support_tickets st ON st.id = ml.support_ticket_id
    )
    SELECT * FROM base
  `;
}

function activeTaskSql() {
  return `
    WITH base AS (${baseSql()}),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY asset_type, COALESCE(bike_id, station_id, id)
          ORDER BY
            CASE
              WHEN priority = 'urgent' OR severity = 'critical' THEN 1
              WHEN priority = 'high' OR severity = 'high' THEN 2
              WHEN status = 'in_progress' THEN 3
              WHEN status = 'waiting_parts' THEN 4
              WHEN status = 'pending_inspection' THEN 5
              ELSE 6
            END,
            reported_at DESC,
            id DESC
        ) AS rn
      FROM base
      WHERE status = ANY($1::text[])
    )
    SELECT * FROM ranked WHERE rn = 1
  `;
}

function mapTask(row) {
  return {
    id: Number(row.id),
    taskId: taskCode(row.id),
    assetType: cleanDisplay(row.asset_type, "bike").toLowerCase(),
    asset: cleanDisplay(row.asset_label, "Bike unassigned"),
    bikeId: row.bike_id ? Number(row.bike_id) : null,
    bikeCode: row.bike_code ? cleanBikeCode(row.bike_code, row.bike_id) : "",
    stationId: row.station_id ? Number(row.station_id) : null,
    type: titleCase(row.issue_type || "Maintenance"),
    issue: titleCase(row.issue_type || "Maintenance"),
    description: cleanDisplay(row.description, "Maintenance task requires review."),
    location: cleanDisplay(row.location_label, "Not assigned"),
    priority: cleanDisplay(row.priority, row.severity === "critical" ? "urgent" : "medium").toLowerCase(),
    severity: cleanDisplay(row.severity, "medium").toLowerCase(),
    status: displayStatus(row),
    statusLabel: titleCase(displayStatus(row)),
    technician: cleanDisplay(row.technician_name, "Unassigned"),
    cost: money(row.cost),
    reportedDate: row.reported_at,
    estimatedCompletion: row.estimated_completion_at,
    eta: etaLabel(row.estimated_completion_at),
    completedAt: row.completed_at,
    lastUpdated: row.updated_at,
    supportTicket: cleanDisplay(row.ticket_code, row.support_ticket_id ? `TKT-${row.support_ticket_id}` : "None"),
    supportTicketId: row.support_ticket_id ? Number(row.support_ticket_id) : null,
    notes: cleanDisplay(row.notes || row.resolution_notes, "No maintenance notes recorded."),
    overdue: row.estimated_completion_at && !["completed"].includes(displayStatus(row)) && new Date(row.estimated_completion_at) < new Date(),
  };
}

function buildFilters(query, startIndex = 1) {
  const params = [];
  const where = [];
  const push = (value) => {
    params.push(value);
    return "$" + (startIndex + params.length - 1);
  };
  if (query.search) {
    const p = push("%" + String(query.search).trim() + "%");
    where.push(`(task_id_text ILIKE ${p} OR bike_code ILIKE ${p} OR station_name ILIKE ${p} OR issue_type ILIKE ${p} OR technician_name ILIKE ${p})`);
  }
  if (query.status && query.status !== "all") where.push(`display_status = ${push(query.status)}`);
  if (query.priority && query.priority !== "all") where.push(`priority = ${push(query.priority)}`);
  if (query.type && query.type !== "all") where.push(`(asset_type = ${push(query.type)} OR issue_type ILIKE ${push("%" + query.type + "%")})`);
  if (query.technician && query.technician !== "all") where.push(`technician_name = ${push(query.technician)}`);
  if (query.dateFrom) where.push(`reported_at >= ${push(query.dateFrom)}`);
  if (query.dateTo) where.push(`reported_at < (${push(query.dateTo)}::date + INTERVAL '1 day')`);
  return { params, clause: where.length ? " WHERE " + where.join(" AND ") : "" };
}

async function logActivity(type, title, description, bikeId = null, userId = null) {
  try {
    await db.query(
      `INSERT INTO admin_activity_log (activity_type, title, description, related_bike_id, related_user_id, created_at)
       VALUES ($1::admin_activity_type, $2, $3, $4, $5, NOW())`,
      [type, title, description, bikeId, userId]
    );
  } catch (err) {
    console.warn("[adminMaintenance activity]", err.message);
  }
}

router.get("/filters", async (_req, res) => {
  try {
    const [technicians, bikes, stations] = await Promise.all([
      db.query("SELECT full_name FROM technicians WHERE status = 'active' ORDER BY full_name"),
      db.query("SELECT id, bike_code FROM bikes ORDER BY bike_code LIMIT 500"),
      db.query("SELECT id, station_name FROM stations WHERE is_active = TRUE ORDER BY station_name"),
    ]);
    res.json({
      technicians: technicians.rows.map((r) => cleanDisplay(r.full_name, "Technician")),
      bikes: bikes.rows.map((r) => ({ id: Number(r.id), code: cleanBikeCode(r.bike_code, r.id) })),
      stations: stations.rows.map((r) => ({ id: Number(r.id), name: cleanDisplay(r.station_name, "Station") })),
    });
  } catch (err) {
    console.error("[GET /api/admin/maintenance/filters]", err);
    res.status(500).json({ error: "Could not load maintenance filters." });
  }
});

router.get("/overview", async (req, res) => {
  try {
    const range = parseRange(req.query.range);
    const result = await db.query(
      `
      WITH active_tasks AS (${activeTaskSql()}),
      cur AS (
        SELECT
          (SELECT COUNT(*)::int FROM active_tasks) AS open_tasks,
          (SELECT COUNT(*)::int FROM active_tasks WHERE asset_type = 'station') AS station_issues,
          (SELECT COUNT(*)::int FROM active_tasks WHERE priority IN ('urgent','high') OR severity IN ('critical','high')) AS urgent_repairs,
          (SELECT COUNT(*)::int FROM maintenance_logs WHERE status::text IN ('resolved','closed') AND COALESCE(completed_at, resolved_at, updated_at) >= $2 AND COALESCE(completed_at, resolved_at, updated_at) < $3) AS completed_repairs,
          (SELECT COUNT(*)::int FROM active_tasks WHERE status = 'pending_inspection' OR issue_type ILIKE '%inspection%') AS pending_inspection,
          (SELECT COALESCE(SUM(cost), 0)::numeric FROM maintenance_logs WHERE cost IS NOT NULL AND cost > 0 AND COALESCE(completed_at, resolved_at, reported_at) >= $2 AND COALESCE(completed_at, resolved_at, reported_at) < $3) AS maintenance_cost,
          (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(completed_at, resolved_at) - reported_at)) / 3600), 0)::numeric FROM maintenance_logs WHERE status::text IN ('resolved','closed') AND COALESCE(completed_at, resolved_at) IS NOT NULL AND COALESCE(completed_at, resolved_at) >= $2 AND COALESCE(completed_at, resolved_at) < $3) AS avg_repair_hours
      ),
      prev AS (
        SELECT
          COUNT(*) FILTER (WHERE reported_at >= $4 AND reported_at < $5 AND status::text = ANY($1::text[]))::int AS open_tasks,
          COUNT(*) FILTER (WHERE asset_type = 'station' AND reported_at >= $4 AND reported_at < $5 AND status::text = ANY($1::text[]))::int AS station_issues,
          COUNT(*) FILTER (WHERE reported_at >= $4 AND reported_at < $5 AND status::text = ANY($1::text[]) AND (priority IN ('urgent','high') OR severity::text IN ('critical','high')))::int AS urgent_repairs,
          COUNT(*) FILTER (WHERE status::text IN ('resolved','closed') AND COALESCE(completed_at, resolved_at, updated_at) >= $4 AND COALESCE(completed_at, resolved_at, updated_at) < $5)::int AS completed_repairs,
          COUNT(*) FILTER (WHERE reported_at >= $4 AND reported_at < $5 AND status::text = 'pending_inspection')::int AS pending_inspection,
          COALESCE(SUM(cost) FILTER (WHERE cost IS NOT NULL AND cost > 0 AND COALESCE(completed_at, resolved_at, reported_at) >= $4 AND COALESCE(completed_at, resolved_at, reported_at) < $5), 0)::numeric AS maintenance_cost,
          COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(completed_at, resolved_at) - reported_at)) / 3600) FILTER (WHERE status::text IN ('resolved','closed') AND COALESCE(completed_at, resolved_at) IS NOT NULL AND COALESCE(completed_at, resolved_at) >= $4 AND COALESCE(completed_at, resolved_at) < $5), 0)::numeric AS avg_repair_hours
        FROM maintenance_logs
      ),
      fleet AS (
        SELECT COUNT(DISTINCT b.id)::int AS bikes_in_maintenance
        FROM bikes b
        WHERE b.status::text = 'maintenance'
           OR EXISTS (
             SELECT 1 FROM maintenance_logs ml WHERE ml.bike_id = b.id AND ml.status::text = ANY($1::text[])
           )
      )
      SELECT cur.*, prev.open_tasks AS prev_open_tasks, prev.station_issues AS prev_station_issues,
             prev.urgent_repairs AS prev_urgent_repairs, prev.completed_repairs AS prev_completed_repairs,
             prev.pending_inspection AS prev_pending_inspection, prev.maintenance_cost AS prev_maintenance_cost,
             prev.avg_repair_hours AS prev_avg_repair_hours, fleet.bikes_in_maintenance
        FROM cur, prev, fleet
      `,
      [UNRESOLVED_STATUSES, range.currentStart, range.currentEnd, range.prevStart, range.prevEnd]
    );
    const row = result.rows[0] || {};
    const totals = {
      openTasks: Number(row.open_tasks || 0),
      bikesInMaintenance: Number(row.bikes_in_maintenance || 0),
      stationIssues: Number(row.station_issues || 0),
      urgentRepairs: Number(row.urgent_repairs || 0),
      completedRepairs: Number(row.completed_repairs || 0),
      pendingInspection: Number(row.pending_inspection || 0),
      maintenanceCost: money(row.maintenance_cost),
      averageRepairTime: Number(Number(row.avg_repair_hours || 0).toFixed(1)),
    };
    res.json({
      range: range.key,
      totals,
      trends: {
        openTasks: adminMetrics.pctTrend(totals.openTasks, row.prev_open_tasks),
        bikesInMaintenance: 0,
        stationIssues: adminMetrics.pctTrend(totals.stationIssues, row.prev_station_issues),
        urgentRepairs: adminMetrics.pctTrend(totals.urgentRepairs, row.prev_urgent_repairs),
        completedRepairs: adminMetrics.pctTrend(totals.completedRepairs, row.prev_completed_repairs),
        pendingInspection: adminMetrics.pctTrend(totals.pendingInspection, row.prev_pending_inspection),
        maintenanceCost: adminMetrics.pctTrend(totals.maintenanceCost, row.prev_maintenance_cost),
        averageRepairTime: adminMetrics.pctTrend(totals.averageRepairTime, row.prev_avg_repair_hours),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/maintenance/overview]", err);
    res.status(500).json({ error: "Could not load maintenance overview." });
  }
});

router.get("/trends", async (req, res) => {
  try {
    const range = parseRange(req.query.range);
    const cfg = bucketConfig(range.key);
    const result = await db.query(
      `
      WITH buckets AS (
        SELECT generate_series(date_trunc($3, $1::timestamptz), date_trunc($3, $2::timestamptz), ('1 ' || $3)::interval) AS bucket_start
      ),
      limited AS (
        SELECT bucket_start, bucket_start + ('1 ' || $3)::interval AS bucket_end FROM buckets ORDER BY bucket_start DESC LIMIT $4
      )
      SELECT
        l.bucket_start,
        COUNT(DISTINCT (
          ml.asset_type || ':' || COALESCE(ml.bike_id::text, ml.station_id::text, ml.id::text)
        )) FILTER (WHERE ml.reported_at < l.bucket_end AND ml.status::text = ANY($5::text[]))::int AS open_tasks,
        COUNT(ml.id) FILTER (WHERE ml.status::text IN ('resolved','closed') AND COALESCE(ml.completed_at, ml.resolved_at, ml.updated_at) >= l.bucket_start AND COALESCE(ml.completed_at, ml.resolved_at, ml.updated_at) < l.bucket_end)::int AS completed_repairs,
        COALESCE(SUM(ml.cost) FILTER (WHERE COALESCE(ml.completed_at, ml.resolved_at, ml.reported_at) >= l.bucket_start AND COALESCE(ml.completed_at, ml.resolved_at, ml.reported_at) < l.bucket_end), 0)::numeric AS maintenance_cost
      FROM limited l
      LEFT JOIN maintenance_logs ml ON ml.reported_at < l.bucket_end
      GROUP BY l.bucket_start
      ORDER BY l.bucket_start ASC
      `,
      [range.currentStart, range.currentEnd, cfg.unit, cfg.count, UNRESOLVED_STATUSES]
    );
    res.json({
      labels: result.rows.map((r) => r.bucket_start),
      openTasks: result.rows.map((r) => Number(r.open_tasks || 0)),
      completedRepairs: result.rows.map((r) => Number(r.completed_repairs || 0)),
      maintenanceCost: result.rows.map((r) => money(r.maintenance_cost)),
    });
  } catch (err) {
    console.error("[GET /api/admin/maintenance/trends]", err);
    res.status(500).json({ error: "Could not load maintenance trend." });
  }
});

router.get("/status-breakdown", async (req, res) => {
  try {
    const range = parseRange(req.query.range);
    const result = await db.query(
      `
      WITH active_tasks AS (${activeTaskSql()}),
      completed AS (
        SELECT COUNT(*)::int AS completed_count
        FROM maintenance_logs
        WHERE status::text IN ('resolved','closed')
          AND COALESCE(completed_at, resolved_at, updated_at) >= $2
          AND COALESCE(completed_at, resolved_at, updated_at) < $3
      )
      SELECT
        COUNT(*) FILTER (WHERE status = 'reported' AND priority NOT IN ('urgent','high') AND severity NOT IN ('critical','high'))::int AS open,
        COUNT(*) FILTER (WHERE status = 'in_progress' AND priority NOT IN ('urgent','high') AND severity NOT IN ('critical','high'))::int AS in_progress,
        COUNT(*) FILTER (WHERE status = 'waiting_parts' AND priority NOT IN ('urgent','high') AND severity NOT IN ('critical','high'))::int AS waiting_parts,
        completed.completed_count AS completed,
        COUNT(*) FILTER (WHERE priority IN ('urgent','high') OR severity IN ('critical','high'))::int AS urgent
      FROM active_tasks, completed
      GROUP BY completed.completed_count
      `,
      [UNRESOLVED_STATUSES, range.currentStart, range.currentEnd]
    );
    const row = result.rows[0] || {};
    res.json({
      open: Number(row.open || 0),
      inProgress: Number(row.in_progress || 0),
      waitingParts: Number(row.waiting_parts || 0),
      completed: Number(row.completed || 0),
      urgent: Number(row.urgent || 0),
    });
  } catch (err) {
    console.error("[GET /api/admin/maintenance/status-breakdown]", err);
    res.status(500).json({ error: "Could not load status breakdown." });
  }
});

router.get("/alerts", async (_req, res) => {
  try {
    const result = await db.query(
      `WITH active_tasks AS (${activeTaskSql()})
       SELECT * FROM active_tasks
        WHERE TRUE
          AND (priority IN ('urgent','high') OR severity IN ('critical','high'))
        ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 ELSE 3 END, reported_at DESC
        LIMIT 5`,
      [UNRESOLVED_STATUSES]
    );
    res.json({ alerts: result.rows.map(mapTask) });
  } catch (err) {
    console.error("[GET /api/admin/maintenance/alerts]", err);
    res.status(500).json({ error: "Could not load urgent alerts." });
  }
});

router.get("/technician-tasks", async (_req, res) => {
  try {
    const result = await db.query(
      `WITH active_tasks AS (${activeTaskSql()})
       SELECT * FROM active_tasks
        WHERE technician_name IS NOT NULL
        ORDER BY estimated_completion_at NULLS LAST, reported_at DESC
        LIMIT 5`,
      [UNRESOLVED_STATUSES]
    );
    res.json({ tasks: result.rows.map(mapTask) });
  } catch (err) {
    console.error("[GET /api/admin/maintenance/technician-tasks]", err);
    res.status(500).json({ error: "Could not load technician tasks." });
  }
});

router.get("/activity", async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 5, 20);
    const result = await db.query(
      `
      SELECT * FROM (
        SELECT 'repair_completed' AS type,
               'Repair completed' AS title,
               INITCAP(REPLACE(issue_type, '_', ' ')) || ' fixed' AS description,
               COALESCE(completed_at, resolved_at, updated_at) AS created_at,
               id
          FROM maintenance_logs
         WHERE status::text IN ('resolved','closed')
        UNION ALL
        SELECT 'maintenance_flagged' AS type,
               'Bike sent to maintenance' AS title,
               INITCAP(REPLACE(issue_type, '_', ' ')) AS description,
               reported_at AS created_at,
               id
          FROM maintenance_logs
         WHERE asset_type = 'bike'
        UNION ALL
        SELECT 'technician_assigned' AS type,
               'Technician assigned' AS title,
               technician_name || ' assigned to ' || INITCAP(REPLACE(issue_type, '_', ' ')) AS description,
               updated_at AS created_at,
               id
          FROM maintenance_logs
         WHERE technician_name IS NOT NULL
        UNION ALL
        SELECT 'station_repaired' AS type,
               'Station dock repaired' AS title,
               INITCAP(REPLACE(issue_type, '_', ' ')) AS description,
               COALESCE(completed_at, resolved_at, updated_at) AS created_at,
               id
          FROM maintenance_logs
         WHERE asset_type = 'station'
      ) a
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );
    res.json({
      activity: result.rows.map((r) => ({
        id: Number(r.id),
        type: r.type,
        title: cleanDisplay(r.title, "Maintenance activity"),
        description: cleanDisplay(r.description, "Maintenance update"),
        timestamp: r.created_at,
      })),
    });
  } catch (err) {
    console.error("[GET /api/admin/maintenance/activity]", err);
    res.status(500).json({ error: "Could not load maintenance activity." });
  }
});

router.get("/list", async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, 100000);
    const limit = parsePositiveInt(req.query.limit, 10, 100);
    const offset = (page - 1) * limit;
    const inner = `WITH base AS (${baseSql()}) SELECT *, ('MT-' || LPAD(id::text, 4, '0')) AS task_id_text FROM base`;
    const filters = buildFilters(req.query);
    const countResult = await db.query(`WITH scoped AS (${inner}) SELECT COUNT(*)::int AS total FROM scoped${filters.clause}`, filters.params);
    const total = Number(countResult.rows[0]?.total || 0);
    const params = [...filters.params, limit, offset];
    const result = await db.query(
      `WITH scoped AS (${inner})
       SELECT * FROM scoped${filters.clause}
       ORDER BY
        CASE display_status WHEN 'urgent' THEN 1 WHEN 'open' THEN 2 WHEN 'in_progress' THEN 3 WHEN 'waiting_parts' THEN 4 WHEN 'pending_inspection' THEN 5 ELSE 6 END,
        reported_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ tasks: result.rows.map(mapTask), total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    console.error("[GET /api/admin/maintenance/list]", err);
    res.status(500).json({ error: "Could not load maintenance tasks." });
  }
});

router.get("/:taskId", async (req, res) => {
  try {
    const raw = String(req.params.taskId || "").replace(/^MT-/i, "");
    const id = Number.parseInt(raw, 10);
    if (!id) return res.status(400).json({ error: "Invalid task ID." });
    const result = await db.query(`WITH base AS (${baseSql()}) SELECT * FROM base WHERE id = $1`, [id]);
    if (!result.rowCount) return res.status(404).json({ error: "Maintenance task not found." });
    res.json({ task: mapTask(result.rows[0]) });
  } catch (err) {
    console.error("[GET /api/admin/maintenance/:taskId]", err);
    res.status(500).json({ error: "Could not load maintenance detail." });
  }
});

router.post("/", async (req, res) => {
  try {
    const assetType = String(req.body.assetType || "bike").toLowerCase() === "station" ? "station" : "bike";
    const bikeId = assetType === "bike" ? Number(req.body.bikeId || req.body.bike_id) : null;
    const stationId = assetType === "station" ? Number(req.body.stationId || req.body.station_id) : (req.body.stationId ? Number(req.body.stationId) : null);
    if (assetType === "bike" && !bikeId) return res.status(400).json({ error: "Bike is required." });
    if (assetType === "station" && !stationId) return res.status(400).json({ error: "Station is required." });
    const priority = ["low", "medium", "high", "urgent"].includes(String(req.body.priority || "").toLowerCase()) ? String(req.body.priority).toLowerCase() : "medium";
    const severity = priorityToSeverity(priority);
    const issueType = cleanDisplay(req.body.issueType || "Maintenance", "Maintenance").toLowerCase().replace(/\s+/g, "_").slice(0, 50);
    const description = cleanDisplay(req.body.description, "Maintenance task requires review.");
    const technician = cleanDisplay(req.body.technicianName || req.body.technician, "").slice(0, 120) || null;
    const estimate = req.body.estimatedCompletion || req.body.estimated_completion_at || null;
    const cost = money(req.body.cost || req.body.initialCost || 0);
    const supportTicketId = req.body.supportTicketId ? Number(req.body.supportTicketId) : null;
    const result = await db.query(
      `INSERT INTO maintenance_logs
        (asset_type, bike_id, station_id, issue_type, description, severity, priority, status, technician_name, estimated_completion_at, cost, support_ticket_id, notes, reported_at)
       VALUES ($1, $2, $3, $4, $5, $6::maintenance_severity, $7, 'reported', $8, $9, $10, $11, $12, NOW())
       RETURNING id, bike_id`,
      [assetType, bikeId, stationId, issueType, description, severity, priority, technician, estimate || null, cost, supportTicketId, cleanDisplay(req.body.notes, "")]
    );
    if (bikeId && ["high", "urgent"].includes(priority)) {
      await db.query("UPDATE bikes SET status = 'maintenance', updated_at = NOW() WHERE id = $1", [bikeId]);
    }
    await logActivity("maintenance_created", `Maintenance task created ${taskCode(result.rows[0].id)}`, description, bikeId);
    res.status(201).json({ taskId: taskCode(result.rows[0].id), id: Number(result.rows[0].id) });
  } catch (err) {
    console.error("[POST /api/admin/maintenance]", err);
    res.status(500).json({ error: "Could not create maintenance task." });
  }
});

router.patch("/:taskId/status", async (req, res) => {
  try {
    const id = Number.parseInt(String(req.params.taskId).replace(/^MT-/i, ""), 10);
    const status = dbStatus(req.body.status);
    if (!id || !status) return res.status(400).json({ error: "Valid task ID and status are required." });
    if (status === "resolved") return await completeTask(req, res, id);
    const result = await db.query(
      `UPDATE maintenance_logs SET status = $1::maintenance_status, updated_at = NOW() WHERE id = $2 RETURNING id, bike_id`,
      [status, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Maintenance task not found." });
    if (result.rows[0].bike_id && ["in_progress", "waiting_parts", "pending_inspection"].includes(status)) {
      await db.query("UPDATE bikes SET status = 'maintenance', updated_at = NOW() WHERE id = $1", [result.rows[0].bike_id]);
    }
    res.json({ ok: true, taskId: taskCode(id), status });
  } catch (err) {
    console.error("[PATCH /api/admin/maintenance/:taskId/status]", err);
    res.status(500).json({ error: "Could not update maintenance status." });
  }
});

router.patch("/:taskId/assign-technician", async (req, res) => {
  try {
    const id = Number.parseInt(String(req.params.taskId).replace(/^MT-/i, ""), 10);
    const technician = cleanDisplay(req.body.technicianName || req.body.technician, "").slice(0, 120);
    if (!id || !technician) return res.status(400).json({ error: "Technician is required." });
    await db.query("INSERT INTO technicians (full_name) VALUES ($1) ON CONFLICT (full_name) DO NOTHING", [technician]);
    const result = await db.query(
      "UPDATE maintenance_logs SET technician_name = $1, status = CASE WHEN status::text = 'reported' THEN 'in_progress'::maintenance_status ELSE status END, updated_at = NOW() WHERE id = $2 RETURNING id, bike_id",
      [technician, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Maintenance task not found." });
    await logActivity("technician_assigned", `Technician assigned ${taskCode(id)}`, `${technician} assigned to maintenance task.`, result.rows[0].bike_id);
    res.json({ ok: true, taskId: taskCode(id), technician });
  } catch (err) {
    console.error("[PATCH /api/admin/maintenance/:taskId/assign-technician]", err);
    res.status(500).json({ error: "Could not assign technician." });
  }
});

router.patch("/:taskId/cost", async (req, res) => {
  try {
    const id = Number.parseInt(String(req.params.taskId).replace(/^MT-/i, ""), 10);
    const cost = money(req.body.cost);
    if (!id || cost < 0) return res.status(400).json({ error: "Valid cost is required." });
    const result = await db.query("UPDATE maintenance_logs SET cost = $1, updated_at = NOW() WHERE id = $2 RETURNING id, bike_id", [cost, id]);
    if (!result.rowCount) return res.status(404).json({ error: "Maintenance task not found." });
    await logActivity("repair_cost_added", `Repair cost updated ${taskCode(id)}`, `Repair cost set to $${cost.toFixed(2)}.`, result.rows[0].bike_id);
    res.json({ ok: true, taskId: taskCode(id), cost });
  } catch (err) {
    console.error("[PATCH /api/admin/maintenance/:taskId/cost]", err);
    res.status(500).json({ error: "Could not update repair cost." });
  }
});

async function completeTask(req, res, explicitId = null) {
  const id = explicitId || Number.parseInt(String(req.params.taskId).replace(/^MT-/i, ""), 10);
  const cost = req.body.cost == null ? null : money(req.body.cost);
  const result = await db.query(
    `UPDATE maintenance_logs
        SET status = 'resolved',
            resolved_at = NOW(),
            completed_at = NOW(),
            cost = COALESCE($1, cost),
            severity = 'low',
            notes = COALESCE(NULLIF($2, ''), notes),
            resolution_notes = COALESCE(NULLIF($2, ''), resolution_notes),
            updated_at = NOW()
      WHERE id = $3
      RETURNING id, bike_id, station_id`,
    [cost, cleanDisplay(req.body.notes, ""), id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Maintenance task not found." });
  const row = result.rows[0];
  if (row.bike_id) {
    await db.query("UPDATE bikes SET status = 'available', last_maintenance_at = NOW(), \"condition\" = 'good', updated_at = NOW() WHERE id = $1 AND status::text NOT IN ('offline','disabled','retired')", [row.bike_id]);
  }
  if (row.station_id) {
    await db.query("UPDATE stations SET status = 'active', updated_at = NOW() WHERE id = $1", [row.station_id]);
  }
  await logActivity("repair_completed", `Repair completed ${taskCode(id)}`, "Maintenance task completed.", row.bike_id);
  return res.json({ ok: true, taskId: taskCode(id), status: "completed" });
}

router.patch("/:taskId/complete", async (req, res) => {
  try {
    await completeTask(req, res);
  } catch (err) {
    console.error("[PATCH /api/admin/maintenance/:taskId/complete]", err);
    res.status(500).json({ error: "Could not complete maintenance task." });
  }
});

module.exports = router;
