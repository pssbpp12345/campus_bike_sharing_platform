const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const notify = require("../utils/notify");
const { ensureStudentSchema } = require("../utils/studentSchema");
const { getLocalCheckoutSession } = require("../utils/localCheckoutSessions");
const settingsService = require("../services/settingsService");
const {
  ensurePaymentMethodSchema,
  requireSavedPaymentMethod,
  savePaymentMethodFromCheckoutSession,
} = require("../utils/savedPaymentMethods");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-me-to-a-long-random-string";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const UNLOCK_FEE_CENTS = Number(process.env.BOOKING_UNLOCK_FEE_CENTS) || 100;
const PER_MINUTE_CENTS = Number(process.env.BOOKING_PER_MINUTE_CENTS) || 20;
const ALLOWED_DURATIONS = new Set([15, 30, 60, 120, 240, 480]);
const PAYG_RESERVATION_HOLD_MINUTES = Number(process.env.PAYG_RESERVATION_HOLD_MINUTES) || 30;

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

function canAccess(req, userId) {
  return String(req.user.sub) === String(userId) || req.user.role === "admin";
}

function bookingAmount(duration) {
  return (UNLOCK_FEE_CENTS + Number(duration) * PER_MINUTE_CENTS) / 100;
}

function fallbackPricing() {
  return {
    unlockFee: UNLOCK_FEE_CENTS / 100,
    perMinuteFee: PER_MINUTE_CENTS / 100,
    minimumRideDuration: 5,
    maximumRideDuration: 180,
  };
}

// Active ride = literal DB status = 'active' AND end_time is still in the
// future (or unset). Scheduled bookings — even ones past their start_time —
// stay 'pending' / 'ready_to_start' until the student hits Start Ride, so
// they don't count. Everything else (cancelled, completed, expired,
// no_show, pending_payment) is also explicitly excluded.
async function assertNoActiveRide(clientOrDb, userId) {
  const existing = await clientOrDb.query(
    `SELECT id, bike_id, status, start_time, end_time
       FROM bookings
      WHERE user_id = $1
        AND status = 'active'
        AND (end_time IS NULL OR end_time > NOW())
      LIMIT 1`,
    [userId]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
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

async function assertBikeFreeForWindow(clientOrDb, bikeId, start, end) {
  const overlap = await clientOrDb.query(
    `SELECT id
       FROM bookings
      WHERE bike_id = $1
        AND status::text IN ('pending','confirmed','active','scheduled','upcoming')
        AND start_time < $3
        AND COALESCE(end_time, expires_at) > $2
      LIMIT 1
      FOR UPDATE`,
    [bikeId, start, end]
  );
  if (overlap.rows[0]) {
    throw new Error("This bike is already booked during this time. Please choose another bike or time.");
  }
}

// See payments.js for the canonical version. This `FOR UPDATE` variant runs
// inside booking transactions to serialise concurrent overlap checks.
async function assertNoUserFixedOverlap(clientOrDb, userId, start, end) {
  const overlap = await clientOrDb.query(
    `SELECT id, start_time, COALESCE(end_time, expires_at) AS end_effective
       FROM bookings
      WHERE user_id = $1
        AND status::text IN ('pending','confirmed','active','scheduled','upcoming')
        AND start_time < $3
        AND COALESCE(end_time, expires_at) > $2
      LIMIT 1
      FOR UPDATE`,
    [userId, start, end]
  );
  if (overlap.rows[0]) {
    const err = new Error("You already have a booking during this time. Please cancel it or choose another time.");
    err.status = 409;
    throw err;
  }
}

function bookingAmountForPricing(duration, pricing) {
  return settingsService.amountForDuration(duration, pricing || fallbackPricing());
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

async function verifyPaidSession(sessionId, userId) {
  if (String(sessionId).startsWith("cbs_") && !STRIPE_SECRET_KEY) {
    const session = getLocalCheckoutSession(sessionId);
    if (!session) throw new Error("Payment session was not found.");
    if (String(session.metadata && session.metadata.user_id) !== String(userId)) {
      throw new Error("This payment session does not belong to the logged-in user.");
    }
    return session;
  }
  if (!String(sessionId).startsWith("cs_")) {
    throw new Error("Invalid payment session.");
  }
  if (!STRIPE_SECRET_KEY) {
    throw new Error("Payment verification is unavailable because Stripe is not configured.");
  }

  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  const session = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((session.error && session.error.message) || "Could not verify Stripe payment.");
  }
  if (session.payment_status !== "paid") {
    throw new Error("Stripe has not confirmed this payment.");
  }
  if (session.client_reference_id && String(session.client_reference_id) !== String(userId)) {
    throw new Error("This payment session does not belong to the logged-in user.");
  }
  return session;
}

const bookingSelect = `
  SELECT
    bk.id AS booking_id,
    bk.user_id,
    bk.bike_id,
    bi.bike_code,
    bi.model AS bike_type,
    bk.pickup_station_id,
    sp.station_name AS pickup_station,
    sp.latitude AS pickup_latitude,
    sp.longitude AS pickup_longitude,
    bk.return_station_id,
    sr.station_name AS return_station,
    bk.start_time,
    bk.end_time,
    bk.expires_at,
    bk.duration_minutes,
    bk.fee_amount,
    COALESCE(bk.booking_type, 'scheduled') AS booking_type,
    COALESCE(bk.pricing_mode, 'pay_as_you_go') AS pricing_mode,
    bk.status,
    bk.notes,
    bk.created_at,
    p.status AS payment_status,
    p.payment_method,
    p.transaction_reference,
    p.amount AS amount_paid,
    p.currency,
    p.paid_at
  FROM bookings bk
  JOIN bikes bi ON bi.id = bk.bike_id
  JOIN stations sp ON sp.id = bk.pickup_station_id
  LEFT JOIN stations sr ON sr.id = bk.return_station_id
  LEFT JOIN LATERAL (
    SELECT *
    FROM payments pay
    WHERE pay.booking_id = bk.id
    ORDER BY pay.created_at DESC
    LIMIT 1
  ) p ON TRUE
`;

router.get("/user/:id", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    if (!canAccess(req, req.params.id)) return res.status(403).json({ error: "Forbidden." });
    const result = await db.query(
      `${bookingSelect} WHERE bk.user_id = $1 ORDER BY bk.start_time DESC`,
      [req.params.id]
    );
    res.json({ bookings: result.rows });
  } catch (err) {
    console.error("[GET /api/bookings/user/:id]", err);
    res.status(500).json({ error: "Could not load bookings." });
  }
});

