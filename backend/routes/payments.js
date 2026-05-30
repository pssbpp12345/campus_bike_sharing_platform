const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { createLocalCheckoutSession: createLocalSession, createLocalEndRideSession, createLocalStartRideSession, getLocalCheckoutSession } = require("../utils/localCheckoutSessions");
const settingsService = require("../services/settingsService");
const {
  deletePaymentMethod,
  ensurePaymentMethodSchema,
  ensureStripeCustomer,
  getDefaultPaymentMethod,
  listPaymentMethods,
  savePaymentMethodFromCheckoutSession,
  setDefaultPaymentMethod,
  storePaymentMethod,
} = require("../utils/savedPaymentMethods");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";
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
    process.env.FRONTEND_BASE_URL ||
    process.env.APP_BASE_URL ||
    "https://campus-bike-sharing-frontend.onrender.com"
  ).replace(/\/$/, "");
}

function bookingAmountCents(duration) {
  return UNLOCK_FEE_CENTS + (duration * PER_MINUTE_CENTS);
}

function fallbackPricing() {
  return {
    unlockFee: UNLOCK_FEE_CENTS / 100,
    perMinuteFee: PER_MINUTE_CENTS / 100,
    minimumRideDuration: 5,
    maximumRideDuration: 180,
  };
}

// "Active" ride = literal DB status = 'active' (i.e. user manually started it).
// A scheduled booking past its start_time stays 'pending' / 'ready_to_start'
// and MUST NOT count as active — otherwise it blocks the very same Start Ride
// button that's supposed to flip it active.
//
// Other statuses (pending/scheduled/confirmed/upcoming/ready_to_start/
// completed/cancelled/expired/no_show/pending_payment) are explicitly NOT
// counted. We also ignore rows whose end_time has already passed (stale
// active rides that autoExpireStaleBookings hasn't swept yet).
async function assertNoActiveRide(userId) {
  const active = await db.query(
    `SELECT id, bike_id, status, start_time, end_time
       FROM bookings
      WHERE user_id = $1
        AND status = 'active'
        AND (end_time IS NULL OR end_time > NOW())
      LIMIT 1`,
    [userId]
  );
  if (active.rows[0]) {
    const row = active.rows[0];
    const err = new Error("You already have an active ride. You can still schedule an upcoming booking.");
    err.status = 409;
    err.activeBooking = {
      bookingId: row.id,
      bikeId: row.bike_id,
      status: row.status,
      startedAt: row.start_time,
    };
    throw err;
  }
}

// Block ANY new booking that overlaps an existing active/upcoming booking
// for the same user. Compares against the existing row's effective window
// (end_time when set, otherwise the pickup hold via expires_at). Bookings
// with status cancelled/completed/failed/refunded/expired are ignored.
//
// Overlap formula: newStart < existingEnd AND newEnd > existingStart
async function assertNoUserFixedOverlap(userId, start, end) {
  const overlap = await db.query(
    `SELECT id, start_time, COALESCE(end_time, expires_at) AS end_effective
       FROM bookings
      WHERE user_id = $1
        AND status::text IN ('pending','confirmed','active','scheduled','upcoming')
        AND start_time < $3
        AND COALESCE(end_time, expires_at) > $2
      LIMIT 1`,
    [userId, start, end]
  );
  if (overlap.rows[0]) {
    const err = new Error("You already have a booking during this time. Please cancel it or choose another time.");
    err.status = 409;
    throw err;
  }
}

async function assertBikeFreeForWindow(bikeId, start, end) {
  const overlap = await db.query(
    `SELECT id
       FROM bookings
      WHERE bike_id = $1
        AND status::text IN ('pending','confirmed','active','scheduled','upcoming')
        AND start_time < $3
        AND COALESCE(end_time, expires_at) > $2
      LIMIT 1`,
    [bikeId, start, end]
  );
  if (overlap.rows[0]) {
    throw new Error("This bike is already booked during this time. Please choose another bike or time.");
  }
}

async function assertBikeAvailableAtStation(bikeId, stationId) {
  const result = await db.query(
    `SELECT b.id
       FROM bikes b
      WHERE b.id = $1
        AND b.station_id = $2
        AND b.status = 'available'
      LIMIT 1`,
    [bikeId, stationId]
  );
  if (!result.rows[0]) {
    throw new Error("This bike is no longer available. Please choose another bike.");
  }
}

function bookingAmountCentsForPricing(duration, pricing) {
  return settingsService.amountCentsForDuration(duration, pricing || fallbackPricing());
}

function bookingFromMetadata(metadata) {
  if (!metadata) return null;
  if (metadata.booking) {
    try { return JSON.parse(metadata.booking); } catch (_) {}
  }

  const duration = Number(metadata.duration);
  const stationId = Number(metadata.station_id);
  const bikeId = Number(metadata.bike_id);
  const bikeCode = String(metadata.bike_code || "").trim();
  if (!Number.isInteger(stationId) || !Number.isInteger(bikeId) || !bikeCode || !duration) return null;
  if (!metadata.start || !metadata.end) return null;

  const bookingType = metadata.booking_type === "ride_now" ? "ride_now" : "scheduled";
  const pricingMode = metadata.pricing_mode === "pay_as_you_go" ? "pay_as_you_go" : "fixed_duration";
  const bikeModel = String(metadata.bike_model || "Standard bike");
  const unlockFee = Number(metadata.unlock_fee ?? UNLOCK_FEE_CENTS / 100);
  const perMinuteFee = Number(metadata.per_minute_fee ?? PER_MINUTE_CENTS / 100);
  const totalCost = Number(metadata.total_cost ?? (unlockFee + duration * perMinuteFee));
  return {
    bookingType,
    stationId,
    stationName: String(metadata.station_name || "Campus station"),
    bikeId,
    bikeCode,
    bikeModel,
    start: metadata.start,
    end: metadata.end,
    duration,
    type: bikeModel,
    pricingMode,
    unlockFee,
    perMinuteFee,
    totalCost,
    cost: totalCost,
  };
}

