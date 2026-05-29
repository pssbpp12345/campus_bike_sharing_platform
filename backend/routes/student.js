// /api/student — ride history endpoints scoped to the authenticated user
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { ensureStudentSchema } = require("../utils/studentSchema");
const settingsService = require("../services/settingsService");
const {
  ensureRefundSchema,
  buildRefundEstimate,
  isNeverStartedStatus,
  isRefundEligibleStatus,
  createRefundRequest,
  listUserRefundRequests,
} = require("../utils/refundRequests");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";

function requireUser(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Please log in." });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (_) {
    res.status(401).json({ error: "Invalid or expired session." });
  }
}

// GET /api/student/map-bikes
// Public-safe fleet markers for the student dashboard map. Coordinates are
// anchored to each bike's assigned station or active ride pickup station; the
// frontend applies a deterministic display offset so no DB GPS fields are
// required and real bike locations are not mutated.
router.get("/map-bikes", requireUser, async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit || 600);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(600, Math.floor(requestedLimit)))
      : 600;

    const result = await db.query(
      `WITH active_bike_bookings AS (
         SELECT DISTINCT ON (bk.bike_id)
                bk.id,
                bk.bike_id,
                bk.pickup_station_id,
                bk.status::text AS booking_status,
                bk.start_time
           FROM bookings bk
          WHERE bk.status::text IN ('pending', 'confirmed', 'active')
            AND bk.start_time <= NOW()
            AND COALESCE(bk.end_time, bk.expires_at, bk.start_time + INTERVAL '30 minutes') > NOW()
          ORDER BY bk.bike_id, bk.start_time DESC
       )
       SELECT
         b.id,
         b.bike_code,
         b.model,
         b.status::text AS raw_status,
         CASE
           WHEN ab.id IS NOT NULL OR b.status::text = 'in_use' THEN 'in_use'
           WHEN b.status::text IN ('maintenance', 'retired') THEN 'maintenance'
           ELSE 'available'
         END AS display_status,
         COALESCE(b.station_id, ab.pickup_station_id) AS station_id,
         COALESCE(s.station_name, pickup.station_name) AS station_name,
         COALESCE(s.latitude, pickup.latitude)::float AS station_latitude,
         COALESCE(s.longitude, pickup.longitude)::float AS station_longitude,
         COALESCE(s.campus_zone, pickup.campus_zone) AS campus_zone,
         ab.id AS active_booking_id,
         ab.booking_status
       FROM bikes b
       LEFT JOIN active_bike_bookings ab ON ab.bike_id = b.id
       LEFT JOIN stations s ON s.id = b.station_id
       LEFT JOIN stations pickup ON pickup.id = ab.pickup_station_id
       WHERE COALESCE(s.is_active, pickup.is_active, TRUE) = TRUE
         AND COALESCE(s.latitude, pickup.latitude) IS NOT NULL
         AND COALESCE(s.longitude, pickup.longitude) IS NOT NULL
       ORDER BY
         CASE
           WHEN ab.id IS NOT NULL OR b.status::text = 'in_use' THEN 0
           WHEN b.status::text = 'available' THEN 1
           ELSE 2
         END,
         COALESCE(s.station_name, pickup.station_name),
         b.bike_code
       LIMIT $1`,
      [limit]
    );

    res.json({
      bikes: result.rows.map((bike) => ({
        id: bike.id,
        bikeCode: bike.bike_code,
        type: bike.model || "Standard",
        status: bike.display_status,
        rawStatus: bike.raw_status,
        stationId: bike.station_id,
        stationName: bike.station_name,
        stationLatitude: bike.station_latitude,
        stationLongitude: bike.station_longitude,
        campusZone: bike.campus_zone,
        batteryLevel: null,
        condition: bike.display_status === "maintenance" ? "Maintenance required" : "Good",
        activeBookingId: bike.active_booking_id || null,
      })),
    });
  } catch (err) {
    console.error("[GET /api/student/map-bikes]", err);
    res.status(500).json({ error: "Could not load bike map markers." });
  }
});

const RIDE_SELECT = `
  SELECT
    bk.id              AS ride_id,
    bk.user_id,
    bk.bike_id,
    bi.bike_code,
    bi.model           AS bike_type,
    bk.pickup_station_id,
    sp.station_name    AS start_station,
    sp.latitude        AS pickup_lat,
    sp.longitude       AS pickup_lng,
    bk.return_station_id,
    sr.station_name    AS end_station,
    COALESCE(bk.display_end_latitude, sr.latitude) AS destination_lat,
    COALESCE(bk.display_end_longitude, sr.longitude) AS destination_lng,
    bk.display_end_label,
    bk.start_time,
    bk.end_time,
    bk.expires_at,
    bk.duration_minutes,
    COALESCE(bk.booking_type, 'scheduled') AS booking_type,
    COALESCE(bk.pricing_mode, 'pay_as_you_go') AS pricing_mode,
    COALESCE(bk.distance_km, 0)    AS distance_km,
    COALESCE(bk.unlock_fee, 2.50)  AS unlock_fee,
    COALESCE(bk.per_minute_fee, 0.20) AS per_minute_fee,
    bk.fee_amount      AS cost,
    bk.status          AS ride_status,
    bk.refund_status   AS booking_refund_status,
    bk.notes,
    bk.created_at,
    rr.status                 AS refund_request_status,
    rr.requested_at           AS refund_requested_at,
    p.id                      AS payment_id,
    p.status                  AS payment_status,
    p.payment_method,
    p.transaction_reference,
    p.refund_status           AS payment_refund_status,
    p.amount                  AS amount_paid,
    p.currency,
    p.paid_at
  FROM bookings bk
  JOIN bikes bi  ON bi.id = bk.bike_id
  JOIN stations sp ON sp.id = bk.pickup_station_id
  LEFT JOIN stations sr ON sr.id = bk.return_station_id
  LEFT JOIN LATERAL (
    SELECT * FROM payments pay WHERE pay.booking_id = bk.id ORDER BY pay.created_at DESC LIMIT 1
  ) p ON TRUE
  LEFT JOIN LATERAL (
    SELECT status, requested_at
      FROM refund_requests req
     WHERE req.booking_id = bk.id
       AND req.user_id = bk.user_id
     ORDER BY req.requested_at DESC
     LIMIT 1
  ) rr ON TRUE
`;