// GET/POST /api/bookings/check-overlap
//   body / query: { start: ISO, end?: ISO, durationMinutes?: number, bikeId?: number }
// Returns { ok, conflict, conflictingBookingId, message }. Used by the
// dashboard BookingModal before redirecting to Stripe or hitting
// charge-saved-card, so the student sees the conflict immediately.
async function checkOverlapHandler(req, res) {
  try {
    const src = (req.method === "GET" ? req.query : req.body) || {};
    const startRaw = String(src.start || src.startTime || "").trim();
    if (!startRaw) return res.status(400).json({ error: "Missing start time." });
    const start = new Date(startRaw);
    if (Number.isNaN(start.getTime())) return res.status(400).json({ error: "Invalid start time." });

    let end;
    if (src.end || src.endTime) {
      end = new Date(String(src.end || src.endTime));
      if (Number.isNaN(end.getTime())) return res.status(400).json({ error: "Invalid end time." });
    } else if (src.durationMinutes != null) {
      const dur = Number(src.durationMinutes);
      if (!Number.isFinite(dur) || dur <= 0) return res.status(400).json({ error: "Invalid duration." });
      end = new Date(start.getTime() + dur * 60000);
    } else {
      // PAYG reservation: use the 30-minute pickup hold window.
      end = new Date(start.getTime() + PAYG_RESERVATION_HOLD_MINUTES * 60000);
    }
    if (end <= start) return res.status(400).json({ error: "End must be after start." });

    // Per-user overlap check
    const overlap = await db.query(
      `SELECT id, start_time, COALESCE(end_time, expires_at) AS end_effective,
              COALESCE(booking_type, 'scheduled') AS booking_type,
              COALESCE(pricing_mode, 'fixed_duration') AS pricing_mode
         FROM bookings
        WHERE user_id = $1
          AND status::text IN ('pending','confirmed','active','scheduled','upcoming')
          AND start_time < $3
          AND COALESCE(end_time, expires_at) > $2
        LIMIT 1`,
      [req.user.sub, start, end]
    );
    if (overlap.rows[0]) {
      return res.json({
        ok: false,
        conflict: "user",
        conflictingBookingId: overlap.rows[0].id,
        conflictWindow: {
          start: overlap.rows[0].start_time,
          end: overlap.rows[0].end_effective,
        },
        message: "You already have a booking during this time. Please cancel it or choose another time.",
      });
    }

    // Optional same-bike conflict check (if a bike was selected)
    const bikeId = Number(src.bikeId);
    if (Number.isInteger(bikeId) && bikeId > 0) {
      const bikeOverlap = await db.query(
        `SELECT id
           FROM bookings
          WHERE bike_id = $1
            AND status::text IN ('pending','confirmed','active','scheduled','upcoming')
            AND start_time < $3
            AND COALESCE(end_time, expires_at) > $2
          LIMIT 1`,
        [bikeId, start, end]
      );
      if (bikeOverlap.rows[0]) {
        return res.json({
          ok: false,
          conflict: "bike",
          conflictingBookingId: bikeOverlap.rows[0].id,
          message: "This bike is already booked during this time. Please choose another bike or time.",
        });
      }
    }

    res.json({ ok: true, conflict: null });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not check booking overlap." });
  }
}
router.post("/check-overlap", requireUser, checkOverlapHandler);
router.get("/check-overlap", requireUser, checkOverlapHandler);

router.get("/active", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    const result = await db.query(
      `${bookingSelect} WHERE bk.user_id = $1 AND bk.status = 'active' ORDER BY bk.start_time DESC LIMIT 1`,
      [req.user.sub]
    );
    res.json({ booking: result.rows[0] || null });
  } catch (err) {
    console.error("[GET /api/bookings/active]", err);
    res.status(500).json({ error: "Could not load active booking." });
  }
});

router.get("/history", requireUser, async (req, res) => {
  try {
    await ensureStudentSchema();
    const status = String(req.query.status || "all");
    const sort = String(req.query.sort || "newest") === "oldest" ? "ASC" : "DESC";
    const q = String(req.query.q || "").trim();
    const params = [req.user.sub];
    let where = "WHERE bk.user_id = $1";
    if (status !== "all") {
      params.push(status);
      where += ` AND bk.status = $${params.length}`;
    }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where += ` AND (LOWER(bi.bike_code) LIKE $${params.length} OR LOWER(sp.station_name) LIKE $${params.length})`;
    }
    const result = await db.query(
      `${bookingSelect} ${where} ORDER BY bk.start_time ${sort}`,
      params
    );
    res.json({ bookings: result.rows });
  } catch (err) {
    console.error("[GET /api/bookings/history]", err);
    res.status(500).json({ error: "Could not load booking history." });
  }
});

async function handleCancel(req, res) {
  const bookingId = Number(req.body && req.body.bookingId);
  const reason = String((req.body && req.body.reason) || "").trim();
  if (!bookingId) return res.status(400).json({ error: "Missing booking ID." });
  if (reason.length < 12) return res.status(400).json({ error: "Please provide a valid cancellation reason." });

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT id, user_id, bike_id, pickup_station_id, status FROM bookings WHERE id = $1 FOR UPDATE",
      [bookingId]
    );
    const row = current.rows[0];
    if (!row) throw new Error("Booking not found.");
    if (!canAccess(req, row.user_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Forbidden." });
    }
    if (!["pending", "active"].includes(row.status)) throw new Error("Only pending or active bookings can be cancelled.");

    await client.query(
      `UPDATE bookings
          SET status = 'cancelled',
              notes = CONCAT(COALESCE(notes, ''), CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE E'\n' END, $2),
              updated_at = NOW()
        WHERE id = $1`,
      [bookingId, `Cancelled by student: ${reason}`]
    );
    await client.query(
      "UPDATE bikes SET status = 'available', station_id = $2 WHERE id = $1 AND status = 'in_use'",
      [row.bike_id, row.pickup_station_id]
    );
    await client.query("COMMIT");
    notify.push({ userId: row.user_id, type: "booking_cancelled", kind: "warning",
      title: `Booking #${bookingId} cancelled`, message: reason.slice(0, 200),
      relatedEntityType: "booking", relatedEntityId: bookingId });
    res.json({ ok: true, status: "cancelled" });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ error: err.message || "Could not cancel booking." });
  } finally {
    client.release();
  }
}
router.post("/cancel", requireUser, handleCancel);

