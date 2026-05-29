// /api/notifications — list, unread count, mark read, mark all read
const express = require("express");
const db = require("../db");
const { requireUser } = require("../middleware/auth");
const { ensureStudentSchema } = require("../utils/studentSchema");

const router = express.Router();

router.get("/", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const r = await db.query(
      `SELECT id, type, kind, title, message, related_entity_type, related_entity_id, is_read, created_at
       FROM notifications WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [req.user.sub, limit]
    );
    res.json({ notifications: r.rows });
  } catch (err) {
    console.error("[GET /api/notifications]", err);
    res.status(500).json({ error: "Could not load notifications." });
  }
});

router.get("/unread-count", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    // Respect the user's in-app notifications preference. When it's off,
    // we hide the badge by returning unread=0 + enabled=false.
    const pref = await db.query(
      "SELECT push_notifications FROM user_preferences WHERE user_id = $1",
      [req.user.sub]
    );
    const enabled = pref.rowCount === 0 ? true : !!pref.rows[0].push_notifications;
    const r = await db.query(
      "SELECT COUNT(*)::int AS unread FROM notifications WHERE user_id = $1 AND is_read = FALSE",
      [req.user.sub]
    );
    res.json({ unread: enabled ? r.rows[0].unread : 0, enabled });
  } catch (err) {
    res.status(500).json({ error: "Could not load unread count." });
  }
});

router.patch("/:id/read", requireUser, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id." });
  try {
    await ensureStudentSchema();
    const r = await db.query(
      `UPDATE notifications SET is_read = TRUE
       WHERE id = $1 AND user_id = $2 RETURNING id, is_read`,
      [id, req.user.sub]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Not found." });
    res.json({ ok: true, notification: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Could not update notification." });
  }
});

router.patch("/read-all", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    const r = await db.query(
      "UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE RETURNING id",
      [req.user.sub]
    );
    res.json({ ok: true, marked: r.rowCount });
  } catch (err) {
    res.status(500).json({ error: "Could not mark all as read." });
  }
});

module.exports = router;