// GET /api/student/stations — live station availability for the dashboard map
router.get("/stations", requireUser, async (_req, res) => {
  try {
    const result = await db.query(
      `SELECT
         s.id,
         s.station_name,
         s.latitude,
         s.longitude,
         s.capacity,
         s.campus_zone,
         s.address,
         COUNT(b.id) FILTER (
           WHERE b.status = 'available'
             AND active_bk.id IS NULL
         )::int AS available_bikes
       FROM stations s
       LEFT JOIN bikes b ON b.station_id = s.id
       LEFT JOIN bookings active_bk
              ON active_bk.bike_id = b.id
             AND active_bk.status::text IN ('pending','confirmed','active')
             AND active_bk.start_time <= NOW()
             AND COALESCE(active_bk.end_time, active_bk.expires_at) > NOW()
       WHERE s.is_active = TRUE
       GROUP BY s.id
       ORDER BY s.station_name`
    );
    res.json({ stations: result.rows });
  } catch (err) {
    console.error("[GET /api/student/stations]", err);
    res.status(500).json({ error: "Could not load stations." });
  }
});

function readStationId(req, res) {
  const stationId = Number(req.params.stationId);
  if (!Number.isInteger(stationId) || stationId <= 0) {
    res.status(400).json({ error: "Invalid station id." });
    return null;
  }
  return stationId;
}

async function listAvailableBikesNow(stationId) {
  return db.query(
    `SELECT b.id, b.bike_code, b.model, b.status, b.station_id
       FROM bikes b
      WHERE b.station_id = $1
        AND b.status = 'available'
        AND NOT EXISTS (
          SELECT 1
            FROM bookings bk
           WHERE bk.bike_id = b.id
             AND bk.status::text IN ('pending','confirmed','active')
             AND bk.start_time <= NOW()
             AND COALESCE(bk.end_time, bk.expires_at) > NOW()
        )
      ORDER BY b.bike_code`,
    [stationId]
  );
}

// GET /api/student/stations/:stationId/bikes/available-now
router.get("/stations/:stationId/bikes/available-now", requireUser, async (req, res) => {
  try {
    const stationId = readStationId(req, res);
    if (!stationId) return;

    const result = await listAvailableBikesNow(stationId);
    res.json({ bikes: result.rows });
  } catch (err) {
    console.error("[GET /api/student/stations/:stationId/bikes/available-now]", err);
    res.status(500).json({ error: "Could not load available bikes." });
  }
});

// GET /api/student/stations/:stationId/bikes/available?start=ISO&end=ISO
router.get("/stations/:stationId/bikes/available", requireUser, async (req, res) => {
  try {
    const stationId = readStationId(req, res);
    if (!stationId) return;

    const start = new Date(String(req.query.start || ""));
    const end = new Date(String(req.query.end || ""));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: "Invalid start or end time." });
    }
    if (start.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Start time must be in the future." });
    }
    if (end <= start) {
      return res.status(400).json({ error: "End time must be after start time." });
    }

    const result = await db.query(
      `SELECT b.id, b.bike_code, b.model, b.status, b.station_id
         FROM bikes b
        WHERE b.station_id = $1
          AND b.status = 'available'
          AND NOT EXISTS (
            SELECT 1
              FROM bookings bk
             WHERE bk.bike_id = b.id
               AND bk.status::text IN ('pending','confirmed','active','scheduled','upcoming')
               AND bk.start_time < $3
               AND COALESCE(bk.end_time, bk.expires_at) > $2
          )
        ORDER BY b.bike_code`,
      [stationId, start, end]
    );

    res.json({ bikes: result.rows });
  } catch (err) {
    console.error("[GET /api/student/stations/:stationId/bikes/available]", err);
    res.status(500).json({ error: "Could not load available bikes." });
  }
});

// Backward-compatible current-availability endpoint used by older dashboard code.
router.get("/stations/:stationId/bikes", requireUser, async (req, res) => {
  try {
    const stationId = readStationId(req, res);
    if (!stationId) return;
    const result = await listAvailableBikesNow(stationId);
    res.json({ bikes: result.rows });
  } catch (err) {
    console.error("[GET /api/student/stations/:stationId/bikes]", err);
    res.status(500).json({ error: "Could not load available bikes." });
  }
});

// Map a ride row → display status bucket:
//   'completed' | 'active' | 'ready_to_start' | 'upcoming' | 'cancelled' | 'expired'
//
// Important: a booking is treated as ACTIVE only when the DB row literally
// says 'active' (i.e. the student manually started it). Scheduled bookings
// stay 'upcoming' until start_time arrives, then become 'ready_to_start'
// during the grace window, then 'expired' if never started. This keeps
// Dashboard / My Bookings / Ride History in sync with the backend so
// End Ride never errors with "Only an active ride can be ended".
function bucketize(row) {
  const s = row.ride_status;
  if (s === "completed") return "completed";
  if (s === "cancelled" || s === "expired") return s;
  const now     = Date.now();
  const endMs   = row.end_time ? new Date(row.end_time).getTime() : null;
  if (s === "active") {
    if (endMs != null && endMs <= now) return "expired";
    return "active";
  }
  // s === 'pending'
  const startMs = row.start_time ? new Date(row.start_time).getTime() : null;
  if (startMs == null) return "upcoming";
  if (startMs > now) return "upcoming";
  const graceEnd = startMs + READY_GRACE_MINUTES * 60_000;
  if (now <= graceEnd) return "ready_to_start";
  return "expired";
}

