// ──────────────────────────────────────────────────────────────
// /api/auth — login + register endpoints.
// ──────────────────────────────────────────────────────────────

const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../db");
const mailer = require("../utils/mailer");
const { welcomeEmail, passwordChangedEmail, otpEmail } = require("../utils/emailTemplates");

// Public base URL used in email links — falls back to localhost in dev.
function publicBaseUrl(req) {
  return process.env.PUBLIC_URL ||
    (req && `${req.protocol}://${req.get("host")}`) ||
    "http://localhost:5000";
}

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const BCRYPT_ROUNDS = 12;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Lazy bootstrap: ensure password_resets table exists ────────
// Runs once at module load so the forgot-password flow works even
// if the user hasn't manually applied database/06_password_resets.sql.
(async function ensurePasswordResetsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id          SERIAL      PRIMARY KEY,
        user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        otp_hash    TEXT        NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        used_at     TIMESTAMPTZ,
        ip_address  INET,
        user_agent  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_password_resets_user    ON password_resets(user_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_password_resets_created ON password_resets(created_at DESC);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_password_resets_active  ON password_resets(user_id) WHERE used_at IS NULL;`);
    console.log("[auth] password_resets table ready.");
  } catch (err) {
    console.warn("[auth] Could not ensure password_resets table:", err.message);
  }
})();

// Education-domain check — accept .edu, .edu.<cc>, .ac.<cc>, .school.<cc>
// (e.g. university.edu, uni.edu.au, dept.ac.uk, college.school.nz)
// Override at deploy-time by setting ALLOWED_EMAIL_DOMAINS in env (comma-separated exact domains).
function isEducationalEmail(email) {
  if (!email || typeof email !== "string") return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();

  // Optional explicit allow-list from env
  const allowList = (process.env.ALLOWED_EMAIL_DOMAINS || "")
    .split(",").map(d => d.trim().toLowerCase()).filter(Boolean);
  if (allowList.length > 0) return allowList.includes(domain);

  // Generic academic-domain patterns
  return /\.edu(\.[a-z]{2,})?$/.test(domain) ||
         /\.ac\.[a-z]{2,}$/.test(domain) ||
         /\.school\.[a-z]{2,}$/.test(domain);
}


function signTokenFor(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function publicUser(row) {
  return {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    role: row.role,
  };
}


// Map low-level Postgres / connection errors to friendly messages
function describeDbError(err, action) {
  if (!err) return `Server error during ${action}.`;
  const code = err.code || "";
  const msg = err.message || "";

  // Connection-level
  if (code === "ECONNREFUSED" || msg.includes("ECONNREFUSED"))
    return `Cannot reach the database. Is PostgreSQL running?`;
  if (code === "28P01" || code === "28000" || /password authentication/i.test(msg))
    return `Database authentication failed. Check PGUSER / PGPASSWORD in backend/.env.`;
  if (code === "3D000" || /does not exist/i.test(msg) && /database/i.test(msg))
    return `Database "campus_bike_sharing" doesn't exist yet. Create it and run database/01_schema.sql.`;

  // Schema-level
  if (code === "42P01") // undefined_table
    return `The "users" table is missing. Run database/01_schema.sql against your database.`;
  if (code === "42704") // undefined_object (enum, etc.)
    return `Database type missing. Run database/01_schema.sql to create the user_role ENUM.`;
  if (code === "42703") // undefined_column
    return `A column referenced by the API doesn't exist on the table. Re-run database/01_schema.sql.`;

  // Constraint-level
  if (code === "23505") // unique_violation
    return `An account with that email already exists.`;
  if (code === "23514") // check_violation
    return `The provided value didn't pass a database check (e.g. invalid email format).`;
  if (code === "23502") // not_null_violation
    return `A required field was missing.`;

  // Anything else — return the actual message so the dev can see it
  return msg ? `${msg}` : `Server error during ${action}.`;
}

// ──────────────── POST /api/auth/register ────────────────
router.post("/register", async (req, res) => {
  try {
    const { fullName, email, password } = req.body || {};

    if (!fullName || !email || !password) {
      return res.status(400).json({ error: "fullName, email and password are required." });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "Please provide a valid email address." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters long." });
    }

    const existing = await db.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const insert = await db.query(
      `INSERT INTO users (full_name, email, password_hash, role)
       VALUES ($1, $2, $3, 'student')  -- New users always start as 'student'; admin can promote later
       RETURNING id, full_name, email, role`,
      [fullName.trim(), email.toLowerCase().trim(), password_hash]
    );

    const user = insert.rows[0];
    const token = signTokenFor(user);

    // Fire-and-forget welcome email — don't block registration on SMTP latency
    (async () => {
      try {
        const mail = welcomeEmail({
          name: user.full_name,
          email: user.email,
          role: user.role,
          loginUrl: `${publicBaseUrl(req)}/login.html`,
        });
        const ok = await mailer.send({
          to: user.email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
        if (!ok) console.log(`[register] Welcome email skipped or failed for ${user.email} (mailer not configured?)`);
      } catch (e) {
        console.warn("[register] welcome email error:", e.message);
      }
    })();

    return res.status(201).json({ user: publicUser(user), token });
  } catch (err) {
    console.error("[POST /api/auth/register]", err);
    return res.status(500).json({ error: describeDbError(err, "register") });
  }
});

// ──────────────── POST /api/auth/login ────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const result = await db.query(
      `SELECT id, full_name, email, password_hash, role, is_active
         FROM users
        WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const row = result.rows[0];
    if (!row.is_active) {
      return res.status(403).json({ error: "This account has been disabled. Please contact an administrator." });
    }

    let ok = false;
    try {
      ok = await bcrypt.compare(password, row.password_hash);
    } catch (cmpErr) {
      // Invalid hash format (e.g. seeded placeholder) — treat as bad credentials
      console.warn("[POST /api/auth/login] bcrypt.compare failed:", cmpErr.message);
      ok = false;
    }
    if (!ok) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = signTokenFor(row);
    return res.json({ user: publicUser(row), token });
  } catch (err) {
    console.error("[POST /api/auth/login]", err);
    return res.status(500).json({ error: describeDbError(err, "login") });
  }
});

// ──────────────── GET /api/auth/me ────────────────
// Returns the currently authenticated user, given a Bearer token.
router.get("/me", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token." });

    const payload = jwt.verify(token, JWT_SECRET);
    const result = await db.query(
      "SELECT id, full_name, email, role, is_active FROM users WHERE id = $1",
      [payload.sub]
    );
    if (result.rowCount === 0 || !result.rows[0].is_active) {
      return res.status(401).json({ error: "User not found or disabled." });
    }
    return res.json({ user: publicUser(result.rows[0]) });
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
});


// ──────────────────────────────────────────────────────────────
// Forgot-Password / OTP flow
// ──────────────────────────────────────────────────────────────
const OTP_EXPIRY_MIN     = 5;            // OTP valid for 5 minutes
const OTP_RESEND_COOLDOWN_SEC = 60;      // user must wait 60s between requests
const OTP_MAX_ATTEMPTS_WINDOW = 3;       // max OTP requests within the rate-window
const OTP_RATE_WINDOW_MIN     = 15;      // window for max-attempts counter (15 min)

function generateOtp() {
  // 6-digit numeric, zero-padded
  return String(Math.floor(100000 + Math.random() * 900000));
}
function clientIp(req) {
  const fwd = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  let ip = fwd || req.ip || (req.connection && req.connection.remoteAddress) || null;
  if (!ip) return null;
  // strip IPv6-mapped IPv4 prefix so PG ::inet cast accepts it
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  // basic sanity: reject anything that obviously isn't an IP
  const looksLikeIp = /^[0-9a-fA-F:.]+$/.test(ip);
  return looksLikeIp ? ip : null;
}

// ──────────────── POST /api/auth/forgot-password ────────────────
// Body: { email }
// Generates a fresh OTP, stores its bcrypt hash, emails it to the user.
// Always responds with the same success shape so we don't reveal which emails exist
// — but rate-limit messages are returned for known accounts.
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "Please provide a valid email address." });
    }
    const cleanEmail = email.toLowerCase().trim();

    const userRes = await db.query(
      "SELECT id, full_name, email FROM users WHERE email = $1 AND is_active = TRUE",
      [cleanEmail]
    );

    // If email isn't registered, return a neutral success so we don't leak account existence.
    if (userRes.rowCount === 0) {
      return res.json({
        ok: true,
        message: "If that email is registered, an OTP has been sent. Check your inbox.",
        cooldownSeconds: OTP_RESEND_COOLDOWN_SEC
      });
    }
    const user = userRes.rows[0];

    // Rate-limit: count requests in the current window
    const recentRes = await db.query(
      `SELECT id, created_at FROM password_resets
        WHERE user_id = $1 AND created_at > NOW() - ($2 || ' minutes')::interval
        ORDER BY created_at DESC`,
      [user.id, OTP_RATE_WINDOW_MIN]
    );

    // (a) cooldown — wait 60s between sends
    if (recentRes.rowCount > 0) {
      const lastSent = new Date(recentRes.rows[0].created_at);
      const elapsed = Math.floor((Date.now() - lastSent.getTime()) / 1000);
      if (elapsed < OTP_RESEND_COOLDOWN_SEC) {
        const wait = OTP_RESEND_COOLDOWN_SEC - elapsed;
        return res.status(429).json({
          error: `Please wait ${wait} second${wait === 1 ? "" : "s"} before requesting another OTP.`,
          cooldownSeconds: wait
        });
      }
    }
    // (b) maximum attempts per window
    if (recentRes.rowCount >= OTP_MAX_ATTEMPTS_WINDOW) {
      return res.status(429).json({
        error: `Too many OTP requests. Try again in ${OTP_RATE_WINDOW_MIN} minutes.`
      });
    }

    // Generate + hash + store OTP
    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 8);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MIN * 60 * 1000);

    // Mark any previous unused OTPs as used so only the freshest one works
    await db.query(
      "UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL",
      [user.id]
    );
    await db.query(
      `INSERT INTO password_resets (user_id, otp_hash, expires_at, ip_address, user_agent)
         VALUES ($1, $2, $3, $4::inet, $5)`,
      [user.id, otpHash, expiresAt, clientIp(req), (req.headers["user-agent"] || "").slice(0, 500)]
    );

    // Email the OTP using the branded template
    const otpMail = otpEmail({
      name: user.full_name,
      email: user.email,
      otp,
      expiresMin: OTP_EXPIRY_MIN,
    });
    const sent = await mailer.send({
      to: user.email,
      subject: otpMail.subject,
      text: otpMail.text,
      html: otpMail.html,
    });

    // Dev convenience: when SMTP is not configured, log the OTP to the server console
    if (!sent) console.log(`[forgot-password] DEV OTP for ${user.email}: ${otp} (mailer not configured / email send failed)`);

    return res.json({
      ok: true,
      message: "If that email is registered, an OTP has been sent. Check your inbox.",
      cooldownSeconds: OTP_RESEND_COOLDOWN_SEC,
      attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS_WINDOW - (recentRes.rowCount + 1))
    });
  } catch (err) {
    console.error("[POST /api/auth/forgot-password]", err);
    return res.status(500).json({ error: describeDbError(err, "forgot password") });
  }
});

// ──────────────── POST /api/auth/verify-otp ────────────────
// Body: { email, otp }  — soft-checks the OTP without consuming it.
router.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    if (!email || !otp) return res.status(400).json({ error: "Email and OTP are required." });

    const cleanEmail = email.toLowerCase().trim();
    const userRes = await db.query("SELECT id FROM users WHERE email = $1 AND is_active = TRUE", [cleanEmail]);
    if (userRes.rowCount === 0) return res.status(400).json({ error: "Invalid OTP or email." });
    const user = userRes.rows[0];

    const otpRes = await db.query(
      `SELECT id, otp_hash, expires_at FROM password_resets
        WHERE user_id = $1 AND used_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    if (otpRes.rowCount === 0) {
      return res.status(400).json({ error: "No active OTP. Please request a new one." });
    }
    const row = otpRes.rows[0];
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "Your OTP has expired. Please request a new one." });
    }
    const ok = await bcrypt.compare(String(otp), row.otp_hash).catch(() => false);
    if (!ok) return res.status(400).json({ error: "Incorrect OTP. Please try again." });

    return res.json({ ok: true, message: "OTP verified. You can now set a new password." });
  } catch (err) {
    console.error("[POST /api/auth/verify-otp]", err);
    return res.status(500).json({ error: describeDbError(err, "verify OTP") });
  }
});

