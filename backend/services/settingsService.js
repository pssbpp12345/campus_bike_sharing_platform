const db = require("../db");

const DEFAULT_SETTINGS = [
  ["profile_timezone", "Australia/Sydney", "profile", "string"],
  ["profile_date_format", "DD MMM YYYY", "profile", "string"],
  ["platform_name", "Campus Bike Sharing", "platform", "string"],
  ["default_city", "Sydney Campus", "platform", "string"],
  ["operating_hours", "6:00 AM - 10:00 PM", "platform", "string"],
  ["support_email", "support@campusbikesharing.local", "platform", "string"],
  ["default_currency", "AUD", "platform", "string"],
  ["default_language", "English", "platform", "string"],
  ["maintenance_mode", "false", "platform", "boolean"],
  ["allow_new_registrations", "true", "platform", "boolean"],
  ["unlock_fee", "1.00", "pricing", "number"],
  ["per_minute_fee", "0.20", "pricing", "number"],
  ["min_ride_duration_minutes", "5", "pricing", "number"],
  ["max_ride_duration_minutes", "180", "pricing", "number"],
  ["late_return_fee", "5.00", "pricing", "number"],
  ["cancellation_fee", "0.00", "pricing", "number"],
  ["refund_window_hours", "24", "pricing", "number"],
  ["new_booking_notification", "true", "notifications", "boolean"],
  ["payment_received_notification", "true", "notifications", "boolean"],
  ["failed_payment_notification", "true", "notifications", "boolean"],
  ["refund_request_notification", "true", "notifications", "boolean"],
  ["maintenance_alert_notification", "true", "notifications", "boolean"],
  ["low_bike_availability_notification", "true", "notifications", "boolean"],
  ["support_ticket_notification", "true", "notifications", "boolean"],
  ["daily_summary_email", "false", "notifications", "boolean"],
  ["notification_email", "admin@university.edu", "notifications", "string"],
  ["low_availability_threshold", "3", "notifications", "number"],
  ["low_battery_threshold", "25", "notifications", "number"],
  ["require_strong_password", "true", "security", "boolean"],
  ["session_timeout_minutes", "60", "security", "number"],
  ["auto_logout_inactive_admins", "true", "security", "boolean"],
  ["two_factor_authentication", "false", "security", "boolean"],
  ["login_alert_notification", "true", "security", "boolean"],
  ["admin_activity_logging", "true", "security", "boolean"],
  ["last_backup_at", "", "data_backup", "string"],
];

let readyPromise = null;

function parseValue(row) {
  const value = row.setting_value;
  if (row.value_type === "boolean") return value === true || value === "true";
  if (row.value_type === "number") return Number(value || 0);
  if (row.value_type === "json") {
    try { return JSON.parse(value || "{}"); } catch (_) { return {}; }
  }
  return value || "";
}