// Grace window for manual "Start Ride" on scheduled bookings: students have
// this many minutes after the scheduled start before the booking expires.
const READY_GRACE_MINUTES = Number(process.env.READY_TO_START_GRACE_MINUTES) || 15;

function haversineKm(aLat, aLng, bLat, bLng) {
  const toRad = (n) => (Number(n) * Math.PI) / 180;
  const lat1 = Number(aLat);
  const lng1 = Number(aLng);
  const lat2 = Number(bLat);
  const lng2 = Number(bLng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return 0;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const r1 = toRad(lat1);
  const r2 = toRad(lat2);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(r1) * Math.cos(r2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function loopDistanceForDuration(minutes, rideId) {
  const mins = Math.max(1, Number(minutes) || 5);
  let min = 0.4;
  let max = 1.0;
  if (mins >= 60) { min = 5; max = 10; }
  else if (mins >= 30) { min = 2.5; max = 5; }
  else if (mins >= 15) { min = 1.2; max = 2.5; }
  const seed = ((Number(rideId) || 1) * 9301 + 49297) % 233280;
  return Number((min + (seed / 233280) * (max - min)).toFixed(2));
}

function generatedEndPoint(startLat, startLng, rideId, distanceKm) {
  const seed = (Number(rideId) || 1) * 2.41421;
  const angle = (seed % (Math.PI * 2));
  const km = Math.max(0.25, Number(distanceKm) || 0.6);
  const dLat = (km / 111) * Math.cos(angle);
  const cos = Math.max(0.2, Math.cos((Number(startLat) * Math.PI) / 180));
  const dLng = (km / (111 * cos)) * Math.sin(angle);
  return {
    lat: Number((Number(startLat) + dLat).toFixed(7)),
    lng: Number((Number(startLng) + dLng).toFixed(7)),
  };
}

function canonicalRefundStatus(row = {}) {
  const requestStatus = String(row.refund_request_status || "").toLowerCase();
  if (requestStatus === "pending_review") return "requested";
  if (requestStatus === "approved_pending_manual_processing") return "approved";
  if (["requested", "approved", "rejected", "refunded"].includes(requestStatus)) return requestStatus;

  const storedStatus = String(row.booking_refund_status || row.payment_refund_status || "").toLowerCase();
  if (storedStatus === "pending_review") return "requested";
  if (storedStatus === "approved_pending_manual_processing") return "approved";
  if (["requested", "approved", "rejected", "refunded"].includes(storedStatus)) return storedStatus;
  return "none";
}

async function ensureCompletedRideHistoryData(row) {
  if (!row || bucketize(row) !== "completed") return row;
  const out = { ...row, status: "completed" };
  const startLat = Number(out.pickup_lat);
  const startLng = Number(out.pickup_lng);
  let endLat = Number(out.destination_lat);
  let endLng = Number(out.destination_lng);
  let distance = Number(out.distance_km || 0);

  if (!Number(out.duration_minutes) && out.start_time && out.end_time) {
    const minutes = Math.max(1, Math.ceil((new Date(out.end_time).getTime() - new Date(out.start_time).getTime()) / 60000));
    out.duration_minutes = minutes;
    await db.query("UPDATE bookings SET duration_minutes = COALESCE(duration_minutes, $2), updated_at = NOW() WHERE id = $1", [out.ride_id, minutes]).catch(() => {});
  }

  const hasStart = Number.isFinite(startLat) && Number.isFinite(startLng);
  const hasEnd = Number.isFinite(endLat) && Number.isFinite(endLng);
  const pointDistance = hasStart && hasEnd ? haversineKm(startLat, startLng, endLat, endLng) : 0;

  if (distance <= 0) {
    distance = pointDistance > 0.05 ? pointDistance : loopDistanceForDuration(out.duration_minutes, out.ride_id);
    out.distance_km = Number(distance.toFixed(2));
    await db.query("UPDATE bookings SET distance_km = $2, updated_at = NOW() WHERE id = $1", [out.ride_id, out.distance_km]).catch(() => {});
  }

  // If a completed ride has no usable B point, store a deterministic campus
  // loop endpoint so the completed map remains stable between page loads.
  if (hasStart && (!hasEnd || pointDistance <= 0.03)) {
    const generated = generatedEndPoint(startLat, startLng, out.ride_id, Math.min(Math.max(distance / 2, 0.3), 1.6));
    out.destination_lat = generated.lat;
    out.destination_lng = generated.lng;
    out.display_end_label = out.display_end_label || "Campus loop endpoint";
    await db.query(
      `UPDATE bookings
          SET display_end_latitude = COALESCE(display_end_latitude, $2),
              display_end_longitude = COALESCE(display_end_longitude, $3),
              display_end_label = COALESCE(display_end_label, $4),
              return_station_id = COALESCE(return_station_id, pickup_station_id),
              updated_at = NOW()
        WHERE id = $1`,
      [out.ride_id, generated.lat, generated.lng, out.display_end_label]
    ).catch(() => {});
  }

  return out;
}

function enrichRideForHistory(row, pricing = {}) {
  const status = row.status || bucketize(row);
  const neverStarted = isNeverStartedStatus(status);
  const active = status === "active";
  const completed = status === "completed";
  const estimate = buildRefundEstimate({ ...row, status, amount_paid: row.amount_paid || row.cost }, pricing);
  const refundStatus = canonicalRefundStatus(row);
  return {
    ...row,
    status,
    is_never_started: neverStarted,
    can_show_route_map: completed || active,
    map_mode: completed ? "completed" : active ? "live" : "none",
    refund_status: refundStatus,
    refund_requested_at: row.refund_requested_at || null,
    refund_eligible: isRefundEligibleStatus(status) && refundStatus === "none",
    refund_estimate: estimate,
    status_note: neverStarted
      ? status === "cancelled"
        ? "This booking was cancelled before the ride started. Route and distance are not available."
        : "This ride was never started. It expired after the start window because the ride was not started within the allowed time."
      : active
        ? "Live ride tracking is available while this ride is in progress."
        : completed
          ? "Completed ride route and travel details are available."
          : "This booking is scheduled and has not started yet.",
  };
}

function rideSortTime(row) {
  const dates = [row.end_time, row.start_time, row.created_at].filter(Boolean).map((v) => new Date(v).getTime()).filter(Number.isFinite);
  return dates[0] || 0;
}

function sortRideHistory(rows) {
  const rank = (row) => {
    if (row.status === "active") return 0;
    if (row.status === "ready_to_start" || row.status === "upcoming") return 1;
    if (row.status === "completed") return 2;
    return 3;
  };
  return [...rows].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return new Date(a.start_time || 0) - new Date(b.start_time || 0);
    return rideSortTime(b) - rideSortTime(a);
  });
}

// Mark stale bookings as 'expired':
//   1. Active or pending bookings whose end_time has already passed.
//   2. Pending scheduled bookings that the student did not manually start
//      within READY_GRACE_MINUTES after start_time.
// Frees the bike and unblocks the unique-active-per-user constraint, then
// records a notification + payment-status hint per row.
async function autoExpireStaleBookings(userId) {
  const notify = require("../utils/notify");

  // 1. Expire rows whose fixed end_time has passed
  await db.query(
    `WITH expired AS (
       UPDATE bookings
          SET status = 'expired', updated_at = NOW()
        WHERE user_id = $1
          AND status IN ('pending', 'active')
          AND end_time IS NOT NULL
          AND end_time <= NOW()
        RETURNING bike_id, pickup_station_id
     )
     UPDATE bikes b
        SET status = 'available', station_id = COALESCE(b.station_id, e.pickup_station_id)
       FROM expired e
      WHERE b.id = e.bike_id AND b.status = 'in_use'`,
    [userId]
  );

  // 2. Expire scheduled bookings that missed the grace window (no-show).
  //    Returns enough context to notify and tag refund_status.
  const missed = await db.query(
    `WITH missed AS (
       UPDATE bookings
          SET status = 'expired',
              payment_status = CASE
                                 WHEN payment_status = 'paid' THEN 'pending_refund'
                                 ELSE payment_status
                               END,
              notes = CONCAT(COALESCE(notes,''), CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE E'\n' END,
                             'Auto-expired (no_show): not started within ', $2::int, ' min of scheduled start.'),
              updated_at = NOW()
        WHERE user_id = $1
          AND status = 'pending'
          AND start_time IS NOT NULL
          AND start_time + ($2::int * INTERVAL '1 minute') <= NOW()
          AND (end_time IS NULL OR end_time > NOW())
        RETURNING id, bike_id, pickup_station_id, COALESCE(pricing_mode, 'pay_as_you_go') AS pricing_mode, payment_status
     )
     UPDATE bikes b
        SET status = 'available', station_id = COALESCE(b.station_id, m.pickup_station_id)
       FROM missed m
      WHERE b.id = m.bike_id AND b.status = 'in_use'
     RETURNING m.id, m.pricing_mode, m.payment_status`,
    [userId, READY_GRACE_MINUTES]
  );

  for (const row of missed.rows) {
    notify.push({
      userId,
      type: "booking_cancelled",
      kind: "warning",
      title: "Booking expired",
      message: row.payment_status === "pending_refund"
        ? `Booking #${row.id} expired because it was not started within ${READY_GRACE_MINUTES} minutes. Your payment is queued for refund.`
        : `Booking #${row.id} expired because it was not started within ${READY_GRACE_MINUTES} minutes.`,
      relatedEntityType: "booking",
      relatedEntityId: row.id,
    });
    notify.pushAdmin({
      activityType: "booking_completed",
      title: `Booking expired (no-show)`,
      description: `Booking #${row.id} not started within ${READY_GRACE_MINUTES} min of scheduled time.`,
      bookingId: row.id,
      userId,
    });
  }
  return missed.rowCount || 0;
}

// GET /api/student/rides  — list with optional tab/filter/sort/search
router.get("/rides", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    await ensureRefundSchema();
    await autoExpireStaleBookings(req.user.sub).catch(() => {});
    const tab    = String(req.query.tab    || "all").toLowerCase();
    const sort   = String(req.query.sort   || "newest").toLowerCase() === "oldest" ? "ASC" : "DESC";
    const q      = String(req.query.q      || "").trim().toLowerCase();
    const from   = req.query.from || null;
    const to     = req.query.to   || null;

    const params = [req.user.sub];
    let where = "WHERE bk.user_id = $1";

    if (q) {
      params.push(`%${q}%`);
      where += ` AND (CAST(bk.id AS TEXT) LIKE $${params.length}
                   OR LOWER(bi.bike_code) LIKE $${params.length}
                   OR LOWER(sp.station_name) LIKE $${params.length}
                   OR LOWER(COALESCE(sr.station_name,'')) LIKE $${params.length})`;
    }
    if (from) { params.push(from);              where += ` AND bk.start_time >= $${params.length}::timestamptz`; }
    if (to)   { params.push(to + " 23:59:59");  where += ` AND bk.start_time <= $${params.length}::timestamptz`; }

    const result = await db.query(`${RIDE_SELECT} ${where} ORDER BY bk.start_time ${sort}`, params);
    const pricing = await settingsService.getPricingSettings().catch(() => ({}));
    const repairedRows = await Promise.all(result.rows.map(ensureCompletedRideHistoryData));
    let rides = sortRideHistory(repairedRows.map(r => enrichRideForHistory({ ...r, status: bucketize(r) }, pricing)));

    if (tab !== "all") {
      rides = rides.filter(r => r.status === tab);
    }

    // Summary uses ALL the user's rides (not the filtered set) so the numbers don't change with tab clicks
    const all = sortRideHistory(repairedRows.map(r => enrichRideForHistory({ ...r, status: bucketize(r) }, pricing)));
    const completed = all.filter(r => r.status === "completed");

    // Insights: most-used station + favourite route + avg duration
    const stationCounts = {};
    all.forEach(r => {
      if (r.start_station) stationCounts[r.start_station] = (stationCounts[r.start_station] || 0) + 1;
      if (r.end_station)   stationCounts[r.end_station]   = (stationCounts[r.end_station]   || 0) + 1;
    });
    const mostUsedStation = Object.entries(stationCounts).sort((a,b)=>b[1]-a[1])[0];

    const routeCounts = {};
    completed.forEach(r => {
      if (r.start_station && r.end_station && r.start_station !== r.end_station) {
        const key = `${r.start_station} → ${r.end_station}`;
        routeCounts[key] = (routeCounts[key] || 0) + 1;
      }
    });
    const favouriteRoute = Object.entries(routeCounts).sort((a,b)=>b[1]-a[1])[0];

    const completedWithDur = completed.filter(r => r.duration_minutes);
    const avgDuration = completedWithDur.length
      ? Math.round(completedWithDur.reduce((s, r) => s + Number(r.duration_minutes), 0) / completedWithDur.length)
      : 0;

    const totalDistanceKm = +completed.reduce((s, r) => s + Number(r.distance_km || 0), 0).toFixed(2);

    const summary = {
      total_completed:  completed.length,
      upcoming:         all.filter(r => r.status === "upcoming").length,
      active:           all.filter(r => r.status === "active").length,
      cancelled:        all.filter(r => ["cancelled", "expired", "no_show", "missed", "not_started"].includes(r.status)).length,
      total_distance_km: totalDistanceKm,
      total_spend:       +all.reduce((s, r) => s + (Number(r.amount_paid) || Number(r.cost) || 0), 0).toFixed(2),
      // CO2 saved vs. driving a passenger car (avg 0.192 kg CO2 / km)
      co2_saved_kg:      +(totalDistanceKm * 0.192).toFixed(2),
      // Insights
      most_used_station: mostUsedStation ? mostUsedStation[0] : null,
      favourite_route:   favouriteRoute  ? favouriteRoute[0]  : null,
      avg_duration_minutes: avgDuration,
    };

    res.json({ rides, summary });
  } catch (err) {
    console.error("[GET /api/student/rides]", err);
    res.status(500).json({ error: "Could not load rides." });
  }
});

