// /api/support — student support tickets
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";

const CATEGORIES = ["booking", "bike", "payment", "account", "station", "other"];
const PRIORITIES = ["low", "medium", "high", "urgent"];

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

// GET /api/support/tickets — list current user's tickets
router.get("/tickets", requireUser, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, category, subject, description, priority, booking_id,
              status, admin_response, resolved_at, created_at, updated_at
         FROM support_tickets
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user.sub]
    );
    res.json({ tickets: result.rows });
  } catch (err) {
    console.error("[GET /api/support/tickets]", err);
    res.status(500).json({ error: "Could not load tickets." });
  }
});

// POST /api/support/tickets — create a new ticket
router.post("/tickets", requireUser, async (req, res) => {
  try {
    const { category, subject, description, priority, bookingId } = req.body || {};
    const c = String(category || "other").toLowerCase();
    const p = String(priority || "medium").toLowerCase();
    if (!CATEGORIES.includes(c)) return res.status(400).json({ error: "Invalid category." });
    if (!PRIORITIES.includes(p)) return res.status(400).json({ error: "Invalid priority." });
    const subj = String(subject || "").trim();
    const desc = String(description || "").trim();
    if (subj.length < 3 || subj.length > 200) return res.status(400).json({ error: "Subject must be 3–200 chars." });
    if (desc.length < 10 || desc.length > 5000) return res.status(400).json({ error: "Please describe the issue (10–5000 chars)." });

    let bId = null;
    if (bookingId) {
      const n = Number(bookingId);
      if (Number.isFinite(n) && n > 0) {
        // verify booking belongs to user
        const ok = await db.query("SELECT id FROM bookings WHERE id = $1 AND user_id = $2", [n, req.user.sub]);
        if (ok.rowCount > 0) bId = n;
      }
    }

    const result = await db.query(
      `INSERT INTO support_tickets (user_id, category, subject, description, priority, booking_id)
       VALUES ($1, $2::ticket_category, $3, $4, $5::ticket_priority, $6)
       RETURNING id, category, subject, description, priority, booking_id, status, created_at`,
      [req.user.sub, c, subj, desc, p, bId]
    );
    res.status(201).json({ ticket: result.rows[0] });
  } catch (err) {
    console.error("[POST /api/support/tickets]", err);
    res.status(500).json({ error: "Could not submit ticket." });
  }
});

// GET /api/support/faq — static FAQ list (could move to DB later)
router.get("/faq", (_req, res) => {
  res.json({
    faqs: [
      { id: 1, category: "Booking",  q: "How do I book a bike?",
        a: "Open the Student Dashboard, choose a station on the map, click 'Book Bike', pick a date & time, then proceed to payment. You'll receive a confirmation notification once payment is verified." },
      { id: 2, category: "Booking",  q: "Can I cancel a booking?",
        a: "Yes — from My Bookings, find the pending or active booking, click 'Cancel', and provide a brief reason (12+ chars). Cancellations release the bike back to the station." },
      { id: 3, category: "Bike",     q: "What if a bike is broken?",
        a: "Use 'Report an Issue' from the dashboard or submit a ticket below with category 'Bike issue'. Our maintenance team will resolve it within 24 hours." },
      { id: 4, category: "Payment",  q: "Which payment methods are accepted?",
        a: "We use Stripe for secure credit-card payments. Campus-card support is rolling out soon." },
      { id: 5, category: "Payment",  q: "How are rental fees calculated?",
        a: "Fees include a small unlock fee plus a per-minute rate. The exact total is shown on the booking confirmation before you pay." },
      { id: 6, category: "Account",  q: "How do I change my password?",
        a: "Go to your Profile page, click 'Change Password', enter your current and new password. New passwords must be at least 8 characters." },
      { id: 7, category: "Account",  q: "I forgot my password.",
        a: "From the login page, click 'Forgot Password' to receive a 6-digit OTP via email. The OTP is valid for 5 minutes." },
      { id: 8, category: "Station",  q: "What if my station is full and I can't return the bike?",
        a: "Return to the nearest station with available docks. The app will show live availability on the map." },
      { id: 9, category: "Station",  q: "Can I extend my ride?",
        a: "Yes — from My Bookings, choose 'Extend Ride' on an active booking. Extra time is billed at the standard per-minute rate." },
      { id: 10, category: "Other",   q: "How do I contact support directly?",
        a: "Submit a ticket from this page, or email us at campusbikesharing@gmail.com. We reply within 1–2 business days." },
    ]
  });
});

module.exports = router;
