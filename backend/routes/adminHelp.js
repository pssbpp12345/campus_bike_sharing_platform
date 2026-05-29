// /api/admin/help/* - Admin/staff Help Center support.
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";

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
    schemaReadyPromise = db.query(`
      CREATE TABLE IF NOT EXISTS admin_help_requests (
        id SERIAL PRIMARY KEY,
        title VARCHAR(160) NOT NULL,
        category VARCHAR(60),
        priority VARCHAR(30),
        description TEXT NOT NULL,
        affected_page VARCHAR(80),
        status VARCHAR(30) DEFAULT 'open',
        created_by VARCHAR(120),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }
  return schemaReadyPromise;
}

function clean(value, fallback = "") {
  const text = String(value == null ? "" : value).trim();
  return text ? text.replace(/\s+/g, " ") : fallback;
}

function configured(value) {
  return clean(value) ? "connected" : "not_configured";
}

function displayName(payload) {
  return clean(payload.full_name || payload.name || payload.email, "Admin User");
}

router.use(requireAdmin);
router.use(async (_req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (err) {
    console.error("[adminHelp schema]", err);
    res.status(500).json({ error: "Could not prepare admin help schema." });
  }
});

router.get("/status", async (_req, res) => {
  try {
    const dbCheck = await db.query("SELECT NOW() AS now");
    res.json({
      backend: "online",
      database: dbCheck.rows[0]?.now ? "connected" : "offline",
      stripe: configured(process.env.STRIPE_SECRET_KEY),
      smtp: process.env.SMTP_HOST && process.env.SMTP_USER ? "connected" : "not_configured",
      maps: configured(process.env.GOOGLE_MAPS_API_KEY),
    });
  } catch (err) {
    console.error("[GET /api/admin/help/status]", err);
    res.json({
      backend: "online",
      database: "offline",
      stripe: configured(process.env.STRIPE_SECRET_KEY),
      smtp: process.env.SMTP_HOST && process.env.SMTP_USER ? "connected" : "not_configured",
      maps: configured(process.env.GOOGLE_MAPS_API_KEY),
    });
  }
});

router.post("/support-request", async (req, res) => {
  try {
    const title = clean(req.body.title).slice(0, 160);
    const category = clean(req.body.category, "Other").slice(0, 60);
    const priority = clean(req.body.priority, "Medium").slice(0, 30);
    const description = clean(req.body.description).slice(0, 5000);
    const affectedPage = clean(req.body.affectedPage, "Dashboard").slice(0, 80);
    if (title.length < 4 || description.length < 12) {
      return res.status(400).json({ error: "Issue title and a clear description are required." });
    }
    const result = await db.query(
      `INSERT INTO admin_help_requests
        (title, category, priority, description, affected_page, status, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, 'open', $6, NOW())
       RETURNING id, created_at`,
      [title, category, priority, description, affectedPage, displayName(req.user)]
    );
    res.status(201).json({
      ok: true,
      request: {
        id: Number(result.rows[0].id),
        requestCode: "AHR-" + String(result.rows[0].id).padStart(4, "0"),
        createdAt: result.rows[0].created_at,
      },
    });
  } catch (err) {
    console.error("[POST /api/admin/help/support-request]", err);
    res.status(500).json({ error: "Could not save admin support request." });
  }
});

module.exports = router;