// POST /api/bookings/ride-now/start  body: { bikeId, stationId, scheduledStart? }
// Creates a Pay-As-You-Go booking with a saved payment method. Ride Now starts
// immediately; scheduled PAYG reserves the bike for a short pickup hold window.
router.post("/ride-now/start", requireUser, async (req, res) => {
  return res.status(400).json({
    error: "Pay-As-You-Go rides must be started through the $1 Stripe unlock payment.",
    paymentEndpoint: "/api/payments/create-payg-booking-payment",
  });
  let platformSettings;
  const bikeId = Number(req.body && req.body.bikeId);
  const stationId = Number(req.body && req.body.stationId);
  const scheduledStartRaw = req.body && req.body.scheduledStart;
  let scheduledStart = null;
  if (scheduledStartRaw) {
    scheduledStart = new Date(scheduledStartRaw);
    if (Number.isNaN(scheduledStart.getTime()) || scheduledStart.getTime() < Date.now() - 60_000) {
      return res.status(400).json({ error: "Pick-up time must be in the future." });
    }
  }
  if (!Number.isInteger(bikeId) || bikeId <= 0) {
    return res.status(400).json({ error: "Missing bike id." });
  }
  if (!Number.isInteger(stationId) || stationId <= 0) {
    return res.status(400).json({ error: "Missing station id." });
  }

  const client = await db.pool.connect();
  try {
    platformSettings = await settingsService.assertBookingAllowed();
    await requireSavedPaymentMethod(req.user.sub);
    await ensureStudentSchema();
    await client.query("BEGIN");

    // Ride Now is limited to one active ride. Future reservations are allowed
    // even when the student already has an active ride.
    if (!scheduledStart) {
      await assertNoActiveRide(client, req.user.sub);
    }

    const station = await client.query(
      "SELECT id, station_name FROM stations WHERE id = $1 AND is_active = TRUE",
      [stationId]
    );
    if (!station.rows[0]) throw new Error("Pickup station was not found.");

    const bike = await client.query(
      `SELECT id, bike_code, model, station_id, status
         FROM bikes
        WHERE id = $1
        FOR UPDATE`,
      [bikeId]
    );
    const selectedBike = bike.rows[0];
    if (!selectedBike) throw new Error("This bike no longer exists.");
    if (selectedBike.status !== "available") {
      throw new Error("This bike is no longer available. Please pick another.");
    }
    if (Number(selectedBike.station_id) !== Number(station.rows[0].id)) {
      throw new Error("This bike is no longer available at the selected station.");
    }

    const start = scheduledStart || new Date();
    const isReservation = !!scheduledStart;
    const bookingStatus = isReservation ? "pending" : "active";
    const bookingTypeLabel = isReservation ? "scheduled" : "ride_now";
    // Scheduled PAYG has no fixed ride end, so the reservation only holds the
    // bike briefly around pickup. The ride duration is captured when it starts/ends.
    const expiresAt = new Date(start.getTime() + (isReservation ? PAYG_RESERVATION_HOLD_MINUTES : 8 * 60) * 60000);
    if (isReservation) {
      await assertBikeFreeForWindow(client, selectedBike.id, start, expiresAt);
    }

    const inserted = await client.query(
      `INSERT INTO bookings (
         user_id, bike_id, pickup_station_id, start_time, status, expires_at,
         unlock_fee, per_minute_fee, booking_type, pricing_mode, notes
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pay_as_you_go',$10)
       RETURNING id`,
      [
        req.user.sub,
        selectedBike.id,
        station.rows[0].id,
        start,
        bookingStatus,
        expiresAt,
        platformSettings.pricing.unlockFee,
        platformSettings.pricing.perMinuteFee,
        bookingTypeLabel,
        isReservation
          ? `PAYG reservation; bike: ${selectedBike.bike_code}`
          : `Ride Now started; bike: ${selectedBike.bike_code}`,
      ]
    );
    if (!isReservation) {
      await client.query("UPDATE bikes SET status = 'in_use', station_id = NULL WHERE id = $1", [selectedBike.id]);
    }
    await client.query("COMMIT");

    notify.push({ userId: req.user.sub,
      type: isReservation ? "booking_created" : "ride_started",
      kind: "success",
      title: isReservation ? "Reservation confirmed" : "Your ride has started",
      message: isReservation
        ? `Bike ${selectedBike.bike_code} is reserved (Pay-As-You-Go). Total charged when you finish.`
        : `Bike ${selectedBike.bike_code} is unlocked. Tap End Ride when you're done.`,
      relatedEntityType: "booking", relatedEntityId: inserted.rows[0].id });

    res.json({
      ok: true,
      bookingId: inserted.rows[0].id,
      bike: {
        id: selectedBike.id,
        bike_code: selectedBike.bike_code,
        model: selectedBike.model,
      },
      station: { id: station.rows[0].id, station_name: station.rows[0].station_name },
      startedAt: start.toISOString(),
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(err.status || 400).json({ error: err.message || "Could not start ride." });
  } finally {
    client.release();
  }
});

// POST /api/bookings/ride-now/start-complete  body: { sessionId }
// Called after the $1 Stripe unlock fee succeeds. Verifies the session,
// then atomically creates the booking + payment row and flips the bike to
// in_use. This is the ONLY way a Ride Now booking is created â€” the dashboard
// no longer inserts directly.
router.post("/ride-now/start-complete", requireUser, async (req, res) => {
  const sessionId = String((req.body && req.body.sessionId) || "");
  if (!sessionId) return res.status(400).json({ error: "Missing payment session." });

  const client = await db.pool.connect();
  try {
    await settingsService.assertBookingAllowed();
    await ensureStudentSchema();
    await ensurePaymentMethodSchema();

    // Idempotent: if we already processed this session, just return it.
    const existing = await client.query(
      `SELECT booking_id FROM payments
        WHERE user_id = $1 AND transaction_reference = $2
        ORDER BY created_at DESC LIMIT 1`,
      [req.user.sub, sessionId]
    );
    if (existing.rows[0]) {
      return res.json({ ok: true, bookingId: existing.rows[0].booking_id, alreadyCreated: true });
    }

    const paidSession = await verifyPaidSession(sessionId, req.user.sub);
    const meta = paidSession.metadata || {};
    if (String(meta.flow) !== "start_ride") {
      throw new Error("This payment was not a Ride Now unlock charge.");
    }
    const savedMethod = await savePaymentMethodFromCheckoutSession(req.user.sub, sessionId);
    const bikeId = Number(meta.bike_id);
    const stationId = Number(meta.station_id);
    if (!Number.isInteger(bikeId) || bikeId <= 0 || !Number.isInteger(stationId) || stationId <= 0) {
      throw new Error("Payment metadata is missing bike or station id.");
    }
    let scheduledStart = null;
    if (meta.scheduled_start) {
      scheduledStart = new Date(meta.scheduled_start);
      if (Number.isNaN(scheduledStart.getTime()) || scheduledStart.getTime() < Date.now() - 60_000) {
        throw new Error("Pick-up time must be in the future.");
      }
    }

    await client.query("BEGIN");
    // Only a second Ride Now/current ride is blocked. Scheduled bookings remain
    // allowed regardless of active or upcoming booking count.
    if (!scheduledStart) {
      await assertNoActiveRide(client, req.user.sub);
    }

    const station = await client.query(
      "SELECT id, station_name FROM stations WHERE id = $1 AND is_active = TRUE",
      [stationId]
    );
    if (!station.rows[0]) throw new Error("Pickup station was not found.");

    const bike = await client.query(
      `SELECT id, bike_code, model, station_id, status
         FROM bikes WHERE id = $1 FOR UPDATE`,
      [bikeId]
    );
    const selectedBike = bike.rows[0];
    if (!selectedBike) throw new Error("This bike no longer exists.");
    if (selectedBike.status !== "available") {
      throw new Error("This bike is no longer available. Please pick another.");
    }
    if (Number(selectedBike.station_id) !== Number(station.rows[0].id)) {
      throw new Error("This bike is no longer available at the selected station.");
    }

    const start = scheduledStart || new Date();
    const isReservation = !!scheduledStart;
    const bookingStatus = isReservation ? "pending" : "active";
    const bookingTypeLabel = isReservation ? "scheduled" : "ride_now";
    const expiresAt = new Date(start.getTime() + (isReservation ? PAYG_RESERVATION_HOLD_MINUTES : 8 * 60) * 60000);
    if (isReservation) {
      // Block PAYG reservation if it overlaps any active/upcoming booking
      // for this user (even with a different bike).
      await assertNoUserFixedOverlap(client, req.user.sub, start, expiresAt);
      await assertBikeFreeForWindow(client, selectedBike.id, start, expiresAt);
    }
    const unlockFeeAmount = (paidSession.amount_total != null
      ? Number(paidSession.amount_total) / 100
      : UNLOCK_FEE_CENTS / 100);
    const unlockFee = Number(meta.unlock_fee ?? unlockFeeAmount);
    const perMinuteFee = Number(meta.per_minute_fee ?? PER_MINUTE_CENTS / 100);

    const inserted = await client.query(
      `INSERT INTO bookings (
         user_id, bike_id, pickup_station_id, start_time, status, expires_at,
         fee_amount, unlock_fee, per_minute_fee, booking_type, pricing_mode,
         payment_status, stripe_customer_id, stripe_payment_method_id, unlock_payment_intent_id, notes
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pay_as_you_go',$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        req.user.sub,
        selectedBike.id,
        station.rows[0].id,
        start,
        bookingStatus,
        expiresAt,
        unlockFeeAmount,
        unlockFee,
        perMinuteFee,
        bookingTypeLabel,
        "unlock_paid_card_saved",
        savedMethod.stripeCustomerId,
        savedMethod.stripePaymentMethodId,
        savedMethod.unlockPaymentIntentId,
        isReservation
          ? `PAYG reservation. Unlock paid via session ${sessionId}.`
          : `Ride Now started. Unlock paid via session ${sessionId}.`,
      ]
    );
    if (!isReservation) {
      await client.query("UPDATE bikes SET status='in_use', station_id=NULL WHERE id=$1", [selectedBike.id]);
    }
    await client.query(
      `INSERT INTO payments (booking_id, user_id, amount, currency, payment_method, status, transaction_reference, paid_at)
       VALUES ($1,$2,$3,$4,'credit_card','paid',$5,NOW())`,
      [inserted.rows[0].id, req.user.sub, unlockFeeAmount, "AUD", sessionId]
    );
    await client.query("COMMIT");

    await Promise.all([
      notify.push({ userId: req.user.sub,
        type: isReservation ? "booking_created" : "ride_started",
        kind: "success",
        title: isReservation ? "Reservation confirmed" : "Your ride has started",
        message: isReservation
          ? `Bike ${selectedBike.bike_code} is reserved (Pay-As-You-Go). Final amount charged when you finish.`
          : `Bike ${selectedBike.bike_code} is unlocked. Open My Bookings to view your timer.`,
        relatedEntityType: "booking", relatedEntityId: inserted.rows[0].id }),
      notify.push({ userId: req.user.sub, type: "payment_received", kind: "success",
        title: `Unlock paid: $${unlockFeeAmount.toFixed(2)}`,
        message: `Ride #${inserted.rows[0].id}`,
        relatedEntityType: "booking", relatedEntityId: inserted.rows[0].id }),
      notify.pushAdmin({
        activityType: "payment_received",
        title: `PAYG unlock: $${unlockFeeAmount.toFixed(2)}`,
        description: `${isReservation ? "Reservation" : "Ride Now"} - bike ${selectedBike.bike_code}`,
        bookingId: inserted.rows[0].id,
        userId: req.user.sub,
        bikeId: selectedBike.id,
      }),
    ]);

    res.json({
      ok: true,
      bookingId: inserted.rows[0].id,
      bike: { id: selectedBike.id, bike_code: selectedBike.bike_code, model: selectedBike.model },
      station: { id: station.rows[0].id, station_name: station.rows[0].station_name },
      startedAt: start.toISOString(),
      unlockFee: unlockFeeAmount,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(err.status || 400).json({ error: err.message || "Could not start ride." });
  } finally {
    client.release();
  }
});

// POST /api/bookings/ride-now/complete  body: { sessionId }
// Called after the end-of-ride Stripe Checkout succeeds. Verifies the payment,
// then marks the booking completed and inserts the payment row.
router.post("/ride-now/complete", requireUser, async (req, res) => {
  const sessionId = String((req.body && req.body.sessionId) || "");
  if (!sessionId) return res.status(400).json({ error: "Missing payment session." });

  const client = await db.pool.connect();
  try {
    await ensurePaymentMethodSchema();
    await ensureStudentSchema();
    // Already finalized?
    const existing = await client.query(
      `SELECT booking_id FROM payments
        WHERE user_id = $1 AND transaction_reference = $2
        ORDER BY created_at DESC LIMIT 1`,
      [req.user.sub, sessionId]
    );
    if (existing.rows[0]) {
      return res.json({ ok: true, bookingId: existing.rows[0].booking_id, alreadyCompleted: true });
    }

    const paidSession = await verifyPaidSession(sessionId, req.user.sub);
    const meta = paidSession.metadata || {};
    if (String(meta.flow) !== "end_ride") {
      throw new Error("This payment was not an end-of-ride charge.");
    }
    const bookingId = Number(meta.booking_id);
    const duration = Number(meta.duration);
    if (!Number.isInteger(bookingId) || bookingId <= 0 || !Number.isFinite(duration) || duration <= 0) {
      throw new Error("Payment metadata is missing booking details.");
    }

    await client.query("BEGIN");
    const cur = await client.query(
      `SELECT id, user_id, bike_id, pickup_station_id, start_time, status
         FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );
    const row = cur.rows[0];
    if (!row) throw new Error("Booking not found.");
    if (String(row.user_id) !== String(req.user.sub)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Forbidden." });
    }

    const end = new Date();
    const unlockFee = Number(meta.unlock_fee ?? UNLOCK_FEE_CENTS / 100);
    const perMinuteFee = Number(meta.per_minute_fee ?? PER_MINUTE_CENTS / 100);
    const amount = Number((unlockFee + duration * perMinuteFee).toFixed(2));

    await client.query(
      `UPDATE bookings
          SET status = 'completed',
              end_time = $2,
              return_station_id = COALESCE(return_station_id, pickup_station_id),
              duration_minutes = $3,
              fee_amount = $4,
              unlock_fee = $5,
              per_minute_fee = $6,
              updated_at = NOW()
        WHERE id = $1`,
      [bookingId, end, duration, amount, unlockFee, perMinuteFee]
    );
    await client.query(
      "UPDATE bikes SET status = 'available', station_id = $2 WHERE id = $1",
      [row.bike_id, row.pickup_station_id]
    );
    const paymentUpdate = await client.query(
      `UPDATE payments
          SET amount = $3,
              currency = $4,
              payment_method = 'credit_card',
              status = 'paid',
              transaction_reference = $5,
              paid_at = NOW(),
              updated_at = NOW()
        WHERE id = (
          SELECT id FROM payments
           WHERE booking_id = $1 AND user_id = $2
           ORDER BY created_at DESC
           LIMIT 1
        )`,
      [bookingId, req.user.sub, amount, "AUD", sessionId]
    );
    if (paymentUpdate.rowCount === 0) {
      await client.query(
        `INSERT INTO payments (booking_id, user_id, amount, currency, payment_method, status, transaction_reference, paid_at)
         VALUES ($1,$2,$3,$4,'credit_card','paid',$5,NOW())`,
        [bookingId, req.user.sub, amount, "AUD", sessionId]
      );
    }
    await client.query("COMMIT");

    await Promise.all([
      notify.push({ userId: req.user.sub, type: "ride_completed", kind: "success",
        title: `Ride complete - ${duration} min`,
        message: `Thanks for riding! Final total $${amount.toFixed(2)}.`,
        relatedEntityType: "booking", relatedEntityId: bookingId }),
      notify.push({ userId: req.user.sub, type: "payment_received", kind: "success",
        title: `Payment received: $${amount.toFixed(2)}`,
        message: `Ride #${bookingId}`,
        relatedEntityType: "booking", relatedEntityId: bookingId }),
      notify.pushAdmin({
        activityType: "booking_completed",
        title: `Ride completed - $${amount.toFixed(2)}`,
        description: `Booking #${bookingId} (${duration} min)`,
        bookingId,
        userId: req.user.sub,
      }),
    ]);

    res.json({ ok: true, bookingId, duration, amount });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(err.status || 400).json({ error: err.message || "Could not complete ride." });
  } finally {
    client.release();
  }
});

