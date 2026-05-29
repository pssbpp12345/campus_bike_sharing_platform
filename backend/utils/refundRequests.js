const db = require("../db");
const notify = require("./notify");
const settingsService = require("../services/settingsService");
const { ensureStudentSchema } = require("./studentSchema");
const { stripeConfigured, stripeRequest } = require("./savedPaymentMethods");

let schemaReady = null;

async function ensureRefundSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await ensureStudentSchema();
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_status VARCHAR(40)");
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS display_end_latitude DOUBLE PRECISION");
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS display_end_longitude DOUBLE PRECISION");
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS display_end_label VARCHAR(160)");
      await db.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_status VARCHAR(40)");
      await db.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_refund_id VARCHAR(160)");
      await db.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ");
      await db.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(160)");
      await db.query(`
        CREATE TABLE IF NOT EXISTS refund_requests (
          id BIGSERIAL PRIMARY KEY,
          booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
          amount_paid NUMERIC(10,2) NOT NULL DEFAULT 0,
          calculated_refund_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
          approved_refund_amount NUMERIC(10,2),
          reason TEXT,
          admin_note TEXT,
          refund_type VARCHAR(40) NOT NULL DEFAULT 'expired',
          status VARCHAR(60) NOT NULL DEFAULT 'pending_review',
          policy_snapshot JSONB,
          stripe_refund_id VARCHAR(160),
          requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reviewed_at TIMESTAMPTZ,
          reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query("CREATE INDEX IF NOT EXISTS idx_refund_requests_user ON refund_requests(user_id, requested_at DESC)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_refund_requests_booking ON refund_requests(booking_id)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_refund_requests_status ON refund_requests(status, requested_at DESC)");
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

function money(value) {
  return Number((Number(value || 0)).toFixed(2));
}

function normaliseStatus(status) {
  return String(status || "").toLowerCase();
}

function isNeverStartedStatus(status) {
  return [
    "cancelled",
    "expired",
    "no_show",
    "missed",
    "payment_failed",
    "not_started",
  ].includes(normaliseStatus(status));
}

function isRefundEligibleStatus(status) {
  return ["cancelled", "expired", "no_show", "missed", "not_started"].includes(normaliseStatus(status));
}

function isPayAsYouGo(row = {}) {
  const text = `${row.booking_type || ""} ${row.pricing_mode || ""} ${row.ride_mode || ""}`.toLowerCase();
  return text.includes("pay_as_you_go") || text.includes("payg") || text.includes("ride_now");
}

function buildRefundEstimate(row = {}, pricing = {}) {
  const paid = money(row.amount_paid || row.payment_amount || row.cost || row.fee_amount || 0);
  const unlockFee = money(row.unlock_fee || pricing.unlockFee || 1);
  const noShowRate = Number(process.env.NO_SHOW_REFUND_FEE_RATE || 0.10);
  const payg = isPayAsYouGo(row);

  if (payg) {
    return {
      amountPaid: paid,
      unlockFee: Math.min(unlockFee, paid),
      rideTimeAmount: 0,
      noShowFeeRate: noShowRate,
      noShowFee: 0,
      calculatedRefundAmount: 0,
      refundType: normaliseStatus(row.status || row.ride_status) || "expired",
      policyTitle: "Pay-As-You-Go activation fee",
      policyExplanation: "Pay-As-You-Go bookings only paid the activation/unlock fee, which is non-refundable when the ride was never started.",
      payAsYouGo: true,
    };
  }

  const nonRefundableUnlock = Math.min(unlockFee, paid);
  const rideTimeAmount = Math.max(0, money(paid - nonRefundableUnlock));
  const noShowFee = money(rideTimeAmount * noShowRate);
  const calculatedRefundAmount = Math.max(0, money(paid - nonRefundableUnlock - noShowFee));

  return {
    amountPaid: paid,
    unlockFee: nonRefundableUnlock,
    rideTimeAmount,
    noShowFeeRate: noShowRate,
    noShowFee,
    calculatedRefundAmount,
    refundType: normaliseStatus(row.status || row.ride_status) || "expired",
    policyTitle: "No-show refund policy",
    policyExplanation: "The unlock fee is non-refundable. A 10% no-show/cancellation fee is applied to the ride-time amount, and the remaining paid amount can be reviewed by admin.",
    payAsYouGo: false,
  };
}

async function getBookingForRefund(bookingId, userId = null, client = db) {
  await ensureRefundSchema();
  const params = [bookingId];
  let userClause = "";
  if (userId != null) {
    params.push(userId);
    userClause = `AND bk.user_id = $${params.length}`;
  }

  const result = await client.query(
    `SELECT
       bk.id AS booking_id,
       bk.user_id,
       u.full_name,
       u.email,
       bk.bike_id,
       bi.bike_code,
       COALESCE(bk.booking_type, 'scheduled') AS booking_type,
       COALESCE(bk.pricing_mode, 'pay_as_you_go') AS pricing_mode,
       COALESCE(bk.ride_mode, '') AS ride_mode,
       bk.status::text AS booking_status,
       bk.start_time,
       bk.end_time,
       bk.expires_at,
       bk.duration_minutes,
       bk.fee_amount,
       COALESCE(bk.unlock_fee, 1) AS unlock_fee,
       COALESCE(bk.per_minute_fee, 0.20) AS per_minute_fee,
       bk.refund_status AS booking_refund_status,
       bk.upfront_payment_intent_id,
       bk.unlock_payment_intent_id,
       bk.final_payment_intent_id,
       p.id AS payment_id,
       p.amount AS payment_amount,
       p.status::text AS payment_status,
       p.transaction_reference,
       p.stripe_payment_intent_id,
       p.refund_status AS payment_refund_status,
       p.stripe_refund_id
     FROM bookings bk
     JOIN users u ON u.id = bk.user_id
     LEFT JOIN bikes bi ON bi.id = bk.bike_id
     LEFT JOIN LATERAL (
       SELECT * FROM payments pay WHERE pay.booking_id = bk.id ORDER BY pay.created_at DESC LIMIT 1
     ) p ON TRUE
     WHERE bk.id = $1 ${userClause}
     LIMIT 1`,
    params
  );
  return result.rows[0] || null;
}

async function notifyAdminUsers({ title, message, bookingId, userId }) {
  try {
    const admins = await db.query("SELECT id FROM users WHERE role::text = 'admin' AND is_active = TRUE");
    for (const admin of admins.rows) {
      notify.push({
        userId: admin.id,
        type: "refund_request",
        kind: "warning",
        title,
        message,
        relatedEntityType: "booking",
        relatedEntityId: bookingId,
      });
    }
  } catch (err) {
    console.warn("[refundRequests] admin notification skipped:", err.message);
  }

  notify.pushAdmin({
    activityType: "refund_requested",
    title,
    description: message,
    bookingId,
    userId,
  });
}

async function createRefundRequest({ userId, bookingId, reason, refundType }) {
  await ensureRefundSchema();
  const cleanReason = String(reason || "").trim();
  if (cleanReason.length < 8) {
    const err = new Error("Please explain why you are requesting a refund.");
    err.status = 400;
    throw err;
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const booking = await getBookingForRefund(bookingId, userId, client);
    if (!booking) {
      const err = new Error("Booking not found.");
      err.status = 404;
      throw err;
    }

    if (!isRefundEligibleStatus(booking.booking_status)) {
      const err = new Error("This booking is not eligible for a no-show or expired-ride refund request.");
      err.status = 400;
      throw err;
    }

    const existing = await client.query(
      `SELECT id, status
         FROM refund_requests
        WHERE booking_id = $1
          AND user_id = $2
          AND status IN ('pending_review','approved','refunded','approved_pending_manual_processing')
        ORDER BY requested_at DESC
        LIMIT 1`,
      [bookingId, userId]
    );
    if (existing.rows[0]) {
      const err = new Error("A refund request for this booking is already under review.");
      err.status = 409;
      throw err;
    }

    const pricing = await settingsService.getPricingSettings().catch(() => ({}));
    const estimate = buildRefundEstimate(
      {
        ...booking,
        status: booking.booking_status,
        amount_paid: booking.payment_amount || booking.fee_amount,
      },
      pricing
    );

    const inserted = await client.query(
      `INSERT INTO refund_requests (
         booking_id, user_id, payment_id, amount_paid, calculated_refund_amount,
         reason, refund_type, status, policy_snapshot, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_review',$8::jsonb,NOW())
       RETURNING *`,
      [
        booking.booking_id,
        booking.user_id,
        booking.payment_id,
        estimate.amountPaid,
        estimate.calculatedRefundAmount,
        cleanReason.slice(0, 2000),
        refundType || estimate.refundType || "expired",
        JSON.stringify(estimate),
      ]
    );

    await client.query("UPDATE bookings SET refund_status = 'requested', updated_at = NOW() WHERE id = $1", [booking.booking_id]);
    if (booking.payment_id) {
      await client.query("UPDATE payments SET refund_status = 'requested', updated_at = NOW() WHERE id = $1", [booking.payment_id]);
    }

    await client.query("COMMIT");

    const request = inserted.rows[0];
    notify.push({
      userId,
      type: "refund_request",
      kind: "info",
      title: "Refund request submitted",
      message: "Your refund request has been submitted for admin review.",
      relatedEntityType: "booking",
      relatedEntityId: booking.booking_id,
    });
    await notifyAdminUsers({
      title: `New refund request for booking #${booking.booking_id}`,
      message: `New refund request from ${booking.full_name || booking.email || "a student"} for booking #${booking.booking_id}.`,
      bookingId: booking.booking_id,
      userId,
    });

    return { request, estimate };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function rowToRefundRequest(row) {
  const policy = row.policy_snapshot || {};
  return {
    id: row.id,
    bookingId: row.booking_id,
    userId: row.user_id,
    userName: row.full_name || row.user_name || null,
    userEmail: row.email || null,
    bikeId: row.bike_id || null,
    bikeCode: row.bike_code || null,
    bookingType: row.booking_type || null,
    rideStatus: row.booking_status || null,
    scheduledAt: row.start_time || null,
    amountPaid: money(row.amount_paid),
    calculatedRefundAmount: money(row.calculated_refund_amount),
    approvedRefundAmount: row.approved_refund_amount == null ? null : money(row.approved_refund_amount),
    reason: row.reason || "",
    adminNote: row.admin_note || "",
    refundType: row.refund_type,
    status: row.status,
    policy,
    paymentId: row.payment_id || null,
    paymentStatus: row.payment_status || null,
    transactionReference: row.transaction_reference || null,
    stripeRefundId: row.stripe_refund_id || null,
    requestedAt: row.requested_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by || null,
  };
}

