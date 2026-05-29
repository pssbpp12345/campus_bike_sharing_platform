const crypto = require("crypto");

const sessions = new Map();

function makeLocalSessionId() {
  if (crypto.randomUUID) return `cbs_${crypto.randomUUID().replace(/-/g, "")}`;
  return `cbs_${crypto.randomBytes(16).toString("hex")}`;
}

function createLocalCheckoutSession({ userId, booking, amount, currency }) {
  const id = makeLocalSessionId();
  const session = {
    id,
    payment_status: "paid",
    amount_total: amount,
    currency,
    client_reference_id: String(userId || ""),
    metadata: {
      booking: JSON.stringify(booking),
      user_id: String(userId || ""),
      booking_type: booking.bookingType || "scheduled",
      pricing_mode: booking.pricingMode || "fixed_duration",
      bike_id: String(booking.bikeId),
      bike_code: booking.bikeCode,
      bike_model: booking.bikeModel || booking.type || "",
      station_id: String(booking.stationId),
      station_name: booking.stationName,
      start: booking.start,
      end: booking.end,
      duration: String(booking.duration),
      unlock_fee: String(booking.unlockFee),
      per_minute_fee: String(booking.perMinuteFee),
      total_cost: String(booking.totalCost || booking.cost),
    },
  };
  sessions.set(id, session);
  return session;
}

function getLocalCheckoutSession(id) {
  return sessions.get(id);
}

// Local (simulated) checkout session for ending a Ride Now booking. The
// booking already exists in the DB; we just need a fake "paid" session whose
// metadata points back to that booking + the calculated final amount.
function createLocalEndRideSession({ userId, bookingId, amount, currency, duration, unlockFee, perMinuteFee }) {
  const id = makeLocalSessionId();
  const session = {
    id,
    payment_status: "paid",
    amount_total: amount,
    currency,
    client_reference_id: String(userId || ""),
    metadata: {
      flow: "end_ride",
      user_id: String(userId || ""),
      booking_id: String(bookingId),
      duration: String(duration),
      unlock_fee: String(unlockFee),
      per_minute_fee: String(perMinuteFee),
      total_cost: String(amount / 100),
    },
  };
  sessions.set(id, session);
  return session;
}

// Simulated session for the $1 unlock fee that starts a Ride Now booking.
function createLocalStartRideSession({ userId, bikeId, stationId, scheduledStart, amount, currency }) {
  const id = makeLocalSessionId();
  const session = {
    id,
    payment_status: "paid",
    amount_total: amount,
    currency,
    client_reference_id: String(userId || ""),
    metadata: {
      flow: "start_ride",
      user_id: String(userId || ""),
      bike_id: String(bikeId),
      station_id: String(stationId),
      scheduled_start: scheduledStart || "",
      total_cost: String(amount / 100),
    },
  };
  sessions.set(id, session);
  return session;
}

module.exports = {
  createLocalCheckoutSession,
  createLocalEndRideSession,
  createLocalStartRideSession,
  getLocalCheckoutSession,
};