router.post("/create-from-payment", requireUser, async (req, res) => {
  let booking = req.body && req.body.booking;
  const sessionId = String((req.body && req.body.sessionId) || "");
  if (!booking || !sessionId) return res.status(400).json({ error: "Missing paid booking details." });

  const client = await db.pool.connect();
  try {
    await ensureStudentSchema();
    const existing = await client.query(
      `SELECT booking_id
         FROM payments
        WHERE user_id = $1 AND transaction_reference = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [req.user.sub, sessionId]
    );
    if (existing.rows[0]) {
      return res.json({ ok: true, bookingId: existing.rows[0].booking_id, alreadyCreated: true });
    }

    const paidSession = await verifyPaidSession(sessionId, req.user.sub);
    const sessionBooking = bookingFromMetadata(paidSession.metadata);
    if (sessionBooking) booking = sessionBooking;
    const platformSettings = await settingsService.getPublicSettings();
    const upfrontPaymentIntentId = typeof paidSession.payment_intent === "string"
      ? paidSession.payment_intent
      : (paidSession.payment_intent && paidSession.payment_intent.id) || null;

    // If the user opted to save the card on the Review step, persist the
    // payment method now. Idempotent and de-duped by the duplicate-card
    // logic in savedPaymentMethods.js, so it's safe even if the webhook
    // also handled it.
    if (paidSession.metadata && paidSession.metadata.save_card === "true") {
      try {
        await savePaymentMethodFromCheckoutSession(req.user.sub, sessionId);
      } catch (saveErr) {
        console.warn("[create-from-payment] could not save card:", saveErr.message);
      }
    }

    const stationId = Number(booking.stationId);
    const bikeId = Number(booking.bikeId);
    const bookingType = booking.bookingType === "ride_now" ? "ride_now" : "scheduled";
    const pricingMode = booking.pricingMode === "pay_as_you_go" ? "pay_as_you_go" : "fixed_duration";
    const duration = Number(booking.duration);
    const start = bookingType === "ride_now" ? new Date() : new Date(booking.start);
    const end = bookingType === "ride_now"
      ? new Date(start.getTime() + duration * 60000)
      : new Date(booking.end);

    if (!Number.isInteger(stationId) || stationId <= 0) {
      throw new Error("Pickup station was not found in the payment details.");
    }
    if (!Number.isInteger(bikeId) || bikeId <= 0) {
      throw new Error("Selected bike was not found in the payment details.");
    }
    const minDuration = Number(platformSettings.pricing.minimumRideDuration || 1);
    const maxDuration = Number(platformSettings.pricing.maximumRideDuration || 480);
    if (!Number.isFinite(duration) || duration < minDuration || duration > maxDuration) {
      throw new Error(`Booking duration must be between ${minDuration} and ${maxDuration} minutes.`);
    }
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new Error("Invalid booking time.");
    }
    const unlockFee = Number(booking.unlockFee ?? booking.unlock_fee ?? platformSettings.pricing.unlockFee);
    const perMinuteFee = Number(booking.perMinuteFee ?? booking.per_minute_fee ?? platformSettings.pricing.perMinuteFee);
    const expectedAmountCents = Math.round((unlockFee + duration * perMinuteFee) * 100);
    if (paidSession.amount_total && Number(paidSession.amount_total) !== expectedAmountCents) {
      throw new Error("Payment amount did not match the booking price.");
    }
    const willStartActive = bookingType === "ride_now" || start.getTime() <= Date.now();

    await client.query("BEGIN");
    if (willStartActive) {
      await assertNoActiveRide(client, req.user.sub);
    }
    if (bookingType !== "ride_now") {
      await assertNoUserFixedOverlap(client, req.user.sub, start, end);
    }

    const station = await client.query(
      "SELECT id, station_name FROM stations WHERE id = $1 AND is_active = TRUE",
      [stationId]
    );
    if (!station.rows[0]) throw new Error("Pickup station was not found in the database.");

    const bike = await client.query(
      `SELECT id, bike_code, model, station_id, status
         FROM bikes
        WHERE id = $1
        FOR UPDATE`,
      [bikeId]
    );
    const selectedBike = bike.rows[0];
    if (!selectedBike) throw new Error("This bike is no longer available. Please choose another bike.");
    if (selectedBike.status !== "available" || Number(selectedBike.station_id) !== station.rows[0].id) {
      throw new Error("This bike is no longer available. Please choose another bike.");
    }

    await assertBikeFreeForWindow(client, selectedBike.id, start, end);

    const status = willStartActive ? "active" : "pending";
    const amount = Number((unlockFee + duration * perMinuteFee).toFixed(2));
    const inserted = await client.query(
      `INSERT INTO bookings (
         user_id, bike_id, pickup_station_id, start_time, end_time, status, expires_at,
         duration_minutes, fee_amount, unlock_fee, per_minute_fee, booking_type, pricing_mode,
         payment_status, upfront_payment_intent_id, notes
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'paid',$14,$15)
       RETURNING id`,
      [
        req.user.sub,
        selectedBike.id,
        station.rows[0].id,
        start,
        end,
        status,
        end,
        duration,
        amount,
        unlockFee,
        perMinuteFee,
        bookingType,
        pricingMode,
        upfrontPaymentIntentId,
        `Payment session: ${sessionId}; bike: ${selectedBike.bike_code}`,
      ]
    );
    if (status === "active") {
      await client.query("UPDATE bikes SET status = 'in_use', station_id = NULL WHERE id = $1", [selectedBike.id]);
    }
    await client.query(
      `INSERT INTO payments (booking_id, user_id, amount, currency, payment_method, status, transaction_reference, paid_at)
       VALUES ($1,$2,$3,$4,'credit_card','paid',$5,NOW())`,
      [inserted.rows[0].id, req.user.sub, amount, "AUD", sessionId]
    );
    await client.query("COMMIT");
    // Await the notification inserts so the frontend can see them on its very
    // next /api/notifications poll. notify.push swallows its own errors so
    // this never throws.
    const startLabel = start.toLocaleString("en-AU", {
      weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
    });
    await Promise.all([
      notify.push({ userId: req.user.sub, type: "booking_created", kind: "success",
        title: bookingType === "ride_now" ? "Your ride has started" : `Booking #${inserted.rows[0].id} confirmed`,
        message: bookingType === "ride_now"
          ? `Your ride has started. Bike ${selectedBike.bike_code} is ready to use.`
          : `Your bike booking is confirmed for ${startLabel}.`,
        relatedEntityType: "booking", relatedEntityId: inserted.rows[0].id }),
      notify.push({ userId: req.user.sub, type: "payment_received", kind: "success",
        title: `Payment received: $${amount.toFixed(2)}`,
        message: `Ride #${inserted.rows[0].id}`,
        relatedEntityType: "booking", relatedEntityId: inserted.rows[0].id }),
      notify.pushAdmin({
        activityType: "payment_received",
        title: `New booking - $${amount.toFixed(2)}`,
        description: `${bookingType === "ride_now" ? "Ride Now" : "Reservation"} - bike ${selectedBike.bike_code}`,
        bookingId: inserted.rows[0].id,
        userId: req.user.sub,
        bikeId: selectedBike.id,
      }),
    ]);
    res.json({ ok: true, bookingId: inserted.rows[0].id });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    let message = err.message || "Could not save booking.";
    if (err.code === "23505") {
      message = /bike/i.test(err.constraint || "")
        ? "This bike is no longer available. Please choose another bike."
        : "You already have an active ride. You can still schedule an upcoming booking.";
    }
    res.status(400).json({ error: message });
  } finally {
    client.release();
  }
});

