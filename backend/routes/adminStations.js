// ──────────────────────────────────────────────────────────────
// /api/admin/stations/* — powers Admin_stations.html.
// All endpoints require an admin JWT. Parameterised SQL throughout.
// ──────────────────────────────────────────────────────────────
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");

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

// ── helpers ──
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
function pctTrend(c, p) {
  const cur = Number(c || 0), prev = Number(p || 0);
  if (prev === 0) return cur === 0 ? 0 : 100;
  return Number((((cur - prev) / Math.abs(prev)) * 100).toFixed(1));
}

// ── GET /overview ──
router.get("/overview", requireAdmin, async (req, res) => {
  try {
    const r = parseRange(req.query.range);
    const result = await db.query(
      `
      WITH bike_counts AS (
        SELECT
          station_id,
          COUNT(*) FILTER (WHERE status = 'available')   AS avail,
          COUNT(*)                                       AS total_assigned,
          COUNT(*) FILTER (WHERE status = 'maintenance') AS maint
        FROM bikes
        WHERE station_id IS NOT NULL
        GROUP BY station_id
      ),
      station_metrics AS (
        SELECT
          s.id, s.capacity, s.status,
          COALESCE(bc.avail, 0)          AS avail,
          COALESCE(bc.total_assigned, 0) AS assigned,
          COALESCE(bc.maint, 0)          AS maint,
          CASE
            WHEN s.status = 'offline' OR s.is_active = FALSE THEN 'offline'
            WHEN s.status = 'maintenance'
                 OR (SELECT COUNT(*) FROM maintenance_logs ml JOIN bikes b ON b.id = ml.bike_id WHERE b.station_id = s.id AND ml.status::text NOT IN ('resolved','closed')) > 0
                 OR COALESCE(bc.maint, 0) >= 2 THEN 'maintenance'
            WHEN COALESCE(bc.total_assigned, 0) >= s.capacity THEN 'full'
            WHEN COALESCE(bc.avail, 0) <= 3 OR (s.capacity > 0 AND COALESCE(bc.avail, 0)::float / s.capacity < 0.20) THEN 'low'
            ELSE 'normal'
          END AS effective_status
        FROM stations s
        LEFT JOIN bike_counts bc ON bc.station_id = s.id
      )
      SELECT
        COUNT(*)                                                                  AS total_stations,
        COUNT(*) FILTER (WHERE effective_status NOT IN ('offline'))               AS active_stations,
        COALESCE(SUM(avail), 0)                                                   AS available_bikes,
        COALESCE(SUM(capacity), 0)                                                AS total_capacity,
        COUNT(*) FILTER (WHERE effective_status = 'low')                          AS low_avail_stations,
        COUNT(*) FILTER (WHERE effective_status = 'full')                         AS full_stations,
        COUNT(*) FILTER (WHERE effective_status = 'maintenance')                  AS maint_stations,
        COUNT(*) FILTER (WHERE effective_status = 'offline')                      AS offline_stations
      FROM station_metrics
      `
    );
    const row = result.rows[0] || {};

    // Trend = compare bookings count between current and previous period
    const trendRes = await db.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE start_time BETWEEN $1 AND $2) AS cur,
        COUNT(*) FILTER (WHERE start_time BETWEEN $3 AND $4) AS prev
      FROM bookings
      `,
      [r.start, r.end, r.prevStart, r.prevEnd]
    );
    const t = trendRes.rows[0] || {};
    const utilTrend = pctTrend(t.cur, t.prev);

    res.json({
      range: r.key,
      totals: {
        totalStations:           Number(row.total_stations || 0),
        activeStations:          Number(row.active_stations || 0),
        availableBikes:          Number(row.available_bikes || 0),
        totalCapacity:           Number(row.total_capacity || 0),
        lowAvailabilityStations: Number(row.low_avail_stations || 0),
        fullStations:            Number(row.full_stations || 0),
        maintenanceStations:     Number(row.maint_stations || 0),
        offlineStations:         Number(row.offline_stations || 0),
      },
      // Trend approximation: shared "vs prev period" booking volume movement
      trends: {
        totalStations: 0, activeStations: 0, availableBikes: 0, totalCapacity: 0,
        lowAvailabilityStations: 0, fullStations: 0, maintenanceStations: 0, offlineStations: 0,
        bookingVolume: utilTrend,
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/stations/overview]", err);
    res.status(500).json({ error: "Could not load station overview." });
  }
});

// ── GET /trends ──
// Available / reserved-active / maintenance bike counts over time. Reserved
// counts come from the bookings table (active or pending bookings whose start
// time falls in the bucket).
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
        date_trunc($1, bk.start_time) AS bucket,
        COUNT(*) FILTER (WHERE bk.status::text IN ('pending'))                 AS reserved,
        COUNT(*) FILTER (WHERE bk.status::text IN ('active'))                  AS active
      FROM bookings bk
      WHERE bk.start_time BETWEEN $2 AND $3
      GROUP BY bucket
      ORDER BY bucket ASC
      `,
      [bucket, r.start, r.end]
    );

    // Available bikes baseline = current snapshot (we don't have per-bucket history).
    // We project the snapshot horizontally so the line is a steady reference.
    const snap = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'available')   AS avail,
         COUNT(*) FILTER (WHERE status = 'maintenance') AS maint
       FROM bikes`
    );
    const baseAvail = Number(snap.rows[0].avail || 0);
    const baseMaint = Number(snap.rows[0].maint || 0);

    const labels = [], available = [], reservedActive = [], maintenance = [];
    result.rows.forEach((row) => {
      const d = new Date(row.bucket);
      if (r.key === "today")      labels.push(d.toLocaleTimeString("en-AU", { hour: "2-digit" }));
      else if (r.key === "year")  labels.push(d.toLocaleDateString("en-AU", { month: "short" }));
      else                        labels.push(d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }));
      available.push(baseAvail);
      reservedActive.push(Number(row.reserved) + Number(row.active));
      maintenance.push(baseMaint);
    });
    if (!labels.length) {
      // Empty range → show a single "now" data point so the chart isn't blank.
      labels.push("Now");
      available.push(baseAvail);
      reservedActive.push(0);
      maintenance.push(baseMaint);
    }
    res.json({ range: r.key, bucket, labels, series: { available, reservedActive, maintenance } });
  } catch (err) {
    console.error("[GET /api/admin/stations/trends]", err);
    res.status(500).json({ error: "Could not load station trends." });
  }
});

// ── GET /capacity-breakdown ──
router.get("/capacity-breakdown", requireAdmin, async (_req, res) => {
  try {
    const result = await db.query(
      `
      WITH bike_counts AS (
        SELECT station_id,
               COUNT(*) FILTER (WHERE status = 'available')   AS avail,
               COUNT(*)                                       AS total_assigned,
               COUNT(*) FILTER (WHERE status = 'maintenance') AS maint
        FROM bikes
        WHERE station_id IS NOT NULL
        GROUP BY station_id
      )
      SELECT
        CASE
          WHEN s.status = 'offline' OR s.is_active = FALSE THEN 'offline'
          WHEN s.status = 'maintenance'
               OR (SELECT COUNT(*) FROM maintenance_logs ml JOIN bikes b ON b.id = ml.bike_id WHERE b.station_id = s.id AND ml.status::text NOT IN ('resolved','closed')) > 0
               OR COALESCE(bc.maint, 0) >= 2 THEN 'maintenance'
          WHEN COALESCE(bc.total_assigned, 0) >= s.capacity THEN 'full'
          WHEN COALESCE(bc.avail, 0) <= 3 OR (s.capacity > 0 AND COALESCE(bc.avail, 0)::float / s.capacity < 0.20) THEN 'low'
          ELSE 'normal'
        END AS effective_status,
        COUNT(*) AS count
      FROM stations s
      LEFT JOIN bike_counts bc ON bc.station_id = s.id
      GROUP BY effective_status
      `
    );
    const palette = {
      normal:      { label: "Normal Capacity", color: "#22C55E" },
      low:         { label: "Low Availability", color: "#F59E0B" },
      full:        { label: "Full",             color: "#8B5CF6" },
      offline:     { label: "Offline",          color: "#94A3B8" },
      maintenance: { label: "Maintenance",      color: "#EF4444" },
    };
    const counts = { normal: 0, low: 0, full: 0, offline: 0, maintenance: 0 };
    result.rows.forEach(r => { if (counts[r.effective_status] != null) counts[r.effective_status] = Number(r.count || 0); });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const pct = (n) => total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
    res.json({
      total,
      breakdown: ["normal","low","full","offline","maintenance"].map(key => ({
        key, label: palette[key].label, count: counts[key], pct: pct(counts[key]), color: palette[key].color,
      })),
    });
  } catch (err) {
    console.error("[GET /api/admin/stations/capacity-breakdown]", err);
    res.status(500).json({ error: "Could not load capacity breakdown." });
  }
});

// ── GET /alerts ──
router.get("/alerts", requireAdmin, async (_req, res) => {
  try {
    const result = await db.query(
      `
      WITH bike_counts AS (
        SELECT station_id,
               COUNT(*) FILTER (WHERE status = 'available')   AS avail,
               COUNT(*)                                       AS total_assigned,
               COUNT(*) FILTER (WHERE status = 'maintenance') AS maint
        FROM bikes
        WHERE station_id IS NOT NULL
        GROUP BY station_id
      )
      SELECT
        COUNT(*) FILTER (
          WHERE (s.status = 'active' OR s.is_active = TRUE)
            AND s.status NOT IN ('offline','maintenance')
            AND COALESCE(bc.avail, 0) <= 3
            AND COALESCE(bc.total_assigned, 0) < s.capacity
        )                                                                            AS low_bike_availability,
        COUNT(*) FILTER (WHERE COALESCE(bc.total_assigned, 0) >= s.capacity)         AS station_full,
        COUNT(*) FILTER (WHERE s.status = 'offline' OR s.is_active = FALSE)          AS station_offline,
        COUNT(*) FILTER (
          WHERE s.capacity > 0
            AND COALESCE(bc.avail, 0)::float / s.capacity > 0.85
        )                                                                            AS bikes_redistribution,
        COUNT(*) FILTER (
          WHERE s.status = 'maintenance'
             OR (SELECT COUNT(*) FROM maintenance_logs ml JOIN bikes b ON b.id = ml.bike_id WHERE b.station_id = s.id AND ml.status::text NOT IN ('resolved','closed')) > 0
             OR COALESCE(bc.maint, 0) >= 2
        ) AS maintenance_reported
      FROM stations s
      LEFT JOIN bike_counts bc ON bc.station_id = s.id
      `
    );
    const r = result.rows[0] || {};
    res.json({
      alerts: [
        { key: "lowAvailability",   label: "Low bike availability",         count: Number(r.low_bike_availability  || 0), tone: "amber" },
        { key: "stationFull",       label: "Station full",                  count: Number(r.station_full           || 0), tone: "purple" },
        { key: "stationOffline",    label: "Station offline",               count: Number(r.station_offline        || 0), tone: "red" },
        { key: "redistribution",    label: "Bikes needing redistribution",  count: Number(r.bikes_redistribution   || 0), tone: "blue" },
        { key: "maintenance",       label: "Maintenance issue reported",    count: Number(r.maintenance_reported   || 0), tone: "red" },
      ].slice(0, 5),
    });
  } catch (err) {
    console.error("[GET /api/admin/stations/alerts]", err);
    res.status(500).json({ error: "Could not load alerts." });
  }
});

// ── GET /top-active ──
router.get("/top-active", requireAdmin, async (req, res) => {
  try {
    const r = parseRange(req.query.range);
    const result = await db.query(
      `
      SELECT
        s.id,
        s.station_name AS name,
        s.campus_zone  AS area,
        s.capacity,
        COALESCE(COUNT(bk.id) FILTER (WHERE bk.start_time BETWEEN $1 AND $2), 0) AS rides_today,
        COALESCE((SELECT COUNT(*) FROM bikes b WHERE b.station_id = s.id AND b.status = 'available'), 0) AS available
      FROM stations s
      LEFT JOIN bookings bk ON bk.pickup_station_id = s.id
      GROUP BY s.id
      ORDER BY rides_today DESC, s.station_name ASC
      LIMIT 5
      `,
      [r.start, r.end]
    );
    res.json({
      range: r.key,
      stations: result.rows.map(row => {
        const cap = Number(row.capacity || 0);
        const avail = Number(row.available || 0);
        const utilisation = cap > 0 ? Math.min(100, Math.round((1 - avail / cap) * 100)) : 0;
        return {
          id:         row.id,
          stationId:  "ST-" + String(row.id).padStart(3, "0"),
          name:       row.name,
          area:       row.area || "—",
          rides:      Number(row.rides_today || 0),
          available:  avail,
          capacity:   cap,
          utilisation,
        };
      }),
    });
  } catch (err) {
    console.error("[GET /api/admin/stations/top-active]", err);
    res.status(500).json({ error: "Could not load top active stations." });
  }
});

// ── GET /activity ──
router.get("/activity", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5));
    // Mix booking events (pickup/return) and station-level events
    const result = await db.query(
      `
      (
        SELECT
          'pickup_' || bk.id::text AS id,
          'pickup' AS kind,
          s.id   AS station_id,
          s.station_name,
          bi.bike_code,
          COALESCE(bk.created_at, bk.start_time) AS occurred_at
        FROM bookings bk
        JOIN stations s ON s.id = bk.pickup_station_id
        JOIN bikes bi ON bi.id = bk.bike_id
        ORDER BY COALESCE(bk.created_at, bk.start_time) DESC
        LIMIT 20
      )
      UNION ALL
      (
        SELECT
          'return_' || bk.id::text AS id,
          'return' AS kind,
          s.id   AS station_id,
          s.station_name,
          bi.bike_code,
          bk.end_time AS occurred_at
        FROM bookings bk
        JOIN stations s ON s.id = COALESCE(bk.return_station_id, bk.pickup_station_id)
        JOIN bikes bi ON bi.id = bk.bike_id
        WHERE bk.status = 'completed' AND bk.end_time IS NOT NULL
        ORDER BY bk.end_time DESC
        LIMIT 20
      )
      `
    );
    const rows = result.rows
      .map(r => ({
        id:          r.id,
        kind:        r.kind,
        stationId:   "ST-" + String(r.station_id).padStart(3, "0"),
        stationName: r.station_name,
        bikeCode:    r.bike_code,
        occurredAt:  r.occurred_at,
      }))
      .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
      .slice(0, limit);
    res.json({ activity: rows });
  } catch (err) {
    console.error("[GET /api/admin/stations/activity]", err);
    res.status(500).json({ error: "Could not load activity." });
  }
});

// ── GET /list ──
router.get("/list", requireAdmin, async (req, res) => {
  try {
    const q          = (req.query.search || "").toString().trim().toLowerCase();
    const status     = (req.query.status || "").toString();
    const availability = (req.query.availability || "").toString();
    const capacity   = (req.query.capacity || "").toString();
    const area       = (req.query.area || "").toString();
    const limit  = Math.min(100, Math.max(5, Number(req.query.limit) || 10));
    const page   = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    const add = (clauseFn, val) => { params.push(val); where.push(clauseFn("$" + params.length)); };

    if (q) {
      params.push(`%${q}%`);
      const p = "$" + params.length;
      where.push(`(LOWER(s.station_name) LIKE ${p}
                 OR LOWER(COALESCE(s.campus_zone,'')) LIKE ${p}
                 OR LOWER(COALESCE(s.address,'')) LIKE ${p}
                 OR CAST(s.id AS TEXT) LIKE ${p})`);
    }
    if (["active","low","full","offline","maintenance","normal"].includes(status)) {
      const map = { active: "normal", normal: "normal", low: "low", full: "full", offline: "offline", maintenance: "maintenance" };
      add((p) => `(
          CASE
            WHEN s.status = 'offline' OR s.is_active = FALSE THEN 'offline'
            WHEN s.status = 'maintenance'
                 OR (SELECT COUNT(*) FROM maintenance_logs ml JOIN bikes b ON b.id = ml.bike_id WHERE b.station_id = s.id AND ml.status::text NOT IN ('resolved','closed')) > 0
                 OR COALESCE(bc.maint, 0) >= 2 THEN 'maintenance'
            WHEN COALESCE(bc.total_assigned,0) >= s.capacity THEN 'full'
            WHEN COALESCE(bc.avail,0) <= 3 OR (s.capacity > 0 AND COALESCE(bc.avail,0)::float / s.capacity < 0.20) THEN 'low'
            ELSE 'normal'
          END
        ) = ${p}`, map[status]);
    }
    if (availability === "high")  where.push(`(s.capacity > 0 AND COALESCE(bc.avail,0)::float / s.capacity >= 0.50)`);
    if (availability === "medium") where.push(`(s.capacity > 0 AND COALESCE(bc.avail,0)::float / s.capacity >= 0.20 AND COALESCE(bc.avail,0)::float / s.capacity < 0.50)`);
    if (availability === "low")   where.push(`(s.capacity > 0 AND COALESCE(bc.avail,0)::float / s.capacity <  0.20)`);
    if (availability === "empty") where.push(`COALESCE(bc.avail,0) = 0`);

    if (capacity === "small")  where.push(`s.capacity < 10`);
    if (capacity === "medium") where.push(`s.capacity BETWEEN 10 AND 19`);
    if (capacity === "large")  where.push(`s.capacity >= 20`);

    if (area) add((p) => `LOWER(COALESCE(s.campus_zone,'')) = LOWER(${p})`, area);

    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const baseSql = `
      FROM stations s
      LEFT JOIN (
        SELECT station_id,
               COUNT(*) FILTER (WHERE status = 'available')   AS avail,
               COUNT(*)                                       AS total_assigned,
               COUNT(*) FILTER (WHERE status = 'maintenance') AS maint
        FROM bikes
        WHERE station_id IS NOT NULL
        GROUP BY station_id
      ) bc ON bc.station_id = s.id
      ${whereSql}
    `;

    const countResult = await db.query(`SELECT COUNT(*) AS count ${baseSql}`, params);
    const total = Number(countResult.rows[0].count || 0);

    params.push(limit);  const limitParam  = "$" + params.length;
    params.push(offset); const offsetParam = "$" + params.length;

    const rowsResult = await db.query(
      `
      SELECT
        s.id,
        s.station_name,
        s.campus_zone AS area,
        s.address,
        s.latitude,
        s.longitude,
        s.capacity,
        s.status,
        s.is_active,
        s.operating_hours,
        s.last_activity_at,
        COALESCE(bc.avail, 0) AS avail,
        COALESCE(bc.total_assigned, 0) AS total_assigned,
        COALESCE(bc.maint, 0) AS maint,
        (SELECT COUNT(*) FROM bookings bk
          WHERE bk.pickup_station_id = s.id AND bk.status = 'active') AS active_rides,
        (SELECT COUNT(*) FROM maintenance_logs ml
          WHERE ml.bike_id IN (SELECT id FROM bikes WHERE station_id = s.id)
            AND ml.status::text NOT IN ('resolved','closed')) AS maintenance_issues
      ${baseSql}
      ORDER BY s.station_name ASC
      LIMIT ${limitParam} OFFSET ${offsetParam}
      `,
      params
    );

    res.json({
      page, limit, total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      stations: rowsResult.rows.map(r => {
        const cap = Number(r.capacity || 0);
        const avail = Number(r.avail || 0);
        const assigned = Number(r.total_assigned || 0);
        let effective = "normal";
        if (r.status === "offline" || r.is_active === false) effective = "offline";
        else if (r.status === "maintenance" || Number(r.maint || 0) >= 2 || Number(r.maintenance_issues || 0) > 0) effective = "maintenance";
        else if (assigned >= cap && cap > 0) effective = "full";
        else if (avail <= 3 || (cap > 0 && avail / cap < 0.20)) effective = "low";
        const util = cap > 0 ? Math.min(100, Math.round((1 - avail / cap) * 100)) : 0;
        return {
          id:                 r.id,
          stationId:          "ST-" + String(r.id).padStart(3, "0"),
          stationName:        r.station_name,
          area:               r.area || "—",
          address:            r.address || "",
          latitude:           r.latitude  != null ? Number(r.latitude) : null,
          longitude:          r.longitude != null ? Number(r.longitude) : null,
          capacity:           cap,
          status:             r.status || (r.is_active ? "active" : "offline"),
          isActive:           !!r.is_active,
          operatingHours:     r.operating_hours || "24/7",
          lastActivityAt:     r.last_activity_at,
          availableBikes:     avail,
          totalAssigned:      assigned,
          maintenanceBikes:   Number(r.maint || 0),
          activeRides:        Number(r.active_rides || 0),
          maintenanceIssues:  Number(r.maintenance_issues || 0),
          utilisation:        util,
          effectiveStatus:    effective,
        };
      }),
    });
  } catch (err) {
    console.error("[GET /api/admin/stations/list]", err);
    res.status(500).json({ error: "Could not load stations." });
  }
});

// ── GET /:id ──
router.get("/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid station id." });
    const result = await db.query(
      `
      SELECT
        s.*,
        COALESCE((SELECT COUNT(*) FROM bikes b WHERE b.station_id = s.id AND b.status = 'available'),   0) AS avail,
        COALESCE((SELECT COUNT(*) FROM bikes b WHERE b.station_id = s.id AND b.status = 'maintenance'), 0) AS maint,
        COALESCE((SELECT COUNT(*) FROM bikes b WHERE b.station_id = s.id),                              0) AS total_assigned,
        COALESCE((SELECT COUNT(*) FROM bookings bk WHERE bk.pickup_station_id = s.id AND bk.status = 'active'),  0) AS active_rides,
        COALESCE((SELECT COUNT(*) FROM bookings bk WHERE bk.pickup_station_id = s.id AND bk.status = 'pending'), 0) AS reserved_rides,
        (SELECT COUNT(*) FROM maintenance_logs ml WHERE ml.bike_id IN (SELECT id FROM bikes WHERE station_id = s.id) AND ml.status::text NOT IN ('resolved','closed')) AS maintenance_issues
      FROM stations s
      WHERE s.id = $1
      `,
      [id]
    );
    const r = result.rows[0];
    if (!r) return res.status(404).json({ error: "Station not found." });
    const cap = Number(r.capacity || 0);
    const avail = Number(r.avail || 0);
    const assigned = Number(r.total_assigned || 0);
    let effective = "normal";
    if (r.status === "offline" || r.is_active === false) effective = "offline";
    else if (r.status === "maintenance" || Number(r.maint || 0) >= 2 || Number(r.maintenance_issues || 0) > 0) effective = "maintenance";
    else if (assigned >= cap && cap > 0) effective = "full";
    else if (avail <= 3 || (cap > 0 && avail / cap < 0.20)) effective = "low";
    const util = cap > 0 ? Math.min(100, Math.round((1 - avail / cap) * 100)) : 0;

    res.json({
      station: {
        id:               r.id,
        stationId:        "ST-" + String(r.id).padStart(3, "0"),
        stationName:      r.station_name,
        area:             r.campus_zone || "—",
        address:          r.address || "",
        latitude:         r.latitude  != null ? Number(r.latitude) : null,
        longitude:        r.longitude != null ? Number(r.longitude) : null,
        capacity:         cap,
        status:           r.status || (r.is_active ? "active" : "offline"),
        isActive:         !!r.is_active,
        operatingHours:   r.operating_hours || "24/7",
        lastActivityAt:   r.last_activity_at,
        availableBikes:   avail,
        reservedBikes:    Number(r.reserved_rides || 0),
        activeBikes:      Number(r.active_rides || 0),
        maintenanceBikes: Number(r.maint || 0),
        totalAssigned:    assigned,
        utilisation:      util,
        effectiveStatus:  effective,
        mapStatus:        r.latitude != null && r.longitude != null ? "Online" : "Missing GPS",
        maintenanceStatus: Number(r.maint || 0) > 0 ? `${r.maint} issue${Number(r.maint) === 1 ? "" : "s"}` : "No issue",
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/stations/:id]", err);
    res.status(500).json({ error: "Could not load station." });
  }
});

// ── POST / (create station) ──
router.post("/", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const stationName = String(b.stationName || "").trim();
    const area = String(b.area || "").trim();
    const address = String(b.address || "").trim();
    const capacity = Number(b.capacity);
    const status = ["active","offline","maintenance"].includes(b.status) ? b.status : "active";
    const latitude = b.latitude != null && b.latitude !== "" ? Number(b.latitude) : null;
    const longitude = b.longitude != null && b.longitude !== "" ? Number(b.longitude) : null;
    const operatingHours = String(b.operatingHours || "24/7").trim().slice(0, 120);

    if (!stationName) return res.status(400).json({ error: "Station name is required." });
    if (!Number.isFinite(capacity) || capacity <= 0) return res.status(400).json({ error: "Capacity must be a positive number." });
    if (latitude == null || longitude == null) return res.status(400).json({ error: "Latitude and longitude are required." });
    if (latitude < -90 || latitude > 90) return res.status(400).json({ error: "Latitude must be between -90 and 90." });
    if (longitude < -180 || longitude > 180) return res.status(400).json({ error: "Longitude must be between -180 and 180." });

    const result = await db.query(
      `INSERT INTO stations (station_name, latitude, longitude, capacity, campus_zone, address, is_active, status, operating_hours)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [stationName, latitude, longitude, capacity, area || null, address || null, status !== "offline", status, operatingHours]
    );
    res.json({ ok: true, stationId: result.rows[0].id });
  } catch (err) {
    console.error("[POST /api/admin/stations]", err);
    res.status(400).json({ error: err.message || "Could not create station." });
  }
});

