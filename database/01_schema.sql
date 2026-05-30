-- ============================================================
--  CAMPUS BIKE SHARING PLATFORM — PostgreSQL Schema (Part 1/5)
--  01_schema.sql  —  Types, Tables, Constraints, Indexes
--
--  Run order:
--    01_schema.sql          (this file)
--    02_functions.sql
--    03_views.sql
--    04_seed.sql
--    05_queries.sql         (reference only, no need to execute)
--
--  Source of truth: ERD + DFD + Use Case + Architecture diagrams.
--  Extras enabled: maintenance_logs, admin_audit_log, ratings, payments
-- ============================================================


-- ============================================================
-- DROP (for clean re-runs during development — remove in prod)
-- ============================================================
DROP TABLE IF EXISTS payments           CASCADE;
DROP TABLE IF EXISTS bike_ratings       CASCADE;
DROP TABLE IF EXISTS admin_audit_log    CASCADE;
DROP TABLE IF EXISTS maintenance_logs   CASCADE;
DROP TABLE IF EXISTS bookings           CASCADE;
DROP TABLE IF EXISTS bikes              CASCADE;
DROP TABLE IF EXISTS stations           CASCADE;
DROP TABLE IF EXISTS system_settings    CASCADE;
DROP TABLE IF EXISTS users              CASCADE;

DROP TYPE IF EXISTS payment_status       CASCADE;
DROP TYPE IF EXISTS payment_method       CASCADE;
DROP TYPE IF EXISTS maintenance_severity CASCADE;
DROP TYPE IF EXISTS maintenance_status   CASCADE;
DROP TYPE IF EXISTS booking_status       CASCADE;
DROP TYPE IF EXISTS bike_status          CASCADE;
DROP TYPE IF EXISTS user_role            CASCADE;


-- ============================================================
-- STEP 1: ENUM TYPES
-- ============================================================
CREATE TYPE user_role             AS ENUM ('student', 'staff', 'admin');
CREATE TYPE bike_status           AS ENUM ('available', 'in_use', 'maintenance', 'retired');
CREATE TYPE booking_status        AS ENUM ('pending', 'active', 'completed', 'cancelled', 'expired');
CREATE TYPE maintenance_status    AS ENUM ('reported', 'in_progress', 'resolved', 'closed');
CREATE TYPE maintenance_severity  AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE payment_method        AS ENUM ('campus_card', 'credit_card', 'wallet', 'waived');
CREATE TYPE payment_status        AS ENUM ('pending', 'paid', 'failed', 'refunded');


-- ============================================================
-- STEP 2: TABLES
-- ============================================================

-- ------------------------------------------------------------
-- TABLE: users
--   Supports: Login, Register, Authenticate User (UC), Admin user list
-- ------------------------------------------------------------
CREATE TABLE users (
    id                SERIAL          PRIMARY KEY,
    full_name         VARCHAR(100)    NOT NULL,
    email             VARCHAR(150)    NOT NULL UNIQUE,
    password_hash     TEXT            NOT NULL,                  -- bcrypt hash
    role              user_role       NOT NULL DEFAULT 'student',
    phone             VARCHAR(20),
    is_active         BOOLEAN         NOT NULL DEFAULT TRUE,     -- soft-delete / suspension
    email_verified    BOOLEAN         NOT NULL DEFAULT FALSE,    -- campus email domain verification
    last_login_at     TIMESTAMPTZ,
    created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_users_email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);

-- ------------------------------------------------------------
-- TABLE: stations
--   Supports: View Station Map (UC), pickup/return selectors, admin fleet
-- ------------------------------------------------------------
CREATE TABLE stations (
    id               SERIAL          PRIMARY KEY,
    station_name     VARCHAR(100)    NOT NULL,
    latitude         DECIMAL(9, 6)   NOT NULL,                   -- e.g. -33.886100
    longitude        DECIMAL(9, 6)   NOT NULL,                   -- e.g.  151.199400
    capacity         INTEGER         NOT NULL CHECK (capacity > 0),
    campus_zone      VARCHAR(50),                                -- 'North', 'East', 'Library'
    address          VARCHAR(200),
    is_active        BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_stations_lat CHECK (latitude  BETWEEN -90  AND 90),
    CONSTRAINT chk_stations_lng CHECK (longitude BETWEEN -180 AND 180)
);

