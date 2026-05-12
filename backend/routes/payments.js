const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_CURRENCY = (process.env.STRIPE_CURRENCY || "aud").toLowerCase();
const UNLOCK_FEE_CENTS = Number(process.env.BOOKING_UNLOCK_FEE_CENTS) || 100;
const PER_MINUTE_CENTS = Number(process.env.BOOKING_PER_MINUTE_CENTS) || 20;
const ALLOWED_DURATIONS = new Set([15, 30, 60, 120, 240, 480]);

function requireUser(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Please log in before booking." });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (_) {
    res.status(401).json({ error: "Your login session has expired. Please log in again." });
  }
}

function appBaseUrl(req) {
  return (
    process.env.APP_BASE_URL ||
    `${req.protocol}://${req.get("host")}`
  ).replace(/\/$/, "");
}

function bookingAmountCents(duration) {
  return UNLOCK_FEE_CENTS + (duration * PER_MINUTE_CENTS);
}

function cleanBooking(input) {
  const b = input || {};
  const duration = Number(b.duration);
  const start = new Date(b.start);
  const end = new Date(b.end);

  if (!b.stationId || !b.stationName || !duration || !b.start || !b.end) {
    throw new Error("Missing booking details.");
  }
  if (!ALLOWED_DURATIONS.has(duration)) {
    throw new Error("Invalid booking duration.");
  }
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error("Invalid booking time.");
  }
  if (start.getTime() < Date.now() - 60_000) {
    throw new Error("Pick-up time must be in the future.");
  }

  return {
    stationId: String(b.stationId).slice(0, 80),
    stationName: String(b.stationName).slice(0, 120),
    start: start.toISOString(),
    end: end.toISOString(),
    duration,
    type: String(b.type || "Standard bike").slice(0, 80),
    cost: bookingAmountCents(duration) / 100,
  };
}

async function stripeRequest(path, { method = "GET", body } = {}) {
  if (!STRIPE_SECRET_KEY) {
    const err = new Error("Stripe is not configured.");
    err.status = 503;
    throw err;
  }

  const headers = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
  };
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";

  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers,
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error((data.error && data.error.message) || "Stripe request failed.");
    err.status = response.status;
    throw err;
  }
  return data;
}

router.post("/create-checkout-session", requireUser, async (req, res) => {
  try {
    const booking = cleanBooking(req.body && req.body.booking);
    const amount = bookingAmountCents(booking.duration);
    const baseUrl = appBaseUrl(req);

    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("payment_method_types[]", "card");
    params.set("client_reference_id", String(req.user.sub || req.user.email || ""));
    if (req.user.email) params.set("customer_email", String(req.user.email));
    params.set("success_url", `${baseUrl}/frontend/Student/Student_dashboard.html?payment=success&session_id={CHECKOUT_SESSION_ID}`);
    params.set("cancel_url", `${baseUrl}/frontend/Student/Student_dashboard.html?payment=cancelled`);
    params.set("line_items[0][quantity]", "1");
    params.set("line_items[0][price_data][currency]", STRIPE_CURRENCY);
    params.set("line_items[0][price_data][unit_amount]", String(amount));
    params.set("line_items[0][price_data][product_data][name]", `Bike booking - ${booking.stationName}`);
    params.set("line_items[0][price_data][product_data][description]", `${booking.duration} min ${booking.type}`);
    params.set("metadata[booking]", JSON.stringify(booking));
    params.set("metadata[user_id]", String(req.user.sub || ""));

    const session = await stripeRequest("/checkout/sessions", {
      method: "POST",
      body: params,
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not start payment." });
  }
});

router.get("/session/:id", requireUser, async (req, res) => {
  try {
    const sessionId = String(req.params.id || "");
    if (!sessionId.startsWith("cs_")) return res.status(400).json({ error: "Invalid session." });

    const session = await stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
    const booking = session.metadata && session.metadata.booking
      ? JSON.parse(session.metadata.booking)
      : null;

    res.json({
      id: session.id,
      paid: session.payment_status === "paid",
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      currency: session.currency,
      booking,
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not verify payment." });
  }
});

router.post("/refund-booking", requireUser, async (req, res) => {
  try {
    const sessionId = String((req.body && req.body.sessionId) || "");
    const reason = String((req.body && req.body.reason) || "").trim();

    if (!sessionId.startsWith("cs_")) return res.status(400).json({ error: "This booking does not have a valid Stripe payment session." });
    if (reason.length < 12) return res.status(400).json({ error: "Please provide a clear cancellation reason before requesting a refund." });

    const session = await stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
    if (session.payment_status !== "paid") {
      return res.status(400).json({ error: "Stripe has not marked this booking as paid." });
    }
    if (!session.payment_intent) {
      return res.status(400).json({ error: "Stripe did not return a payment intent for this booking." });
    }

    const params = new URLSearchParams();
    params.set("payment_intent", session.payment_intent);
    params.set("reason", "requested_by_customer");
    params.set("metadata[cancellation_reason]", reason.slice(0, 500));
    params.set("metadata[user_id]", String(req.user.sub || ""));

    const refund = await stripeRequest("/refunds", {
      method: "POST",
      body: params,
    });

    res.json({
      refundId: refund.id,
      status: refund.status,
      amount: refund.amount,
      currency: refund.currency,
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not create refund." });
  }
});

router.get("/status", requireUser, async (req, res) => {
  try {
    const bookingId = req.query.bookingId ? Number(req.query.bookingId) : null;
    const params = [req.user.sub];
    let where = "WHERE p.user_id = $1";
    if (bookingId) {
      params.push(bookingId);
      where += ` AND p.booking_id = $${params.length}`;
    }
    const result = await db.query(
      `SELECT p.booking_id, p.amount, p.currency, p.payment_method, p.status,
              p.transaction_reference, p.paid_at, p.created_at
         FROM payments p
        ${where}
        ORDER BY p.created_at DESC`,
      params
    );
    res.json({ payments: result.rows });
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not load payment status." });
  }
});

module.exports = router;