// ── PATCH /:id/status ──
router.patch("/:id/status", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid station id." });
    const next = String((req.body && req.body.status) || "").toLowerCase();
    if (!["active","offline","maintenance"].includes(next)) return res.status(400).json({ error: "Invalid status." });
    await db.query(
      `UPDATE stations SET status = $2, is_active = $3, updated_at = NOW() WHERE id = $1`,
      [id, next, next !== "offline"]
    );
    res.json({ ok: true, status: next });
  } catch (err) {
    console.error("[PATCH /api/admin/stations/:id/status]", err);
    res.status(400).json({ error: err.message || "Could not update station status." });
  }
});

// ── POST /:id/assign-bikes ──
// body: { bikeIds: [1,2,3] }  — moves the listed bikes to this station and
// marks them available. Safe-no-ops if bike already there.
router.post("/:id/assign-bikes", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid station id." });
  const bikeIds = Array.isArray(req.body && req.body.bikeIds) ? req.body.bikeIds.map(Number).filter(Number.isInteger) : [];
  if (!bikeIds.length) return res.status(400).json({ error: "Provide at least one bike id." });

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE bikes SET station_id = $1, status = 'available', updated_at = NOW()
        WHERE id = ANY($2::int[])
          AND status <> 'in_use'`,
      [id, bikeIds]
    );
    await client.query("COMMIT");
    res.json({ ok: true, stationId: id, moved: bikeIds.length });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ error: err.message || "Could not assign bikes." });
  } finally {
    client.release();
  }
});

// ── POST /:id/maintenance ──
// body: { description, severity } — opens a maintenance log for the first bike
// at the station (or a generic flag if no bikes). Best-effort: silently no-ops
// if maintenance_logs table isn't present.
router.post("/:id/maintenance", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid station id." });
    const description = String((req.body && req.body.description) || "Station-wide maintenance flagged by admin.").slice(0, 500);
    const severity = ["low","medium","high","critical"].includes(req.body && req.body.severity) ? req.body.severity : "medium";

    const bikeRow = await db.query(
      `SELECT id FROM bikes WHERE station_id = $1 ORDER BY id ASC LIMIT 1`,
      [id]
    );
    if (bikeRow.rows[0]) {
      await db.query(
        `INSERT INTO maintenance_logs (bike_id, issue_type, description, severity, status, reported_at)
         VALUES ($1, 'station', $2, $3::maintenance_severity, 'reported'::maintenance_status, NOW())`,
        [bikeRow.rows[0].id, description, severity]
      );
    }
    // Bump station status if not already maintenance/offline
    await db.query(
      `UPDATE stations SET status = 'maintenance', updated_at = NOW()
        WHERE id = $1 AND status NOT IN ('offline')`,
      [id]
    );
    res.json({ ok: true, stationId: id });
  } catch (err) {
    console.error("[POST /api/admin/stations/:id/maintenance]", err);
    res.status(400).json({ error: err.message || "Could not flag maintenance." });
  }
});

module.exports = router;
