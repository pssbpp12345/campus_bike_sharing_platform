// /api/admin/settings/* - database-backed Admin Settings Management.
const express = require("express");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const db = require("../db");
const settingsService = require("../services/settingsService");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";

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

const ROLE_PERMISSIONS = [
  "view_dashboard",
  "manage_bookings",
  "manage_payments",
  "manage_bikes",
  "manage_stations",
  "manage_maintenance",
  "manage_reports",
  "manage_support_tickets",
  "manage_settings",
];
const ROLE_NAMES = ["Super Admin", "Admin", "Support Staff", "Maintenance Staff", "Viewer"];
const SECTION_GROUPS = {
  profile: ["profile"],
  platform: ["platform"],
  pricing: ["pricing"],
  notifications: ["notifications"],
  security: ["security"],
};

const EXPORTS = {
  bookings: {
    filename: "bookings",
    headers: ["Booking ID", "Student", "Bike", "Status", "Start Time", "End Time", "Amount"],
    sql: `
      SELECT 'BK-' || LPAD(bk.id::text, 4, '0') AS booking_id,
             COALESCE(u.full_name, 'Student') AS student,
             COALESCE(bi.bike_code, 'B' || LPAD(bi.id::text, 2, '0')) AS bike,
             bk.status::text AS status,
             bk.start_time,
             bk.end_time,
             COALESCE(bk.fee_amount, 0) AS amount
        FROM bookings bk
        LEFT JOIN users u ON u.id = bk.user_id
        LEFT JOIN bikes bi ON bi.id = bk.bike_id
       ORDER BY bk.created_at DESC
       LIMIT 5000`,
  },
  payments: {
    filename: "payments",
    headers: ["Payment ID", "Booking", "Student", "Amount", "Status", "Method", "Created"],
    sql: `
      SELECT 'PM-' || LPAD(p.id::text, 4, '0') AS payment_id,
             CASE WHEN p.booking_id IS NULL THEN '' ELSE 'BK-' || LPAD(p.booking_id::text, 4, '0') END AS booking,
             COALESCE(u.full_name, 'Student') AS student,
             p.amount,
             p.status::text AS status,
             COALESCE(p.payment_method::text, 'card') AS method,
             COALESCE(p.paid_at, p.updated_at, p.created_at) AS created
        FROM payments p
        LEFT JOIN bookings bk ON bk.id = p.booking_id
        LEFT JOIN users u ON u.id = COALESCE(p.user_id, bk.user_id)
       ORDER BY COALESCE(p.paid_at, p.updated_at, p.created_at) DESC
       LIMIT 5000`,
  },
  support: {
    filename: "support-tickets",
    headers: ["Ticket ID", "Student", "Category", "Subject", "Priority", "Status", "Created"],
    sql: `
      SELECT COALESCE(st.ticket_code, 'TK-' || LPAD(st.id::text, 4, '0')) AS ticket_id,
             COALESCE(st.student_name, u.full_name, 'Student') AS student,
             st.category::text AS category,
             st.subject,
             st.priority::text AS priority,
             st.status::text AS status,
             st.created_at
        FROM support_tickets st
        LEFT JOIN users u ON u.id = st.user_id
       ORDER BY st.created_at DESC
       LIMIT 5000`,
  },
  maintenance: {
    filename: "maintenance",
    headers: ["Task ID", "Asset", "Issue", "Priority", "Status", "Cost", "Reported"],
    sql: `
      SELECT 'MT-' || LPAD(ml.id::text, 4, '0') AS task_id,
             COALESCE(b.bike_code, s.station_name, INITCAP(COALESCE(ml.asset_type, 'asset'))) AS asset,
             ml.issue_type AS issue,
             COALESCE(ml.priority, ml.severity::text) AS priority,
             ml.status::text AS status,
             ml.cost,
             ml.reported_at
        FROM maintenance_logs ml
        LEFT JOIN bikes b ON b.id = ml.bike_id
        LEFT JOIN stations s ON s.id = ml.station_id
       ORDER BY ml.reported_at DESC
       LIMIT 5000`,
  },
  stations: {
    filename: "stations",
    headers: ["Station ID", "Station", "Location", "Capacity", "Status", "Active"],
    sql: `
      SELECT 'ST-' || LPAD(id::text, 3, '0') AS station_id,
             station_name,
             COALESCE(address, campus_zone, '') AS location,
             capacity,
             COALESCE(status::text, 'active') AS status,
             is_active
        FROM stations
       ORDER BY station_name
       LIMIT 5000`,
  },
  bikes: {
    filename: "bikes",
    headers: ["Bike ID", "Type", "Station", "Status", "Battery", "Condition"],
    sql: `
      SELECT COALESCE(b.bike_code, 'B' || LPAD(b.id::text, 2, '0')) AS bike_id,
             COALESCE(b.model, 'Standard') AS type,
             COALESCE(s.station_name, 'Unassigned') AS station,
             b.status::text AS status,
             COALESCE(b.battery_level, 100) AS battery,
             COALESCE(b.condition, 'good') AS condition
        FROM bikes b
        LEFT JOIN stations s ON s.id = b.station_id
       ORDER BY b.id
       LIMIT 5000`,
  },
};

