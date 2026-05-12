// ──────────────────────────────────────────────────────────────
// /api/contact — public submission + admin inbox.
// ──────────────────────────────────────────────────────────────

const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const mailer = require("../utils/mailer");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";

const VALID_CATEGORIES = new Set([
  "general", "support", "feedback", "partnership", "press", "bug_report",
]);
const VALID_STATUSES = new Set([
  "new", "read", "replied", "archived",
]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Best-effort decode of a Bearer token — we use this on the public POST
// route so a logged-in submission can be linked back to their user record.
function tryDecodeUser(req) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return null;
    const payload = jwt.verify(token, JWT_SECRET);
    return payload && payload.sub ? Number(payload.sub) : null;
  } catch (_) { return null; }
}

function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token." });
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== "admin") return res.status(403).json({ error: "Admin access required." });
    req.adminId = Number(payload.sub);
    return next();
  } catch (_) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

// Pulls the originating IP even when running behind a proxy.
function clientIp(req) {
  const fwd = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.ip || req.connection?.remoteAddress || null;
}

// ───────── POST /api/contact ─────────  (public)
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const fullName = String(body.fullName || "").trim();
    const email    = String(body.email || "").trim().toLowerCase();
    const phone    = body.phone ? String(body.phone).trim() : null;
    const category = String(body.category || "general").trim();
    const subject  = String(body.subject || "").trim();
    const message  = String(body.message || "").trim();

    // Validation
    if (!fullName || fullName.length < 2 || fullName.length > 150) {
      return res.status(400).json({ error: "Please tell us your name." });
    }
    if (!EMAIL_RE.test(email) || email.length > 150) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    if (!VALID_CATEGORIES.has(category)) {
      return res.status(400).json({ error: "Please choose a valid category." });
    }
    if (!subject || subject.length < 2 || subject.length > 200) {
      return res.status(400).json({ error: "Please add a short subject (2–200 chars)." });
    }
    if (!message || message.length < 5 || message.length > 10000) {
      return res.status(400).json({ error: "Please write a message (5–10,000 chars)." });
    }
    if (phone && phone.length > 40) {
      return res.status(400).json({ error: "Phone number is too long." });
    }

    const userId = tryDecodeUser(req);
    const ip = clientIp(req);
    const userAgent = (req.headers["user-agent"] || "").slice(0, 500);

    // Insert into DB — this is the source of truth.
    const insert = await db.query(
      `INSERT INTO contact_messages
        (user_id, full_name, email, phone, category, subject, message, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::inet, $9)
       RETURNING id, created_at`,
      [userId, fullName, email, phone, category, subject, message, ip, userAgent]
    );
    const saved = insert.rows[0];

    // Best-effort email notification to admin (won't fail the request).
    if (ADMIN_EMAIL) {
      const safe = (s) => String(s || "").replace(/[<>]/g, "");
      mailer.send({
        to: ADMIN_EMAIL,
        replyTo: email,
        subject: `[Campus Bike Sharing] New ${category} message: ${subject}`,
        text:
`New contact form submission #${saved.id}

From:     ${fullName} <${email}>${phone ? `\nPhone:    ${phone}` : ""}
Category: ${category}
Subject:  ${subject}
User ID:  ${userId || "(anonymous)"}
Received: ${saved.created_at.toISOString()}

Message
-------
${message}
`,
        html:
`<div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#0F172A">
  <h2 style="margin:0 0 6px">New ${safe(category)} message</h2>
  <p style="color:#64748B;margin:0 0 18px">Submission #${saved.id} · ${saved.created_at.toISOString()}</p>
  <table style="border-collapse:collapse;font-size:14px;margin-bottom:18px">
    <tr><td style="padding:4px 12px 4px 0;color:#64748B">From</td><td><strong>${safe(fullName)}</strong> &lt;<a href="mailto:${safe(email)}">${safe(email)}</a>&gt;</td></tr>
    ${phone ? `<tr><td style="padding:4px 12px 4px 0;color:#64748B">Phone</td><td>${safe(phone)}</td></tr>` : ""}
    <tr><td style="padding:4px 12px 4px 0;color:#64748B">Category</td><td>${safe(category)}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#64748B">Subject</td><td>${safe(subject)}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#64748B">Account</td><td>${userId ? `User #${userId}` : "(anonymous)"}</td></tr>
  </table>
  <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:16px;white-space:pre-wrap">${safe(message)}</div>
</div>`,
      }).catch(() => {});
    }

    return res.status(201).json({
      id: saved.id,
      received_at: saved.created_at,
      message: "Thanks — we've received your message and will reply within 1–2 business days.",
    });
  } catch (err) {
    console.error("[POST /api/contact]", err);
    return res.status(500).json({ error: "Something went wrong saving your message. Please try again." });
  }
});

// ───────── GET /api/contact/messages ─────────  (admin)
router.get("/messages", requireAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    if (status && !VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: "Invalid status filter." });
    }

    const params = [];
    let where = "";
    if (status) { params.push(status); where = `WHERE status = $${params.length}`; }
    params.push(limit, offset);
    const result = await db.query(
      `SELECT id, created_at, status, category, full_name, email, phone,
              subject, message, user_id, admin_notes, replied_at, replied_by
         FROM contact_messages
         ${where}
         ORDER BY
           CASE status WHEN 'new' THEN 0 WHEN 'read' THEN 1 WHEN 'replied' THEN 2 ELSE 3 END,
           created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return res.json({ messages: result.rows, count: result.rowCount });
  } catch (err) {
    console.error("[GET /api/contact/messages]", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// ───────── PATCH /api/contact/messages/:id ─────────  (admin)
router.patch("/messages/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid message id." });
    }
    const { status, admin_notes } = req.body || {};

    if (status !== undefined && !VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: "Invalid status value." });
    }

    const fields = [];
    const params = [];
    if (status !== undefined) {
      params.push(status); fields.push(`status = $${params.length}`);
      if (status === "replied") {
        params.push(req.adminId); fields.push(`replied_by = $${params.length}`);
        fields.push(`replied_at = NOW()`);
      }
    }
    if (admin_notes !== undefined) {
      params.push(admin_notes); fields.push(`admin_notes = $${params.length}`);
    }
    if (fields.length === 0) {
      return res.status(400).json({ error: "No fields to update." });
    }
    params.push(id);
    const result = await db.query(
      `UPDATE contact_messages SET ${fields.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Not found." });
    return res.json({ message: result.rows[0] });
  } catch (err) {
    console.error("[PATCH /api/contact/messages/:id]", err);
    return res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;