// ──────────────────────────────────────────────────────────────
// POST /api/bookings/end-ride   body: { bookingId }
// End an active Pay-As-You-Go ride and charge the saved default card
// off_session (no Stripe redirect). The booking row is marked completed
// and a payment row recorded only if the charge succeeds.
// ──────────────────────────────────────────────────────────────
async function handleEndRide(req, res) {
  const bookingId = Number(req.body && req.body.bookingId);
  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    return res.status(400).json({ error: "Missing booking id." });
  }

  const STRIPE_CURRENCY = (process.env.STRIPE_CURRENCY || "aud").toLowerCase();
  try {
    await ensurePaymentMethodSchema();
    await ensureStudentSchema();
    const platformSettings = await settingsService.getPublicSettings();
    const { getDefaultPaymentMethod, stripeRequest } = require("../utils/savedPaymentMethods");

    const lookup = await db.query(
      `SELECT bk.id, bk.user_id, bk.bike_id, bk.start_time, bk.status,
              bk.booking_type, bk.pricing_mode, bk.pickup_station_id,
              bk.unlock_fee, bi.bike_code
         FROM bookings bk
         JOIN bikes bi ON bi.id = bk.bike_id
        WHERE bk.id = $1`,
      [bookingId]
    );
    const row = lookup.rows[0];
    if (!row) return res.status(404).json({ error: "Booking not found." });
    if (String(row.user_id) !== String(req.user.sub) && req.user.role !== "admin") {
      return res.status(403).json({ error: "Forbidden." });
    }
    if (row.status !== "active") {
      return res.status(400).json({ error: "Only an active ride can be ended." });
    }

    const start = new Date(row.start_time).getTime();
    const minDuration = Number(platformSettings.pricing.minimumRideDuration || 1);
    const maxDuration = Number(platformSettings.pricing.maximumRideDuration || 480);
    const rawMinutes = Math.max(minDuration, Math.ceil((Date.now() - start) / 60000));
    const duration = Math.min(rawMinutes, maxDuration);
    const unlockFee = Number(row.unlock_fee ?? platformSettings.pricing.unlockFee ?? 1);
    const perMinuteFee = Number(platformSettings.pricing.perMinuteFee || 0.20);
    const totalAmount = Number((unlockFee + duration * perMinuteFee).toFixed(2));
    const prepaidCents = Math.round(unlockFee * 100);
    const totalCents = Math.round(totalAmount * 100);
    const remainingCents = Math.max(0, totalCents - prepaidCents);
    const remainingAmount = Number((remainingCents / 100).toFixed(2));

    const savedCard = await getDefaultPaymentMethod(req.user.sub);
    if (!savedCard) {
      return res.status(402).json({
        error: "No saved card found. Add a card in your profile to end this ride.",
      });
    }

    let finalPaymentIntentId = "";
    if (remainingCents > 0) {
      const params = new URLSearchParams();
      params.set("amount", String(remainingCents));
      params.set("currency", STRIPE_CURRENCY);
      params.set("customer", savedCard.stripe_customer_id);
      params.set("payment_method", savedCard.stripe_payment_method_id);
      params.set("off_session", "true");
      params.set("confirm", "true");
      params.set("description", `Campus Bike Sharing PAYG final charge - booking ${bookingId}`);
      params.set("metadata[flow]", "payg_final");
      params.set("metadata[user_id]", String(req.user.sub || ""));
      params.set("metadata[booking_id]", String(bookingId));
      params.set("metadata[duration]", String(duration));
      try {
        const paymentIntent = await stripeRequest("/payment_intents", { method: "POST", body: params });
        finalPaymentIntentId = paymentIntent.id;
      } catch (chargeErr) {
        // Mark booking as payment_failed so admin / support can follow up.
        await db.query(
          `UPDATE bookings
              SET payment_status = 'payment_failed',
                  updated_at = NOW()
            WHERE id = $1`,
          [bookingId]
        ).catch(() => {});
        return res.status(402).json({
          error: chargeErr.message || "Saved card was declined. Please update your card and try again.",
        });
      }
    }

    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `SELECT id, user_id, bike_id, pickup_station_id, status
           FROM bookings WHERE id = $1 FOR UPDATE`,
        [bookingId]
      );
      const current = locked.rows[0];
      if (!current) throw new Error("Booking not found.");
      if (current.status !== "active") throw new Error("Only an active ride can be ended.");

      const end = new Date();
      await client.query(
        `UPDATE bookings
            SET status = 'completed',
                end_time = $2,
                return_station_id = COALESCE(return_station_id, pickup_station_id),
                duration_minutes = $3,
                fee_amount = $4,
                final_amount = $5,
                unlock_fee = $6,
                per_minute_fee = $7,
                final_payment_intent_id = NULLIF($8, ''),
                payment_status = 'paid',
                updated_at = NOW()
          WHERE id = $1`,
        [bookingId, end, duration, totalAmount, remainingAmount, unlockFee, perMinuteFee, finalPaymentIntentId]
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
          STRIPE_CURRENCY.toUpperCase(),
          finalPaymentIntentId || `payg_no_remaining_${bookingId}_${Date.now()}`,
        ]
      );
      await client.query("COMMIT");

      await Promise.all([
        notify.push({ userId: req.user.sub, type: "ride_completed", kind: "success",
          title: `Ride complete - ${duration} min`,
          message: `Charged $${remainingAmount.toFixed(2)} to your saved card. Total $${totalAmount.toFixed(2)}.`,
          relatedEntityType: "booking", relatedEntityId: bookingId }),
        notify.push({ userId: req.user.sub, type: "payment_received", kind: "success",
          title: `Payment received: $${remainingAmount.toFixed(2)}`,
          message: `Ride #${bookingId} - final PAYG charge.`,
          relatedEntityType: "booking", relatedEntityId: bookingId }),
        notify.pushAdmin({
          activityType: "booking_completed",
          title: `PAYG ride ended - $${totalAmount.toFixed(2)}`,
          description: `Booking #${bookingId} (${duration} min) - bike ${row.bike_code}`,
          bookingId,
          userId: req.user.sub,
        }),
      ]);

      res.json({
        ok: true,
        bookingId,
        duration,
        totalAmount,
        remainingAmount,
        finalPaymentIntentId,
        card: { brand: savedCard.brand, last4: savedCard.last4 },
      });
    } catch (txErr) {
      await client.query("ROLLBACK").catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || "Could not end ride." });
  }
}
router.post("/end-ride", requireUser, handleEndRide);

