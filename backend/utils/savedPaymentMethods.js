const db = require("../db");

const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();

let readyPromise = null;

async function ensurePaymentMethodSchema() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(120)");
      await db.query(`
        CREATE TABLE IF NOT EXISTS student_payment_methods (
          id BIGSERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          stripe_customer_id VARCHAR(120) NOT NULL,
          stripe_payment_method_id VARCHAR(160) NOT NULL UNIQUE,
          brand VARCHAR(40),
          last4 VARCHAR(8),
          exp_month INTEGER,
          exp_year INTEGER,
          is_default BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query("CREATE INDEX IF NOT EXISTS idx_student_payment_methods_user ON student_payment_methods(user_id)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_student_payment_methods_default ON student_payment_methods(user_id, is_default)");
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status VARCHAR(40)");
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(120)");
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_payment_method_id VARCHAR(160)");
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS unlock_payment_intent_id VARCHAR(160)");
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS upfront_payment_intent_id VARCHAR(160)");
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS final_payment_intent_id VARCHAR(160)");
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS final_amount DECIMAL(10,2)");
      // Newer columns the unified Stripe flow relies on.
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS ride_mode VARCHAR(30)");
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS unlock_fee_paid DECIMAL(10,2)");
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_checkout_session_id VARCHAR(160)");
      await db.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(160)");
      // payments ledger - extra columns for type and stripe ids
      await db.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS type VARCHAR(40)");
      await db.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(160)");
      await db.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_checkout_session_id VARCHAR(160)");

      // De-dupe any existing duplicates left over from older flows where
      // attaching the same physical card created multiple pm_xxx ids.
      // We keep the row marked default (or the most recent one) and drop
      // the rest. Safe to run on every boot - it's a no-op once clean.
      try {
        await db.query(`
          WITH ranked AS (
            SELECT id, user_id, brand, last4, exp_month, exp_year, is_default, created_at,
                   ROW_NUMBER() OVER (
                     PARTITION BY user_id, LOWER(brand), last4, exp_month, exp_year
                     ORDER BY is_default DESC, created_at DESC, id DESC
                   ) AS rn
              FROM student_payment_methods
             WHERE brand IS NOT NULL AND last4 IS NOT NULL
          )
          DELETE FROM student_payment_methods spm
            USING ranked
           WHERE spm.id = ranked.id
             AND ranked.rn > 1
        `);
      } catch (e) {
        console.warn("[paymentMethods] dedupe pass skipped:", e.message);
      }
      // Best-effort unique index. Use a partial index so legacy rows without
      // brand/last4 do not block creation. If it already exists, Postgres
      // is happy with the IF NOT EXISTS.
      try {
        await db.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS uq_student_payment_methods_card
            ON student_payment_methods (user_id, LOWER(brand), last4, exp_month, exp_year)
            WHERE brand IS NOT NULL AND last4 IS NOT NULL
        `);
      } catch (e) {
        console.warn("[paymentMethods] unique index skipped:", e.message);
      }
    })().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

function stripeConfigured() {
  return Boolean(STRIPE_SECRET_KEY && STRIPE_SECRET_KEY.trim());
}