let schemaReadyPromise = null;

function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Admin login required." });
    const payload = jwt.verify(token, JWT_SECRET);
    if ((payload.role || "").toLowerCase() !== "admin") return res.status(403).json({ error: "Administrator access required." });
    req.user = payload;
    next();
  } catch (_) {
    res.status(401).json({ error: "Invalid or expired admin session." });
  }
}

async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await settingsService.ensureSettingsSchema();
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
        CREATE TABLE IF NOT EXISTS admin_role_permissions (
          id SERIAL PRIMARY KEY,
          role_name VARCHAR(80) NOT NULL,
          permission_key VARCHAR(120) NOT NULL,
          is_enabled BOOLEAN DEFAULT TRUE,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(role_name, permission_key)
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
      await db.query("CREATE INDEX IF NOT EXISTS idx_admin_settings_group ON admin_settings(setting_group)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_admin_role_permissions_role ON admin_role_permissions(role_name)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC)");
      await seedDefaults();
    })().catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }
  return schemaReadyPromise;
}

async function seedDefaults() {
  for (const [key, value, group, type] of DEFAULT_SETTINGS) {
    await db.query(
      `INSERT INTO admin_settings (setting_key, setting_value, setting_group, value_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (setting_key) DO NOTHING`,
      [key, value, group, type]
    );
  }

  for (const role of ROLE_NAMES) {
    for (const permission of ROLE_PERMISSIONS) {
      const enabled = defaultPermission(role, permission);
      await db.query(
        `INSERT INTO admin_role_permissions (role_name, permission_key, is_enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (role_name, permission_key) DO NOTHING`,
        [role, permission, enabled]
      );
    }
  }
}

router.use(requireAdmin);
router.use(async (_req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (err) {
    console.error("[adminSettings schema]", err);
    res.status(500).json({ error: "Could not prepare settings schema." });
  }
});

function defaultPermission(role, permission) {
  if (role === "Super Admin") return true;
  if (role === "Admin") return permission !== "manage_settings";
  if (role === "Support Staff") return ["view_dashboard", "manage_support_tickets", "manage_reports"].includes(permission);
  if (role === "Maintenance Staff") return ["view_dashboard", "manage_bikes", "manage_stations", "manage_maintenance"].includes(permission);
  return permission === "view_dashboard";
}

function parseSetting(row) {
  const value = row.setting_value;
  if (row.value_type === "boolean") return value === true || value === "true";
  if (row.value_type === "number") return Number(value || 0);
  if (row.value_type === "json") {
    try { return JSON.parse(value || "{}"); } catch (_) { return {}; }
  }
  return value || "";
}

function normaliseSettingValue(key, value) {
  const def = DEFAULT_SETTINGS.find((item) => item[0] === key);
  const type = def ? def[3] : "string";
  if (type === "boolean") return { value: String(Boolean(value)), type };
  if (type === "number") {
    const n = Number(value);
    return { value: String(Number.isFinite(n) ? n : Number(def?.[1] || 0)), type };
  }
  if (type === "json") return { value: JSON.stringify(value || {}), type };
  return { value: String(value ?? ""), type };
}