// ──────────────────────────────────────────────────────────────
// Manual lifecycle endpoints — keyed by booking id in the URL so
// every page (Dashboard, My Bookings, Ride History) shares one
// consistent API. They wrap the existing logic instead of
// duplicating it.
// ──────────────────────────────────────────────────────────────
const READY_GRACE_MINUTES = Number(process.env.READY_TO_START_GRACE_MINUTES) || 15;

// POST /api/bookings/:id/start
// Manually starts a scheduled booking. Only works inside the
// grace window (now <= start_time + READY_GRACE_MINUTES) and
// only while the booking is still pending.
router.post("/:id/start", requireUser, async (req, res) => {
  const bookingId = Number(req.params.id);
  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    return res.status(400).json({ error: "Invalid booking id." });
  }

  // Belt-and-braces: clear stale 'active' rows whose end_time has already
  // passed BEFORE we run assertNoActiveRide. This handles the case where a
  // previous ride was never properly ended, so a phantom "active" row was
  // sitting in the DB invisible to the UI but blocking new rides.
  await db.query(
    `WITH stale AS (
       UPDATE bookings
          SET status = 'completed', updated_at = NOW()
        WHERE user_id = $1
          AND status = 'active'
          AND end_time IS NOT NULL
          AND end_time <= NOW()
        RETURNING bike_id, pickup_station_id
     )
     UPDATE bikes b
        SET status = 'available', station_id = COALESCE(b.station_id, s.pickup_station_id)
       FROM stale s
      WHERE b.id = s.bike_id AND b.status = 'in_use'`,
    [req.user.sub]
  ).catch(() => {});

  const client = await db.pool.connect();
  try {
    await ensureStudentSchema();
    await client.query("BEGIN");

    const cur = await client.query(
      `SELECT id, user_id, bike_id, pickup_station_id, status, start_time, end_time
         FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );
    const row = cur.rows[0];
    if (!row) throw Object.assign(new Error("Booking not found."), { status: 404 });
    if (!canAccess(req, row.user_id)) throw Object.assign(new Error("Forbidden."), { status: 403 });
    if (row.status !== "pending") throw new Error("Only an upcoming booking can be started.");

    const start = new Date(row.start_time).getTime();
    const now = Date.now();
    const graceEnd = start + READY_GRACE_MINUTES * 60_000;
    if (now < start) throw new Error("It's too early to start this ride.");
    if (now > graceEnd) throw new Error("The start window has passed. This booking has expired.");

    // Will throw with err.activeBooking diagnostics if a real active ride
    // still exists after the stale sweep above.
    await assertNoActiveRide(client, req.user.sub);

    await client.query(
      `UPDATE bookings
          SET status = 'active',
              start_time = NOW(),
              expires_at = NOW() + INTERVAL '8 hours',
              updated_at = NOW()
        WHERE id = $1`,
      [bookingId]
    );
    await client.query(
      "UPDATE bikes SET status = 'in_use', station_id = NULL WHERE id = $1",
      [row.bike_id]
    );
    await client.query("COMMIT");

    await Promise.all([
      notify.push({
        userId: row.user_id,
        type: "ride_started",
        kind: "success",
        title: "Your ride has started",
        message: `Booking #${bookingId} is now active. Tap End Ride on My Bookings when you're done.`,
        relatedEntityType: "booking",
        relatedEntityId: bookingId,
      }),
      notify.pushAdmin({
        activityType: "payment_received",
        title: `Ride manually started`,
        description: `Booking #${bookingId} started by user.`,
        bookingId,
        userId: row.user_id,
      }),
    ]);

    res.json({ ok: true, bookingId, status: "active", startedAt: new Date().toISOString() });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const payload = { error: err.message || "Could not start ride." };
    if (err.activeBooking) {
      // Log full diagnostics server-side, and include them in the response
      // only outside production so the frontend can surface the offending
      // booking id when debugging.
      console.warn("[bookings/:id/start] blocked by active booking:", {
        userId: req.user.sub,
        attemptedBookingId: bookingId,
        ...err.activeBooking,
      });
      if (process.env.NODE_ENV !== "production") {
        payload.activeBooking = err.activeBooking;
      }
    }
    res.status(err.status || 400).json(payload);
  } finally {
    client.release();
  }
});

