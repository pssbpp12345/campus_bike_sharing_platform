const db = require("../db");

const RANGE_CONFIG = {
  today: { unit: "hour", chartCount: 24 },
  week: { unit: "day", chartCount: 7 },
  month: { unit: "day", chartCount: 30 },
  year: { unit: "month", chartCount: 12 },
};

const LIVE_ACTIVE_SQL = `
  bk.status = 'active'
  AND bk.start_time <= NOW()
  AND COALESCE(
    bk.end_time,
    bk.expires_at,
    bk.start_time + (COALESCE(bk.duration_minutes, 60) || ' minutes')::interval
  ) > NOW()
`;

function asMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function pctTrend(current, previous) {
  const cur = Number(current || 0);
  const prev = Number(previous || 0);
  if (prev === 0) return cur === 0 ? 0 : 100;
  return Number((((cur - prev) / Math.abs(prev)) * 100).toFixed(1));
}

function parseRange(value) {
  const key = Object.prototype.hasOwnProperty.call(RANGE_CONFIG, value) ? value : "month";
  const now = new Date();
  let start;
  if (key === "today") {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
  } else if (key === "week") {
    start = new Date(now);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
  } else if (key === "year") {
    start = new Date(now.getFullYear(), 0, 1);
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  const currentEnd = now;
  const durationMs = currentEnd.getTime() - start.getTime();
  return {
    key,
    currentStart: start,
    currentEnd,
    prevStart: new Date(start.getTime() - durationMs),
    prevEnd: start,
  };
}

async function paymentSummaryBetween(start, end) {
  const result = await db.query(
    `
    WITH scoped AS (
      SELECT *,
             COALESCE(paid_at, updated_at, created_at) AS activity_at
        FROM payments
       WHERE COALESCE(paid_at, updated_at, created_at) >= $1
         AND COALESCE(paid_at, updated_at, created_at) < $2
    ),
    paid AS (
      SELECT COALESCE(SUM(amount), 0)::numeric AS amount,
             COUNT(*)::int AS count,
             COALESCE(AVG(amount), 0)::numeric AS average
        FROM scoped
       WHERE status = 'paid'
    ),
    pending AS (
      SELECT COUNT(*)::int AS count FROM scoped WHERE status = 'pending'
    ),
    failed AS (
      SELECT COUNT(*)::int AS count FROM scoped WHERE status = 'failed'
    ),
    refunded AS (
      SELECT COALESCE(SUM(amount), 0)::numeric AS amount,
             COUNT(*)::int AS count
        FROM scoped
       WHERE status = 'refunded'
    ),
    admin_refunds AS (
      SELECT COALESCE(SUM(amount), 0)::numeric AS amount
        FROM admin_expenses
       WHERE expense_type = 'refund'
         AND created_at >= $1
         AND created_at < $2
    ),
    payment_refunds_without_admin_row AS (
      SELECT COALESCE(SUM(p.amount), 0)::numeric AS amount
        FROM scoped p
       WHERE p.status = 'refunded'
         AND NOT EXISTS (
           SELECT 1
             FROM admin_expenses ae
            WHERE ae.expense_type = 'refund'
              AND ae.related_booking_id = p.booking_id
         )
    )
    SELECT
      paid.amount AS paid_revenue,
      paid.count AS successful_payments,
      pending.count AS pending_payments,
      failed.count AS failed_payments,
      refunded.amount AS refunded_payment_amount,
      refunded.count AS refunded_payments,
      (admin_refunds.amount + payment_refunds_without_admin_row.amount)::numeric AS refunds,
      paid.average AS average_payment
      FROM paid, pending, failed, refunded, admin_refunds, payment_refunds_without_admin_row
    `,
    [start, end]
  );
  const row = result.rows[0] || {};
  const paidRevenue = asMoney(row.paid_revenue);
  const refunds = asMoney(row.refunds);
  return {
    paidRevenue,
    successfulPayments: Number(row.successful_payments || 0),
    pendingPayments: Number(row.pending_payments || 0),
    failedPayments: Number(row.failed_payments || 0),
    refundedPaymentAmount: asMoney(row.refunded_payment_amount),
    refundedPayments: Number(row.refunded_payments || 0),
    refunds,
    averagePayment: asMoney(row.average_payment),
    netPaymentBalance: asMoney(paidRevenue - refunds),
  };
}

async function financialSummaryBetween(start, end) {
  const payments = await paymentSummaryBetween(start, end);
  const expenses = await expenseSummaryBetweenWithRefunds(start, end, payments.refunds);
  return {
    bookingIncome: payments.paidRevenue,
    totalRevenue: payments.paidRevenue,
    refunds: expenses.refunds,
    maintenanceCost: expenses.maintenanceCost,
    operationalExpenses: expenses.operationalExpenses,
    totalExpenses: expenses.totalExpenses,
    netBalance: asMoney(payments.paidRevenue - expenses.totalExpenses),
    netProfit: asMoney(payments.paidRevenue - expenses.totalExpenses),
    successfulPayments: payments.successfulPayments,
    pendingPayments: payments.pendingPayments,
    failedPayments: payments.failedPayments,
    refundedPayments: payments.refundedPayments,
    refundsProcessed: payments.refunds,
    averagePayment: payments.averagePayment,
    netPaymentBalance: payments.netPaymentBalance,
  };
}

async function expenseSummaryBetweenWithRefunds(start, end, refunds) {
  const result = await db.query(
    `
    WITH maintenance AS (
      SELECT (
        COALESCE((SELECT SUM(cost) FROM maintenance_logs WHERE COALESCE(reported_at, created_at) >= $1 AND COALESCE(reported_at, created_at) < $2), 0)
        + COALESCE((SELECT SUM(amount) FROM admin_expenses WHERE expense_type IN ('maintenance','repair') AND created_at >= $1 AND created_at < $2), 0)
      )::numeric AS amount
    ),
    operations AS (
      SELECT COALESCE(SUM(amount), 0)::numeric AS amount
        FROM admin_expenses
       WHERE expense_type IN ('operational','other')
         AND created_at >= $1
         AND created_at < $2
    )
    SELECT maintenance.amount AS maintenance_cost,
           operations.amount AS operational_expenses,
           ($3::numeric + maintenance.amount + operations.amount)::numeric AS total_expenses
      FROM maintenance, operations
    `,
    [start, end, refunds]
  );
  const row = result.rows[0] || {};
  return {
    refunds: asMoney(refunds),
    maintenanceCost: asMoney(row.maintenance_cost),
    operationalExpenses: asMoney(row.operational_expenses),
    totalExpenses: asMoney(row.total_expenses),
  };
}

async function financialOverview(range) {
  const current = await financialSummaryBetween(range.currentStart, range.currentEnd);
  const previous = await financialSummaryBetween(range.prevStart, range.prevEnd);
  return {
    current,
    previous,
    trends: {
      totalRevenue: pctTrend(current.totalRevenue, previous.totalRevenue),
      totalExpenses: pctTrend(current.totalExpenses, previous.totalExpenses),
      netProfit: pctTrend(current.netProfit, previous.netProfit),
      successfulPayments: pctTrend(current.successfulPayments, previous.successfulPayments),
      pendingPayments: pctTrend(current.pendingPayments, previous.pendingPayments),
      failedPayments: pctTrend(current.failedPayments, previous.failedPayments),
      refundsProcessed: pctTrend(current.refundsProcessed, previous.refundsProcessed),
      refundRequests: pctTrend(current.refundedPayments, previous.refundedPayments),
      averagePayment: pctTrend(current.averagePayment, previous.averagePayment),
      netPaymentBalance: pctTrend(current.netPaymentBalance, previous.netPaymentBalance),
    },
  };
}

async function bookingSummary(range) {
  const result = await db.query(
    `
    WITH live AS (
      SELECT COUNT(*)::int AS active
        FROM bookings bk
        JOIN bikes bi ON bi.id = bk.bike_id
       WHERE ${LIVE_ACTIVE_SQL}
    ),
    cur AS (
      SELECT
        COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS total,
        COUNT(*) FILTER (WHERE status = 'pending' AND start_time > NOW() AND created_at >= $1 AND created_at < $2)::int AS upcoming,
        COUNT(*) FILTER (WHERE status = 'completed' AND created_at >= $1 AND created_at < $2)::int AS completed,
        COUNT(*) FILTER (WHERE status = 'cancelled' AND created_at >= $1 AND created_at < $2)::int AS cancelled
        FROM bookings
    ),
    prev AS (
      SELECT
        COUNT(*) FILTER (WHERE created_at >= $3 AND created_at < $4)::int AS total,
        COUNT(*) FILTER (WHERE status = 'pending' AND start_time > NOW() AND created_at >= $3 AND created_at < $4)::int AS upcoming,
        COUNT(*) FILTER (WHERE status = 'completed' AND created_at >= $3 AND created_at < $4)::int AS completed,
        COUNT(*) FILTER (WHERE status = 'cancelled' AND created_at >= $3 AND created_at < $4)::int AS cancelled
        FROM bookings
    ),
    issues AS (
      SELECT COUNT(*)::int AS booking_issues
        FROM support_tickets
       WHERE category IN ('booking','payment')
         AND status IN ('open','in_progress')
    )
    SELECT
      cur.total,
      live.active,
      cur.upcoming,
      cur.completed,
      cur.cancelled,
      issues.booking_issues,
      prev.total AS prev_total,
      live.active AS prev_active,
      prev.upcoming AS prev_upcoming,
      prev.completed AS prev_completed,
      prev.cancelled AS prev_cancelled
      FROM cur, prev, live, issues
    `,
    [range.currentStart, range.currentEnd, range.prevStart, range.prevEnd]
  );
  const row = result.rows[0] || {};
  const payments = await paymentSummaryBetween(range.currentStart, range.currentEnd);
  const prevPayments = await paymentSummaryBetween(range.prevStart, range.prevEnd);
  return {
    totals: {
      totalBookings: Number(row.total || 0),
      activeRides: Number(row.active || 0),
      upcomingBookings: Number(row.upcoming || 0),
      completedRides: Number(row.completed || 0),
      cancelledBookings: Number(row.cancelled || 0),
      pendingPayments: payments.pendingPayments,
      refundRequests: payments.refundedPayments,
      bookingIssues: Number(row.booking_issues || 0),
    },
    trends: {
      totalBookings: pctTrend(row.total, row.prev_total),
      activeRides: pctTrend(row.active, row.prev_active),
      upcomingBookings: pctTrend(row.upcoming, row.prev_upcoming),
      completedRides: pctTrend(row.completed, row.prev_completed),
      cancelledBookings: pctTrend(row.cancelled, row.prev_cancelled),
      pendingPayments: pctTrend(payments.pendingPayments, prevPayments.pendingPayments),
      refundRequests: pctTrend(payments.refundedPayments, prevPayments.refundedPayments),
    },
  };
}

async function fleetSummary() {
  const result = await db.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE status = 'available')::int AS available_bikes,
      COUNT(*)::int AS total_bikes
      FROM bikes
    `
  );
  return {
    availableBikes: Number(result.rows[0]?.available_bikes || 0),
    totalBikes: Number(result.rows[0]?.total_bikes || 0),
  };
}

async function revenueExpenseSeries(range) {
  const config = RANGE_CONFIG[range.key];
  const result = await db.query(
    `WITH buckets AS (
       SELECT generate_series(
                date_trunc($3, $1::timestamptz),
                date_trunc($3, $2::timestamptz),
                ('1 ' || $3)::interval
              ) AS bucket_start
     ),
     bucketed AS (
       SELECT bucket_start,
              bucket_start + ('1 ' || $3)::interval AS bucket_end
         FROM buckets
        ORDER BY bucket_start DESC
        LIMIT $4
     ),
     revenue AS (
       SELECT date_trunc($3, COALESCE(paid_at, updated_at, created_at)) AS bucket_start,
              SUM(amount)::numeric AS value
         FROM payments
        WHERE status = 'paid'
          AND COALESCE(paid_at, updated_at, created_at) >= $1
          AND COALESCE(paid_at, updated_at, created_at) < $2
        GROUP BY 1
     ),
     admin_exp_non_refund AS (
       SELECT date_trunc($3, created_at) AS bucket_start,
              SUM(amount)::numeric AS value
         FROM admin_expenses
        WHERE expense_type <> 'refund'
          AND created_at >= $1
          AND created_at < $2
        GROUP BY 1
     ),
     admin_refunds AS (
       SELECT date_trunc($3, created_at) AS bucket_start,
              SUM(amount)::numeric AS value
         FROM admin_expenses
        WHERE expense_type = 'refund'
          AND created_at >= $1
          AND created_at < $2
        GROUP BY 1
     ),
     maint_exp AS (
       SELECT date_trunc($3, COALESCE(reported_at, created_at)) AS bucket_start,
              SUM(cost)::numeric AS value
         FROM maintenance_logs
        WHERE COALESCE(reported_at, created_at) >= $1
          AND COALESCE(reported_at, created_at) < $2
          AND cost > 0
        GROUP BY 1
     ),
     payment_refunds_without_admin_row AS (
       SELECT date_trunc($3, COALESCE(p.updated_at, p.paid_at, p.created_at)) AS bucket_start,
              SUM(p.amount)::numeric AS value
         FROM payments p
        WHERE p.status = 'refunded'
          AND COALESCE(p.updated_at, p.paid_at, p.created_at) >= $1
          AND COALESCE(p.updated_at, p.paid_at, p.created_at) < $2
          AND NOT EXISTS (
            SELECT 1
              FROM admin_expenses ae
             WHERE ae.expense_type = 'refund'
               AND ae.related_booking_id = p.booking_id
          )
        GROUP BY 1
     )
     SELECT bucketed.bucket_start,
            COALESCE(revenue.value, 0)::numeric AS revenue,
            (COALESCE(admin_exp_non_refund.value, 0)
             + COALESCE(admin_refunds.value, 0)
             + COALESCE(maint_exp.value, 0)
             + COALESCE(payment_refunds_without_admin_row.value, 0))::numeric AS expenses
       FROM bucketed
       LEFT JOIN revenue ON revenue.bucket_start = bucketed.bucket_start
       LEFT JOIN admin_exp_non_refund ON admin_exp_non_refund.bucket_start = bucketed.bucket_start
       LEFT JOIN admin_refunds ON admin_refunds.bucket_start = bucketed.bucket_start
       LEFT JOIN maint_exp ON maint_exp.bucket_start = bucketed.bucket_start
       LEFT JOIN payment_refunds_without_admin_row ON payment_refunds_without_admin_row.bucket_start = bucketed.bucket_start
      ORDER BY bucketed.bucket_start ASC`,
    [range.currentStart, range.currentEnd, config.unit, config.chartCount]
  );
  return result.rows.map((row) => ({
    bucketStart: row.bucket_start,
    revenue: asMoney(row.revenue),
    expenses: asMoney(row.expenses),
  }));
}

module.exports = {
  RANGE_CONFIG,
  LIVE_ACTIVE_SQL,
  asMoney,
  pctTrend,
  parseRange,
  paymentSummaryBetween,
  financialSummaryBetween,
  financialOverview,
  bookingSummary,
  fleetSummary,
  revenueExpenseSeries,
};