async function getGroupedSettings() {
  const result = await db.query("SELECT setting_key, setting_value, setting_group, value_type FROM admin_settings ORDER BY setting_group, setting_key");
  return result.rows.reduce((groups, row) => {
    const group = row.setting_group || "general";
    groups[group] ||= {};
    groups[group][row.setting_key] = parseSetting(row);
    return groups;
  }, {});
}

async function updateSettings(settings) {
  const allowed = new Set(DEFAULT_SETTINGS.map((item) => item[0]));
  const changes = [];
  for (const [key, value] of Object.entries(settings || {})) {
    if (!allowed.has(key)) continue;
    const def = DEFAULT_SETTINGS.find((item) => item[0] === key);
    const normalised = normaliseSettingValue(key, value);
    const before = await db.query("SELECT setting_value FROM admin_settings WHERE setting_key = $1", [key]);
    const oldValue = before.rows[0]?.setting_value ?? "";
    await db.query(
      `INSERT INTO admin_settings (setting_key, setting_value, setting_group, value_type, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (setting_key)
       DO UPDATE SET setting_value = EXCLUDED.setting_value, value_type = EXCLUDED.value_type, updated_at = NOW()`,
      [key, normalised.value, def[2], normalised.type]
    );
    if (String(oldValue) !== String(normalised.value)) {
      changes.push({ key, group: def[2], oldValue, newValue: normalised.value });
    }
  }
  return changes;
}

async function logAudit(req, action, description, extra = {}) {
  try {
    await db.query(
      `INSERT INTO admin_audit_log (admin_id, action, entity_type, details, ip_address, user_agent)
       VALUES ($1, $2, 'admin_settings', $3::jsonb, NULLIF($4, '')::inet, $5)`,
      [
        Number(req.user.sub || req.user.id) || null,
        action,
        JSON.stringify({ description, ...extra }),
        (req.ip || "").replace(/^::ffff:/, ""),
        req.headers["user-agent"] || "",
      ]
    );
  } catch (err) {
    console.warn("[adminSettings audit]", err.message);
  }
}

