// ──────────────────────────────────────────────────────────────
// utils/mailer.js
//
// Optional SMTP transport for outbound notifications.
// • If SMTP_HOST is not set in .env, every send() call is a no-op
//   that just logs to the console — so the app keeps working
//   even without email credentials.
// • If SMTP_HOST is set, a nodemailer transport is reused for the
//   life of the process.
// ──────────────────────────────────────────────────────────────

let nodemailer;
try { nodemailer = require("nodemailer"); } catch (_) { nodemailer = null; }

const HOST = process.env.SMTP_HOST;
const PORT = Number(process.env.SMTP_PORT) || 587;
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;
const FROM = process.env.SMTP_FROM || USER;
const SECURE = String(process.env.SMTP_SECURE || "").toLowerCase() === "true";

let transport = null;
let configured = false;

if (nodemailer && HOST && USER && PASS) {
  try {
    transport = nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: SECURE,            // true for 465, false for 587/STARTTLS
      auth: { user: USER, pass: PASS },
    });
    configured = true;
    console.log(`[mailer] SMTP configured (${HOST}:${PORT}) — outbound mail enabled.`);
  } catch (err) {
    console.warn("[mailer] Failed to initialise SMTP transport:", err.message);
  }
} else {
  console.log("[mailer] SMTP not configured — emails will be logged but not sent.");
}

/**
 * send({ to, subject, text, html, replyTo }) → resolves true if sent (or logged).
 * Never rejects — failure is logged and swallowed so a missed notification
 * cannot break the underlying request flow (the message is already in the DB).
 */
async function send({ to, subject, text, html, replyTo }) {
  if (!to) return false;

  if (!configured) {
    console.log("[mailer] (would send)", { to, subject, replyTo });
    return false;
  }

  try {
    await transport.sendMail({
      from: FROM,
      to,
      replyTo,
      subject,
      text,
      html,
    });
    return true;
  } catch (err) {
    console.error("[mailer] send failed:", err.message);
    return false;
  }
}

module.exports = { send, configured: () => configured };
