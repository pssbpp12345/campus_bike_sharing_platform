// /api/profile — student profile management
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";
const BCRYPT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

// GET /api/profile — return current user + account stats
router.get("/", requireUser, async (req, res) => {
  try {
    const u = await db.query(
      `SELECT id, full_name, email, phone, role, is_active, email_verified,
              last_login_at, created_at
         FROM users WHERE id = $1`,
      [req.user.sub]
    );
    if (u.rowCount === 0) return res.status(404).json({ error: "Account not found." });

    const stats = await db.query(
      `SELECT
         COUNT(*)::int                                                        AS total_bookings,
         COUNT(*) FILTER (WHERE status = 'completed')::int                   AS completed_rides,
         COUNT(*) FILTER (WHERE status IN ('pending','active'))::int        AS active_bookings,
         COUNT(*) FILTER (WHERE status = 'cancelled')::int                  AS cancelled_bookings,
         COALESCE(SUM(duration_minutes) FILTER (WHERE status='completed'), 0)::int AS total_minutes,
         COALESCE(SUM(fee_amount) FILTER (WHERE status='completed'), 0)::float    AS total_spent
       FROM bookings WHERE user_id = $1`,
      [req.user.sub]
    );

    const recent = await db.query(
      `SELECT bk.id, bk.status, bk.start_time, bk.end_time, bk.fee_amount,
              bi.bike_code, sp.station_name AS pickup_station
         FROM bookings bk
         JOIN bikes bi ON bi.id = bk.bike_id
         JOIN stations sp ON sp.id = bk.pickup_station_id
        WHERE bk.user_id = $1
        ORDER BY bk.start_time DESC
        LIMIT 5`,
      [req.user.sub]
    );

    const user = u.rows[0];
    res.json({
      user: { ...user, student_id: `STU-${String(user.id).padStart(6, "0")}` },
      stats: stats.rows[0],
      recent_activity: recent.rows,
    });
  } catch (err) {
    console.error("[GET /api/profile]", err);
    res.status(500).json({ error: "Could not load profile." });
  }
});

// PATCH /api/profile — update full_name, email, phone
router.patch("/", requireUser, async (req, res) => {
  try {
    const { fullName, email, phone } = req.body || {};
    const fields = [];
    const params = [];

    if (fullName !== undefined) {
      const v = String(fullName).trim();
      if (v.length < 2 || v.length > 100) return res.status(400).json({ error: "Full name must be 2–100 chars." });
      params.push(v); fields.push(`full_name = $${params.length}`);
    }
    if (email !== undefined) {
      const v = String(email).trim().toLowerCase();
      if (!EMAIL_RE.test(v)) return res.status(400).json({ error: "Invalid email." });
      const exists = await db.query("SELECT id FROM users WHERE email = $1 AND id <> $2", [v, req.user.sub]);
      if (exists.rowCount > 0) return res.status(409).json({ error: "Another account already uses this email." });
      params.push(v); fields.push(`email = $${params.length}`);
    }
    if (phone !== undefined) {
      const v = String(phone).trim();
      if (v && (v.length < 6 || v.length > 20)) return res.status(400).json({ error: "Phone must be 6–20 chars." });
      params.push(v || null); fields.push(`phone = $${params.length}`);
    }
    if (fields.length === 0) return res.status(400).json({ error: "No fields to update." });
    fields.push("updated_at = NOW()");
    params.push(req.user.sub);

    const result = await db.query(
      `UPDATE users SET ${fields.join(", ")} WHERE id = $${params.length}
       RETURNING id, full_name, email, phone, role`,
      params
    );
    const user = result.rows[0];
    res.json({ user: { ...user, student_id: `STU-${String(user.id).padStart(6, "0")}` } });
  } catch (err) {
    console.error("[PATCH /api/profile]", err);
    res.status(500).json({ error: "Could not update profile." });
  }
});

// POST /api/profile/change-password
router.post("/change-password", requireUser, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "Both passwords are required." });
    if (String(newPassword).length < 8) return res.status(400).json({ error: "New password must be 8+ characters." });

    const u = await db.query("SELECT password_hash FROM users WHERE id = $1", [req.user.sub]);
    if (u.rowCount === 0) return res.status(404).json({ error: "Account not found." });
    const ok = await bcrypt.compare(String(currentPassword), u.rows[0].password_hash).catch(() => false);
    if (!ok) return res.status(401).json({ error: "Current password is incorrect." });

    const newHash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
    await db.query("UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2", [newHash, req.user.sub]);
    res.json({ ok: true, message: "Password updated." });
  } catch (err) {
    console.error("[POST /api/profile/change-password]", err);
    res.status(500).json({ error: "Could not change password." });
  }
});

module.exports = router;
