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

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ── Static front-end (index.html, Login.css, /UI/*, etc.) ─────
app.use(express.static(PROJECT_ROOT));

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
app.use("/bookings", bookingRoutes);
app.use("/rides", rideRoutes);
app.use("/payments", paymentRoutes);

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
app.listen(PORT, () => {
  console.log("");
  console.log(`  Campus Bike Sharing backend is running.`);
  console.log(`  ➜  Local:   http://localhost:${PORT}/`);
  console.log(`  ➜  Health:  http://localhost:${PORT}/api/health`);
  console.log("");
});
