const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const notify = require("../utils/notify");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";
const EXTRA_MINUTE_CENTS = Number(process.env.BOOKING_PER_MINUTE_CENTS) || 20;

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

router.post("/end", requireUser, async (req, res) => {
  const bookingId = Number(req.body && req.body.bookingId);
  const returnStationId = req.body && req.body.returnStationId ? Number(req.body.returnStationId) : null;
  if (!bookingId) return res.status(400).json({ error: "Missing booking ID." });

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    // Accept both 'active' AND 'pending' bookings. Frontend treats pending
    // bookings whose start_time has passed as effectively active, so we must
    // be able to end them here too — otherwise the user gets stuck.
    const current = await client.query(
      `SELECT id, user_id, bike_id, pickup_station_id, start_time, status
         FROM bookings
        WHERE id = $1
          AND status IN ('pending', 'active')
        FOR UPDATE`,
      [bookingId]
    );
    const row = current.rows[0];
    if (!row) throw new Error("Active ride not found.");
    if (String(row.user_id) !== String(req.user.sub) && req.user.role !== "admin") throw new Error("Forbidden.");

    const stationId = returnStationId || row.pickup_station_id;
    // Compute a sensible duration: if pending (never actually started), use
    // 0 minutes; otherwise count from start_time → now.
    const startMs = new Date(row.start_time).getTime();
    const minutes = row.status === "active"
      ? Math.max(1, Math.ceil((Date.now() - startMs) / 60000))
      : Math.max(0, Math.ceil((Date.now() - startMs) / 60000));
    await client.query(
      `UPDATE bookings
          SET status = 'completed',
              end_time = NOW(),
              return_station_id = $2,
              duration_minutes = $3,
              updated_at = NOW()
        WHERE id = $1`,
      [bookingId, stationId, minutes]
    );
    // Free the bike — whether it was checked out ('in_use') or still docked.
    await client.query(
      `UPDATE bikes
          SET status = 'available',
              station_id = $2,
              total_rides = total_rides + CASE WHEN status = 'in_use' THEN 1 ELSE 0 END
        WHERE id = $1`,
      [row.bike_id, stationId]
    );
    await client.query("COMMIT");
    notify.push({ userId: row.user_id, type: "ride_ended", kind: "success",
      title: "Ride completed", message: `Duration: ${minutes} min`,
      relatedEntityType: "booking", relatedEntityId: bookingId });
    res.json({ ok: true, status: "completed", duration_minutes: minutes });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ error: err.message || "Could not end ride." });
  } finally {
    client.release();
  }
});

router.post("/extend", requireUser, async (req, res) => {
  const bookingId = Number(req.body && req.body.bookingId);
  const extraMinutes = Number(req.body && req.body.extraMinutes);
  if (!bookingId || ![15, 30, 60, 120].includes(extraMinutes)) {
    return res.status(400).json({ error: "Choose a valid extension time." });
  }

  const result = await db.query(
    `UPDATE bookings
        SET expires_at = expires_at + make_interval(mins => $2),
            end_time = CASE WHEN end_time IS NULL THEN NULL ELSE end_time + make_interval(mins => $2) END,
            fee_amount = fee_amount + $3,
            updated_at = NOW()
      WHERE id = $1 AND user_id = $4 AND status IN ('pending','active')
      RETURNING id, expires_at, end_time, fee_amount`,
    [bookingId, extraMinutes, (extraMinutes * EXTRA_MINUTE_CENTS) / 100, req.user.sub]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Ride not found or cannot be extended." });
  res.json({ booking: result.rows[0], extraAmount: (extraMinutes * EXTRA_MINUTE_CENTS) / 100 });
});

module.exports = router;
