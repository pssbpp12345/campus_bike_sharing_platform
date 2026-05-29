// Internal helper to push notifications into the DB.
// Fire-and-forget: logs but never throws to caller.
const db = require("../db");
const { ensureStudentSchema } = require("./studentSchema");
const settingsService = require("../services/settingsService");

async function push({ userId, type, kind = "info", title, message, relatedEntityType = null, relatedEntityId = null }) {
  if (!userId || !title) return;
  try {
    if (!(await settingsService.isNotificationEnabled(type))) return;
    await ensureStudentSchema();
    await db.query(
      `INSERT INTO notifications (user_id, type, kind, title, message, related_entity_type, related_entity_id)
       VALUES ($1, $2, $3::notification_kind, $4, $5, $6, $7)`,
      [userId, type, kind, String(title).slice(0, 160), message || null, relatedEntityType, relatedEntityId]
    );
  } catch (e) {
    console.warn("[notify] failed to push:", e.message);
  }
}

// Admin-side activity feed. Writes to admin_activity_log which the
// admin dashboard reads for its "Recent activity" widget. Falls back
// silently if the table or enum value is missing — never throws.
async function pushAdmin({ activityType, title, description = null, bookingId = null, userId = null, bikeId = null }) {
  if (!activityType || !title) return;
  try {
    await db.query(
      `INSERT INTO admin_activity_log
         (activity_type, title, description, related_booking_id, related_user_id, related_bike_id, created_at)
       VALUES ($1::admin_activity_type, $2, $3, $4, $5, $6, NOW())`,
      [activityType, String(title).slice(0, 180), description, bookingId, userId, bikeId]
    );
  } catch (e) {
    // The admin_activity_type enum may not include every type we want; degrade
    // to a safe value so the row still appears in Recent Activity.
    try {
      await db.query(
        `INSERT INTO admin_activity_log
           (activity_type, title, description, related_booking_id, related_user_id, related_bike_id, created_at)
         VALUES ('payment_received'::admin_activity_type, $1, $2, $3, $4, $5, NOW())`,
        [String(title).slice(0, 180), description, bookingId, userId, bikeId]
      );
    } catch (e2) {
      console.warn("[notify.pushAdmin] failed:", e.message);
    }
  }
}

module.exports = { push, pushAdmin };
