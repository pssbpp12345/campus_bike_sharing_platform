// /api/admin/bikes/* - endpoints powering Admin_bikes.html.
// All endpoints require an admin JWT and use parameterised SQL.
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const adminMetrics = require("../services/adminMetrics");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";

const BAD_VISIBLE_RE = /demo|seed|test|profit|loss/i;
const ACTIVE_BOOKING_SQL = `
  bk.status = 'active'
  AND bk.start_time <= NOW()
  AND COALESCE(
    bk.end_time,
    bk.expires_at,
    bk.start_time + (COALESCE(bk.duration_minutes, 60) || ' minutes')::interval
  ) > NOW()
`;

let schemaReadyPromise = null;

function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Admin login required." });
    const payload = jwt.verify(token, JWT_SECRET);
    if ((payload.role || "").toLowerCase() !== "admin") {
      return res.status(403).json({ error: "Administrator access required." });
    }
    req.user = payload;
    next();
  } catch (_) {
    res.status(401).json({ error: "Invalid or expired admin session." });
  }
}

async function ensureBikeAdminSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await db.query("ALTER TYPE bike_status ADD VALUE IF NOT EXISTS 'reserved'");
      await db.query("ALTER TYPE bike_status ADD VALUE IF NOT EXISTS 'offline'");
      await db.query("ALTER TYPE bike_status ADD VALUE IF NOT EXISTS 'disabled'");
      await db.query("ALTER TYPE admin_activity_type ADD VALUE IF NOT EXISTS 'bike_added'");
      await db.query("ALTER TYPE admin_activity_type ADD VALUE IF NOT EXISTS 'bike_assigned'");
      await db.query("ALTER TYPE admin_activity_type ADD VALUE IF NOT EXISTS 'bike_disabled'");
      await db.query("ALTER TYPE admin_activity_type ADD VALUE IF NOT EXISTS 'bike_status_updated'");
      await db.query("ALTER TYPE admin_activity_type ADD VALUE IF NOT EXISTS 'battery_warning'");
      await db.query(`
        ALTER TABLE bikes
          ADD COLUMN IF NOT EXISTS battery_level INTEGER NOT NULL DEFAULT 100,
          ADD COLUMN IF NOT EXISTS "condition" VARCHAR(40) NOT NULL DEFAULT 'good',
          ADD COLUMN IF NOT EXISTS gps_status VARCHAR(40) NOT NULL DEFAULT 'online',
          ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ
      `);
      await db.query("CREATE INDEX IF NOT EXISTS idx_bikes_battery_level ON bikes(battery_level)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_bikes_station_status ON bikes(station_id, status)");
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
    await ensureBikeAdminSchema();
    next();
  } catch (err) {
    console.error("[adminBikes schema]", err);
    res.status(500).json({ error: "Could not prepare bike management schema." });
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

function cleanName(value, id) {
  const names = [
    "Alice Johnson", "Sarah Lee", "Michael Brown", "Emily Davis", "Logan Lewis",
    "Olivia Smith", "John Smith", "Ava Chen", "Noah Patel", "Mia Thompson",
  ];
  const text = cleanDisplay(value, "");
  return text || names[Math.abs(Number(id || 0)) % names.length];
}

function normaliseRequestedStatus(status) {
  const key = String(status || "").toLowerCase().trim().replace(/\s+/g, "_");
  if (key === "active") return "in_use";
  if (key === "disabled") return "disabled";
  if (["available", "reserved", "in_use", "maintenance", "offline"].includes(key)) return key;
  return null;
}

function displayStatus(raw) {
  const key = String(raw || "").toLowerCase();
  if (key === "in_use") return "active";
  if (key === "retired" || key === "disabled") return "offline";
  return key || "available";
}

function statusLabel(status) {
  return String(status || "available")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
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

function mapBikeRow(row) {
  const status = cleanDisplay(row.display_status || displayStatus(row.status), "available").toLowerCase().replace(/\s+/g, "_");
  return {
    id: Number(row.id),
    bikeId: cleanBikeCode(row.bike_code, row.id),
    bikeCode: cleanBikeCode(row.bike_code, row.id),
    type: cleanDisplay(row.bike_type || row.model, "Standard"),
    currentStation: cleanDisplay(row.station_name, status === "active" ? "In use" : "Not assigned"),
    stationId: row.station_id ? Number(row.station_id) : null,
    status,
    statusLabel: statusLabel(status),
    rawStatus: displayStatus(row.status),
    batteryLevel: Number(row.battery_level ?? 100),
    lastUsed: row.last_used_at || row.last_booking_at || null,
    currentRider: row.current_rider ? cleanName(row.current_rider, row.user_id) : "None",
    currentRiderEmail: cleanDisplay(row.current_rider_email, ""),
    condition: cleanDisplay(row.bike_condition, "Good"),
    maintenance: cleanDisplay(row.maintenance_status_label, "No issue"),
    maintenanceIssue: cleanDisplay(row.issue_type, "No issue"),
    maintenanceSeverity: cleanDisplay(row.severity, "low"),
    totalRides: Number(row.total_rides || 0),
    totalDistance: Number(row.total_distance || 0),
    gpsStatus: cleanDisplay(row.gps_status, "online").toLowerCase(),
    lastMaintenanceDate: row.last_maintenance_at || row.latest_maintenance_at || null,
    activeBookingId: row.active_booking_id ? Number(row.active_booking_id) : null,
    timeRemainingMinutes: row.time_remaining_minutes == null ? null : Number(row.time_remaining_minutes),
  };
}

function baseBikeSql() {
  return `
    WITH bike_base AS (
      SELECT
        b.id,
        b.bike_code,
        b.model,
        CASE
          WHEN LOWER(b.model) LIKE '%electric%' OR LOWER(b.bike_code) LIKE 'E%' THEN 'Electric'
          ELSE 'Standard'
        END AS bike_type,
        b.status::text AS status,
        b.station_id,
        s.station_name,
        b.total_rides,
        b.last_maintenance_at,
        b.battery_level,
        b."condition" AS bike_condition,
        b.gps_status,
        b.last_used_at,
        b.created_at,
        cr.booking_id AS active_booking_id,
        cr.user_id,
        cr.current_rider,
        cr.current_rider_email,
        cr.expected_end,
        CEIL(EXTRACT(EPOCH FROM (cr.expected_end - NOW())) / 60)::int AS time_remaining_minutes,
        lr.last_booking_at,
        lm.id AS maintenance_id,
        lm.issue_type,
        lm.description AS maintenance_description,
        lm.severity::text AS severity,
        lm.status::text AS maintenance_status,
        lm.reported_at AS latest_maintenance_at,
        COALESCE(dist.total_distance, 0)::numeric AS total_distance,
        CASE
          WHEN cr.booking_id IS NOT NULL OR b.status::text = 'in_use' THEN 'active'
          WHEN lm.id IS NOT NULL AND (lm.severity::text IN ('high','critical') OR lm.issue_type ILIKE '%damage%') THEN 'damaged'
          WHEN b.status::text = 'maintenance' OR lm.id IS NOT NULL THEN 'maintenance'
          WHEN b.status::text = 'reserved' THEN 'reserved'
          WHEN b.status::text IN ('offline','disabled','retired') THEN 'offline'
          WHEN b.battery_level < 25 THEN 'low_battery'
          ELSE 'available'
        END AS display_status,
        CASE
          WHEN lm.id IS NOT NULL AND COALESCE(lm.issue_type, '') <> '' THEN INITCAP(REPLACE(lm.issue_type, '_', ' '))
          WHEN b."condition" IS NULL OR b."condition" = '' THEN 'Good'
          ELSE INITCAP(REPLACE(b."condition", '_', ' '))
        END AS condition_label,
        CASE
          WHEN lm.id IS NULL THEN 'No issue'
          WHEN lm.status::text = 'reported' THEN 'Pending'
          WHEN lm.status::text = 'in_progress' THEN 'In progress'
          ELSE INITCAP(REPLACE(lm.status::text, '_', ' '))
        END AS maintenance_status_label
      FROM bikes b
      LEFT JOIN stations s ON s.id = b.station_id
      LEFT JOIN LATERAL (
        SELECT bk.id AS booking_id,
               bk.user_id,
               u.full_name AS current_rider,
               u.email AS current_rider_email,
               COALESCE(
                 bk.end_time,
                 bk.expires_at,
                 bk.start_time + (COALESCE(bk.duration_minutes, 60) || ' minutes')::interval
               ) AS expected_end
          FROM bookings bk
          JOIN users u ON u.id = bk.user_id
         WHERE bk.bike_id = b.id
           AND ${ACTIVE_BOOKING_SQL}
         ORDER BY bk.start_time DESC
         LIMIT 1
      ) cr ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(MAX(end_time), MAX(start_time)) AS last_booking_at
          FROM bookings bk
         WHERE bk.bike_id = b.id
      ) lr ON TRUE
      LEFT JOIN LATERAL (
        SELECT ml.*
          FROM maintenance_logs ml
         WHERE ml.bike_id = b.id
           AND ml.status::text NOT IN ('resolved','closed')
         ORDER BY
           CASE ml.severity::text WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
           ml.reported_at DESC
         LIMIT 1
      ) lm ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(COALESCE(distance_km, duration_minutes * 0.18)), 0) AS total_distance
          FROM bookings bk
         WHERE bk.bike_id = b.id
           AND bk.status = 'completed'
      ) dist ON TRUE
    )
    SELECT * FROM bike_base
  `;
}

function buildBikeFilters(query, startIndex = 1) {
  const params = [];
  const where = [];
  function push(value) {
    params.push(value);
    return "$" + (startIndex + params.length - 1);
  }

  if (query.search) {
    where.push(`(bike_code ILIKE ${push("%" + query.search.trim() + "%")})`);
  }
  if (query.status && query.status !== "all") {
    where.push(`display_status = ${push(query.status)}`);
  }
  if (query.station && query.station !== "all") {
    where.push(`station_id = ${push(Number(query.station))}`);
  }
  if (query.type && query.type !== "all") {
    where.push(`LOWER(bike_type) = LOWER(${push(query.type)})`);
  }
  if (query.battery && query.battery !== "all") {
    if (query.battery === "low") where.push("battery_level < 25");
    if (query.battery === "medium") where.push("battery_level >= 25 AND battery_level < 60");
    if (query.battery === "high") where.push("battery_level >= 60");
  }
  return {
    params,
    clause: where.length ? " WHERE " + where.join(" AND ") : "",
  };
}

async function addActivity(type, title, description, bikeId, userId = null) {
  try {
    await db.query(
      `INSERT INTO admin_activity_log (activity_type, title, description, related_bike_id, related_user_id, created_at)
       VALUES ($1::admin_activity_type, $2, $3, $4, $5, NOW())`,
      [type, title, description, bikeId, userId]
    );
  } catch (err) {
    console.warn("[adminBikes activity]", err.message);
  }
}

async function firstActiveStationId() {
  const result = await db.query("SELECT id FROM stations WHERE is_active = TRUE ORDER BY id LIMIT 1");
  return result.rows[0]?.id || null;
}

router.get("/filters", async (_req, res) => {
  try {
    const [stations, types] = await Promise.all([
      db.query("SELECT id, station_name FROM stations WHERE is_active = TRUE ORDER BY station_name"),
      db.query(`SELECT DISTINCT CASE WHEN LOWER(model) LIKE '%electric%' OR LOWER(bike_code) LIKE 'E%' THEN 'Electric' ELSE 'Standard' END AS type FROM bikes ORDER BY type`),
    ]);
    res.json({
      stations: stations.rows.map((row) => ({ id: Number(row.id), name: cleanDisplay(row.station_name, "Station") })),
      types: types.rows.map((row) => cleanDisplay(row.type, "Standard")),
    });
  } catch (err) {
    console.error("[GET /api/admin/bikes/filters]", err);
    res.status(500).json({ error: "Could not load bike filters." });
  }
});

router.get("/overview", async (req, res) => {
  try {
    const range = parseRange(req.query.range);
    const result = await db.query(
      `
      WITH flags AS (
        SELECT
          b.id,
          b.status::text AS status,
          b.battery_level,
          b.created_at,
          EXISTS (
            SELECT 1 FROM bookings bk
             WHERE bk.bike_id = b.id AND ${ACTIVE_BOOKING_SQL}
          ) AS has_active,
          EXISTS (
            SELECT 1 FROM bookings bk
             WHERE bk.bike_id = b.id
               AND bk.status = 'pending'
               AND bk.start_time > NOW()
          ) AS has_reserved,
          EXISTS (
            SELECT 1 FROM maintenance_logs ml
             WHERE ml.bike_id = b.id
               AND ml.status::text NOT IN ('resolved','closed')
          ) AS has_maintenance,
          EXISTS (
            SELECT 1 FROM maintenance_logs ml
             WHERE ml.bike_id = b.id
               AND ml.status::text NOT IN ('resolved','closed')
               AND (ml.severity::text IN ('high','critical') OR ml.issue_type ILIKE '%damage%')
          ) AS is_damaged
        FROM bikes b
      ),
      cur AS (
        SELECT
          COUNT(*)::int AS total_bikes,
          COUNT(*) FILTER (WHERE status = 'available')::int AS available_bikes,
          COUNT(*) FILTER (WHERE has_active OR status = 'in_use')::int AS active_bikes,
          COUNT(*) FILTER (WHERE has_reserved OR status = 'reserved')::int AS reserved_bikes,
          COUNT(*) FILTER (WHERE has_maintenance OR status = 'maintenance')::int AS maintenance_bikes,
          COUNT(*) FILTER (WHERE status IN ('offline','disabled','retired'))::int AS offline_bikes,
          COUNT(*) FILTER (WHERE battery_level < 25)::int AS low_battery_bikes,
          COUNT(*) FILTER (WHERE is_damaged)::int AS damaged_bikes
        FROM flags
      ),
      prev AS (
        SELECT
          COUNT(*) FILTER (WHERE created_at < $1)::int AS total_bikes,
          COUNT(*) FILTER (WHERE status = 'available' AND created_at < $1)::int AS available_bikes,
          COUNT(*) FILTER (WHERE (has_active OR status = 'in_use') AND created_at < $1)::int AS active_bikes,
          COUNT(*) FILTER (WHERE (has_reserved OR status = 'reserved') AND created_at < $1)::int AS reserved_bikes,
          COUNT(*) FILTER (WHERE (has_maintenance OR status = 'maintenance') AND created_at < $1)::int AS maintenance_bikes,
          COUNT(*) FILTER (WHERE status IN ('offline','disabled','retired') AND created_at < $1)::int AS offline_bikes,
          COUNT(*) FILTER (WHERE battery_level < 25 AND created_at < $1)::int AS low_battery_bikes,
          COUNT(*) FILTER (WHERE is_damaged AND created_at < $1)::int AS damaged_bikes
        FROM flags
      )
      SELECT cur.*, prev.total_bikes AS prev_total_bikes,
             prev.available_bikes AS prev_available_bikes,
             prev.active_bikes AS prev_active_bikes,
             prev.reserved_bikes AS prev_reserved_bikes,
             prev.maintenance_bikes AS prev_maintenance_bikes,
             prev.offline_bikes AS prev_offline_bikes,
             prev.low_battery_bikes AS prev_low_battery_bikes,
             prev.damaged_bikes AS prev_damaged_bikes
        FROM cur, prev
      `,
      [range.currentStart]
    );
    const row = result.rows[0] || {};
    const totals = {
      totalBikes: Number(row.total_bikes || 0),
      availableBikes: Number(row.available_bikes || 0),
      activeBikes: Number(row.active_bikes || 0),
      reservedBikes: Number(row.reserved_bikes || 0),
      maintenanceBikes: Number(row.maintenance_bikes || 0),
      offlineBikes: Number(row.offline_bikes || 0),
      lowBatteryBikes: Number(row.low_battery_bikes || 0),
      damagedBikes: Number(row.damaged_bikes || 0),
    };
    res.json({
      range: range.key,
      totals,
      trends: {
        totalBikes: adminMetrics.pctTrend(totals.totalBikes, row.prev_total_bikes),
        availableBikes: adminMetrics.pctTrend(totals.availableBikes, row.prev_available_bikes),
        activeBikes: adminMetrics.pctTrend(totals.activeBikes, row.prev_active_bikes),
        reservedBikes: adminMetrics.pctTrend(totals.reservedBikes, row.prev_reserved_bikes),
        maintenanceBikes: adminMetrics.pctTrend(totals.maintenanceBikes, row.prev_maintenance_bikes),
        offlineBikes: adminMetrics.pctTrend(totals.offlineBikes, row.prev_offline_bikes),
        lowBatteryBikes: adminMetrics.pctTrend(totals.lowBatteryBikes, row.prev_low_battery_bikes),
        damagedBikes: adminMetrics.pctTrend(totals.damagedBikes, row.prev_damaged_bikes),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/bikes/overview]", err);
    res.status(500).json({ error: "Could not load bike overview." });
  }
});

router.get("/trends", async (req, res) => {
  try {
    const range = parseRange(req.query.range);
    const cfg = bucketConfig(range.key);
    const result = await db.query(
      `
      WITH buckets AS (
        SELECT generate_series(
          date_trunc($3, $1::timestamptz),
          date_trunc($3, $2::timestamptz),
          ('1 ' || $3)::interval
        ) AS bucket_start
      ),
      limited AS (
        SELECT bucket_start,
               bucket_start + ('1 ' || $3)::interval AS bucket_end
          FROM buckets
         ORDER BY bucket_start DESC
         LIMIT $4
      ),
      scoped AS (
        SELECT
          l.bucket_start,
          l.bucket_end,
          COUNT(b.id) FILTER (WHERE b.status::text = 'available')::int AS available,
          COUNT(DISTINCT bk.bike_id)::int AS active,
          COUNT(DISTINCT ml.bike_id)::int AS maintenance
        FROM limited l
        CROSS JOIN bikes b
        LEFT JOIN bookings bk
          ON bk.bike_id = b.id
         AND bk.status = 'active'
         AND bk.start_time < l.bucket_end
         AND COALESCE(bk.end_time, bk.expires_at, bk.start_time + (COALESCE(bk.duration_minutes, 60) || ' minutes')::interval) > l.bucket_start
        LEFT JOIN maintenance_logs ml
          ON ml.bike_id = b.id
         AND ml.reported_at < l.bucket_end
         AND COALESCE(ml.resolved_at, NOW() + INTERVAL '20 years') > l.bucket_start
         AND ml.status::text NOT IN ('resolved','closed')
        WHERE b.created_at < l.bucket_end
        GROUP BY l.bucket_start, l.bucket_end
      )
      SELECT bucket_start, available, active, maintenance
        FROM scoped
       ORDER BY bucket_start ASC
      `,
      [range.currentStart, range.currentEnd, cfg.unit, cfg.count]
    );
    res.json({
      labels: result.rows.map((row) => row.bucket_start),
      available: result.rows.map((row) => Number(row.available || 0)),
      active: result.rows.map((row) => Number(row.active || 0)),
      maintenance: result.rows.map((row) => Number(row.maintenance || 0)),
    });
  } catch (err) {
    console.error("[GET /api/admin/bikes/trends]", err);
    res.status(500).json({ error: "Could not load bike trend data." });
  }
});

router.get("/status-breakdown", async (_req, res) => {
  try {
    const result = await db.query(
      `
      WITH base AS (${baseBikeSql()}),
      grouped AS (
        SELECT display_status, COUNT(*)::int AS count
          FROM base
         GROUP BY display_status
      )
      SELECT
        COALESCE(SUM(count) FILTER (WHERE display_status IN ('available','low_battery')), 0)::int AS available,
        COALESCE(SUM(count) FILTER (WHERE display_status = 'active'), 0)::int AS active,
        COALESCE(SUM(count) FILTER (WHERE display_status = 'reserved'), 0)::int AS reserved,
        COALESCE(SUM(count) FILTER (WHERE display_status = 'maintenance'), 0)::int AS maintenance,
        COALESCE(SUM(count) FILTER (WHERE display_status = 'offline'), 0)::int AS offline,
        COALESCE(SUM(count) FILTER (WHERE display_status = 'damaged'), 0)::int AS damaged,
        (SELECT COUNT(*)::int FROM bikes) AS total
      FROM grouped
      `
    );
    const row = result.rows[0] || {};
    res.json({
      available: Number(row.available || 0),
      active: Number(row.active || 0),
      reserved: Number(row.reserved || 0),
      maintenance: Number(row.maintenance || 0),
      offline: Number(row.offline || 0),
      damaged: Number(row.damaged || 0),
      total: Number(row.total || 0),
    });
  } catch (err) {
    console.error("[GET /api/admin/bikes/status-breakdown]", err);
    res.status(500).json({ error: "Could not load status breakdown." });
  }
});

router.get("/alerts", async (_req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        (SELECT COUNT(DISTINCT bike_id)::int FROM maintenance_logs
          WHERE status::text NOT IN ('resolved','closed')
            AND (severity::text IN ('high','critical') OR issue_type ILIKE '%damage%')) AS damaged,
        (SELECT COUNT(*)::int FROM bikes WHERE battery_level < 25) AS low_battery,
        (SELECT COUNT(*)::int FROM bikes WHERE status::text IN ('offline','disabled','retired')) AS offline,
        (SELECT COUNT(*)::int FROM bikes b
          WHERE b.status::text = 'maintenance'
             OR EXISTS (SELECT 1 FROM maintenance_logs ml WHERE ml.bike_id = b.id AND ml.status::text NOT IN ('resolved','closed'))) AS maintenance,
        (SELECT COUNT(*)::int FROM bookings bk
          WHERE bk.status = 'active'
            AND COALESCE(bk.end_time, bk.expires_at, bk.start_time + (COALESCE(bk.duration_minutes, 60) || ' minutes')::interval) <= NOW()) AS not_returned
      `
    );
    const row = result.rows[0] || {};
    res.json({
      alerts: {
        damaged: Number(row.damaged || 0),
        lowBattery: Number(row.low_battery || 0),
        offline: Number(row.offline || 0),
        maintenance: Number(row.maintenance || 0),
        notReturned: Number(row.not_returned || 0),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/bikes/alerts]", err);
    res.status(500).json({ error: "Could not load bike alerts." });
  }
});

router.get("/list", async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, 100000);
    const limit = parsePositiveInt(req.query.limit, 10, 100);
    const offset = (page - 1) * limit;
    const filters = buildBikeFilters(req.query);
    const countResult = await db.query(`WITH base AS (${baseBikeSql()}) SELECT COUNT(*)::int AS total FROM base${filters.clause}`, filters.params);
    const total = Number(countResult.rows[0]?.total || 0);
    const params = [...filters.params, limit, offset];
    const result = await db.query(
      `WITH base AS (${baseBikeSql()})
       SELECT * FROM base${filters.clause}
       ORDER BY
         CASE display_status
           WHEN 'active' THEN 1 WHEN 'maintenance' THEN 2 WHEN 'damaged' THEN 3
           WHEN 'low_battery' THEN 4 WHEN 'reserved' THEN 5 WHEN 'offline' THEN 6 ELSE 7
         END,
         COALESCE(last_used_at, last_booking_at, created_at) DESC,
         id ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({
      bikes: result.rows.map(mapBikeRow),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error("[GET /api/admin/bikes/list]", err);
    res.status(500).json({ error: "Could not load bikes." });
  }
});

router.get("/live-active", async (_req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        b.id,
        b.bike_code,
        b.model,
        u.id AS user_id,
        u.full_name AS rider,
        ps.station_name AS pickup_station,
        COALESCE(rs.station_name, 'In progress') AS return_station,
        COALESCE(bk.end_time, bk.expires_at, bk.start_time + (COALESCE(bk.duration_minutes, 60) || ' minutes')::interval) AS expected_end,
        CEIL(EXTRACT(EPOCH FROM (COALESCE(bk.end_time, bk.expires_at, bk.start_time + (COALESCE(bk.duration_minutes, 60) || ' minutes')::interval) - NOW())) / 60)::int AS minutes_left,
        bk.id AS booking_id
      FROM bookings bk
      JOIN bikes b ON b.id = bk.bike_id
      JOIN users u ON u.id = bk.user_id
      LEFT JOIN stations ps ON ps.id = bk.pickup_station_id
      LEFT JOIN stations rs ON rs.id = bk.return_station_id
      WHERE ${ACTIVE_BOOKING_SQL}
      ORDER BY bk.start_time DESC
      LIMIT 5
      `
    );
    res.json({
      bikes: result.rows
        .filter((row) => Number(row.minutes_left || 0) > 0)
        .map((row) => ({
          id: Number(row.id),
          bikeId: cleanBikeCode(row.bike_code, row.id),
          rider: cleanName(row.rider, row.user_id),
          route: `${cleanDisplay(row.pickup_station, "Campus station")} -> ${cleanDisplay(row.return_station, "In progress")}`,
          timeRemainingMinutes: Number(row.minutes_left),
          bookingId: Number(row.booking_id),
        })),
    });
  } catch (err) {
    console.error("[GET /api/admin/bikes/live-active]", err);
    res.status(500).json({ error: "Could not load active bikes." });
  }
});

router.get("/activity", async (_req, res) => {
  try {
    const result = await db.query(
      `
      SELECT * FROM (
        SELECT 'bike_returned' AS type,
               'Bike returned to station ' || b.bike_code AS title,
               COALESCE(s.station_name, 'Campus station') AS description,
               COALESCE(bk.end_time, bk.updated_at) AS created_at,
               b.id AS bike_id,
               b.bike_code
          FROM bookings bk
          JOIN bikes b ON b.id = bk.bike_id
          LEFT JOIN stations s ON s.id = bk.return_station_id
         WHERE bk.status = 'completed'
           AND COALESCE(bk.end_time, bk.updated_at) IS NOT NULL
        UNION ALL
        SELECT 'bike_checked_out' AS type,
               'Bike checked out ' || b.bike_code AS title,
               COALESCE(u.full_name, 'Student rider') AS description,
               bk.start_time AS created_at,
               b.id AS bike_id,
               b.bike_code
          FROM bookings bk
          JOIN bikes b ON b.id = bk.bike_id
          JOIN users u ON u.id = bk.user_id
         WHERE bk.status = 'active'
        UNION ALL
        SELECT 'maintenance_flagged' AS type,
               'Bike marked for maintenance ' || b.bike_code AS title,
               INITCAP(REPLACE(ml.issue_type, '_', ' ')) AS description,
               ml.reported_at AS created_at,
               b.id AS bike_id,
               b.bike_code
          FROM maintenance_logs ml
          JOIN bikes b ON b.id = ml.bike_id
        UNION ALL
        SELECT 'battery_warning' AS type,
               'Battery warning triggered ' || b.bike_code AS title,
               b.battery_level || '% battery remaining' AS description,
               COALESCE(b.updated_at, b.created_at) AS created_at,
               b.id AS bike_id,
               b.bike_code
          FROM bikes b
         WHERE b.battery_level < 25
        UNION ALL
        SELECT 'bike_added' AS type,
               'New bike added ' || b.bike_code AS title,
               COALESCE(s.station_name, 'Station pending') AS description,
               b.created_at AS created_at,
               b.id AS bike_id,
               b.bike_code
          FROM bikes b
          LEFT JOIN stations s ON s.id = b.station_id
      ) activity
      ORDER BY created_at DESC
      LIMIT 8
      `
    );
    res.json({
      activity: result.rows.map((row) => ({
        type: row.type,
        title: cleanDisplay(row.title, "Bike activity").replace(cleanDisplay(row.bike_code, ""), cleanBikeCode(row.bike_code, row.bike_id)),
        description: cleanDisplay(row.description, "Bike operation update"),
        timestamp: row.created_at,
        bikeId: cleanBikeCode(row.bike_code, row.bike_id),
      })),
    });
  } catch (err) {
    console.error("[GET /api/admin/bikes/activity]", err);
    res.status(500).json({ error: "Could not load bike activity." });
  }
});

router.get("/:bikeId", async (req, res) => {
  try {
    const identifier = String(req.params.bikeId || "");
    const isNumeric = /^\d+$/.test(identifier);
    const result = await db.query(
      `WITH base AS (${baseBikeSql()})
       SELECT * FROM base WHERE ${isNumeric ? "id = $1" : "bike_code = $1"} LIMIT 1`,
      [isNumeric ? Number(identifier) : identifier]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Bike not found." });
    res.json({ bike: mapBikeRow(result.rows[0]) });
  } catch (err) {
    console.error("[GET /api/admin/bikes/:bikeId]", err);
    res.status(500).json({ error: "Could not load bike details." });
  }
});

router.post("/", async (req, res) => {
  try {
    const bikeCode = cleanBikeCode(req.body.bikeCode || req.body.bike_id, Date.now()).slice(0, 20);
    const model = cleanDisplay(req.body.model || req.body.type, "Standard").slice(0, 100);
    const stationId = req.body.stationId || req.body.station_id || await firstActiveStationId();
    const batteryLevel = Math.max(0, Math.min(100, Number(req.body.batteryLevel ?? 100)));
    const exists = await db.query("SELECT id FROM bikes WHERE LOWER(bike_code) = LOWER($1)", [bikeCode]);
    if (exists.rowCount) return res.status(409).json({ error: "A bike with this ID already exists." });
    const result = await db.query(
      `INSERT INTO bikes (bike_code, model, status, station_id, battery_level, "condition", gps_status, last_used_at)
       VALUES ($1, $2, 'available', $3, $4, 'good', 'online', NULL)
       RETURNING *`,
      [bikeCode, model, stationId ? Number(stationId) : null, batteryLevel]
    );
    await addActivity("bike_added", `New bike added ${bikeCode}`, "Bike added to the fleet.", result.rows[0].id);
    res.status(201).json({ bike: mapBikeRow({ ...result.rows[0], bike_type: model, display_status: "available", station_name: null }) });
  } catch (err) {
    console.error("[POST /api/admin/bikes]", err);
    res.status(500).json({ error: "Could not add bike." });
  }
});

router.patch("/:bikeId/status", async (req, res) => {
  try {
    const status = normaliseRequestedStatus(req.body.status);
    if (!status) return res.status(400).json({ error: "Unsupported bike status." });
    const identifier = String(req.params.bikeId || "");
    const isNumeric = /^\d+$/.test(identifier);
    let stationId = req.body.stationId || req.body.station_id || null;
    if (status === "available" && !stationId) stationId = await firstActiveStationId();
    const result = await db.query(
      `UPDATE bikes
          SET status = $1::bike_status,
              station_id = CASE WHEN $1::text = 'in_use' THEN NULL ELSE COALESCE($2, station_id) END,
              disabled_at = CASE WHEN $1::text = 'disabled' THEN NOW() ELSE NULL END,
              updated_at = NOW()
        WHERE ${isNumeric ? "id = $3" : "bike_code = $3"}
        RETURNING id, bike_code`,
      [status, stationId ? Number(stationId) : null, isNumeric ? Number(identifier) : identifier]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Bike not found." });
    if (status === "available") {
      await db.query(
        `UPDATE maintenance_logs
            SET status = 'resolved',
                resolved_at = COALESCE(resolved_at, NOW()),
                resolution_notes = COALESCE(resolution_notes, 'Marked available by administrator.'),
                updated_at = NOW()
          WHERE bike_id = $1
            AND status::text NOT IN ('resolved','closed')`,
        [result.rows[0].id]
      );
      await db.query("UPDATE bikes SET \"condition\" = 'good', gps_status = 'online', updated_at = NOW() WHERE id = $1", [result.rows[0].id]);
    }
    await addActivity("bike_status_updated", `Bike status updated ${result.rows[0].bike_code}`, `Bike marked ${statusLabel(displayStatus(status))}.`, result.rows[0].id);
    res.json({ ok: true, bikeId: cleanBikeCode(result.rows[0].bike_code, result.rows[0].id), status: displayStatus(status) });
  } catch (err) {
    console.error("[PATCH /api/admin/bikes/:bikeId/status]", err);
    res.status(500).json({ error: "Could not update bike status." });
  }
});

router.patch("/:bikeId/assign-station", async (req, res) => {
  try {
    const stationId = Number(req.body.stationId || req.body.station_id);
    if (!stationId) return res.status(400).json({ error: "stationId is required." });
    const identifier = String(req.params.bikeId || "");
    const isNumeric = /^\d+$/.test(identifier);
    const active = await db.query(
      `SELECT 1 FROM bookings bk JOIN bikes b ON b.id = bk.bike_id
        WHERE ${isNumeric ? "b.id = $1" : "b.bike_code = $1"} AND ${ACTIVE_BOOKING_SQL}
        LIMIT 1`,
      [isNumeric ? Number(identifier) : identifier]
    );
    if (active.rowCount) return res.status(409).json({ error: "Active bikes cannot be assigned until the ride ends." });
    const result = await db.query(
      `UPDATE bikes
          SET station_id = $1,
              status = CASE WHEN status::text IN ('in_use') THEN 'available'::bike_status ELSE status END,
              updated_at = NOW()
        WHERE ${isNumeric ? "id = $2" : "bike_code = $2"}
        RETURNING id, bike_code`,
      [stationId, isNumeric ? Number(identifier) : identifier]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Bike not found." });
    await addActivity("bike_assigned", `Bike assigned to station ${result.rows[0].bike_code}`, "Bike station assignment updated.", result.rows[0].id);
    res.json({ ok: true, bikeId: cleanBikeCode(result.rows[0].bike_code, result.rows[0].id) });
  } catch (err) {
    console.error("[PATCH /api/admin/bikes/:bikeId/assign-station]", err);
    res.status(500).json({ error: "Could not assign station." });
  }
});

router.post("/:bikeId/maintenance", async (req, res) => {
  try {
    const identifier = String(req.params.bikeId || "");
    const isNumeric = /^\d+$/.test(identifier);
    const bike = await db.query(`SELECT id, bike_code, station_id FROM bikes WHERE ${isNumeric ? "id = $1" : "bike_code = $1"} LIMIT 1`, [isNumeric ? Number(identifier) : identifier]);
    if (!bike.rowCount) return res.status(404).json({ error: "Bike not found." });
    const row = bike.rows[0];
    const issueType = cleanDisplay(req.body.issueType || req.body.issue_type, "General service").toLowerCase().replace(/\s+/g, "_").slice(0, 40);
    const description = cleanDisplay(req.body.description, "Bike requires maintenance review.");
    const severity = ["low", "medium", "high", "critical"].includes(String(req.body.severity || "").toLowerCase()) ? String(req.body.severity).toLowerCase() : "medium";
    await db.query(
      `INSERT INTO maintenance_logs (bike_id, station_id, issue_type, description, severity, status, reported_at, cost)
       VALUES ($1, $2, $3, $4, $5::maintenance_severity, 'reported', NOW(), 0)`,
      [row.id, row.station_id, issueType, description, severity]
    );
    await db.query("UPDATE bikes SET status = 'maintenance', \"condition\" = $2, updated_at = NOW() WHERE id = $1", [row.id, issueType]);
    await addActivity("maintenance_flagged", `Bike marked for maintenance ${row.bike_code}`, description, row.id);
    res.json({ ok: true, bikeId: cleanBikeCode(row.bike_code, row.id) });
  } catch (err) {
    console.error("[POST /api/admin/bikes/:bikeId/maintenance]", err);
    res.status(500).json({ error: "Could not send bike to maintenance." });
  }
});

router.patch("/:bikeId/disable", async (req, res) => {
  try {
    const identifier = String(req.params.bikeId || "");
    const isNumeric = /^\d+$/.test(identifier);
    const result = await db.query(
      `UPDATE bikes
          SET status = 'disabled',
              disabled_at = NOW(),
              updated_at = NOW()
        WHERE ${isNumeric ? "id = $1" : "bike_code = $1"}
        RETURNING id, bike_code`,
      [isNumeric ? Number(identifier) : identifier]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Bike not found." });
    await addActivity("bike_disabled", `Bike disabled ${result.rows[0].bike_code}`, "Bike removed from active service.", result.rows[0].id);
    res.json({ ok: true, bikeId: cleanBikeCode(result.rows[0].bike_code, result.rows[0].id) });
  } catch (err) {
    console.error("[PATCH /api/admin/bikes/:bikeId/disable]", err);
    res.status(500).json({ error: "Could not disable bike." });
  }
});

module.exports = router;