async function stripeRequest(path, { method = "GET", body } = {}) {
  if (!stripeConfigured()) {
    const err = new Error("Stripe is not configured. Add STRIPE_SECRET_KEY in backend/.env.");
    err.status = 503;
    throw err;
  }
  const headers = { Authorization: `Bearer ${STRIPE_SECRET_KEY}` };
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
  const response = await fetch(`https://api.stripe.com/v1${path}`, { method, headers, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error((data.error && data.error.message) || "Stripe request failed.");
    err.status = response.status;
    throw err;
  }
  return data;
}

async function getUserForPayment(userId) {
  await ensurePaymentMethodSchema();
  const result = await db.query(
    "SELECT id, full_name, email, stripe_customer_id FROM users WHERE id = $1",
    [userId]
  );
  const user = result.rows[0];
  if (!user) {
    const err = new Error("User not found.");
    err.status = 404;
    throw err;
  }
  return user;
}

async function ensureStripeCustomer(userId) {
  const user = await getUserForPayment(userId);
  if (user.stripe_customer_id) return user.stripe_customer_id;

  const params = new URLSearchParams();
  if (user.email) params.set("email", user.email);
  if (user.full_name) params.set("name", user.full_name);
  params.set("metadata[user_id]", String(user.id));

  const customer = await stripeRequest("/customers", { method: "POST", body: params });
  await db.query("UPDATE users SET stripe_customer_id = $2 WHERE id = $1", [user.id, customer.id]);
  return customer.id;
}

async function listPaymentMethods(userId) {
  await ensurePaymentMethodSchema();
  const result = await db.query(
    `SELECT id, stripe_payment_method_id, brand, last4, exp_month, exp_year, is_default, created_at
       FROM student_payment_methods
      WHERE user_id = $1
      ORDER BY is_default DESC, created_at DESC`,
    [userId]
  );
  // Belt-and-braces: collapse any duplicates by brand/last4/exp at read time
  // so the UI never shows two of the same card even if a write race slipped
  // past the unique index.
  const seen = new Set();
  const unique = [];
  for (const row of result.rows) {
    const fp = `${(row.brand || "").toLowerCase()}|${row.last4 || ""}|${row.exp_month || ""}|${row.exp_year || ""}`;
    if (seen.has(fp)) continue;
    seen.add(fp);
    unique.push(row);
  }
  return unique;
}

async function getDefaultPaymentMethod(userId) {
  await ensurePaymentMethodSchema();
  const result = await db.query(
    `SELECT *
       FROM student_payment_methods
      WHERE user_id = $1
      ORDER BY is_default DESC, created_at DESC
      LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

function normaliseCard(paymentMethod) {
  const card = paymentMethod.card || {};
  return {
    brand: String(card.brand || "card").slice(0, 40),
    last4: String(card.last4 || "").slice(0, 8),
    expMonth: Number(card.exp_month) || null,
    expYear: Number(card.exp_year) || null,
  };
}

async function storePaymentMethod(userId, stripeCustomerId, stripePaymentMethodId, options = {}) {
  await ensurePaymentMethodSchema();
  if (!stripePaymentMethodId) throw new Error("Missing Stripe payment method.");

  const paymentMethod = options.paymentMethod || await stripeRequest(`/payment_methods/${encodeURIComponent(stripePaymentMethodId)}`);
  const card = normaliseCard(paymentMethod);
  const existingAny = await db.query("SELECT id FROM student_payment_methods WHERE user_id = $1 LIMIT 1", [userId]);
  const makeDefault = options.makeDefault !== false || existingAny.rowCount === 0;

  // Duplicate check by physical card metadata: a fresh attach of the SAME
  // card creates a brand-new pm_xxx id on Stripe, so unique
  // (stripe_payment_method_id) is not enough. We dedupe on the card
  // fingerprint (brand + last4 + expiry) per user.
  let duplicateRow = null;
  if (card.brand && card.last4 && card.expMonth && card.expYear) {
    const dupe = await db.query(
      `SELECT id, stripe_payment_method_id
         FROM student_payment_methods
        WHERE user_id = $1
          AND LOWER(brand) = LOWER($2)
          AND last4 = $3
          AND exp_month = $4
          AND exp_year = $5
        LIMIT 1`,
      [userId, card.brand, card.last4, card.expMonth, card.expYear]
    );
    duplicateRow = dupe.rows[0] || null;
  }

  if (duplicateRow) {
    // Keep the existing row; refresh customer/pm id metadata and detach the
    // freshly-attached pm so it does not accumulate on Stripe's side.
    if (duplicateRow.stripe_payment_method_id !== stripePaymentMethodId) {
      await stripeRequest(
        `/payment_methods/${encodeURIComponent(stripePaymentMethodId)}/detach`,
        { method: "POST", body: new URLSearchParams() }
      ).catch(() => {});
    }
    if (makeDefault) {
      await db.query("UPDATE student_payment_methods SET is_default = false, updated_at = NOW() WHERE user_id = $1", [userId]);
    }
    await db.query(
      `UPDATE student_payment_methods
          SET stripe_customer_id = $2,
              stripe_payment_method_id = COALESCE(stripe_payment_method_id, $3),
              is_default = $4,
              updated_at = NOW()
        WHERE id = $1`,
      [duplicateRow.id, stripeCustomerId, duplicateRow.stripe_payment_method_id || stripePaymentMethodId, makeDefault]
    );
    if (makeDefault) {
      const params = new URLSearchParams();
      params.set("invoice_settings[default_payment_method]", duplicateRow.stripe_payment_method_id || stripePaymentMethodId);
      await stripeRequest(`/customers/${encodeURIComponent(stripeCustomerId)}`, { method: "POST", body: params }).catch(() => {});
    }
    return getDefaultPaymentMethod(userId);
  }

  if (makeDefault) {
    await db.query("UPDATE student_payment_methods SET is_default = false, updated_at = NOW() WHERE user_id = $1", [userId]);
  }

  await db.query(
    `INSERT INTO student_payment_methods (
       user_id, stripe_customer_id, stripe_payment_method_id, brand, last4, exp_month, exp_year, is_default, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (stripe_payment_method_id) DO UPDATE
       SET stripe_customer_id = EXCLUDED.stripe_customer_id,
           brand = EXCLUDED.brand,
           last4 = EXCLUDED.last4,
           exp_month = EXCLUDED.exp_month,
           exp_year = EXCLUDED.exp_year,
           is_default = EXCLUDED.is_default,
           updated_at = NOW()`,
    [
      userId,
      stripeCustomerId,
      stripePaymentMethodId,
      card.brand,
      card.last4,
      card.expMonth,
      card.expYear,
      makeDefault,
    ]
  );

  if (makeDefault) {
    const params = new URLSearchParams();
    params.set("invoice_settings[default_payment_method]", stripePaymentMethodId);
    await stripeRequest(`/customers/${encodeURIComponent(stripeCustomerId)}`, { method: "POST", body: params }).catch(() => {});
  }

  return getDefaultPaymentMethod(userId);
}

async function savePaymentMethodFromCheckoutSession(userId, sessionId) {
  await ensurePaymentMethodSchema();
  const session = await stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (String(session.client_reference_id || "") && String(session.client_reference_id) !== String(userId)) {
    const err = new Error("This payment session does not belong to the logged-in user.");
    err.status = 403;
    throw err;
  }
  if (session.payment_status && session.payment_status !== "paid") {
    throw new Error("Stripe has not confirmed the unlock payment.");
  }

  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (!paymentIntentId) throw new Error("Stripe session did not include a payment intent.");
  const paymentIntent = await stripeRequest(`/payment_intents/${encodeURIComponent(paymentIntentId)}`);
  const paymentMethodId = typeof paymentIntent.payment_method === "string"
    ? paymentIntent.payment_method
    : paymentIntent.payment_method?.id;
  if (!paymentMethodId) throw new Error("Stripe did not return a saved payment method.");

  const customerId = typeof session.customer === "string"
    ? session.customer
    : (session.customer && session.customer.id) || await ensureStripeCustomer(userId);
  const stored = await storePaymentMethod(userId, customerId, paymentMethodId, { makeDefault: true });

  return {
    stripeCustomerId: customerId,
    stripePaymentMethodId: paymentMethodId,
    unlockPaymentIntentId: paymentIntentId,
    card: stored,
    amountTotal: session.amount_total,
    currency: session.currency,
  };
}

async function deletePaymentMethod(userId, id) {
  await ensurePaymentMethodSchema();
  const result = await db.query(
    "DELETE FROM student_payment_methods WHERE user_id = $1 AND id = $2 RETURNING stripe_payment_method_id",
    [userId, id]
  );
  const row = result.rows[0];
  if (!row) {
    const err = new Error("Payment method not found.");
    err.status = 404;
    throw err;
  }
  await stripeRequest(`/payment_methods/${encodeURIComponent(row.stripe_payment_method_id)}/detach`, {
    method: "POST",
    body: new URLSearchParams(),
  }).catch(() => {});
  const remaining = await listPaymentMethods(userId);
  if (remaining.length && !remaining.some((pm) => pm.is_default)) {
    await db.query("UPDATE student_payment_methods SET is_default = true, updated_at = NOW() WHERE id = $1", [remaining[0].id]);
  }
  return true;
}

async function setDefaultPaymentMethod(userId, id) {
  await ensurePaymentMethodSchema();
  const result = await db.query(
    "SELECT id, stripe_customer_id, stripe_payment_method_id FROM student_payment_methods WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  const row = result.rows[0];
  if (!row) {
    const err = new Error("Payment method not found.");
    err.status = 404;
    throw err;
  }
  await db.query("UPDATE student_payment_methods SET is_default = false, updated_at = NOW() WHERE user_id = $1", [userId]);
  await db.query("UPDATE student_payment_methods SET is_default = true, updated_at = NOW() WHERE id = $1", [id]);
  const params = new URLSearchParams();
  params.set("invoice_settings[default_payment_method]", row.stripe_payment_method_id);
  await stripeRequest(`/customers/${encodeURIComponent(row.stripe_customer_id)}`, { method: "POST", body: params }).catch(() => {});
  return getDefaultPaymentMethod(userId);
}

async function requireSavedPaymentMethod(userId) {
  const method = await getDefaultPaymentMethod(userId);
  if (!method) {
    const err = new Error("You must save a payment card to book a Pay-As-You-Go ride.");
    err.status = 402;
    throw err;
  }
  return method;
}

module.exports = {
  ensurePaymentMethodSchema,
  ensureStripeCustomer,
  getDefaultPaymentMethod,
  listPaymentMethods,
  savePaymentMethodFromCheckoutSession,
  storePaymentMethod,
  deletePaymentMethod,
  setDefaultPaymentMethod,
  requireSavedPaymentMethod,
  stripeConfigured,
  stripeRequest,
};