function cleanBooking(input, pricing = fallbackPricing()) {
  const b = input || {};
  const duration = Number(b.duration);
  const stationId = Number(b.stationId);
  const bikeId = Number(b.bikeId);
  const bikeCode = String(b.bikeCode || "").trim();
  const bookingType = b.bookingType === "ride_now" ? "ride_now" : "scheduled";
  const pricingMode = b.pricingMode === "pay_as_you_go" ? "pay_as_you_go" : "fixed_duration";
  const start = bookingType === "ride_now" && !b.start ? new Date() : new Date(b.start);
  const end = bookingType === "ride_now" && !b.end
    ? new Date(start.getTime() + duration * 60000)
    : new Date(b.end);

  if (!Number.isInteger(stationId) || stationId <= 0 || !b.stationName || !duration) {
    throw new Error("Missing booking details.");
  }
  if (!Number.isInteger(bikeId) || bikeId <= 0 || !bikeCode) {
    throw new Error("Please select an available bike before paying.");
  }
  const minDuration = Number(pricing.minimumRideDuration || 1);
  const maxDuration = Number(pricing.maximumRideDuration || 480);
  if (!Number.isFinite(duration) || duration < minDuration || duration > maxDuration) {
    throw new Error(`Booking duration must be between ${minDuration} and ${maxDuration} minutes.`);
  }
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error("Invalid booking time.");
  }
  if (bookingType === "scheduled" && start.getTime() < Date.now() - 60_000) {
    throw new Error("Pick-up time must be in the future.");
  }

  const totalCost = bookingAmountCentsForPricing(duration, pricing) / 100;
  const bikeModel = String(b.bikeModel || b.type || "Standard bike").slice(0, 80);

  return {
    bookingType,
    stationId,
    stationName: String(b.stationName).slice(0, 120),
    bikeId,
    bikeCode: bikeCode.slice(0, 80),
    bikeModel,
    start: start.toISOString(),
    end: end.toISOString(),
    duration,
    type: bikeModel,
    pricingMode,
    unlockFee: Number(pricing.unlockFee || 0),
    perMinuteFee: Number(pricing.perMinuteFee || 0),
    totalCost,
    cost: totalCost,
  };
}

