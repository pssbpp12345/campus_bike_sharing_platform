// /api/config — public-safe runtime configuration for the frontend.
// Keys returned here are intentionally browser-accessible.
// Restrict the Google Maps API key in Google Cloud Console by HTTP referrer:
//   http://localhost:*
//   http://localhost:3000/*
//   <your-deployed-domain>/*

const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();

function detectStudentGoogleMapsKey() {
  // Scan the User pages for an inline Google Maps key as a last-resort
  // fallback. The /frontend/Student/ paths are kept as a back-compat
  // probe in case anyone still keeps that folder around.
  const candidates = [
    path.resolve(__dirname, "../../frontend/User/User_dashboard.html"),
    path.resolve(__dirname, "../../frontend/User/User_ride_history.html"),
    path.resolve(__dirname, "../../frontend/Student/Student_dashboard.html"),
    path.resolve(__dirname, "../../frontend/Student/Student_ride_history.html"),
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

// GET /api/config/google-maps-key
// Returns { key } so the front-end can lazy-load the Maps JS API at runtime.
router.get("/google-maps-key", (_req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY || detectStudentGoogleMapsKey();
  res.json({ key });
});

module.exports = router;
