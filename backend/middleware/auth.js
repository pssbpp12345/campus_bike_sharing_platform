// Reusable JWT auth middleware (DRY across routes)
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";

function requireUser(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Please log in." });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (_) {
    res.status(401).json({ error: "Invalid or expired session." });
  }
}

module.exports = { requireUser, JWT_SECRET };