// GET /api/student/rides/:id — single ride (must belong to user)
router.get("/rides/:id", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    await ensureRefundSchema();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid ride id." });
    const result = await db.query(`${RIDE_SELECT} WHERE bk.id = $1 AND bk.user_id = $2`, [id, req.user.sub]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "Ride not found." });
    const pricing = await settingsService.getPricingSettings().catch(() => ({}));
    const repaired = await ensureCompletedRideHistoryData(row);
    res.json({ ride: enrichRideForHistory({ ...repaired, status: bucketize(repaired) }, pricing) });
  } catch (err) {
    console.error("[GET /api/student/rides/:id]", err);
    res.status(500).json({ error: "Could not load ride." });
  }
});

// GET /api/student/rides/:id/receipt — receipt data
router.get("/rides/:id/receipt", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    await ensureRefundSchema();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid ride id." });
    const r2 = await db.query(
      `${RIDE_SELECT} WHERE bk.id = $1 AND bk.user_id = $2`,
      [id, req.user.sub]
    );
    const row = await ensureCompletedRideHistoryData(r2.rows[0]);
    if (!row) return res.status(404).json({ error: "Ride not found." });
    if (bucketize(row) !== "completed") return res.status(400).json({ error: "Receipts are only available for completed rides." });
    const u = await db.query("SELECT full_name, email FROM users WHERE id = $1", [req.user.sub]);

    const cost = Number(row.cost) || 0;
    const unlock = Number(row.unlock_fee) || 0;
    const perMin = Number(row.per_minute_fee) || 0;
    const minuteCharge = Math.max(0, +(cost - unlock).toFixed(2));

    res.json({
      receipt: {
        receipt_number: `CBS-${new Date(row.start_time).getFullYear()}-${String(row.ride_id).padStart(6, "0")}`,
        issued_at:      new Date().toISOString(),
        student_name:   u.rows[0]?.full_name || "",
        student_email:  u.rows[0]?.email || "",
        ride_id:        row.ride_id,
        bike_code:      row.bike_code,
        bike_type:      row.bike_type,
        start_station:  row.start_station,
        end_station:    row.end_station,
        start_time:     row.start_time,
        end_time:       row.end_time,
        duration_minutes: row.duration_minutes,
        distance_km:    Number(row.distance_km) || 0,
        unlock_fee:     unlock,
        per_minute_fee: perMin,
        minute_charge:  minuteCharge,
        total_paid:     Number(row.amount_paid) || cost,
        currency:       row.currency || "AUD",
        payment_method: row.payment_method,
        payment_status: row.payment_status,
        transaction_reference: row.transaction_reference,
        paid_at:        row.paid_at,
      }
    });
  } catch (err) {
    console.error("[GET /api/student/rides/:id/receipt]", err);
    res.status(500).json({ error: "Could not generate receipt." });
  }
});

