// /api/profile — student profile management
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireUser } = require("../middleware/auth");
const { ensureStudentSchema } = require("../utils/studentSchema");

const router = express.Router();
const BCRYPT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Avatar upload — disk storage in this project's Uploads/avatars folder.
const AVATAR_DIR = path.resolve(__dirname, "..", "..", "Uploads", "avatars");
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || "") || ".png").toLowerCase();
    cb(null, `u${req.user.sub}-${Date.now()}${ext}`);
  },
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype)) return cb(new Error("Only image files (png/jpg/webp/gif) allowed."));
    cb(null, true);
  },
});

// GET /api/profile — return current user + account stats
router.get("/", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    const u = await db.query(
      `SELECT id, full_name, email, phone, role, is_active, email_verified,
              avatar_url, last_login_at, created_at
         FROM users WHERE id = $1`,
      [req.user.sub]
    );
    if (u.rowCount === 0) return res.status(404).json({ error: "Account not found." });

    const stats = await db.query(
      `SELECT
         COUNT(*)::int                                                                              AS total_bookings,
         COUNT(*) FILTER (WHERE status = 'completed')::int                                          AS completed_rides,
         COUNT(*) FILTER (WHERE status IN ('pending','active'))::int                                AS active_bookings,
         COUNT(*) FILTER (WHERE status = 'cancelled')::int                                          AS cancelled_bookings,
         COALESCE(SUM(duration_minutes) FILTER (WHERE status='completed'), 0)::int                  AS total_minutes,
         COALESCE(SUM(fee_amount) FILTER (WHERE status='completed'), 0)::float                      AS total_spent,
         COALESCE(SUM(COALESCE(distance_km, 0)) FILTER (WHERE status='completed'), 0)::float        AS total_distance_km
       FROM bookings WHERE user_id = $1`,
      [req.user.sub]
    );
    // CO₂ avoided vs. driving a passenger car (~0.192 kg / km)
    const distanceKm = Number(stats.rows[0].total_distance_km) || 0;
    stats.rows[0].co2_saved_kg = +(distanceKm * 0.192).toFixed(2);

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
    // Generate a stable role-aware user-facing ID. We expose it as both
    // `user_id` (new wording) and `student_id` (legacy alias the
    // existing UI still reads). Prefix follows the role:
    //   student → STU-, staff → STF-, admin → ADM-
    const prefix = user.role === "staff" ? "STF" : (user.role === "admin" ? "ADM" : "STU");
    const codedId = `${prefix}-${String(user.id).padStart(6, "0")}`;
    res.json({
      user: { ...user, student_id: codedId, user_id: codedId },
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
    const prefix = user.role === "staff" ? "STF" : (user.role === "admin" ? "ADM" : "STU");
    const codedId = `${prefix}-${String(user.id).padStart(6, "0")}`;
    res.json({ user: { ...user, student_id: codedId, user_id: codedId } });
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

// POST /api/profile/avatar — upload profile picture
router.post("/avatar", requireUser, (req, res) => {
  avatarUpload.single("avatar")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file provided." });
    const url = `/uploads/avatars/${req.file.filename}`;
    try {
      await ensureStudentSchema();
      // Best-effort cleanup of previous avatar file
      const prev = await db.query("SELECT avatar_url FROM users WHERE id = $1", [req.user.sub]);
      const old = prev.rows[0]?.avatar_url;
      if (old && old.startsWith("/uploads/avatars/")) {
        const oldPath = path.resolve(__dirname, "..", "..", "Uploads", old.replace("/uploads/", ""));
        fs.unlink(oldPath, () => {});
      }
      await db.query("UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2", [url, req.user.sub]);
      res.json({ ok: true, avatar_url: url });
    } catch (e) {
      console.error("[POST /api/profile/avatar]", e);
      res.status(500).json({ error: "Could not save avatar." });
    }
  });
});

// DELETE /api/profile/avatar
router.delete("/avatar", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    const prev = await db.query("SELECT avatar_url FROM users WHERE id = $1", [req.user.sub]);
    const old = prev.rows[0]?.avatar_url;
    if (old && old.startsWith("/uploads/avatars/")) {
      const oldPath = path.resolve(__dirname, "..", "..", "Uploads", old.replace("/uploads/", ""));
      fs.unlink(oldPath, () => {});
    }
    await db.query("UPDATE users SET avatar_url = NULL, updated_at = NOW() WHERE id = $1", [req.user.sub]);
    res.json({ ok: true });
  } catch (_) { res.status(500).json({ error: "Could not remove avatar." }); }
});

// GET /api/profile/preferences
router.get("/preferences", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    let r = await db.query("SELECT * FROM user_preferences WHERE user_id = $1", [req.user.sub]);
    if (r.rowCount === 0) {
      await db.query("INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [req.user.sub]);
      r = await db.query("SELECT * FROM user_preferences WHERE user_id = $1", [req.user.sub]);
    }
    res.json({ preferences: r.rows[0] });
  } catch (e) { res.status(500).json({ error: "Could not load preferences." }); }
});

// PATCH /api/profile/preferences
router.patch("/preferences", requireUser, async (req, res) => {
  // Notification + privacy preferences live in the same row.
  const fields = [
    "email_notifications",
    "booking_reminders",
    "ride_receipts_email",
    "push_notifications",
    "show_ride_stats_on_profile",
    "keep_receipt_shortcuts",
    "support_follow_ups",
  ];
  const body = req.body || {};
  const sets = [], params = [];
  fields.forEach(f => {
    if (body[f] !== undefined) {
      params.push(!!body[f]);
      sets.push(`${f} = $${params.length}`);
    }
  });
  if (sets.length === 0) return res.status(400).json({ error: "No fields to update." });
  sets.push("updated_at = NOW()");
  params.push(req.user.sub);
  try {
    await ensureStudentSchema();
    await db.query("INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [req.user.sub]);
    const r = await db.query(
      `UPDATE user_preferences SET ${sets.join(", ")} WHERE user_id = $${params.length} RETURNING *`,
      params
    );
    res.json({ preferences: r.rows[0] });
  } catch (e) {
    console.error("[PATCH /api/profile/preferences]", e);
    res.status(500).json({ error: "Could not update preferences." });
  }
});

// POST /api/profile/deactivation-request
// Saves an account-deactivation request as a support ticket so an admin can
// review it. We never hard-delete users, rides, or payments.
router.post("/deactivation-request", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    const reason = String((req.body && req.body.reason) || "User requested account deactivation from Account Settings.").trim().slice(0, 1000);
    const u = await db.query("SELECT full_name, email FROM users WHERE id = $1", [req.user.sub]);
    const who = u.rows[0] || {};
    const r = await db.query(
      `INSERT INTO support_tickets (user_id, category, subject, description, priority, status)
       VALUES ($1, 'account', $2, $3, 'high', 'open')
       RETURNING id, created_at`,
      [
        req.user.sub,
        "Account deactivation request",
        `User ${who.full_name || ""} <${who.email || ""}> has requested account deactivation.\n\nReason / context:\n${reason}`,
      ]
    );
    require("../utils/notify").push({
      userId: req.user.sub, type: "account_deactivation_requested", kind: "info",
      title: "Deactivation request submitted",
      message: "A support team member will review your request and contact you.",
      relatedEntityType: "support_ticket", relatedEntityId: r.rows[0].id,
    });
    res.json({ ok: true, ticketId: r.rows[0].id, createdAt: r.rows[0].created_at });
  } catch (e) {
    console.error("[POST /api/profile/deactivation-request]", e);
    res.status(500).json({ error: "Could not submit deactivation request." });
  }
});

module.exports = router;