// ──────────────── POST /api/auth/reset-password ────────────────
// Body: { email, otp, newPassword }  — verifies OTP, sets new password, marks OTP used.
router.post("/reset-password", async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body || {};
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: "Email, OTP and new password are required." });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "Please provide a valid email address." });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters long." });
    }

    const cleanEmail = email.toLowerCase().trim();
    const userRes = await db.query(
      "SELECT id, full_name, email FROM users WHERE email = $1 AND is_active = TRUE",
      [cleanEmail]
    );
    if (userRes.rowCount === 0) return res.status(400).json({ error: "Invalid OTP or email." });
    const user = userRes.rows[0];

    const otpRes = await db.query(
      `SELECT id, otp_hash, expires_at FROM password_resets
        WHERE user_id = $1 AND used_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    if (otpRes.rowCount === 0) {
      return res.status(400).json({ error: "No active OTP. Please request a new one." });
    }
    const row = otpRes.rows[0];
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "Your OTP has expired. Please request a new one." });
    }
    const ok = await bcrypt.compare(String(otp), row.otp_hash).catch(() => false);
    if (!ok) return res.status(400).json({ error: "Incorrect OTP. Please try again." });

    // Hash + store new password, then consume the OTP
    const newHash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
    await db.query(
      "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
      [newHash, user.id]
    );
    await db.query("UPDATE password_resets SET used_at = NOW() WHERE id = $1", [row.id]);

    // Fire-and-forget security notification — confirms the change to the user.
    (async () => {
      try {
        const mail = passwordChangedEmail({
          name: user.full_name,
          email: user.email,
          ip: clientIp(req),
          userAgent: req.headers["user-agent"] || "",
          when: new Date(),
          loginUrl: `${publicBaseUrl(req)}/login.html`,
        });
        const sentOk = await mailer.send({
          to: user.email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
        if (!sentOk) console.log(`[reset-password] confirmation email skipped for ${user.email}`);
      } catch (e) {
        console.warn("[reset-password] confirmation email error:", e.message);
      }
    })();

    return res.json({ ok: true, message: "Password updated. You can now log in." });
  } catch (err) {
    console.error("[POST /api/auth/reset-password]", err);
    return res.status(500).json({ error: describeDbError(err, "reset password") });
  }
});

module.exports = router;