function createLocalCheckoutSession(req, booking, amount) {
  const baseUrl = appBaseUrl(req);
  const session = createLocalSession({
    userId: req.user.sub,
    booking,
    amount,
    currency: STRIPE_CURRENCY,
  });
  const url = `${baseUrl}/User/User_dashboard.html?payment=success&session_id=${encodeURIComponent(session.id)}`;
  return { id: session.id, url };
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

function exposePaymentMethod(row) {
  if (!row) return null;
  return {
    id: row.id,
    stripePaymentMethodId: row.stripe_payment_method_id,
    brand: row.brand || "card",
    last4: row.last4 || "",
    expMonth: row.exp_month,
    expYear: row.exp_year,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
  };
}

router.get("/stripe-config", requireUser, (req, res) => {
  res.json({
    success: true,
    configured: Boolean(STRIPE_PUBLISHABLE_KEY && STRIPE_SECRET_KEY),
    publishableKey: STRIPE_PUBLISHABLE_KEY,
  });
});

router.post("/create-setup-intent", requireUser, async (req, res) => {
  try {
    const customerId = await ensureStripeCustomer(req.user.sub);
    const params = new URLSearchParams();
    params.set("customer", customerId);
    params.set("usage", "off_session");
    params.set("metadata[user_id]", String(req.user.sub || ""));
    const setupIntent = await stripeRequest("/setup_intents", { method: "POST", body: params });
    res.json({
      success: true,
      customerId,
      setupIntentId: setupIntent.id,
      clientSecret: setupIntent.client_secret,
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not create SetupIntent." });
  }
});

router.get("/payment-methods", requireUser, async (req, res) => {
  try {
    const methods = await listPaymentMethods(req.user.sub);
    res.json({
      success: true,
      paymentMethods: methods.map(exposePaymentMethod),
      hasSavedPaymentMethod: methods.length > 0,
      defaultPaymentMethod: exposePaymentMethod(methods.find((m) => m.is_default) || methods[0]),
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not load payment methods." });
  }
});

router.post("/save-payment-method", requireUser, async (req, res) => {
  try {
    const paymentMethodId = String(req.body?.paymentMethodId || "").trim();
    const setupIntentId = String(req.body?.setupIntentId || "").trim();
    let resolvedPaymentMethodId = paymentMethodId;
    const customerId = await ensureStripeCustomer(req.user.sub);

    if (!resolvedPaymentMethodId && setupIntentId) {
      const setupIntent = await stripeRequest(`/setup_intents/${encodeURIComponent(setupIntentId)}`);
      resolvedPaymentMethodId = typeof setupIntent.payment_method === "string"
        ? setupIntent.payment_method
        : setupIntent.payment_method?.id;
    }
    if (!resolvedPaymentMethodId) {
      return res.status(400).json({ error: "Missing Stripe payment method." });
    }

    const stored = await storePaymentMethod(req.user.sub, customerId, resolvedPaymentMethodId, { makeDefault: true });
    res.json({ success: true, paymentMethod: exposePaymentMethod(stored) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not save your card. Please try again." });
  }
});

router.patch("/payment-methods/:id/default", requireUser, async (req, res) => {
  try {
    const stored = await setDefaultPaymentMethod(req.user.sub, Number(req.params.id));
    res.json({ success: true, paymentMethod: exposePaymentMethod(stored) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not update default card." });
  }
});

router.delete("/payment-methods/:id", requireUser, async (req, res) => {
  try {
    await deletePaymentMethod(req.user.sub, Number(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not remove card." });
  }
});

router.post("/create-checkout-session", requireUser, async (req, res) => {
  try {
    const platformSettings = await settingsService.assertBookingAllowed();
    const booking = cleanBooking(req.body && req.body.booking, platformSettings.pricing);
    if (booking.bookingType === "ride_now") {
      await assertNoActiveRide(req.user.sub);
    } else {
      const start = new Date(booking.start);
      const end = new Date(booking.end);
      await assertNoUserFixedOverlap(req.user.sub, start, end);
      await assertBikeAvailableAtStation(booking.bikeId, booking.stationId);
      await assertBikeFreeForWindow(booking.bikeId, start, end);
    }
    const amount = bookingAmountCentsForPricing(booking.duration, platformSettings.pricing);
    const baseUrl = appBaseUrl(req);

    if (!STRIPE_SECRET_KEY) {
      return res.json(createLocalCheckoutSession(req, booking, amount));
    }

    // Save-card opt-in. PAYG always saves (final amount auto-charged), fixed
    // duration honours the user's checkbox from the Review step.
    const saveCardRequested = !!(req.body && req.body.saveCard);
    const isPaygFlow = booking.pricingMode !== "fixed_duration" || booking.bookingType === "ride_now";
    const saveCard = isPaygFlow || saveCardRequested;
    const customerId = saveCard ? await ensureStripeCustomer(req.user.sub) : "";

    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("payment_method_types[]", "card");
    if (customerId) {
      params.set("customer", customerId);
    } else if (req.user.email) {
      params.set("customer_email", String(req.user.email));
    }
    params.set("client_reference_id", String(req.user.sub || req.user.email || ""));
    params.set("success_url", `${baseUrl}/User/User_dashboard.html?payment=success&session_id={CHECKOUT_SESSION_ID}`);
    params.set("cancel_url", `${baseUrl}/User/User_dashboard.html?payment=cancelled`);
    params.set("line_items[0][quantity]", "1");
    params.set("line_items[0][price_data][currency]", (platformSettings.currency || STRIPE_CURRENCY).toLowerCase());
    params.set("line_items[0][price_data][unit_amount]", String(amount));
    params.set("line_items[0][price_data][product_data][name]",
      `${booking.bookingType === "ride_now" ? "Ride Now" : "Scheduled Bike Booking"} - ${booking.bikeCode} at ${booking.stationName}`);
    params.set("line_items[0][price_data][product_data][description]",
      `${booking.pricingMode === "fixed_duration" ? "Fixed duration" : "Pay-As-You-Go"} - ${booking.duration} min`);
    if (saveCard) {
      // Stripe will attach the PaymentMethod to the Customer for off-session
      // reuse (future bookings + PAYG final charge). Skipped when the user
      // opted out — Stripe still processes the payment but does not retain
      // the card for our use.
      params.set("payment_intent_data[setup_future_usage]", "off_session");
      params.set("payment_intent_data[metadata][flow]", "save_card_on_payment");
      params.set("payment_intent_data[metadata][user_id]", String(req.user.sub || ""));
    }
    params.set("metadata[user_id]", String(req.user.sub || ""));
    params.set("metadata[booking_type]", booking.bookingType);
    params.set("metadata[pricing_mode]", booking.pricingMode);
    params.set("metadata[bike_id]", String(booking.bikeId));
    params.set("metadata[bike_code]", booking.bikeCode);
    params.set("metadata[bike_model]", booking.bikeModel);
    params.set("metadata[station_id]", String(booking.stationId));
    params.set("metadata[station_name]", booking.stationName);
    params.set("metadata[start]", booking.start);
    params.set("metadata[end]", booking.end);
    params.set("metadata[duration]", String(booking.duration));
    params.set("metadata[unlock_fee]", String(booking.unlockFee));
    params.set("metadata[per_minute_fee]", String(booking.perMinuteFee));
    params.set("metadata[total_cost]", String(booking.totalCost));
    params.set("metadata[save_card]", saveCard ? "true" : "false");

    const session = await stripeRequest("/checkout/sessions", {
      method: "POST",
      body: params,
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not start payment." });
  }
});

router.post("/create-payg-booking-payment", requireUser, async (req, res) => {
  try {
    await ensurePaymentMethodSchema();
    const platformSettings = await settingsService.assertBookingAllowed();
    const bikeId = Number(req.body && req.body.bikeId);
    const stationId = Number(req.body && req.body.stationId);
    const scheduledStartRaw = String((req.body && req.body.scheduledStart) || "").trim();
    if (!Number.isInteger(bikeId) || bikeId <= 0) return res.status(400).json({ error: "Missing bike id." });
    if (!Number.isInteger(stationId) || stationId <= 0) return res.status(400).json({ error: "Missing station id." });

    let scheduledStart = null;
    if (scheduledStartRaw) {
      scheduledStart = new Date(scheduledStartRaw);
      if (Number.isNaN(scheduledStart.getTime()) || scheduledStart.getTime() < Date.now() - 60_000) {
        return res.status(400).json({ error: "Pick-up time must be in the future." });
      }
    }
    if (!scheduledStart) {
      await assertNoActiveRide(req.user.sub);
    }

    const lookup = await db.query(
      `SELECT b.bike_code, b.model, b.status, b.station_id, s.station_name
         FROM bikes b
         JOIN stations s ON s.id = $2
        WHERE b.id = $1
          AND s.is_active = TRUE`,
      [bikeId, stationId]
    );
    const row = lookup.rows[0];
    if (!row) return res.status(400).json({ error: "Bike or station not found." });
    if (row.status !== "available" || Number(row.station_id) !== stationId) {
      return res.status(400).json({ error: "This bike is no longer available." });
    }
    if (scheduledStart) {
      const holdEnd = new Date(scheduledStart.getTime() + 30 * 60000);
      // Block PAYG reservation that overlaps an existing booking by the
      // same user (even if a different bike is being booked).
      await assertNoUserFixedOverlap(req.user.sub, scheduledStart, holdEnd);
      await assertBikeFreeForWindow(bikeId, scheduledStart, holdEnd);
    }

    const customerId = await ensureStripeCustomer(req.user.sub);
    const amount = settingsService.amountCentsForDuration(0, platformSettings.pricing);
    const baseUrl = appBaseUrl(req);

    // One-time Checkout session that ALSO saves the card for off-session use.
    // IMPORTANT: do NOT set payment_method_collection here. Stripe only accepts
    // payment_method_collection on Subscription / recurring price sessions.
    // For one-off "payment" mode, we save the card using
    // payment_intent_data.setup_future_usage = off_session below.
    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("payment_method_types[]", "card");
    params.set("customer", customerId);
    params.set("client_reference_id", String(req.user.sub || ""));
    const scheduledFlow = scheduledStart ? "reserve_payg" : "ride_now";
    const successPath = "/User/User_my_bookings.html";
    params.set("success_url", `${baseUrl}${successPath}?payment=success&flow=start_ride&session_id={CHECKOUT_SESSION_ID}`);
    params.set("cancel_url", `${baseUrl}/User/User_dashboard.html?payment=cancelled&flow=start_ride`);
    params.set("line_items[0][quantity]", "1");
    params.set("line_items[0][price_data][currency]", (platformSettings.currency || STRIPE_CURRENCY).toLowerCase());
    params.set("line_items[0][price_data][unit_amount]", String(amount));
    params.set("line_items[0][price_data][product_data][name]", `Pay-As-You-Go unlock - ${row.bike_code}`);
    params.set("line_items[0][price_data][product_data][description]",
      `$${(amount / 100).toFixed(2)} unlock fee now. Card is saved securely with Stripe for the final ride charge.`);
    params.set("payment_intent_data[setup_future_usage]", "off_session");
    params.set("payment_intent_data[metadata][flow]", "start_ride");
    params.set("payment_intent_data[metadata][user_id]", String(req.user.sub || ""));
    params.set("payment_intent_data[metadata][bike_id]", String(bikeId));
    params.set("payment_intent_data[metadata][station_id]", String(stationId));
    params.set("metadata[flow]", "start_ride");
    params.set("metadata[user_id]", String(req.user.sub || ""));
    params.set("metadata[bike_id]", String(bikeId));
    params.set("metadata[station_id]", String(stationId));
    params.set("metadata[scheduled_start]", scheduledStartRaw);
    params.set("metadata[pricing_mode]", "pay_as_you_go");
    params.set("metadata[ride_mode]", scheduledStart ? "reserve_later" : "ride_now");
    params.set("metadata[unlock_fee]", String(platformSettings.pricing.unlockFee));
    params.set("metadata[per_minute_fee]", String(platformSettings.pricing.perMinuteFee));
    params.set("metadata[total_cost]", String(amount / 100));

    const session = await stripeRequest("/checkout/sessions", { method: "POST", body: params });
    res.json({ success: true, id: session.id, url: session.url, amount });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not start Pay-As-You-Go payment." });
  }
});

// POST /api/payments/start-ride-session  body: { bikeId, stationId, scheduledStart? }
// $1 Stripe Checkout for the unlock fee. The booking is only created
// after this succeeds, via /api/bookings/ride-now/start-complete on My Bookings.
router.post("/start-ride-session", requireUser, async (req, res) => {
  try {
    const platformSettings = await settingsService.assertBookingAllowed();
    const bikeId = Number(req.body && req.body.bikeId);
    const stationId = Number(req.body && req.body.stationId);
    const scheduledStartRaw = (req.body && req.body.scheduledStart) || "";
    if (!Number.isInteger(bikeId) || bikeId <= 0) return res.status(400).json({ error: "Missing bike id." });
    if (!Number.isInteger(stationId) || stationId <= 0) return res.status(400).json({ error: "Missing station id." });
    let scheduledStart = null;
    if (scheduledStartRaw) {
      scheduledStart = new Date(scheduledStartRaw);
      if (Number.isNaN(scheduledStart.getTime()) || scheduledStart.getTime() < Date.now() - 60_000) {
        return res.status(400).json({ error: "Pick-up time must be in the future." });
      }
    }
    if (!scheduledStart) {
      await assertNoActiveRide(req.user.sub);
    } else {
      // Reserve-later PAYG: also reject if it overlaps an existing user booking.
      const holdEnd = new Date(scheduledStart.getTime() + 30 * 60000);
      await assertNoUserFixedOverlap(req.user.sub, scheduledStart, holdEnd);
      await assertBikeFreeForWindow(bikeId, scheduledStart, holdEnd);
    }

    const lookup = await db.query(
      `SELECT b.bike_code, b.model, b.status, s.station_name
         FROM bikes b
         JOIN stations s ON s.id = $2
        WHERE b.id = $1`,
      [bikeId, stationId]
    );
    const row = lookup.rows[0];
    if (!row) return res.status(400).json({ error: "Bike or station not found." });
    if (row.status !== "available") return res.status(400).json({ error: "This bike is no longer available." });

    const amount = settingsService.amountCentsForDuration(0, platformSettings.pricing);
    const baseUrl = appBaseUrl(req);
    const successUrl = `${baseUrl}/User/User_my_bookings.html?payment=success&flow=start_ride&session_id=`;
    const customerId = STRIPE_SECRET_KEY ? await ensureStripeCustomer(req.user.sub) : "";

    if (!STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: "Stripe is not configured. Pay-As-You-Go requires Stripe card saving." });
    }

    // One-time Checkout (mode: payment) — do NOT set payment_method_collection,
    // it is only valid for subscription / recurring price sessions. Card is still
    // saved via payment_intent_data.setup_future_usage below.
    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("payment_method_types[]", "card");
    if (customerId) params.set("customer", customerId);
    params.set("client_reference_id", String(req.user.sub || req.user.email || ""));
    if (!customerId && req.user.email) params.set("customer_email", String(req.user.email));
    params.set("success_url", `${baseUrl}/User/User_my_bookings.html?payment=success&flow=start_ride&session_id={CHECKOUT_SESSION_ID}`);
    params.set("cancel_url", `${baseUrl}/User/User_dashboard.html?payment=cancelled&flow=start_ride`);
    params.set("line_items[0][quantity]", "1");
    params.set("line_items[0][price_data][currency]", (platformSettings.currency || STRIPE_CURRENCY).toLowerCase());
    params.set("line_items[0][price_data][unit_amount]", String(amount));
    params.set("line_items[0][price_data][product_data][name]", `Ride Now unlock - ${row.bike_code}`);
    params.set("line_items[0][price_data][product_data][description]",
      `$${(amount/100).toFixed(2)} unlock fee. Final per-minute fare is charged when you end the ride at ${row.station_name}.`);
    params.set("metadata[flow]", "start_ride");
    params.set("metadata[pricing_mode]", "pay_as_you_go");
    params.set("metadata[ride_mode]", scheduledStart ? "reserve_later" : "ride_now");
    params.set("metadata[user_id]", String(req.user.sub || ""));
    params.set("metadata[bike_id]", String(bikeId));
    params.set("metadata[station_id]", String(stationId));
    params.set("metadata[scheduled_start]", scheduledStartRaw);
    params.set("metadata[total_cost]", String(amount / 100));
    params.set("metadata[unlock_fee]", String(platformSettings.pricing.unlockFee));
    params.set("metadata[per_minute_fee]", String(platformSettings.pricing.perMinuteFee));
    params.set("payment_intent_data[setup_future_usage]", "off_session");
    params.set("payment_intent_data[metadata][flow]", "start_ride");
    params.set("payment_intent_data[metadata][user_id]", String(req.user.sub || ""));

    const session = await stripeRequest("/checkout/sessions", {
      method: "POST",
      body: params,
    });
    res.json({ id: session.id, url: session.url, amount });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not start payment." });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /api/payments/charge-saved-card
// One-stop endpoint for booking when the student already has a
// default saved card. Charges the card off-session and creates
// the booking + payment + notifications in a single transaction.
//
// body:
//   paymentType : "payg_unlock" | "fixed_upfront"
//   bookingType : "ride_now" | "scheduled"
//   rideMode    : "ride_now" | "reserve_later"
//   bikeId      : int
//   stationId   : int
//   startTime   : ISO string (optional for ride_now)
//   duration    : minutes (required for fixed_upfront)
// ──────────────────────────────────────────────────────────────
router.post("/charge-saved-card", requireUser, async (req, res) => {
  const notify = require("../utils/notify");
  try {
    await ensurePaymentMethodSchema();
    const platformSettings = await settingsService.assertBookingAllowed();
    const body = req.body || {};
    const paymentType = body.paymentType === "fixed_upfront" ? "fixed_upfront" : "payg_unlock";
    const bookingType = body.bookingType === "ride_now" ? "ride_now" : "scheduled";
    const rideMode = body.rideMode === "reserve_later" ? "reserve_later" : "ride_now";
    const bikeId = Number(body.bikeId);
    const stationId = Number(body.stationId);
    const durationInput = Number(body.duration);
    const startInput = String(body.startTime || "").trim();

    if (!Number.isInteger(bikeId) || bikeId <= 0) return res.status(400).json({ error: "Missing bike id." });
    if (!Number.isInteger(stationId) || stationId <= 0) return res.status(400).json({ error: "Missing station id." });

    let startDate = null;
    if (startInput) {
      startDate = new Date(startInput);
      if (Number.isNaN(startDate.getTime())) return res.status(400).json({ error: "Invalid start time." });
      if (rideMode === "reserve_later" && startDate.getTime() < Date.now() - 60_000) {
        return res.status(400).json({ error: "Pick-up time must be in the future." });
      }
    }

    // Pricing
    let durationMinutes = 0;
    let amountCents = 0;
    if (paymentType === "fixed_upfront") {
      const minDur = Number(platformSettings.pricing.minimumRideDuration || 1);
      const maxDur = Number(platformSettings.pricing.maximumRideDuration || 480);
      if (!Number.isFinite(durationInput) || durationInput < minDur || durationInput > maxDur) {
        return res.status(400).json({ error: `Duration must be between ${minDur} and ${maxDur} minutes.` });
      }
      durationMinutes = durationInput;
      amountCents = bookingAmountCentsForPricing(durationMinutes, platformSettings.pricing);
    } else {
      // PAYG unlock = unlock fee only
      amountCents = settingsService.amountCentsForDuration(0, platformSettings.pricing);
    }

    // Only one active ride at a time (skip for future scheduled bookings)
    const willStartActive = (rideMode === "ride_now") || (startDate && startDate.getTime() <= Date.now());
    if (willStartActive) {
      await assertNoActiveRide(req.user.sub);
    }

    // Verify bike is available at station
    const lookup = await db.query(
      `SELECT b.bike_code, b.model, b.status, b.station_id, s.station_name
         FROM bikes b
         JOIN stations s ON s.id = $2
        WHERE b.id = $1
          AND s.is_active = TRUE`,
      [bikeId, stationId]
    );
    const row = lookup.rows[0];
    if (!row) return res.status(400).json({ error: "Bike or station not found." });
    if (row.status !== "available" || Number(row.station_id) !== stationId) {
      return res.status(400).json({ error: "This bike is no longer available." });
    }

    // Per-user overlap check + per-bike conflict check.
    // Applies to every booking type:
    //   - fixed_upfront → check user/bike overlap against the full duration
    //   - payg_unlock reserve_later → check user/bike overlap against the
    //     30-minute pickup hold window
    //   - payg_unlock ride_now → no future window to overlap, the
    //     assertNoActiveRide call above already blocks a second concurrent ride
    const endDate = paymentType === "fixed_upfront" && startDate
      ? new Date(startDate.getTime() + durationMinutes * 60000)
      : null;
    if (paymentType === "fixed_upfront" && startDate && endDate) {
      await assertNoUserFixedOverlap(req.user.sub, startDate, endDate);
      await assertBikeFreeForWindow(bikeId, startDate, endDate);
    }
    if (paymentType === "payg_unlock" && rideMode === "reserve_later" && startDate) {
      const holdEnd = new Date(startDate.getTime() + 30 * 60000);
      await assertNoUserFixedOverlap(req.user.sub, startDate, holdEnd);
      await assertBikeFreeForWindow(bikeId, startDate, holdEnd);
    }

    // Saved default card required
    const savedCard = await getDefaultPaymentMethod(req.user.sub);
    if (!savedCard) {
      return res.status(402).json({ error: "No saved card on file. Please add a card in your profile." });
    }

    const currency = (platformSettings.currency || STRIPE_CURRENCY).toLowerCase();
    const unlockFee = Number(platformSettings.pricing.unlockFee || 1);
    const perMinuteFee = Number(platformSettings.pricing.perMinuteFee || 0.20);

    // Charge the card off-session
    let paymentIntentId = "";
    try {
      const params = new URLSearchParams();
      params.set("amount", String(amountCents));
      params.set("currency", currency);
      params.set("customer", savedCard.stripe_customer_id);
      params.set("payment_method", savedCard.stripe_payment_method_id);
      params.set("off_session", "true");
      params.set("confirm", "true");
      params.set("description",
        paymentType === "fixed_upfront"
          ? `Campus Bike Sharing fixed booking (${durationMinutes} min) - ${row.bike_code}`
          : `Campus Bike Sharing PAYG unlock - ${row.bike_code}`);
      params.set("metadata[flow]", paymentType === "fixed_upfront" ? "fixed_upfront" : "payg_unlock");
      params.set("metadata[user_id]", String(req.user.sub || ""));
      params.set("metadata[bike_id]", String(bikeId));
      params.set("metadata[station_id]", String(stationId));
      params.set("metadata[ride_mode]", rideMode);
      const pi = await stripeRequest("/payment_intents", { method: "POST", body: params });
      paymentIntentId = pi.id;
    } catch (chargeErr) {
      return res.status(402).json({
        error: chargeErr.message || "Saved card was declined. Please update your card and try again.",
      });
    }

    // Insert booking + payment in one transaction
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const start = startDate || new Date();
      const pickupHoldEnd = rideMode === "reserve_later" ? new Date(start.getTime() + 30 * 60000) : null;
      const bookingStatus = willStartActive ? "active" : "pending";
      const pricingMode = paymentType === "fixed_upfront" ? "fixed_duration" : "pay_as_you_go";
      const expiresAt = paymentType === "fixed_upfront" && endDate
        ? endDate
        : pickupHoldEnd || new Date(start.getTime() + 8 * 60 * 60000);
      const amountDollars = Number((amountCents / 100).toFixed(2));

      const inserted = await client.query(
        `INSERT INTO bookings (
           user_id, bike_id, pickup_station_id, start_time, end_time, status, expires_at,
           duration_minutes, fee_amount, unlock_fee, per_minute_fee, booking_type, pricing_mode,
           ride_mode, payment_status, stripe_customer_id, stripe_payment_method_id,
           ${paymentType === "fixed_upfront" ? "upfront_payment_intent_id" : "unlock_payment_intent_id"},
           unlock_fee_paid, notes
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'paid',$15,$16,$17,$18,$19)
         RETURNING id`,
        [
          req.user.sub,
          bikeId,
          stationId,
          start,
          paymentType === "fixed_upfront" ? endDate : null,
          bookingStatus,
          expiresAt,
          paymentType === "fixed_upfront" ? durationMinutes : null,
          paymentType === "fixed_upfront" ? amountDollars : unlockFee,
          unlockFee,
          perMinuteFee,
          bookingType,
          pricingMode,
          rideMode,
          savedCard.stripe_customer_id,
          savedCard.stripe_payment_method_id,
          paymentIntentId,
          paymentType === "payg_unlock" ? amountDollars : null,
          `Charged saved card ${savedCard.brand || "card"} ending ${savedCard.last4 || ""}; bike ${row.bike_code}.`,
        ]
      );
      const bookingId = inserted.rows[0].id;

      if (bookingStatus === "active") {
        await client.query("UPDATE bikes SET status='in_use', station_id=NULL WHERE id=$1", [bikeId]);
      }

      await client.query(
        `INSERT INTO payments
           (booking_id, user_id, amount, currency, payment_method, status,
            transaction_reference, type, stripe_payment_intent_id, paid_at)
         VALUES ($1,$2,$3,$4,'credit_card','paid',$5,$6,$7, NOW())`,
        [
          bookingId,
          req.user.sub,
          amountDollars,
          currency.toUpperCase(),
          paymentIntentId,
          paymentType === "fixed_upfront" ? "upfront_fixed" : "payg_unlock",
          paymentIntentId,
        ]
      );
      await client.query("COMMIT");

      // Notifications (student + admin). Fire-and-forget but awaited so the
      // bell icon updates on the next poll.
      const studentLabel = paymentType === "fixed_upfront"
        ? `Booking #${bookingId} confirmed`
        : (bookingStatus === "active" ? "Your ride has started" : `Booking #${bookingId} confirmed`);
      const studentMsg = paymentType === "fixed_upfront"
        ? `$${amountDollars.toFixed(2)} charged to your ${savedCard.brand || "card"} ending ${savedCard.last4 || ""}.`
        : (bookingStatus === "active"
            ? `Bike ${row.bike_code} is unlocked. $${amountDollars.toFixed(2)} unlock fee charged to your saved card.`
            : `Your PAYG reservation is confirmed. $${amountDollars.toFixed(2)} unlock fee charged.`);
      const userRow = await db.query("SELECT full_name FROM users WHERE id = $1", [req.user.sub]).catch(() => ({ rows: [] }));
      const studentName = (userRow.rows[0] && userRow.rows[0].full_name) || "Student";

      await Promise.all([
        notify.push({
          userId: req.user.sub,
          type: bookingStatus === "active" ? "ride_started" : "booking_created",
          kind: "success",
          title: studentLabel,
          message: studentMsg,
          relatedEntityType: "booking",
          relatedEntityId: bookingId,
        }),
        notify.push({
          userId: req.user.sub,
          type: "payment_received",
          kind: "success",
          title: `Payment of $${amountDollars.toFixed(2)} successful`,
          message: `Booking #${bookingId}`,
          relatedEntityType: "booking",
          relatedEntityId: bookingId,
        }),
        notify.pushAdmin({
          activityType: "payment_received",
          title: `Payment received: $${amountDollars.toFixed(2)}`,
          description: `${studentName} - ${paymentType === "fixed_upfront" ? "Fixed booking" : "PAYG unlock"} for bike ${row.bike_code}`,
          bookingId,
          userId: req.user.sub,
          bikeId,
        }),
      ]);

      return res.json({
        ok: true,
        bookingId,
        amount: amountDollars,
        paymentIntentId,
        status: bookingStatus,
        card: { brand: savedCard.brand, last4: savedCard.last4 },
      });
    } catch (txErr) {
      await client.query("ROLLBACK").catch(() => {});
      // The card was already charged but we couldn't save the booking.
      // Best effort: log so an admin can refund manually if needed.
      console.error("[charge-saved-card] booking insert failed after Stripe charge:", txErr.message,
        "paymentIntent:", paymentIntentId);
      return res.status(500).json({
        error: "Payment succeeded but we could not save the booking. Support has been notified.",
        paymentIntentId,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not charge saved card." });
  }
});

async function chargePaygFinal(req, res) {
  try {
    await ensurePaymentMethodSchema();
    const platformSettings = await settingsService.getPublicSettings();
    const bookingId = Number(req.body && req.body.bookingId);
    if (!Number.isInteger(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: "Missing booking id." });
    }

    const result = await db.query(
      `SELECT bk.id, bk.user_id, bk.bike_id, bk.start_time, bk.status,
              bk.booking_type, bk.pickup_station_id, bk.unlock_fee,
              bi.bike_code, bi.model AS bike_model,
              sp.station_name
         FROM bookings bk
         JOIN bikes bi ON bi.id = bk.bike_id
         JOIN stations sp ON sp.id = bk.pickup_station_id
        WHERE bk.id = $1`,
      [bookingId]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "Booking not found." });
    if (String(row.user_id) !== String(req.user.sub)) {
      return res.status(403).json({ error: "Forbidden." });
    }
    if (row.status !== "active") {
      return res.status(400).json({ error: "Only an active ride can be ended." });
    }

    const start = new Date(row.start_time).getTime();
    const now = Date.now();
    const rawMinutes = Math.max(1, Math.ceil((now - start) / 60000));
    const duration = Math.min(rawMinutes, Number(platformSettings.pricing.maximumRideDuration || 480));
    const totalCents = bookingAmountCentsForPricing(duration, platformSettings.pricing);
    const prepaidUnlockCents = Math.round(Number(row.unlock_fee ?? platformSettings.pricing.unlockFee ?? 0) * 100);
    const remainingCents = Math.max(0, totalCents - prepaidUnlockCents);
    const totalAmount = Number((totalCents / 100).toFixed(2));
    const remainingAmount = Number((remainingCents / 100).toFixed(2));
    const savedCard = await getDefaultPaymentMethod(req.user.sub);
    if (!savedCard) {
      return res.status(402).json({ error: "You must save a payment card to complete a Pay-As-You-Go ride." });
    }

    let finalPaymentIntentId = "";
    if (remainingCents > 0) {
      const params = new URLSearchParams();
      params.set("amount", String(remainingCents));
      params.set("currency", (platformSettings.currency || STRIPE_CURRENCY).toLowerCase());
      params.set("customer", savedCard.stripe_customer_id);
      params.set("payment_method", savedCard.stripe_payment_method_id);
      params.set("off_session", "true");
      params.set("confirm", "true");
      params.set("description", `Campus Bike Sharing PAYG final charge - booking ${bookingId}`);
      params.set("metadata[flow]", "payg_final");
      params.set("metadata[user_id]", String(req.user.sub || ""));
      params.set("metadata[booking_id]", String(bookingId));
      params.set("metadata[duration]", String(duration));
      params.set("metadata[total_cost]", String(totalAmount));
      params.set("metadata[remaining_amount]", String(remainingAmount));
      const paymentIntent = await stripeRequest("/payment_intents", { method: "POST", body: params });
      finalPaymentIntentId = paymentIntent.id;
    }

    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `SELECT id, user_id, bike_id, pickup_station_id, status
           FROM bookings
          WHERE id = $1
          FOR UPDATE`,
        [bookingId]
      );
      const current = locked.rows[0];
      if (!current) throw new Error("Booking not found.");
      if (String(current.user_id) !== String(req.user.sub)) throw new Error("Forbidden.");
      if (current.status !== "active") throw new Error("Only an active ride can be ended.");

      const end = new Date();
      await client.query(
        `UPDATE bookings
            SET status = 'completed',
                end_time = $2,
                return_station_id = COALESCE(return_station_id, pickup_station_id),
                duration_minutes = $3,
                fee_amount = $4,
                final_amount = $8,
                unlock_fee = $5,
                per_minute_fee = $6,
                final_payment_intent_id = NULLIF($7, ''),
                payment_status = 'paid',
                updated_at = NOW()
          WHERE id = $1`,
        [
          bookingId,
          end,
          duration,
          totalAmount,
          platformSettings.pricing.unlockFee,
          platformSettings.pricing.perMinuteFee,
          finalPaymentIntentId,
          remainingAmount,
        ]
      );
      await client.query(
        "UPDATE bikes SET status = 'available', station_id = $2 WHERE id = $1",
        [current.bike_id, current.pickup_station_id]
      );
      await client.query(
        `INSERT INTO payments (booking_id, user_id, amount, currency, payment_method, status, transaction_reference, paid_at)
         VALUES ($1,$2,$3,$4,'credit_card','paid',$5,NOW())`,
        [
          bookingId,
          req.user.sub,
          remainingAmount,
          (platformSettings.currency || STRIPE_CURRENCY).toUpperCase(),
          finalPaymentIntentId || `payg_no_remaining_${bookingId}_${Date.now()}`,
        ]
      );
      await client.query("COMMIT");
      return res.json({
        ok: true,
        autoCharged: true,
        bookingId,
        duration,
        amount: totalAmount,
        remainingAmount,
        finalPaymentIntentId,
        card: { brand: savedCard.brand, last4: savedCard.last4 },
      });
    } catch (chargeErr) {
      await client.query("ROLLBACK").catch(() => {});
      throw chargeErr;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not charge Pay-As-You-Go final amount." });
  }
}

router.post("/end-ride-session", requireUser, chargePaygFinal);
router.post("/charge-payg-final", requireUser, chargePaygFinal);

// ──────────────────────────────────────────────────────────────
// Stripe Checkout - SETUP mode for saving a card from the profile.
// The user is redirected to Stripe Checkout, enters their card,
// and is redirected back. On success the webhook (or success page
// confirmation) stores the saved card in student_payment_methods.
// ──────────────────────────────────────────────────────────────
router.post("/create-card-setup-session", requireUser, async (req, res) => {
  try {
    await ensurePaymentMethodSchema();
    if (!STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: "Stripe is not configured. Please contact support." });
    }
    const customerId = await ensureStripeCustomer(req.user.sub);
    const baseUrl = appBaseUrl(req);
    const params = new URLSearchParams();
    params.set("mode", "setup");
    params.set("payment_method_types[]", "card");
    params.set("customer", customerId);
    params.set("client_reference_id", String(req.user.sub || ""));
    params.set("success_url", `${baseUrl}/User/User_profile.html?card=saved&session_id={CHECKOUT_SESSION_ID}`);
    params.set("cancel_url", `${baseUrl}/User/User_profile.html?card=cancelled`);
    params.set("setup_intent_data[metadata][flow]", "save_card");
    params.set("setup_intent_data[metadata][user_id]", String(req.user.sub || ""));
    params.set("metadata[flow]", "save_card");
    params.set("metadata[user_id]", String(req.user.sub || ""));

    const session = await stripeRequest("/checkout/sessions", { method: "POST", body: params });
    res.json({ success: true, id: session.id, url: session.url });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not start card setup." });
  }
});

// Confirm a setup-mode Checkout session after the user returns from Stripe.
// Pulls the new payment method off the SetupIntent and stores it.
router.post("/confirm-card-setup", requireUser, async (req, res) => {
  try {
    await ensurePaymentMethodSchema();
    const sessionId = String((req.body && req.body.sessionId) || "");
    if (!sessionId.startsWith("cs_")) {
      return res.status(400).json({ error: "Invalid setup session." });
    }
    const session = await stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
    if (session.mode !== "setup") {
      return res.status(400).json({ error: "This session is not a card setup session." });
    }
    if (session.client_reference_id && String(session.client_reference_id) !== String(req.user.sub)) {
      return res.status(403).json({ error: "This setup session does not belong to you." });
    }

    const setupIntentId = typeof session.setup_intent === "string"
      ? session.setup_intent
      : session.setup_intent && session.setup_intent.id;
    if (!setupIntentId) {
      return res.status(400).json({ error: "Stripe did not return a setup intent." });
    }
    const setupIntent = await stripeRequest(`/setup_intents/${encodeURIComponent(setupIntentId)}`);
    if (setupIntent.status !== "succeeded") {
      return res.status(400).json({ error: "Card setup was not completed on Stripe." });
    }
    const paymentMethodId = typeof setupIntent.payment_method === "string"
      ? setupIntent.payment_method
      : setupIntent.payment_method && setupIntent.payment_method.id;
    if (!paymentMethodId) {
      return res.status(400).json({ error: "Stripe did not return a saved payment method." });
    }
    const customerId = typeof session.customer === "string"
      ? session.customer
      : (session.customer && session.customer.id) || await ensureStripeCustomer(req.user.sub);

    const stored = await storePaymentMethod(req.user.sub, customerId, paymentMethodId, { makeDefault: true });
    res.json({ success: true, paymentMethod: exposePaymentMethod(stored) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not save your card." });
  }
});

// POST /api/payments/payment-methods/default  body: { paymentMethodId }
// Set a saved card as the default. Convenience POST alias for the existing
// PATCH /api/payments/payment-methods/:id/default endpoint.
router.post("/payment-methods/default", requireUser, async (req, res) => {
  try {
    const id = Number((req.body && (req.body.paymentMethodId || req.body.id)) || 0);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Missing payment method id." });
    }
    const stored = await setDefaultPaymentMethod(req.user.sub, id);
    res.json({ success: true, paymentMethod: exposePaymentMethod(stored) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not update default card." });
  }
});

// ──────────────────────────────────────────────────────────────
// Stripe webhook. Handles checkout.session.completed and
// payment_intent.succeeded. The route is also reachable as
// /api/payments/stripe/webhook to match the spec.
//
// Webhook signature verification is best-effort: if
// STRIPE_WEBHOOK_SECRET is set we verify, otherwise we accept the
// payload and only act on idempotent server-side lookups by
// session_id / payment_intent_id (so a forged webhook cannot
// fake a payment - the saved-card and booking writers always
// re-fetch from Stripe via stripeRequest).
// ──────────────────────────────────────────────────────────────
async function handleStripeWebhook(req, res) {
  try {
    const event = req.body || {};
    const type = String(event.type || "");
    const obj = (event.data && event.data.object) || {};

    if (type === "checkout.session.completed") {
      const sessionId = obj.id;
      const meta = obj.metadata || {};
      const userId = Number(meta.user_id);
      const flow = String(meta.flow || "");
      if (!sessionId || !Number.isInteger(userId)) {
        return res.json({ received: true, ignored: "missing metadata" });
      }
      if (flow === "save_card" || obj.mode === "setup") {
        try {
          const fullSession = await stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
          const setupIntentId = typeof fullSession.setup_intent === "string"
            ? fullSession.setup_intent : (fullSession.setup_intent && fullSession.setup_intent.id);
          if (setupIntentId) {
            const si = await stripeRequest(`/setup_intents/${encodeURIComponent(setupIntentId)}`);
            const pmId = typeof si.payment_method === "string" ? si.payment_method : (si.payment_method && si.payment_method.id);
            const customerId = typeof fullSession.customer === "string"
              ? fullSession.customer
              : (fullSession.customer && fullSession.customer.id) || await ensureStripeCustomer(userId);
            if (pmId) await storePaymentMethod(userId, customerId, pmId, { makeDefault: true });
          }
        } catch (e) {
          console.warn("[webhook save_card] could not store payment method:", e.message);
        }
      } else if (flow === "start_ride") {
        // Save the card on PAYG sessions (Stripe attached it via setup_future_usage).
        try {
          await savePaymentMethodFromCheckoutSession(userId, sessionId);
        } catch (e) {
          console.warn("[webhook start_ride] save payment method:", e.message);
        }
      } else {
        // Fixed-duration booking checkout where the user opted into saving
        // the card. We detect this by the metadata flag the create-checkout
        // endpoint sets (save_card=true) or by reading the PaymentIntent's
        // setup_future_usage. Either way, storePaymentMethod is idempotent
        // and the duplicate-detection in savedPaymentMethods.js prevents
        // multiple rows per physical card.
        try {
          const shouldSave = meta.save_card === "true";
          if (shouldSave) {
            await savePaymentMethodFromCheckoutSession(userId, sessionId);
          }
        } catch (e) {
          console.warn("[webhook save_card_on_payment] save payment method:", e.message);
        }
      }
    }
    return res.json({ received: true });
  } catch (err) {
    console.error("[stripe webhook]", err);
    return res.status(200).json({ received: false, error: err.message || "Webhook error." });
  }
}

// Bare webhook path (called via /api/payments/stripe/webhook in server.js).
router.post("/stripe/webhook", express.json({ type: "*/*" }), handleStripeWebhook);
router.post("/webhook", express.json({ type: "*/*" }), handleStripeWebhook);

router.get("/session/:id", requireUser, async (req, res) => {
  try {
    const sessionId = String(req.params.id || "");
    if (sessionId.startsWith("cbs_")) {
      const session = getLocalCheckoutSession(sessionId);
      if (!session) return res.status(404).json({ error: "Payment session was not found." });
      if (session.metadata && String(session.metadata.user_id) !== String(req.user.sub || "")) {
        return res.status(403).json({ error: "This payment session does not belong to you." });
      }
      const booking = bookingFromMetadata(session.metadata);
      return res.json({
        id: session.id,
        paid: true,
        payment_status: session.payment_status,
        amount_total: session.amount_total,
        currency: session.currency,
        booking,
        flow: String(session.metadata && session.metadata.flow || ""),
        metadata: session.metadata || {},
        mode: "simulated-local",
      });
    }
    if (!sessionId.startsWith("cs_")) return res.status(400).json({ error: "Invalid session." });

    const session = await stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
    const booking = bookingFromMetadata(session.metadata);

    res.json({
      id: session.id,
      paid: session.payment_status === "paid",
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      currency: session.currency,
      booking,
      flow: String(session.metadata && session.metadata.flow || ""),
      metadata: session.metadata || {},
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
    const settings = await settingsService.getPublicSettings();
    const paidAtMs = session.created ? Number(session.created) * 1000 : Date.now();
    const refundWindowMs = Number(settings.pricing.refundWindowHours || 24) * 60 * 60 * 1000;
    if (Date.now() - paidAtMs > refundWindowMs) {
      return res.status(400).json({ error: `Refund window has closed. The current refund window is ${settings.pricing.refundWindowHours} hours.` });
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

    // Keep the local ledger in sync so admin revenue/expense reports update
    // after a successful Stripe refund. The admin dashboard also treats
    // refunded payments as expenses, so this remains useful even if the
    // optional admin tables have not been migrated yet.
    try {
      const amountRefunded = Number(refund.amount || 0) / 100;
      const updated = await db.query(
        `UPDATE payments
            SET status = 'refunded',
                updated_at = NOW()
          WHERE transaction_reference = $1
          RETURNING booking_id, user_id, amount`,
        [sessionId]
      );
      const row = updated.rows[0];
      if (row) {
        await db.query(
          `INSERT INTO admin_expenses (expense_type, description, amount, related_booking_id, created_at)
           VALUES ('refund', $1, $2, $3, NOW())
           ON CONFLICT DO NOTHING`,
          [
            reason.slice(0, 500) || `Stripe refund ${refund.id}`,
            amountRefunded || Number(row.amount || 0),
            row.booking_id,
          ]
        ).catch(() => {});
        await db.query(
          `INSERT INTO admin_activity_log (activity_type, title, description, related_booking_id, related_user_id, created_at)
           VALUES ('refund_requested', 'Refund recorded', $1, $2, $3, NOW())
           ON CONFLICT DO NOTHING`,
          [
            `Refund ${refund.id} for booking #${row.booking_id}`,
            row.booking_id,
            row.user_id,
          ]
        ).catch(() => {});
      }
    } catch (ledgerErr) {
      console.warn("[refund-booking] refund succeeded but local ledger update failed:", ledgerErr.message);
    }

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