router.post("/refund-requests", requireUser, async (req, res) => {
  try {
    const bookingId = Number(req.body?.booking_id || req.body?.bookingId);
    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: "Booking ID is required." });
    }
    const result = await createRefundRequest({
      userId: req.user.sub,
      bookingId,
      reason: req.body?.reason,
      refundType: req.body?.refund_type || req.body?.refundType,
    });
    res.status(201).json({
      success: true,
      message: "Your refund request has been submitted for admin review.",
      refundRequest: {
        id: result.request.id,
        bookingId: result.request.booking_id,
        status: result.request.status,
        calculatedRefundAmount: Number(result.request.calculated_refund_amount || 0),
        requestedAt: result.request.requested_at,
      },
      estimate: result.estimate,
    });
  } catch (err) {
    console.error("[POST /api/user/refund-requests]", err.message);
    res.status(err.status || 400).json({ error: err.message || "Could not submit refund request." });
  }
});

router.get("/refund-requests", requireUser, async (req, res) => {
  try {
    const requests = await listUserRefundRequests(req.user.sub);
    res.json({ refundRequests: requests });
  } catch (err) {
    console.error("[GET /api/user/refund-requests]", err.message);
    res.status(500).json({ error: "Could not load refund requests." });
  }
});

// ===================================================================
// MY BOOKINGS PAGE APIs — used by Student_MyBooking.html
// All endpoints scoped to the authenticated user.
// ===================================================================

