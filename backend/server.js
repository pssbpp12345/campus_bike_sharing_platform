// ──────────────────────────────────────────────────────────────
// server.js — Campus Bike Sharing API + static front-end host.
//
// • Serves the React/HTML front-end (index.html, Login.css, /UI/*)
//   directly out of the project root, so the browser, the API and
//   the assets all share the same origin (no CORS hassle).
// • Mounts /api/auth/{login,register,me}.
// ──────────────────────────────────────────────────────────────

require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");

const db = require("./db");
const authRoutes = require("./routes/auth");
const contactRoutes = require("./routes/contact");
const paymentRoutes = require("./routes/payments");
const bookingRoutes = require("./routes/bookings");
const rideRoutes = require("./routes/rides");
const profileRoutes = require("./routes/profile");
const supportRoutes = require("./routes/support");
const studentRoutes = require("./routes/student");
const notifRoutes   = require("./routes/notifications");
const configRoutes  = require("./routes/config");
const publicSettingsRoutes = require("./routes/publicSettings");
const adminRoutes   = require("./routes/admin");
const adminBookingsRoutes = require("./routes/adminBookings");
const adminPaymentsRoutes = require("./routes/adminPayments");
const adminStationsRoutes = require("./routes/adminStations");
const adminBikesRoutes = require("./routes/adminBikes");
const adminMaintenanceRouter = require("./routes/adminMaintenance");
const adminReportsRouter = require("./routes/adminReports");
const adminSupportRouter = require("./routes/adminSupport");
const adminSettingsRouter = require("./routes/adminSettings");
const adminHelpRouter = require("./routes/adminHelp");
const adminAiRouter = require("./routes/adminAi");
const adminRefundRequestsRouter = require("./routes/adminRefundRequests");

const app = express();
// PORT comes from backend/.env; default is 8001 for this project.
// EADDRINUSE means another process is already using the selected port.
const PORT = process.env.PORT || 8001;
const PROJECT_ROOT = path.resolve(__dirname, "..");
const UPLOADS_DIR = path.join(PROJECT_ROOT, "Uploads");

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
// Stripe webhooks must be reachable under both /api/payments/stripe/webhook
// (mounted via the payments router) and the bare /stripe/webhook path some
// Stripe dashboards default to. We keep the JSON body parser global because
// signature verification is disabled in dev (no STRIPE_WEBHOOK_SECRET set).
app.use(express.json({ limit: "1mb" }));

// ── Static front-end (index.html, Login.css, /UI/*, etc.) ─────
app.use(express.static(PROJECT_ROOT));

// Backwards-compat: redirect old /frontend/Student/* URLs to the new
// /frontend/User/* tree. The physical files have been renamed —
// frontend/User/User_dashboard.html is now the canonical file. Old
// bookmarks and any cached copies that still point at the old names
// get a 302 redirect so nothing breaks.
//
// Mapping rules:
//   /frontend/Student/Student_dashboard.html        → /frontend/User/User_dashboard.html
//   /frontend/Student/Student_MyBooking.html        → /frontend/User/User_my_bookings.html
//   /frontend/Student/Student_ride_history.html     → /frontend/User/User_ride_history.html
//   /frontend/Student/Student_profile.html          → /frontend/User/User_profile.html
//   /frontend/Student/Student_need_help.html        → /frontend/User/User_need_help.html
//   /frontend/Student/Student_payment.html          → /frontend/User/User_payment.html
//   /frontend/Student/Student_account_settings.html → /frontend/User/User_account_settings.html
//   /frontend/Student/student-shared.css            → /frontend/User/user-shared.css
//   /frontend/Student/student-shared.js             → /frontend/User/user-shared.js
//   /frontend/Student/student-premium.css           → /frontend/User/user-premium.css
//   /frontend/Student/ride-history.css              → /frontend/User/ride-history.css
const LEGACY_STUDENT_MAP = {
  "Student_dashboard.html":        "User_dashboard.html",
  "Student_MyBooking.html":        "User_my_bookings.html",
  "Student_my_bookings.html":      "User_my_bookings.html",
  "Student_profile.html":          "User_profile.html",
  "Student_ride_history.html":     "User_ride_history.html",
  "Student_need_help.html":        "User_need_help.html",
  "Student_payment.html":          "User_payment.html",
  "Student_account_settings.html": "User_account_settings.html",
  "student-shared.css":            "user-shared.css",
  "student-shared.js":             "user-shared.js",
  "student-premium.css":           "user-premium.css",
  "ride-history.css":              "ride-history.css",
};
app.get(/^\/frontend\/Student\/(.+)$/i, (req, res, next) => {
  const oldName = req.params[0];
  const newName = LEGACY_STUDENT_MAP[oldName];
  if (newName) {
    const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    return res.redirect(302, `/frontend/User/${newName}${qs}`);
  }
  return next();
});

// ── Health checks ─────────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  try {
    const r = await db.query("SELECT NOW() AS now");
    res.json({ status: "ok", db_time: r.rows[0].now });
  } catch (err) {
    console.error("[health] DB error:", err.message);
    res.status(500).json({ status: "error", error: "Database not reachable." });
  }
});

// ── API routes ────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/rides", rideRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/student", studentRoutes);
// /api/user/* is the new canonical path that works for both student and
// staff users. The /api/student/* path is kept as a backward-compat alias
// so existing pages and bookmarks keep working during the rename.
app.use("/api/user", studentRoutes);
app.use("/api/notifications", notifRoutes);
app.use("/api/config", configRoutes);
app.use("/api/settings", publicSettingsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/bookings", adminBookingsRoutes);
app.use("/api/admin/payments", adminPaymentsRoutes);
app.use("/api/admin/refund-requests", adminRefundRequestsRouter);
app.use("/api/admin/stations", adminStationsRoutes);
app.use("/api/admin/bikes", adminBikesRoutes);
app.use("/api/admin/maintenance", adminMaintenanceRouter);
app.use("/api/admin/reports", adminReportsRouter);
app.use("/api/admin/support", adminSupportRouter);
app.use("/api/admin/settings", adminSettingsRouter);
app.use("/api/admin/help", adminHelpRouter);
app.use("/api/admin/ai", adminAiRouter);
// Serve uploaded files from the project workspace on every platform.
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/bookings", bookingRoutes);
app.use("/rides", rideRoutes);
app.use("/payments", paymentRoutes);
// Convenience alias: some Stripe dashboards default to /stripe/webhook
app.use("/stripe", paymentRoutes);

// ── Front-end fallback (so refreshing /login still serves the page) ──
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(PROJECT_ROOT, "index.html"));
});

// ── Error handler ─────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("[server] Uncaught error:", err);
  res.status(500).json({ error: "Internal server error." });
});

// ── Boot ──────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use.`);
    console.error("Another backend server may already be running.");
    console.error("Fix option 1: stop the old Node process.");
    console.error("Fix option 2: set a different PORT in backend/.env, for example PORT=8002.");
    process.exit(1);
  }

  console.error("Server error:", error);
  process.exit(1);
});