function csvEscape(value) {
  return `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;
}

function rowsToCsv(headers, rows) {
  return [headers, ...rows.map((row) => Object.values(row))].map((row) => row.map(csvEscape).join(",")).join("\n");
}

function maskSecret(value, prefix = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const tail = text.slice(-4);
  return prefix ? `${prefix}••••${tail}` : `••••${tail}`;
}

function safeMaskSecret(value, prefix = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const tail = text.slice(-4);
  return prefix ? `${prefix}****${tail}` : `****${tail}`;
}

function detectFrontendGoogleMapsKey() {
  // Scan the User pages for an inline Google Maps key as a last-resort
  // fallback. The Student/ paths are kept only for back-compat probing
  // if that folder still exists in older checkouts.
  const candidates = [
    path.resolve(__dirname, "../../frontend/User/User_ride_history.html"),
    path.resolve(__dirname, "../../frontend/User/User_my_bookings.html"),
    path.resolve(__dirname, "../../frontend/User/User_dashboard.html"),
    path.resolve(__dirname, "../../frontend/Student/Student_ride_history.html"),
    path.resolve(__dirname, "../../frontend/Student/Student_MyBooking.html"),
    path.resolve(__dirname, "../../frontend/Student/Student_dashboard.html"),
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, "utf8");
      const match = text.match(/AIza[0-9A-Za-z_-]{20,}/);
      if (match) return match[0];
    } catch (_) {}
  }
  return "";
}

router.get("/", async (_req, res) => {
  try {
    const [settings, access, stats] = await Promise.all([getGroupedSettings(), loadAccessControl(), loadSystemStats()]);
    res.json({ settings, accessControl: access, systemStats: stats });
  } catch (err) {
    console.error("[GET /api/admin/settings]", err);
    res.status(500).json({ error: "Could not load admin settings." });
  }
});

router.patch("/", async (req, res) => {
  try {
    const changes = await updateSettings(req.body.settings || {});
    await logAudit(req, "settings_updated", "Admin settings updated.", { changes });
    res.json({ settings: await getGroupedSettings() });
  } catch (err) {
    console.error("[PATCH /api/admin/settings]", err);
    res.status(500).json({ error: "Could not update admin settings." });
  }
});

router.put("/platform", async (req, res) => {
  try {
    const changes = await updateSettings(req.body.settings || req.body || {});
    await logAudit(req, "platform_settings_updated", "Platform settings updated.", { changes });
    res.json({ settings: await getGroupedSettings() });
  } catch (err) {
    console.error("[PUT /api/admin/settings/platform]", err);
    res.status(500).json({ error: "Could not update platform settings." });
  }
});

router.post("/reset-defaults", async (req, res) => {
  try {
    const section = String(req.body.section || "").toLowerCase();
    let accessControl = null;
    if (section === "access") {
      await resetRolePermissions();
      accessControl = await loadAccessControl();
    } else {
      const groups = SECTION_GROUPS[section] || Object.values(SECTION_GROUPS).flat();
      for (const [key, value, group, type] of DEFAULT_SETTINGS) {
        if (!groups.includes(group)) continue;
        await db.query(
          `INSERT INTO admin_settings (setting_key, setting_value, setting_group, value_type, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (setting_key)
           DO UPDATE SET setting_value = EXCLUDED.setting_value, setting_group = EXCLUDED.setting_group, value_type = EXCLUDED.value_type, updated_at = NOW()`,
          [key, value, group, type]
        );
      }
    }
    await logAudit(req, "settings_reset", section ? `Admin settings reset for ${section}.` : "Admin settings reset to defaults.");
    res.json({ settings: await getGroupedSettings(), accessControl });
  } catch (err) {
    console.error("[POST /api/admin/settings/reset-defaults]", err);
    res.status(500).json({ error: "Could not reset settings." });
  }
});

router.get("/profile", async (req, res) => {
  try {
    const adminId = Number(req.user.sub || req.user.id);
    const result = await db.query("SELECT id, full_name, email, role::text, phone, avatar_url FROM users WHERE id = $1 AND role::text = 'admin'", [adminId]);
    if (!result.rowCount) return res.status(404).json({ error: "Admin profile not found." });
    const settings = await getGroupedSettings();
    const row = result.rows[0];
    res.json({
      profile: {
        id: Number(row.id),
        name: row.full_name,
        email: row.email,
        role: row.role,
        phone: row.phone || "",
        avatarInitials: initials(row.full_name),
        timezone: settings.profile?.profile_timezone || "Australia/Sydney",
        preferredDateFormat: settings.profile?.profile_date_format || "DD MMM YYYY",
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/settings/profile]", err);
    res.status(500).json({ error: "Could not load admin profile." });
  }
});

router.patch("/profile", async (req, res) => {
  try {
    const adminId = Number(req.user.sub || req.user.id);
    const name = String(req.body.name || req.body.fullName || "").trim().slice(0, 120);
    const email = String(req.body.email || "").trim().toLowerCase().slice(0, 160);
    const phone = String(req.body.phone || "").trim().slice(0, 40);
    if (!name || !email || !email.includes("@")) return res.status(400).json({ error: "A valid admin name and email are required." });
    const duplicate = await db.query("SELECT id FROM users WHERE email = $1 AND id <> $2", [email, adminId]);
    if (duplicate.rowCount) return res.status(409).json({ error: "That email is already used by another account." });
    await db.query("UPDATE users SET full_name = $1, email = $2, phone = NULLIF($3, ''), updated_at = NOW() WHERE id = $4 AND role::text = 'admin'", [name, email, phone, adminId]);
    await updateSettings({ profile_timezone: req.body.timezone, profile_date_format: req.body.preferredDateFormat });
    await logAudit(req, "profile_updated", "Admin profile updated.");
    const profile = await db.query("SELECT id, full_name, email, role::text, phone FROM users WHERE id = $1", [adminId]);
    const settings = await getGroupedSettings();
    res.json({
      profile: {
        id: Number(profile.rows[0].id),
        name: profile.rows[0].full_name,
        email: profile.rows[0].email,
        role: profile.rows[0].role,
        phone: profile.rows[0].phone || "",
        avatarInitials: initials(profile.rows[0].full_name),
        timezone: settings.profile?.profile_timezone || "Australia/Sydney",
        preferredDateFormat: settings.profile?.profile_date_format || "DD MMM YYYY",
      },
    });
  } catch (err) {
    console.error("[PATCH /api/admin/settings/profile]", err);
    res.status(500).json({ error: "Could not update admin profile." });
  }
});

router.patch("/pricing", async (req, res) => {
  try {
    const changes = await updateSettings({
      unlock_fee: req.body.unlockFee,
      per_minute_fee: req.body.perMinuteFee,
      min_ride_duration_minutes: req.body.minimumRideDuration,
      max_ride_duration_minutes: req.body.maximumRideDuration,
      late_return_fee: req.body.lateReturnFee,
      cancellation_fee: req.body.cancellationFee,
      refund_window_hours: req.body.refundWindow,
    });
    await logAudit(req, "pricing_updated", "Pricing rules updated.", { changes });
    res.json({ settings: await getGroupedSettings() });
  } catch (err) {
    console.error("[PATCH /api/admin/settings/pricing]", err);
    res.status(500).json({ error: "Could not update pricing rules." });
  }
});

router.put("/pricing", async (req, res) => {
  try {
    const changes = await updateSettings({
      unlock_fee: req.body.unlockFee,
      per_minute_fee: req.body.perMinuteFee,
      min_ride_duration_minutes: req.body.minimumRideDuration,
      max_ride_duration_minutes: req.body.maximumRideDuration,
      late_return_fee: req.body.lateReturnFee,
      cancellation_fee: req.body.cancellationFee,
      refund_window_hours: req.body.refundWindow,
    });
    await logAudit(req, "pricing_updated", "Pricing rules updated.", { changes });
    res.json({ settings: await getGroupedSettings() });
  } catch (err) {
    console.error("[PUT /api/admin/settings/pricing]", err);
    res.status(500).json({ error: "Could not update pricing rules." });
  }
});

async function loadAccessControl() {
  const result = await db.query("SELECT role_name, permission_key, is_enabled FROM admin_role_permissions ORDER BY role_name, permission_key");
  const access = {};
  for (const role of ROLE_NAMES) {
    access[role] = {};
    for (const permission of ROLE_PERMISSIONS) access[role][permission] = defaultPermission(role, permission);
  }
  for (const row of result.rows) {
    access[row.role_name] ||= {};
    access[row.role_name][row.permission_key] = Boolean(row.is_enabled);
  }
  return { roles: ROLE_NAMES, permissions: ROLE_PERMISSIONS, matrix: access };
}

async function resetRolePermissions() {
  for (const role of ROLE_NAMES) {
    for (const permission of ROLE_PERMISSIONS) {
      await db.query(
        `INSERT INTO admin_role_permissions (role_name, permission_key, is_enabled, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (role_name, permission_key)
         DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = NOW()`,
        [role, permission, defaultPermission(role, permission)]
      );
    }
  }
}

router.get("/access-control", async (_req, res) => {
  try {
    res.json(await loadAccessControl());
  } catch (err) {
    console.error("[GET /api/admin/settings/access-control]", err);
    res.status(500).json({ error: "Could not load access control settings." });
  }
});

router.patch("/access-control", async (req, res) => {
  try {
    const matrix = req.body.permissions || {};
    for (const [role, permissions] of Object.entries(matrix)) {
      if (!ROLE_NAMES.includes(role)) continue;
      for (const [permission, enabled] of Object.entries(permissions || {})) {
        if (!ROLE_PERMISSIONS.includes(permission)) continue;
        await db.query(
          `INSERT INTO admin_role_permissions (role_name, permission_key, is_enabled, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (role_name, permission_key)
           DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = NOW()`,
          [role, permission, Boolean(enabled)]
        );
      }
    }
    await logAudit(req, "access_control_updated", "Role permissions updated.");
    res.json(await loadAccessControl());
  } catch (err) {
    console.error("[PATCH /api/admin/settings/access-control]", err);
    res.status(500).json({ error: "Could not update access control settings." });
  }
});

router.put("/access-control", async (req, res) => {
  try {
    const matrix = req.body.permissions || {};
    for (const [role, permissions] of Object.entries(matrix)) {
      if (!ROLE_NAMES.includes(role)) continue;
      for (const [permission, enabled] of Object.entries(permissions || {})) {
        if (!ROLE_PERMISSIONS.includes(permission)) continue;
        await db.query(
          `INSERT INTO admin_role_permissions (role_name, permission_key, is_enabled, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (role_name, permission_key)
           DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = NOW()`,
          [role, permission, Boolean(enabled)]
        );
      }
    }
    await logAudit(req, "access_control_updated", "Role permissions updated.");
    res.json(await loadAccessControl());
  } catch (err) {
    console.error("[PUT /api/admin/settings/access-control]", err);
    res.status(500).json({ error: "Could not update access control settings." });
  }
});

router.put("/notifications", async (req, res) => {
  try {
    const changes = await updateSettings(req.body.settings || req.body || {});
    await logAudit(req, "notification_settings_updated", "Notification settings updated.", { changes });
    res.json({ settings: await getGroupedSettings() });
  } catch (err) {
    console.error("[PUT /api/admin/settings/notifications]", err);
    res.status(500).json({ error: "Could not update notification settings." });
  }
});

router.put("/security", async (req, res) => {
  try {
    const changes = await updateSettings(req.body.settings || req.body || {});
    await logAudit(req, "security_settings_updated", "Security settings updated.", { changes });
    res.json({ settings: await getGroupedSettings() });
  } catch (err) {
    console.error("[PUT /api/admin/settings/security]", err);
    res.status(500).json({ error: "Could not update security settings." });
  }
});

router.get("/integrations", async (_req, res) => {
  try {
    const googleMapsKey = process.env.GOOGLE_MAPS_API_KEY || detectFrontendGoogleMapsKey();
    res.json({
      integrations: [
        {
          key: "stripe",
          name: "Stripe Payments",
          status: process.env.STRIPE_SECRET_KEY ? "connected" : "not_configured",
          maskedValue: process.env.STRIPE_SECRET_KEY ? safeMaskSecret(process.env.STRIPE_SECRET_KEY, process.env.STRIPE_SECRET_KEY.startsWith("sk_live") ? "sk_live_" : "sk_test_") : "",
          description: "Handles checkout and payment settlement for bike bookings.",
        },
        {
          key: "smtp",
          name: "Email SMTP",
          status: process.env.SMTP_HOST && process.env.SMTP_USER ? "connected" : "not_configured",
          maskedValue: process.env.SMTP_USER ? maskEmail(process.env.SMTP_USER) : "",
          description: "Sends account, support, and notification emails.",
        },
        {
          key: "maps",
          name: "Google Maps",
          status: googleMapsKey ? "connected" : "not_configured",
          maskedValue: googleMapsKey ? safeMaskSecret(googleMapsKey, googleMapsKey.startsWith("AIza") ? "AIza" : "") : "",
          description: "Used on student maps and route views.",
        },
        {
          key: "openai",
          name: "OpenAI Help Assistant",
          status: process.env.OPENAI_API_KEY ? "connected" : "not_configured",
          maskedValue: process.env.OPENAI_API_KEY ? safeMaskSecret(process.env.OPENAI_API_KEY, "sk-") : "",
          description: "Optional assistant for support triage and admin help.",
        },
      ],
    });
  } catch (err) {
    console.error("[GET /api/admin/settings/integrations]", err);
    res.status(500).json({ error: "Could not load integration status." });
  }
});

router.post("/export/:type", async (req, res) => {
  try {
    const config = EXPORTS[String(req.params.type || "").toLowerCase()];
    if (!config) return res.status(400).json({ error: "Unsupported export type." });
    const result = await db.query(config.sql);
    const csv = rowsToCsv(config.headers, result.rows);
    await logAudit(req, "data_exported", `${config.filename} exported.`);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${config.filename}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error("[POST /api/admin/settings/export/:type]", err);
    res.status(500).json({ error: "Could not export data." });
  }
});

router.get("/audit-logs", async (req, res) => {
  try {
    const type = String(req.query.type || "settings").toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 80, 200);
    if (type === "logins") {
      const result = await db.query(
        `SELECT l.id, COALESCE(u.full_name, l.admin_email, 'Admin') AS admin_name,
                COALESCE(l.admin_email, u.email, 'N/A') AS admin_email,
                l.status, l.ip_address::text AS ip_address, l.user_agent, l.created_at
           FROM admin_login_logs l
           LEFT JOIN users u ON u.id = l.admin_id
          ORDER BY l.created_at DESC
          LIMIT $1`,
        [limit]
      );
      return res.json({ logs: result.rows, type });
    }
    if (type === "accounts") {
      const result = await db.query(
        `SELECT id, full_name, email, role::text AS role, is_active, created_at
           FROM users
          ORDER BY created_at DESC
          LIMIT $1`,
        [limit]
      );
      return res.json({ logs: result.rows, type });
    }
    const actionFilter = type === "system"
      ? "AND a.action IN ('data_exported','settings_reset','notifications_cleared','security_settings_updated')"
      : type === "settings"
        ? "AND a.entity_type = 'admin_settings'"
        : "";
    const result = await db.query(
      `SELECT a.id, COALESCE(u.full_name, 'Admin User') AS admin_name,
              COALESCE(u.email, 'N/A') AS admin_email,
              a.action, a.entity_type, a.details,
              a.ip_address::text AS ip_address, a.user_agent, a.created_at
         FROM admin_audit_log a
         LEFT JOIN users u ON u.id = a.admin_id
        WHERE 1=1 ${actionFilter}
        ORDER BY a.created_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json({ logs: result.rows, type });
  } catch (err) {
    console.error("[GET /api/admin/settings/audit-logs]", err);
    res.status(500).json({ error: "Could not load audit logs." });
  }
});

router.get("/activity-logs", async (_req, res) => {
  try {
    const [logins, accounts, settings, system] = await Promise.all([
      db.query(`SELECT COALESCE(u.full_name, l.admin_email, 'Admin') AS name, COALESCE(l.admin_email, u.email, 'N/A') AS email, l.status, l.user_agent, l.created_at FROM admin_login_logs l LEFT JOIN users u ON u.id = l.admin_id ORDER BY l.created_at DESC LIMIT 6`),
      db.query(`SELECT full_name AS name, email, role::text AS role, is_active, created_at FROM users ORDER BY created_at DESC LIMIT 6`),
      db.query(`SELECT a.action, a.details, COALESCE(u.full_name, 'Admin User') AS admin_name, a.created_at FROM admin_audit_log a LEFT JOIN users u ON u.id = a.admin_id WHERE a.entity_type = 'admin_settings' ORDER BY a.created_at DESC LIMIT 6`),
      db.query(`SELECT action, details, created_at FROM admin_audit_log WHERE action IN ('data_exported','settings_reset','notifications_cleared','security_settings_updated') ORDER BY created_at DESC LIMIT 6`),
    ]);
    res.json({ logins: logins.rows, accounts: accounts.rows, settings: settings.rows, system: system.rows });
  } catch (err) {
    console.error("[GET /api/admin/settings/activity-logs]", err);
    res.status(500).json({ error: "Could not load admin activity logs." });
  }
});

async function loadSystemStats() {
  const result = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM bookings)::int AS bookings,
      (SELECT COUNT(*) FROM payments)::int AS payments,
      (SELECT COUNT(*) FROM support_tickets)::int AS support_tickets,
      (SELECT COUNT(*) FROM maintenance_logs)::int AS maintenance_logs,
      (SELECT COUNT(*) FROM bikes)::int AS bikes,
      (SELECT COUNT(*) FROM stations)::int AS stations,
      (SELECT MAX(created_at) FROM admin_audit_log WHERE action = 'data_exported') AS last_backup_at
  `);
  const row = result.rows[0] || {};
  const totalRecords = ["bookings", "payments", "support_tickets", "maintenance_logs", "bikes", "stations"].reduce((sum, key) => sum + Number(row[key] || 0), 0);
  return {
    databaseStatus: "Healthy",
    totalRecords,
    lastBackupAt: row.last_backup_at || null,
    storageUsed: "Managed by PostgreSQL",
  };
}

function initials(name) {
  return String(name || "Admin User")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "AU";
}

function maskEmail(value) {
  const [name, domain] = String(value || "").split("@");
  if (!name || !domain) return "";
  return `${name.slice(0, 2)}•••@${domain}`;
}

module.exports = router;