// GET /api/student/bookings/summary
// Returns counters + total spent this calendar month, all from DB.
router.get("/bookings/summary", requireUser, async (req, res) => {
  try {
    const userId = req.user.sub;
    await autoExpireStaleBookings(userId).catch(() => {});
    // Counters from bookings, totalSpent from payments (status='paid') in current month
    const r = await db.query(
      `WITH bk AS (
         SELECT id, status, start_time, end_time, fee_amount
           FROM bookings WHERE user_id = $1
       ),
       pay AS (
         SELECT amount, paid_at
           FROM payments
          WHERE user_id = $1
            AND status = 'paid'
            AND paid_at IS NOT NULL
            AND paid_at >= date_trunc('month', NOW())
            AND paid_at <  date_trunc('month', NOW()) + INTERVAL '1 month'
       )
       SELECT
         COUNT(*) FILTER (WHERE bk.status = 'pending'
                            AND bk.start_time > NOW())::int                                  AS upcoming_count,
         -- Active = currently in progress. Mirrors /api/student/bookings/active
         -- exactly so the badge and the ride card never disagree. End_time must
         -- still be in the future (or unset) — otherwise the row is stale.
         COUNT(*) FILTER (WHERE bk.status IN ('active', 'pending')
                             AND bk.start_time <= NOW()
                             AND (bk.end_time IS NULL OR bk.end_time > NOW()))::int          AS active_count,
         COUNT(*) FILTER (WHERE bk.status = 'completed')::int                                AS completed_count,
         COUNT(*) FILTER (WHERE bk.status IN ('cancelled','expired'))::int                   AS cancelled_count,
         COALESCE((SELECT SUM(amount)::numeric FROM pay), 0)                                 AS total_spent_month
       FROM bk`,
      [userId]
    );
    const row = r.rows[0] || {};
    res.json({
      upcomingCount:        Number(row.upcoming_count)  || 0,
      activeRideCount:      Number(row.active_count)    || 0,
      completedRideCount:   Number(row.completed_count) || 0,
      cancelledCount:       Number(row.cancelled_count) || 0,
      totalSpentThisMonth:  Number(row.total_spent_month) || 0,
    });
  } catch (err) {
    console.error("[GET /api/student/bookings/summary]", err);
    res.status(500).json({ error: "Could not load summary." });
  }
});

// Shared booking SELECT — used by active/upcoming/by-id
const BOOKING_SELECT = `
  SELECT
    bk.id                              AS booking_id,
    bk.user_id,
    bk.bike_id,
    bi.bike_code,
    bi.model                           AS bike_type,
    bk.pickup_station_id,
    sp.station_name                    AS pickup_station_name,
    sp.latitude                        AS pickup_lat,
    sp.longitude                       AS pickup_lng,
    bk.return_station_id,
    sr.station_name                    AS destination_station_name,
    sr.latitude                        AS destination_lat,
    sr.longitude                       AS destination_lng,
    bk.start_time,
    bk.end_time,
    bk.expires_at,
    bk.duration_minutes,
    COALESCE(bk.booking_type, 'scheduled') AS booking_type,
    COALESCE(bk.pricing_mode, 'pay_as_you_go') AS pricing_mode,
    COALESCE(bk.distance_km, 0)        AS distance_km,
    bk.fee_amount                      AS amount,
    bk.status                          AS booking_status,
    bk.notes,
    bk.created_at,
    p.status                           AS payment_status,
    p.payment_method,
    p.transaction_reference,
    p.amount                           AS amount_paid,
    p.currency,
    p.paid_at
  FROM bookings bk
  JOIN bikes bi  ON bi.id = bk.bike_id
  JOIN stations sp ON sp.id = bk.pickup_station_id
  LEFT JOIN stations sr ON sr.id = bk.return_station_id
  LEFT JOIN LATERAL (
    SELECT * FROM payments pay WHERE pay.booking_id = bk.id ORDER BY pay.created_at DESC LIMIT 1
  ) p ON TRUE
`;

