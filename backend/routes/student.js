// /api/student — ride history endpoints scoped to the authenticated user
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

const RIDE_SELECT = `
  SELECT
    bk.id              AS ride_id,
    bk.user_id,
    bk.bike_id,
    bi.bike_code,
    bi.model           AS bike_type,
    bk.pickup_station_id,
    sp.station_name    AS start_station,
    bk.return_station_id,
    sr.station_name    AS end_station,
    bk.start_time,
    bk.end_time,
    bk.expires_at,
    bk.duration_minutes,
    COALESCE(bk.distance_km, 0)    AS distance_km,
    COALESCE(bk.unlock_fee, 2.50)  AS unlock_fee,
    COALESCE(bk.per_minute_fee, 0.20) AS per_minute_fee,
    bk.fee_amount      AS cost,
    bk.status          AS ride_status,
    bk.notes,
    bk.created_at,
    p.status                  AS payment_status,
    p.payment_method,
    p.transaction_reference,
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
`;

// Map a ride row → { status_bucket: 'completed'|'active'|'upcoming'|'cancelled'|'expired' }
function bucketize(row) {
  const s = row.ride_status;
  if (s === "completed") return "completed";
  if (s === "active")    return "active";
  if (s === "cancelled" || s === "expired") return s;
  // 'pending'
  if (new Date(row.start_time).getTime() > Date.now()) return "upcoming";
  return "active";
}

// GET /api/student/rides  — list with optional tab/filter/sort/search
router.get("/rides", requireUser, async (req, res) => {
  try {
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
    let rides = result.rows.map(r => ({ ...r, status: bucketize(r) }));

    if (tab !== "all") {
      rides = rides.filter(r => r.status === tab);
    }

    // Summary uses ALL the user's rides (not the filtered set) so the numbers don't change with tab clicks
    const all = result.rows.map(r => ({ ...r, status: bucketize(r) }));
    const completed = all.filter(r => r.status === "completed");
    const summary = {
      total_completed:  completed.length,
      upcoming:         all.filter(r => r.status === "upcoming").length,
      active:           all.filter(r => r.status === "active").length,
      cancelled:        all.filter(r => r.status === "cancelled").length,
      total_distance_km: +completed.reduce((s, r) => s + Number(r.distance_km || 0), 0).toFixed(2),
      total_spend:       +all.reduce((s, r) => s + (Number(r.amount_paid) || Number(r.cost) || 0), 0).toFixed(2),
      // CO2 saved vs. driving a passenger car (avg 0.192 kg CO2 / km)
      co2_saved_kg:      +(completed.reduce((s, r) => s + Number(r.distance_km || 0), 0) * 0.192).toFixed(2),
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
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid ride id." });
    const result = await db.query(`${RIDE_SELECT} WHERE bk.id = $1 AND bk.user_id = $2`, [id, req.user.sub]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "Ride not found." });
    res.json({ ride: { ...row, status: bucketize(row) } });
  } catch (err) {
    console.error("[GET /api/student/rides/:id]", err);
    res.status(500).json({ error: "Could not load ride." });
  }
});

// GET /api/student/rides/:id/receipt — receipt data
router.get("/rides/:id/receipt", requireUser, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid ride id." });
    const r2 = await db.query(
      `${RIDE_SELECT} WHERE bk.id = $1 AND bk.user_id = $2`,
      [id, req.user.sub]
    );
    const row = r2.rows[0];
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
    res.json({ ok: true, status: "cancelled" });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ error: err.message || "Could not cancel ride." });
  } finally {
    client.release();
  }
});

module.exports = router;
