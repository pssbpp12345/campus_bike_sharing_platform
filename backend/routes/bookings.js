const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");

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

function canAccess(req, userId) {
  return String(req.user.sub) === String(userId) || req.user.role === "admin";
}

const bookingSelect = `
  SELECT
    bk.id AS booking_id,
    bk.user_id,
    bk.bike_id,
    bi.bike_code,
    bi.model AS bike_type,
    bk.pickup_station_id,
    sp.station_name AS pickup_station,
    sp.latitude AS pickup_latitude,
    sp.longitude AS pickup_longitude,
    bk.return_station_id,
    sr.station_name AS return_station,
    bk.start_time,
    bk.end_time,
    bk.expires_at,
    bk.duration_minutes,
    bk.fee_amount,
    bk.status,
    bk.notes,
    bk.created_at,
    p.status AS payment_status,
    p.payment_method,
    p.transaction_reference,
    p.amount AS amount_paid,
    p.currency,
    p.paid_at
  FROM bookings bk
  JOIN bikes bi ON bi.id = bk.bike_id
  JOIN stations sp ON sp.id = bk.pickup_station_id
  LEFT JOIN stations sr ON sr.id = bk.return_station_id
  LEFT JOIN LATERAL (
    SELECT *
    FROM payments pay
    WHERE pay.booking_id = bk.id
    ORDER BY pay.created_at DESC
    LIMIT 1
  ) p ON TRUE
`;

router.get("/user/:id", requireUser, async (req, res) => {
  if (!canAccess(req, req.params.id)) return res.status(403).json({ error: "Forbidden." });
  const result = await db.query(
    `${bookingSelect} WHERE bk.user_id = $1 ORDER BY bk.start_time DESC`,
    [req.params.id]
  );
  res.json({ bookings: result.rows });
});

router.get("/active", requireUser, async (req, res) => {
  const result = await db.query(
    `${bookingSelect} WHERE bk.user_id = $1 AND bk.status = 'active' ORDER BY bk.start_time DESC LIMIT 1`,
    [req.user.sub]
  );
  res.json({ booking: result.rows[0] || null });
});

router.get("/history", requireUser, async (req, res) => {
  const status = String(req.query.status || "all");
  const sort = String(req.query.sort || "newest") === "oldest" ? "ASC" : "DESC";
  const q = String(req.query.q || "").trim();
  const params = [req.user.sub];
  let where = "WHERE bk.user_id = $1";
  if (status !== "all") {
    params.push(status);
    where += ` AND bk.status = $${params.length}`;
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where += ` AND (LOWER(bi.bike_code) LIKE $${params.length} OR LOWER(sp.station_name) LIKE $${params.length})`;
  }
  const result = await db.query(
    `${bookingSelect} ${where} ORDER BY bk.start_time ${sort}`,
    params
  );
  res.json({ bookings: result.rows });
});

router.post("/cancel", requireUser, async (req, res) => {
  const bookingId = Number(req.body && req.body.bookingId);
  const reason = String((req.body && req.body.reason) || "").trim();
  if (!bookingId) return res.status(400).json({ error: "Missing booking ID." });
  if (reason.length < 12) return res.status(400).json({ error: "Please provide a valid cancellation reason." });

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT id, user_id, bike_id, pickup_station_id, status FROM bookings WHERE id = $1 FOR UPDATE",
      [bookingId]
    );
    const row = current.rows[0];
    if (!row) throw new Error("Booking not found.");
    if (!canAccess(req, row.user_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Forbidden." });
    }
    if (!["pending", "active"].includes(row.status)) throw new Error("Only pending or active bookings can be cancelled.");

    await client.query(
      `UPDATE bookings
          SET status = 'cancelled',
              notes = CONCAT(COALESCE(notes, ''), CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE E'\n' END, $2),
              updated_at = NOW()
        WHERE id = $1`,
      [bookingId, `Cancelled by student: ${reason}`]
    );
    await client.query(
      "UPDATE bikes SET status = 'available', station_id = $2 WHERE id = $1 AND status = 'in_use'",
      [row.bike_id, row.pickup_station_id]
    );
    await client.query("COMMIT");
    res.json({ ok: true, status: "cancelled" });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ error: err.message || "Could not cancel booking." });
  } finally {
    client.release();
  }
});

router.post("/create-from-payment", requireUser, async (req, res) => {
  const booking = req.body && req.body.booking;
  const sessionId = String((req.body && req.body.sessionId) || "");
  if (!booking || !sessionId) return res.status(400).json({ error: "Missing paid booking details." });

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const station = await client.query(
      "SELECT id FROM stations WHERE LOWER(station_name) = LOWER($1) OR LOWER(station_name) LIKE LOWER($2) ORDER BY id LIMIT 1",
      [booking.stationName, `%${String(booking.stationName).replace(/\s+Station$/i, "")}%`]
    );
    if (!station.rows[0]) throw new Error("Pickup station was not found in the database.");

    const bike = await client.query(
      "SELECT id FROM bikes WHERE station_id = $1 AND status = 'available' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",
      [station.rows[0].id]
    );
    if (!bike.rows[0]) throw new Error("No available bikes at this station.");

    const start = new Date(booking.start);
    const end = new Date(booking.end);
    const duration = Number(booking.duration) || Math.max(1, Math.ceil((end - start) / 60000));
    const status = start.getTime() <= Date.now() ? "active" : "pending";
    const inserted = await client.query(
      `INSERT INTO bookings (user_id, bike_id, pickup_station_id, start_time, end_time, status, expires_at, duration_minutes, fee_amount, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        req.user.sub,
        bike.rows[0].id,
        station.rows[0].id,
        start,
        end,
        status,
        end,
        duration,
        Number(booking.cost || 0),
        `Stripe checkout session: ${sessionId}`,
      ]
    );
    if (status === "active") {
      await client.query("UPDATE bikes SET status = 'in_use', station_id = NULL WHERE id = $1", [bike.rows[0].id]);
    }
    await client.query(
      `INSERT INTO payments (booking_id, user_id, amount, currency, payment_method, status, transaction_reference, paid_at)
       VALUES ($1,$2,$3,$4,'credit_card','paid',$5,NOW())`,
      [inserted.rows[0].id, req.user.sub, Number(booking.cost || 0), "AUD", sessionId]
    );
    await client.query("COMMIT");
    res.json({ bookingId: inserted.rows[0].id });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ error: err.message || "Could not save booking." });
  } finally {
    client.release();
  }
});

module.exports = router;