// Format a booking row into the shape the frontend expects.
// Also computes the manual-start status fields:
//   displayStatus       — "active" | "ready_to_start" | "upcoming" |
//                         "completed" | "cancelled" | "expired"
//   canStart            — true when scheduled start_time has arrived,
//                         we're still inside the grace window, and the
//                         booking is still pending (i.e. not started yet)
//   graceWindowEndsAt   — start_time + READY_GRACE_MINUTES (ISO)
//   minutesUntilExpiry  — minutes left in the grace window (>=0)
function shapeBooking(row) {
  if (!row) return null;
  const status = String(row.booking_status || "").toLowerCase();
  const start  = row.start_time ? new Date(row.start_time) : null;
  const end    = row.end_time ? new Date(row.end_time) : null;
  const now    = Date.now();
  const graceEnd = start
    ? new Date(start.getTime() + READY_GRACE_MINUTES * 60_000)
    : null;

  let displayStatus = status;
  let canStart = false;
  let minutesUntilExpiry = null;

  if (status === "pending") {
    if (start && start.getTime() <= now) {
      // Past scheduled start
      if (graceEnd && now <= graceEnd.getTime()) {
        displayStatus = "ready_to_start";
        canStart = true;
        minutesUntilExpiry = Math.max(0, Math.ceil((graceEnd.getTime() - now) / 60_000));
      } else if (end && end.getTime() <= now) {
        displayStatus = "expired";
      } else {
        // Grace window has passed but autoExpire hasn't run yet
        displayStatus = "expired";
      }
    } else {
      displayStatus = "upcoming";
    }
  } else if (status === "active") {
    displayStatus = "active";
  }

  return {
    bookingId:                row.booking_id,
    rideId:                   row.booking_id,                // alias for the front-end
    bikeId:                   row.bike_id,
    bikeCode:                 row.bike_code,
    bikeType:                 row.bike_type,
    pickupStationId:          row.pickup_station_id,
    pickupStationName:        row.pickup_station_name,
    pickupLat:                row.pickup_lat ? Number(row.pickup_lat) : null,
    pickupLng:                row.pickup_lng ? Number(row.pickup_lng) : null,
    destinationStationId:     row.return_station_id,
    destinationStationName:   row.destination_station_name || row.pickup_station_name,
    destinationLat:           row.destination_lat ? Number(row.destination_lat) : (row.pickup_lat ? Number(row.pickup_lat) : null),
    destinationLng:           row.destination_lng ? Number(row.destination_lng) : (row.pickup_lng ? Number(row.pickup_lng) : null),
    startTime:                row.start_time,
    endTime:                  row.end_time,
    durationMinutes:          row.duration_minutes,
    bookingType:              row.booking_type || "scheduled",
    pricingMode:              row.pricing_mode || "pay_as_you_go",
    distanceKm:               Number(row.distance_km || 0),
    status:                   row.booking_status,
    displayStatus,
    canStart,
    readyToStart:             displayStatus === "ready_to_start",
    graceWindowEndsAt:        graceEnd ? graceEnd.toISOString() : null,
    minutesUntilExpiry,
    paymentStatus:            row.payment_status || "pending",
    paymentMethod:            row.payment_method || null,
    transactionReference:     row.transaction_reference || null,
    amount:                   Number(row.amount || row.amount_paid || 0),
    currency:                 row.currency || "AUD",
    paidAt:                   row.paid_at,
    notes:                    row.notes || "",
    createdAt:                row.created_at,
  };
}

// GET /api/student/bookings/active — the user's currently active ride (if any).
// IMPORTANT: a ride is "active" ONLY when booking_status='active'. Scheduled
// bookings stay 'pending' and become "ready_to_start" via the upcoming list —
// they never auto-promote to active just because start_time passed.
router.get("/bookings/active", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    await autoExpireStaleBookings(req.user.sub).catch(() => {});
    const r = await db.query(
      `${BOOKING_SELECT}
       WHERE bk.user_id = $1
         AND bk.status = 'active'
         AND (bk.end_time IS NULL OR bk.end_time > NOW())
       ORDER BY bk.start_time DESC
       LIMIT 1`,
      [req.user.sub]
    );
    res.json({ activeRide: shapeBooking(r.rows[0]) });
  } catch (err) {
    console.error("[GET /api/student/bookings/active]", err);
    res.status(500).json({ error: "Could not load active ride." });
  }
});

// GET /api/student/bookings/upcoming — future + ready-to-start bookings.
// Pulls every pending row whose grace window has not yet closed so the
// front end can render either an "Upcoming" card or a "Ready to start"
// action card based on shapeBooking().displayStatus / canStart.
router.get("/bookings/upcoming", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    await autoExpireStaleBookings(req.user.sub).catch(() => {});
    const r = await db.query(
      `${BOOKING_SELECT}
       WHERE bk.user_id = $1
         AND bk.status = 'pending'
         AND bk.start_time + ($2::int * INTERVAL '1 minute') > NOW()
       ORDER BY bk.start_time ASC`,
      [req.user.sub, READY_GRACE_MINUTES]
    );
    const upcoming = r.rows.map(shapeBooking);

    // Notify once per row when it first becomes ready_to_start.
    // We keep this best-effort: notify.push de-dupes nothing on its own, so
    // we only fire when the row's canStart minutesUntilExpiry is at the top
    // of the window (>= grace - 1 minute).
    const notify = require("../utils/notify");
    for (const b of upcoming) {
      if (b.canStart && b.minutesUntilExpiry != null && b.minutesUntilExpiry >= READY_GRACE_MINUTES - 1) {
        notify.push({
          userId: req.user.sub,
          type: "booking_ready",
          kind: "info",
          title: "Your ride is ready to start",
          message: `Open My Bookings to start your ride within ${READY_GRACE_MINUTES} minutes.`,
          relatedEntityType: "booking",
          relatedEntityId: b.bookingId,
        });
      }
    }

    res.json({ upcoming });
  } catch (err) {
    console.error("[GET /api/student/bookings/upcoming]", err);
    res.status(500).json({ error: "Could not load upcoming bookings." });
  }
});

// GET /api/student/bookings/:id — booking detail (modal)
router.get("/bookings/:id", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid booking id." });
    const r = await db.query(
      `${BOOKING_SELECT} WHERE bk.id = $1 AND bk.user_id = $2`,
      [id, req.user.sub]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Booking not found." });
    res.json({ booking: shapeBooking(r.rows[0]) });
  } catch (err) {
    console.error("[GET /api/student/bookings/:id]", err);
    res.status(500).json({ error: "Could not load booking." });
  }
});