// POST /api/bookings/:id/end  → URL-keyed alias for /end-ride
router.post("/:id/end", requireUser, (req, res) => {
  req.body = { ...(req.body || {}), bookingId: Number(req.params.id) };
  return handleEndRide(req, res);
});

// POST /api/bookings/:id/cancel — URL-keyed alias for /cancel
router.post("/:id/cancel", requireUser, (req, res) => {
  req.body = { ...(req.body || {}), bookingId: Number(req.params.id) };
  return handleCancel(req, res);
});

// POST /api/bookings/expire-ready-bookings
// Sweep all rows past their grace window across every user. Safe to call
// from a scheduled task or manually. Returns the number expired.
router.post("/expire-ready-bookings", requireUser, async (req, res) => {
  try {
    const r = await db.query(
      `WITH expired AS (
         UPDATE bookings
            SET status = 'expired',
                payment_status = CASE
                                   WHEN payment_status = 'paid' THEN 'pending_refund'
                                   ELSE payment_status
                                 END,
                notes = CONCAT(COALESCE(notes,''), CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE E'\n' END,
                               'Auto-expired (no_show): grace window passed.'),
                updated_at = NOW()
          WHERE status = 'pending'
            AND start_time IS NOT NULL
            AND start_time + ($1::int * INTERVAL '1 minute') <= NOW()
            AND (end_time IS NULL OR end_time > NOW())
          RETURNING id, user_id, bike_id, pickup_station_id
       )
       UPDATE bikes b
          SET status = 'available', station_id = COALESCE(b.station_id, e.pickup_station_id)
         FROM expired e
        WHERE b.id = e.bike_id AND b.status = 'in_use'
       RETURNING e.id, e.user_id`,
      [READY_GRACE_MINUTES]
    );
    for (const row of r.rows) {
      await notify.push({
        userId: row.user_id,
        type: "booking_cancelled",
        kind: "warning",
        title: "Booking expired",
        message: `Booking #${row.id} expired because it was not started within ${READY_GRACE_MINUTES} minutes.`,
        relatedEntityType: "booking",
        relatedEntityId: row.id,
      }).catch(() => {});
    }
    res.json({ ok: true, expired: r.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not run expiry sweep." });
  }
});

module.exports = router;