async function listUserRefundRequests(userId) {
  await ensureRefundSchema();
  const result = await db.query(
    `SELECT rr.*, bk.status::text AS booking_status, bk.booking_type, bk.pricing_mode,
            bi.bike_code, bk.bike_id, p.status::text AS payment_status, p.transaction_reference
       FROM refund_requests rr
       JOIN bookings bk ON bk.id = rr.booking_id
       LEFT JOIN bikes bi ON bi.id = bk.bike_id
       LEFT JOIN payments p ON p.id = rr.payment_id
      WHERE rr.user_id = $1
      ORDER BY rr.requested_at DESC`,
    [userId]
  );
  return result.rows.map(rowToRefundRequest);
}

async function listAdminRefundRequests(status = "") {
  await ensureRefundSchema();
  const params = [];
  let where = "";
  if (status) {
    params.push(status);
    where = `WHERE rr.status = $1`;
  }
  const result = await db.query(
    `SELECT rr.*, u.full_name, u.email, bk.status::text AS booking_status,
            bk.booking_type, bk.pricing_mode, bk.start_time, bk.bike_id,
            bi.bike_code, p.status::text AS payment_status, p.transaction_reference
       FROM refund_requests rr
       JOIN users u ON u.id = rr.user_id
       JOIN bookings bk ON bk.id = rr.booking_id
       LEFT JOIN bikes bi ON bi.id = bk.bike_id
       LEFT JOIN payments p ON p.id = rr.payment_id
       ${where}
      ORDER BY CASE rr.status WHEN 'pending_review' THEN 0 ELSE 1 END,
               rr.requested_at DESC
      LIMIT 200`,
    params
  );
  return result.rows.map(rowToRefundRequest);
}