// POST /api/student/bookings/:id/cancel — cancel an upcoming/active booking
//   No 12-char reason required (the My Bookings page uses simple confirm).
router.post("/bookings/:id/cancel", requireUser, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid booking id." });
  const reason = String((req.body && req.body.reason) || "Cancelled by student from My Bookings.").trim().slice(0, 250);

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT id, user_id, bike_id, pickup_station_id, status FROM bookings WHERE id = $1 FOR UPDATE",
      [id]
    );
    const row = cur.rows[0];
    if (!row) throw new Error("Booking not found.");
    if (String(row.user_id) !== String(req.user.sub)) throw new Error("Forbidden.");
    if (!["pending","active"].includes(row.status)) throw new Error("This booking can no longer be cancelled.");

    await client.query(
      `UPDATE bookings
          SET status='cancelled',
              notes = CONCAT(COALESCE(notes,''), CASE WHEN notes IS NULL OR notes='' THEN '' ELSE E'\n' END, $2::text),
              updated_at = NOW()
        WHERE id = $1`,
      [id, `Cancelled: ${reason}`]
    );
    // Free the bike back to its pickup station if it was checked out
    await client.query(
      "UPDATE bikes SET status='available', station_id=$2 WHERE id=$1 AND status='in_use'",
      [row.bike_id, row.pickup_station_id]
    );
    await client.query("COMMIT");
    require("../utils/notify").push({
      userId: req.user.sub, type: "booking_cancelled", kind: "warning",
      title: `Booking #${id} cancelled`, message: reason.slice(0, 200),
      relatedEntityType: "booking", relatedEntityId: id
    });
    res.json({ ok: true, status: "cancelled", bookingId: id });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ error: err.message || "Could not cancel booking." });
  } finally {
    client.release();
  }
});

// POST /api/student/bookings/:id/end-ride — end an active ride
//   Equivalent to POST /api/rides/end but path-style to match the spec.
router.post("/bookings/:id/end-ride", requireUser, async (req, res) => {
  const bookingId = Number(req.params.id);
  if (!Number.isFinite(bookingId)) return res.status(400).json({ error: "Invalid booking id." });
  const returnStationId = req.body && req.body.returnStationId ? Number(req.body.returnStationId) : null;

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      `SELECT id, user_id, bike_id, pickup_station_id, start_time, status
         FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );
    const row = cur.rows[0];
    if (!row) throw new Error("Booking not found.");
    if (String(row.user_id) !== String(req.user.sub)) throw new Error("Forbidden.");
    if (!["pending","active"].includes(row.status)) throw new Error("This booking is not active.");

    const stationId = returnStationId || row.pickup_station_id;
    const pricing = await settingsService.getPricingSettings();
    const minutes = Math.max(1, Math.ceil((Date.now() - new Date(row.start_time).getTime()) / 60000));
    const amount = settingsService.amountForDuration(minutes, pricing);
    await client.query(
      `UPDATE bookings
          SET status='completed', end_time=NOW(), return_station_id=$2,
              duration_minutes=$3, fee_amount=$4,
              unlock_fee=$5, per_minute_fee=$6,
              updated_at=NOW()
        WHERE id = $1`,
      [bookingId, stationId, minutes, amount, pricing.unlockFee, pricing.perMinuteFee]
    );
    await client.query(
      `UPDATE bikes SET status='available', station_id=$2,
              total_rides = total_rides + 1
        WHERE id = $1`,
      [row.bike_id, stationId]
    );
    const paymentUpdate = await client.query(
      `UPDATE payments
          SET amount = $2,
              status = 'paid',
              currency = 'AUD',
              paid_at = COALESCE(paid_at, NOW()),
              updated_at = NOW()
        WHERE id = (
          SELECT id FROM payments
           WHERE booking_id = $1
           ORDER BY created_at DESC
           LIMIT 1
        )`,
      [bookingId, amount]
    );
    if (paymentUpdate.rowCount === 0) {
      await client.query(
        `INSERT INTO payments (booking_id, user_id, amount, currency, payment_method, status, transaction_reference, paid_at)
         VALUES ($1,$2,$3,'AUD','credit_card','paid',$4,NOW())`,
        [bookingId, req.user.sub, amount, `PM-CBS-${bookingId}`]
      );
    }
    await client.query("COMMIT");
    require("../utils/notify").push({
      userId: row.user_id, type: "ride_ended", kind: "success",
      title: "Ride completed", message: `Duration: ${minutes} min`,
      relatedEntityType: "booking", relatedEntityId: bookingId
    });
    res.json({ ok: true, status: "completed", durationMinutes: minutes, amount, bookingId });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ error: err.message || "Could not end ride." });
  } finally {
    client.release();
  }
});

// POST /api/student/rides/:id/cancel — cancel an upcoming/pending ride
router.post("/rides/:id/cancel", requireUser, async (req, res) => {
  const id = Number(req.params.id);
  const reason = String((req.body && req.body.reason) || "").trim();
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid ride id." });
  if (reason.length < 12)   return res.status(400).json({ error: "Please provide a cancellation reason (12+ chars)." });

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT id, user_id, bike_id, pickup_station_id, status FROM bookings WHERE id = $1 FOR UPDATE",
      [id]
    );
    const row = cur.rows[0];
    if (!row) throw new Error("Ride not found.");
    if (String(row.user_id) !== String(req.user.sub)) throw new Error("Forbidden.");
    if (!["pending","active"].includes(row.status)) throw new Error("Only pending or active rides can be cancelled.");

    await client.query(
      `UPDATE bookings SET status='cancelled',
         notes = CONCAT(COALESCE(notes,''), CASE WHEN notes IS NULL OR notes='' THEN '' ELSE E'\n' END, $2::text),
         updated_at = NOW()
       WHERE id = $1`,
      [id, `Cancelled by student: ${reason}`]
    );
    await client.query(
      "UPDATE bikes SET status='available', station_id=$2 WHERE id=$1 AND status='in_use'",
      [row.bike_id, row.pickup_station_id]
    );
    await client.query("COMMIT");
    require("../utils/notify").push({
      userId: req.user.sub, type: "booking_cancelled", kind: "warning",
      title: `Booking #${id} cancelled`, message: reason.slice(0, 200),
      relatedEntityType: "booking", relatedEntityId: id
    });
    res.json({ ok: true, status: "cancelled" });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ error: err.message || "Could not cancel ride." });
  } finally {
    client.release();
  }
});

module.exports = router;
