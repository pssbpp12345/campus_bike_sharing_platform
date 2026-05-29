const db = require("../db");
const fs = require("fs");
const path = require("path");

let readyPromise = null;
let cbdSeedAttempted = false;

async function runSydneyCbdSeed() {
  if (cbdSeedAttempted) return;
  cbdSeedAttempted = true;
  try {
    const file = path.join(__dirname, "..", "..", "database", "10_sydney_cbd_stations.sql");
    if (!fs.existsSync(file)) return;
    const sql = fs.readFileSync(file, "utf8");
    await db.query(sql);
  } catch (err) {
    // Seed is best-effort — log and carry on.
    console.warn("[ensureStudentSchema] CBD seed skipped:", err.message);
  }
}

async function ensureStudentSchema() {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_kind') THEN
          CREATE TYPE notification_kind AS ENUM ('info', 'success', 'warning', 'error');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_status') THEN
          CREATE TYPE ticket_status AS ENUM ('open', 'in_progress', 'resolved', 'closed');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_priority') THEN
          CREATE TYPE ticket_priority AS ENUM ('low', 'medium', 'high', 'urgent');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_category') THEN
          CREATE TYPE ticket_category AS ENUM ('booking', 'bike', 'payment', 'account', 'station', 'other');
        END IF;
      END $$;
    `);

    await db.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS distance_km DECIMAL(8,2) DEFAULT 0;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS unlock_fee DECIMAL(8,2) DEFAULT 2.50;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS per_minute_fee DECIMAL(8,2) DEFAULT 0.20;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_type VARCHAR(30) DEFAULT 'scheduled';
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pricing_mode VARCHAR(30) DEFAULT 'pay_as_you_go';
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;

      CREATE TABLE IF NOT EXISTS notifications (
        id                    SERIAL PRIMARY KEY,
        user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type                  VARCHAR(50) NOT NULL,
        kind                  notification_kind NOT NULL DEFAULT 'info',
        title                 VARCHAR(160) NOT NULL,
        message               TEXT,
        related_entity_type   VARCHAR(50),
        related_entity_id     INTEGER,
        is_read               BOOLEAN NOT NULL DEFAULT FALSE,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_notifications_user_created
        ON notifications(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_unread
        ON notifications(user_id) WHERE is_read = FALSE;

      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        email_notifications  BOOLEAN NOT NULL DEFAULT TRUE,
        booking_reminders    BOOLEAN NOT NULL DEFAULT TRUE,
        ride_receipts_email  BOOLEAN NOT NULL DEFAULT TRUE,
        push_notifications   BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Privacy preferences columns (added later)
      ALTER TABLE user_preferences
        ADD COLUMN IF NOT EXISTS show_ride_stats_on_profile BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE user_preferences
        ADD COLUMN IF NOT EXISTS keep_receipt_shortcuts     BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE user_preferences
        ADD COLUMN IF NOT EXISTS support_follow_ups         BOOLEAN NOT NULL DEFAULT TRUE;

      CREATE TABLE IF NOT EXISTS support_tickets (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category        ticket_category NOT NULL DEFAULT 'other',
        subject         VARCHAR(200) NOT NULL,
        description     TEXT NOT NULL,
        priority        ticket_priority NOT NULL DEFAULT 'medium',
        booking_id      INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
        status          ticket_status NOT NULL DEFAULT 'open',
        admin_response  TEXT,
        resolved_at     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_user ON support_tickets(user_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);
      CREATE INDEX IF NOT EXISTS idx_tickets_created ON support_tickets(created_at DESC);

      -- Older schema versions treated pending future bookings as "active" in
      -- these partial unique indexes. Keep the one-active-ride rule, but allow
      -- students to hold any number of upcoming scheduled bookings.
      DROP INDEX IF EXISTS idx_bookings_one_active_per_user;
      DROP INDEX IF EXISTS idx_bookings_one_active_per_bike;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_one_active_per_user
        ON bookings(user_id) WHERE status = 'active';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_one_active_per_bike
        ON bookings(bike_id) WHERE status = 'active';
    `);

    // Sydney CBD stations — runs once per process.
    await runSydneyCbdSeed();
  })().catch((err) => {
    readyPromise = null;
    throw err;
  });

  return readyPromise;
}

module.exports = { ensureStudentSchema };