-- ------------------------------------------------------------
-- TABLE: bikes
--   Supports: Map Dashboard counts, Book Bike selector, Admin fleet
-- ------------------------------------------------------------
CREATE TABLE bikes (
    id                    SERIAL          PRIMARY KEY,
    bike_code             VARCHAR(20)     NOT NULL UNIQUE,       -- 'BIKE-001'
    model                 VARCHAR(100)    NOT NULL DEFAULT 'Standard',
    status                bike_status     NOT NULL DEFAULT 'available',
    station_id            INTEGER         REFERENCES stations(id) ON DELETE SET NULL,
    total_rides           INTEGER         NOT NULL DEFAULT 0,    -- denormalized counter
    last_maintenance_at   TIMESTAMPTZ,
    created_at            TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_bikes_in_use_requires_no_station
        CHECK (status <> 'in_use' OR station_id IS NULL)          -- bikes in use aren't docked
);

-- ------------------------------------------------------------
-- TABLE: bookings
--   Supports: Book Bike, Return Bike, Booking History, Auto-expire
-- ------------------------------------------------------------
CREATE TABLE bookings (
    id                   SERIAL          PRIMARY KEY,
    user_id              INTEGER         NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    bike_id              INTEGER         NOT NULL REFERENCES bikes(id)    ON DELETE RESTRICT,
    pickup_station_id    INTEGER         NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    return_station_id    INTEGER                  REFERENCES stations(id) ON DELETE SET NULL,
    start_time           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    end_time             TIMESTAMPTZ,
    status               booking_status  NOT NULL DEFAULT 'pending',
    expires_at           TIMESTAMPTZ     NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
    duration_minutes     INTEGER,                                 -- computed on return
    fee_amount           DECIMAL(10, 2)  NOT NULL DEFAULT 0.00,
    notes                TEXT,
    created_at           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_bookings_end_after_start
        CHECK (end_time IS NULL OR end_time > start_time),
    CONSTRAINT chk_bookings_return_when_complete
        CHECK (status <> 'completed' OR (end_time IS NOT NULL AND return_station_id IS NOT NULL))
);

-- ------------------------------------------------------------
-- TABLE: maintenance_logs
--   Supports: Flag Bike for Maintenance (UC), Admin Dashboard fleet health
-- ------------------------------------------------------------
CREATE TABLE maintenance_logs (
    id                      SERIAL                PRIMARY KEY,
    bike_id                 INTEGER               NOT NULL REFERENCES bikes(id) ON DELETE CASCADE,
    reported_by_user_id     INTEGER                        REFERENCES users(id) ON DELETE SET NULL,
    resolved_by_admin_id    INTEGER                        REFERENCES users(id) ON DELETE SET NULL,
    issue_type              VARCHAR(50)           NOT NULL,       -- 'flat_tire', 'brake', 'chain', 'other'
    description             TEXT,
    severity                maintenance_severity  NOT NULL DEFAULT 'medium',
    status                  maintenance_status    NOT NULL DEFAULT 'reported',
    reported_at             TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
    resolved_at             TIMESTAMPTZ,
    resolution_notes        TEXT,
    created_at              TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ           NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_maint_resolved_requires_time
        CHECK ((status NOT IN ('resolved','closed')) OR resolved_at IS NOT NULL)
);