async function getAdminRefundRequest(id) {
  await ensureRefundSchema();
  const result = await db.query(
    `SELECT rr.*, u.full_name, u.email, bk.status::text AS booking_status,
            bk.booking_type, bk.pricing_mode, bk.start_time, bk.end_time,
            bk.duration_minutes, bk.unlock_fee, bk.per_minute_fee, bk.bike_id,
            bi.bike_code, p.status::text AS payment_status, p.transaction_reference
       FROM refund_requests rr
       JOIN users u ON u.id = rr.user_id
       JOIN bookings bk ON bk.id = rr.booking_id
       LEFT JOIN bikes bi ON bi.id = bk.bike_id
       LEFT JOIN payments p ON p.id = rr.payment_id
      WHERE rr.id = $1`,
    [id]
  );
  return result.rows[0] ? rowToRefundRequest(result.rows[0]) : null;
}

function choosePaymentIntent(row) {
  const candidates = [
    row.stripe_payment_intent_id,
    row.upfront_payment_intent_id,
    row.unlock_payment_intent_id,
    row.final_payment_intent_id,
    row.transaction_reference,
  ];
  return candidates.find((value) => typeof value === "string" && value.startsWith("pi_")) || null;
}

async function approveRefundRequest({ id, adminId, approvedAmount, adminNote }) {
  await ensureRefundSchema();
  const cleanNote = String(adminNote || "").trim().slice(0, 1000);
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      `SELECT rr.*, bk.upfront_payment_intent_id, bk.unlock_payment_intent_id, bk.final_payment_intent_id,
              p.stripe_payment_intent_id, p.transaction_reference, p.amount AS payment_amount,
              u.full_name, u.email
         FROM refund_requests rr
         JOIN bookings bk ON bk.id = rr.booking_id
         LEFT JOIN users u ON u.id = rr.user_id
         LEFT JOIN payments p ON p.id = rr.payment_id
        WHERE rr.id = $1
        FOR UPDATE`,
      [id]
    );
    const row = cur.rows[0];
    if (!row) {
      const err = new Error("Refund request not found.");
      err.status = 404;
      throw err;
    }
    if (row.status !== "pending_review") {
      const err = new Error("Only pending refund requests can be approved.");
      err.status = 400;
      throw err;
    }

    const maxRefund = money(row.calculated_refund_amount);
    const amount = approvedAmount == null || approvedAmount === ""
      ? maxRefund
      : Math.min(maxRefund, Math.max(0, money(approvedAmount)));

    let status = amount > 0 ? "approved_pending_manual_processing" : "approved";
    let stripeRefundId = null;
    const paymentIntent = choosePaymentIntent(row);

    if (amount > 0 && paymentIntent && stripeConfigured()) {
      const params = new URLSearchParams();
      params.set("payment_intent", paymentIntent);
      params.set("amount", String(Math.round(amount * 100)));
      params.set("metadata[refund_request_id]", String(row.id));
      params.set("metadata[booking_id]", String(row.booking_id));
      const refund = await stripeRequest("/refunds", { method: "POST", body: params });
      stripeRefundId = refund.id || null;
      status = "refunded";
    }

    const updated = await client.query(
      `UPDATE refund_requests
          SET status = $2,
              approved_refund_amount = $3,
              admin_note = NULLIF($4, ''),
              stripe_refund_id = $5,
              reviewed_at = NOW(),
              reviewed_by = $6,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, status, amount, cleanNote, stripeRefundId, adminId || null]
    );

    await client.query("UPDATE bookings SET refund_status = $2, updated_at = NOW() WHERE id = $1", [row.booking_id, status]);
    if (row.payment_id) {
      await client.query(
        `UPDATE payments
            SET refund_status = $2,
                stripe_refund_id = COALESCE($3, stripe_refund_id),
                refunded_at = CASE WHEN $2 = 'refunded' THEN NOW() ELSE refunded_at END,
                status = CASE
                           WHEN $2 = 'refunded' AND $4 >= amount THEN 'refunded'::payment_status
                           ELSE status
                         END,
                updated_at = NOW()
          WHERE id = $1`,
        [row.payment_id, status, stripeRefundId, amount]
      );
    }

    await client.query(
      `INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, details, created_at)
       VALUES ($1, 'approve_refund_request', 'refund_request', $2, $3::jsonb, NOW())`,
      [adminId || null, id, JSON.stringify({ bookingId: row.booking_id, approvedAmount: amount, status, stripeRefundId })]
    ).catch(() => {});

    await client.query("COMMIT");

    notify.push({
      userId: row.user_id,
      type: "refund_request",
      kind: "success",
      title: "Refund request approved",
      message: status === "refunded"
        ? `Your refund request was approved. Refund amount: $${amount.toFixed(2)}.`
        : `Your refund request was approved for $${amount.toFixed(2)} and is waiting for manual processing.`,
      relatedEntityType: "booking",
      relatedEntityId: row.booking_id,
    });
    notify.pushAdmin({
      activityType: "refund_requested",
      title: `Refund request approved`,
      description: `Refund request #${id} for booking #${row.booking_id} approved for $${amount.toFixed(2)}.`,
      bookingId: row.booking_id,
      userId: row.user_id,
    });

    return { request: updated.rows[0], status, stripeRefundId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function rejectRefundRequest({ id, adminId, adminNote }) {
  await ensureRefundSchema();
  const cleanNote = String(adminNote || "").trim().slice(0, 1000);
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query("SELECT * FROM refund_requests WHERE id = $1 FOR UPDATE", [id]);
    const row = cur.rows[0];
    if (!row) {
      const err = new Error("Refund request not found.");
      err.status = 404;
      throw err;
    }
    if (row.status !== "pending_review") {
      const err = new Error("Only pending refund requests can be rejected.");
      err.status = 400;
      throw err;
    }

    const updated = await client.query(
      `UPDATE refund_requests
          SET status = 'rejected',
              admin_note = NULLIF($2, ''),
              reviewed_at = NOW(),
              reviewed_by = $3,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, cleanNote, adminId || null]
    );
    await client.query("UPDATE bookings SET refund_status = 'rejected', updated_at = NOW() WHERE id = $1", [row.booking_id]);
    if (row.payment_id) {
      await client.query("UPDATE payments SET refund_status = 'rejected', updated_at = NOW() WHERE id = $1", [row.payment_id]);
    }
    await client.query(
      `INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, details, created_at)
       VALUES ($1, 'reject_refund_request', 'refund_request', $2, $3::jsonb, NOW())`,
      [adminId || null, id, JSON.stringify({ bookingId: row.booking_id, adminNote: cleanNote })]
    ).catch(() => {});
    await client.query("COMMIT");

    notify.push({
      userId: row.user_id,
      type: "refund_request",
      kind: "warning",
      title: "Refund request rejected",
      message: cleanNote ? `Your refund request was reviewed and rejected. Reason: ${cleanNote}` : "Your refund request was reviewed and rejected.",
      relatedEntityType: "booking",
      relatedEntityId: row.booking_id,
    });
    notify.pushAdmin({
      activityType: "refund_requested",
      title: `Refund request rejected`,
      description: `Refund request #${id} for booking #${row.booking_id} was rejected.`,
      bookingId: row.booking_id,
      userId: row.user_id,
    });

    return { request: updated.rows[0] };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  ensureRefundSchema,
  buildRefundEstimate,
  isNeverStartedStatus,
  isRefundEligibleStatus,
  createRefundRequest,
  listUserRefundRequests,
  listAdminRefundRequests,
  getAdminRefundRequest,
  approveRefundRequest,
  rejectRefundRequest,
};