async function ensureSettingsSchema() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS admin_settings (
          id SERIAL PRIMARY KEY,
          setting_key VARCHAR(120) UNIQUE NOT NULL,
          setting_value TEXT,
          setting_group VARCHAR(80),
          value_type VARCHAR(40) DEFAULT 'string',
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS admin_audit_log (
          id BIGSERIAL PRIMARY KEY,
          admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          action VARCHAR(120) NOT NULL,
          entity_type VARCHAR(80) NOT NULL,
          entity_id INTEGER,
          details JSONB,
          ip_address INET,
          user_agent TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS admin_login_logs (
          id BIGSERIAL PRIMARY KEY,
          admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          admin_email VARCHAR(160),
          status VARCHAR(40) NOT NULL DEFAULT 'success',
          ip_address INET,
          user_agent TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS user_activity_logs (
          id BIGSERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          action VARCHAR(120) NOT NULL,
          details JSONB,
          ip_address INET,
          user_agent TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query("CREATE INDEX IF NOT EXISTS idx_admin_settings_group ON admin_settings(setting_group)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_admin_login_logs_created ON admin_login_logs(created_at DESC)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_user_activity_logs_created ON user_activity_logs(created_at DESC)");
      for (const [key, value, group, type] of DEFAULT_SETTINGS) {
        await db.query(
          `INSERT INTO admin_settings (setting_key, setting_value, setting_group, value_type)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (setting_key) DO NOTHING`,
          [key, value, group, type]
        );
      }
    })().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

async function getGroupedSettings() {
  await ensureSettingsSchema();
  const result = await db.query("SELECT setting_key, setting_value, setting_group, value_type FROM admin_settings ORDER BY setting_group, setting_key");
  return result.rows.reduce((groups, row) => {
    const group = row.setting_group || "general";
    groups[group] ||= {};
    groups[group][row.setting_key] = parseValue(row);
    return groups;
  }, {});
}

async function getPublicSettings() {
  const settings = await getGroupedSettings();
  const platform = settings.platform || {};
  const pricing = settings.pricing || {};
  return {
    platformName: platform.platform_name || "Campus Bike Sharing",
    defaultCampusCity: platform.default_city || "Sydney Campus",
    operatingHours: platform.operating_hours || "6:00 AM - 10:00 PM",
    supportEmail: platform.support_email || "support@campusbikesharing.local",
    currency: platform.default_currency || "AUD",
    defaultLanguage: platform.default_language || "English",
    maintenanceMode: Boolean(platform.maintenance_mode),
    allowNewRegistrations: platform.allow_new_registrations !== false,
    pricing: {
      unlockFee: Number(pricing.unlock_fee ?? 1),
      perMinuteFee: Number(pricing.per_minute_fee ?? 0.2),
      minimumRideDuration: Number(pricing.min_ride_duration_minutes ?? 5),
      maximumRideDuration: Number(pricing.max_ride_duration_minutes ?? 180),
      lateReturnFee: Number(pricing.late_return_fee ?? 5),
      cancellationFee: Number(pricing.cancellation_fee ?? 0),
      refundWindowHours: Number(pricing.refund_window_hours ?? 24),
    },
    integrations: {
      googleMapsConfigured: Boolean(process.env.GOOGLE_MAPS_API_KEY),
      stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      smtpConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER),
    },
  };
}

async function getPricingSettings() {
  const publicSettings = await getPublicSettings();
  return publicSettings.pricing;
}

function cents(amount) {
  return Math.max(0, Math.round(Number(amount || 0) * 100));
}

function amountForDuration(duration, pricing) {
  const minutes = Number(duration || 0);
  return Number((Number(pricing.unlockFee || 0) + minutes * Number(pricing.perMinuteFee || 0)).toFixed(2));
}

function amountCentsForDuration(duration, pricing) {
  return cents(amountForDuration(duration, pricing));
}

async function assertBookingAllowed() {
  const settings = await getPublicSettings();
  if (settings.maintenanceMode) {
    const err = new Error("Bookings are temporarily unavailable while the platform is in maintenance mode.");
    err.status = 503;
    throw err;
  }
  return settings;
}

async function isNotificationEnabled(type) {
  const settings = await getGroupedSettings();
  const n = settings.notifications || {};
  const map = {
    booking_created: "new_booking_notification",
    ride_started: "new_booking_notification",
    payment_received: "payment_received_notification",
    payment_failed: "failed_payment_notification",
    refund_requested: "refund_request_notification",
    maintenance_alert: "maintenance_alert_notification",
    low_bike_availability: "low_bike_availability_notification",
    support_ticket_received: "support_ticket_notification",
  };
  const key = map[type] || type;
  return n[key] !== false;
}

function requestIp(req) {
  return String((req.headers && req.headers["x-forwarded-for"] || "").split(",")[0] || req.ip || "")
    .replace(/^::ffff:/, "")
    .trim();
}

async function logAudit(req, action, details = {}, entityType = "admin_settings", entityId = null) {
  try {
    const settings = await getGroupedSettings();
    if (settings.security?.admin_activity_logging === false) return;
    await db.query(
      `INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, details, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5::jsonb, NULLIF($6, '')::inet, $7)`,
      [
        Number(req?.user?.sub || req?.user?.id) || null,
        String(action).slice(0, 120),
        entityType,
        entityId,
        JSON.stringify(details || {}),
        requestIp(req || {}),
        req?.headers?.["user-agent"] || "",
      ]
    );
  } catch (err) {
    console.warn("[settingsService audit]", err.message);
  }
}

async function logAdminLogin(req, user, status = "success") {
  try {
    await ensureSettingsSchema();
    await db.query(
      `INSERT INTO admin_login_logs (admin_id, admin_email, status, ip_address, user_agent)
       VALUES ($1, $2, $3, NULLIF($4, '')::inet, $5)`,
      [
        Number(user?.id) || null,
        String(user?.email || "").slice(0, 160),
        String(status || "success").slice(0, 40),
        requestIp(req || {}),
        req?.headers?.["user-agent"] || "",
      ]
    );
  } catch (err) {
    console.warn("[settingsService login]", err.message);
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  ensureSettingsSchema,
  getGroupedSettings,
  getPublicSettings,
  getPricingSettings,
  amountForDuration,
  amountCentsForDuration,
  assertBookingAllowed,
  isNotificationEnabled,
  logAudit,
  logAdminLogin,
};