-- ------------------------------------------------------------
-- TABLE: admin_audit_log
--   Supports: Accountability for all admin actions (5.0 Manage System DFD)
-- ------------------------------------------------------------
CREATE TABLE admin_audit_log (
    id             BIGSERIAL     PRIMARY KEY,
    admin_id       INTEGER                REFERENCES users(id) ON DELETE SET NULL,
    action         VARCHAR(100)  NOT NULL,                 -- 'create_station', 'flag_bike'...
    entity_type    VARCHAR(50)   NOT NULL,                 -- 'station', 'bike', 'user', 'booking'
    entity_id      INTEGER,
    details        JSONB,                                   -- before/after snapshots, arbitrary payload
    ip_address     INET,
    user_agent     TEXT,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- TABLE: bike_ratings
--   Supports: Post-ride feedback (extra)
--   One rating per booking (UNIQUE on booking_id)
-- ------------------------------------------------------------
CREATE TABLE bike_ratings (
    id           SERIAL        PRIMARY KEY,
    booking_id   INTEGER       NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    user_id      INTEGER       NOT NULL        REFERENCES users(id)    ON DELETE CASCADE,
    bike_id      INTEGER       NOT NULL        REFERENCES bikes(id)    ON DELETE CASCADE,
    rating       SMALLINT      NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment      TEXT,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- TABLE: payments
--   Supports: Rental fees, campus card integration
--   Most bookings may be free — payment row still useful for audit
-- ------------------------------------------------------------
CREATE TABLE payments (
    id                      SERIAL          PRIMARY KEY,
    booking_id              INTEGER         NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
    user_id                 INTEGER         NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
    amount                  DECIMAL(10, 2)  NOT NULL CHECK (amount >= 0),
    currency                CHAR(3)         NOT NULL DEFAULT 'USD',
    payment_method          payment_method  NOT NULL,
    status                  payment_status  NOT NULL DEFAULT 'pending',
    transaction_reference   VARCHAR(100),
    paid_at                 TIMESTAMPTZ,
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- TABLE: system_settings
--   Configurable parameters (booking timeout, hourly rate, etc.)
--   Admin-editable without a code change.
-- ------------------------------------------------------------
CREATE TABLE system_settings (
    key            VARCHAR(100)   PRIMARY KEY,
    value          TEXT           NOT NULL,
    description    TEXT,
    updated_by     INTEGER        REFERENCES users(id) ON DELETE SET NULL,
    updated_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);


-- ============================================================
-- STEP 3: INDEXES
-- ============================================================

-- users
CREATE UNIQUE INDEX idx_users_email_lower      ON users(LOWER(email));
CREATE        INDEX idx_users_role             ON users(role);
CREATE        INDEX idx_users_active           ON users(is_active);

-- stations
-- Unique station_name so seed scripts can use ON CONFLICT cleanly.
CREATE UNIQUE INDEX idx_stations_name_unique   ON stations(station_name);
CREATE INDEX idx_stations_active               ON stations(is_active);
CREATE INDEX idx_stations_zone                 ON stations(campus_zone);
CREATE INDEX idx_stations_coords               ON stations(latitude, longitude);

-- bikes
CREATE INDEX idx_bikes_status                  ON bikes(status);
CREATE INDEX idx_bikes_station                 ON bikes(station_id);
CREATE INDEX idx_bikes_status_station          ON bikes(status, station_id)
    WHERE status = 'available';                -- fastest path for Map Dashboard counts

-- bookings
CREATE INDEX idx_bookings_user                 ON bookings(user_id);
CREATE INDEX idx_bookings_bike                 ON bookings(bike_id);
CREATE INDEX idx_bookings_status               ON bookings(status);
CREATE INDEX idx_bookings_pickup               ON bookings(pickup_station_id);
CREATE INDEX idx_bookings_return               ON bookings(return_station_id);
CREATE INDEX idx_bookings_start_desc           ON bookings(start_time DESC);
CREATE INDEX idx_bookings_expires_pending      ON bookings(expires_at)
    WHERE status IN ('pending','active');      -- used by auto-expire worker

-- Partial uniqueness: one active booking per user, one per bike
CREATE UNIQUE INDEX idx_bookings_one_active_per_user ON bookings(user_id)
    WHERE status IN ('pending','active');
CREATE UNIQUE INDEX idx_bookings_one_active_per_bike ON bookings(bike_id)
    WHERE status IN ('pending','active');

-- maintenance_logs
CREATE INDEX idx_maint_bike                    ON maintenance_logs(bike_id);
CREATE INDEX idx_maint_status                  ON maintenance_logs(status);
CREATE INDEX idx_maint_severity                ON maintenance_logs(severity);
CREATE INDEX idx_maint_reported_desc           ON maintenance_logs(reported_at DESC);

-- admin_audit_log
CREATE INDEX idx_audit_admin                   ON admin_audit_log(admin_id);
CREATE INDEX idx_audit_entity                  ON admin_audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created_desc            ON admin_audit_log(created_at DESC);

-- bike_ratings
CREATE INDEX idx_ratings_bike                  ON bike_ratings(bike_id);
CREATE INDEX idx_ratings_user                  ON bike_ratings(user_id);

-- payments
CREATE INDEX idx_payments_booking              ON payments(booking_id);
CREATE INDEX idx_payments_user                 ON payments(user_id);
CREATE INDEX idx_payments_status               ON payments(status);


-- ============================================================
-- STEP 4: COMMENTS (table/column documentation)
-- ============================================================
COMMENT ON TABLE users              IS 'Registered users (students, staff, admins).';
COMMENT ON TABLE stations           IS 'Physical docking stations around campus.';
COMMENT ON TABLE bikes              IS 'Individual bicycles owned by the platform.';
COMMENT ON TABLE bookings           IS 'Every pickup/return transaction.';
COMMENT ON TABLE maintenance_logs   IS 'Bike issues reported by users or flagged by admins.';
COMMENT ON TABLE admin_audit_log    IS 'Tamper-evident record of all administrative actions.';
COMMENT ON TABLE bike_ratings       IS 'Post-ride feedback; one rating per completed booking.';
COMMENT ON TABLE payments           IS 'Fee ledger; free rides may still create rows for audit.';
COMMENT ON TABLE system_settings    IS 'Admin-tunable parameters (timeouts, rates, flags).';
