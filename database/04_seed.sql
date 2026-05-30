-- ============================================================
--  Campus Bike Sharing — Rich demo seed (file 4 / 4)
--
--  Run order:
--    01_schema.sql, 02_functions.sql, 03_views.sql, 04_seed.sql
--
--  Seeds enough data for every admin page to look full:
--    * 1 admin, 5 students, 5 staff
--    * 20 Sydney CBD/campus stations
--    * ~100 bikes spread across stations + statuses
--    * Many bookings across the past 6 months (completed,
--      cancelled, expired) + an active ride + upcoming
--    * Payments (paid / pending / failed / refunded) + revenue
--    * Maintenance logs across severities
--    * 30 support tickets across categories/priorities/statuses
--    * 8 refund requests across review states
--    * 50+ notifications
--    * Admin expenses, admin activity log entries
--
--  Idempotent.
--    * users         — ON CONFLICT (email) DO NOTHING
--    * stations      — ON CONFLICT (station_name) DO NOTHING
--    * bikes         — ON CONFLICT (bike_code) DO NOTHING
--    * settings      — ON CONFLICT (key) DO UPDATE
--    * everything else uses a deterministic seed tag
--      (notes, transaction_reference, admin_response, etc.)
--      and skips re-insert via WHERE NOT EXISTS.
--
--  Schema notes — strictly respected:
--    * bookings.status enum: pending|active|completed|cancelled|expired
--    * bikes.status enum:   available|in_use|maintenance|retired
--    * bookings: 'completed' MUST have end_time AND return_station_id
--    * bikes: 'in_use' MUST have NULL station_id
--    * UNIQUE INDEX: one pending/active booking per user, one per bike
-- ============================================================

BEGIN;

-- ── 0. Defensive support tables (created by backend at runtime ─
--    so the seed file can run before the backend has booted).

CREATE UNIQUE INDEX IF NOT EXISTS idx_stations_name_unique ON stations(station_name);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_status') THEN
    CREATE TYPE ticket_status   AS ENUM ('open', 'in_progress', 'resolved', 'closed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_priority') THEN
    CREATE TYPE ticket_priority AS ENUM ('low', 'medium', 'high', 'urgent');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_category') THEN
    CREATE TYPE ticket_category AS ENUM ('booking', 'bike', 'payment', 'account', 'station', 'other');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_kind') THEN
    CREATE TYPE notification_kind AS ENUM ('info', 'success', 'warning', 'error');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'admin_expense_type') THEN
    CREATE TYPE admin_expense_type AS ENUM ('maintenance', 'refund', 'operational', 'repair', 'other');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'admin_activity_type') THEN
    CREATE TYPE admin_activity_type AS ENUM (
      'booking_completed', 'payment_received', 'bike_returned',
      'maintenance_flagged', 'refund_requested', 'support_ticket_received'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS support_tickets (
  id              SERIAL PRIMARY KEY,
  ticket_code     VARCHAR(30),
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  student_name    VARCHAR(120),
  subject         VARCHAR(200) NOT NULL,
  category        ticket_category NOT NULL DEFAULT 'other',
  priority        ticket_priority NOT NULL DEFAULT 'medium',
  status          ticket_status NOT NULL DEFAULT 'open',
  message         TEXT,
  description     TEXT,
  booking_id      INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  admin_response  TEXT,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                VARCHAR(50) NOT NULL,
  kind                notification_kind NOT NULL DEFAULT 'info',
  title               VARCHAR(160) NOT NULL,
  message             TEXT,
  related_entity_type VARCHAR(50),
  related_entity_id   INTEGER,
  is_read             BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_notifications  BOOLEAN NOT NULL DEFAULT TRUE,
  booking_reminders    BOOLEAN NOT NULL DEFAULT TRUE,
  ride_receipts_email  BOOLEAN NOT NULL DEFAULT TRUE,
  push_notifications   BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_expenses (
  id                 SERIAL PRIMARY KEY,
  expense_type       admin_expense_type NOT NULL DEFAULT 'other',
  description        TEXT,
  amount             NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  related_booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  related_bike_id    INTEGER REFERENCES bikes(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_activity_log (
  id                 SERIAL PRIMARY KEY,
  activity_type      admin_activity_type NOT NULL,
  title              VARCHAR(180) NOT NULL,
  description        TEXT,
  related_booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  related_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  related_bike_id    INTEGER REFERENCES bikes(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ── 1. system_settings (UPSERT) ────────────────────────────
INSERT INTO system_settings (key, value, description) VALUES
  ('booking_timeout_minutes',   '15',              'Grace window for manual Start Ride after scheduled start.'),
  ('unlock_fee_cents',          '100',             'Fee to unlock a bike (cents).'),
  ('per_minute_cents',          '20',              'Per-minute ride fee (cents).'),
  ('minimum_ride_duration',     '5',               'Minimum allowed ride duration (minutes).'),
  ('maximum_ride_duration',     '180',             'Maximum allowed ride duration (minutes).'),
  ('station_open_hour',         '6',               'Earliest station open hour (24h).'),
  ('station_close_hour',        '22',              'Latest station close hour (24h).'),
  ('campus_email_domain',       'university.edu',  'Required email domain for self-registration.'),
  ('refund_window_hours',       '24',              'How long after payment a refund can be requested.'),
  ('payg_reservation_hold_min', '30',              'PAYG reserve hold window (minutes).')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description;


-- ── 2. Users (1 admin + 5 students + 5 staff) ──────────────
INSERT INTO users (full_name, email, password_hash, role, phone, is_active, email_verified) VALUES
  ('Admin User',      'admin@university.edu',          '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'admin',   '+61-2-5550-0001', TRUE, TRUE),
  ('Alice Johnson',   'alice.johnson@university.edu',  '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'student', '+61-2-5550-1001', TRUE, TRUE),
  ('Bob Smith',       'bob.smith@university.edu',      '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'student', '+61-2-5550-1002', TRUE, TRUE),
  ('Daniel Kim',      'daniel.kim@university.edu',     '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'student', '+61-2-5550-1003', TRUE, TRUE),
  ('Emma Wilson',     'emma.wilson@university.edu',    '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'student', '+61-2-5550-1004', TRUE, TRUE),
  ('Sophia Nguyen',   'sophia.nguyen@university.edu',  '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'student', '+61-2-5550-1005', TRUE, TRUE),
  ('Dr Michael Brown','michael.brown@university.edu',  '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'staff',   '+61-2-5550-2001', TRUE, TRUE),
  ('Sarah Taylor',    'sarah.taylor@university.edu',   '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'staff',   '+61-2-5550-2002', TRUE, TRUE),
  ('James Carter',    'james.carter@university.edu',   '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'staff',   '+61-2-5550-2003', TRUE, TRUE),
  ('Priya Patel',     'priya.patel@university.edu',    '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'staff',   '+61-2-5550-2004', TRUE, TRUE),
  ('Liam Anderson',   'liam.anderson@university.edu',  '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'staff',   '+61-2-5550-2005', TRUE, TRUE)
ON CONFLICT (email) DO NOTHING;


-- ── 3. Stations (20 across Sydney CBD / campus precincts) ──
INSERT INTO stations (station_name, latitude, longitude, capacity, campus_zone, address, is_active) VALUES
  ('Academic Quad',            -33.888900, 151.187300, 14, 'Campus',       'University Main Quad',                      TRUE),
  ('UTS Tower',                -33.883600, 151.200200, 12, 'Campus',       '15 Broadway, Ultimo',                       TRUE),
  ('TAFE Ultimo',              -33.880500, 151.199000, 10, 'Campus',       '651-731 Harris St, Ultimo',                 TRUE),
  ('Broadway Shopping Centre', -33.883900, 151.195600, 16, 'Retail',       '1 Bay St, Broadway',                        TRUE),
  ('Central Station',          -33.883000, 151.206800, 20, 'Transit',      'Eddy Ave, Haymarket',                       TRUE),
  ('Darling Harbour',          -33.874600, 151.198900, 18, 'Tourist',      'Cockle Bay Wharf, Darling Harbour',         TRUE),
  ('Barangaroo',               -33.863500, 151.200700, 16, 'Business',     'Barangaroo Reserve, Hickson Rd',            TRUE),
  ('Wynyard',                  -33.866500, 151.206500, 14, 'Transit',      'Wynyard Walk, York St',                     TRUE),
  ('Town Hall',                -33.873200, 151.206800, 16, 'Transit',      '483 George St, Sydney',                     TRUE),
  ('Hyde Park',                -33.873100, 151.211000, 12, 'Park',         'Elizabeth St, Sydney',                      TRUE),
  ('Circular Quay',            -33.861200, 151.210600, 18, 'Tourist',      'Alfred St, Circular Quay',                  TRUE),
  ('Pyrmont',                  -33.869400, 151.192900, 12, 'Residential',  'Pyrmont Bridge Rd, Pyrmont',                TRUE),
  ('Haymarket',                -33.879400, 151.204200, 14, 'Retail',       'Hay St, Haymarket',                         TRUE),
  ('Surry Hills',              -33.884900, 151.212300, 10, 'Residential',  'Crown St, Surry Hills',                     TRUE),
  ('Redfern',                  -33.892400, 151.204200, 10, 'Transit',      'Lawson St, Redfern',                        TRUE),
  ('Ultimo Library',           -33.881100, 151.199100,  8, 'Campus',       '40 William Henry St, Ultimo',               TRUE),
  ('Business School',          -33.917300, 151.231300, 12, 'Campus',       'UNSW Business School, Kensington',          TRUE),
  ('Chinatown',                -33.879400, 151.204300, 12, 'Retail',       'Dixon St, Haymarket',                       TRUE),
  ('Martin Place',             -33.867800, 151.210200, 14, 'Business',     '1 Martin Place, Sydney',                    TRUE),
  ('The Rocks',                -33.859500, 151.208900, 10, 'Tourist',      'George St, The Rocks',                      TRUE)
ON CONFLICT (station_name) DO NOTHING;


-- ── 4. Bikes (100 spread across stations + status mix) ─────
-- BIKE-001 is reserved for the demo "active ride" so its
-- status is set to 'in_use' / station_id = NULL further down.
WITH s AS (SELECT id, station_name FROM stations)
INSERT INTO bikes (bike_code, model, status, station_id, total_rides, last_maintenance_at) VALUES
  -- ── Academic Quad (5)
  ('BIKE-001','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Academic Quad'),   42, NOW() - INTERVAL '20 days'),
  ('BIKE-002','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Academic Quad'),   35, NOW() - INTERVAL '25 days'),
  ('BIKE-003','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Academic Quad'),   28, NOW() - INTERVAL '30 days'),
  ('BIKE-004','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Academic Quad'),   31, NOW() - INTERVAL '18 days'),
  ('BIKE-005','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Academic Quad'),   23, NOW() - INTERVAL '40 days'),
  -- ── UTS Tower (6)
  ('BIKE-006','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='UTS Tower'),       55, NOW() - INTERVAL '10 days'),
  ('BIKE-007','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='UTS Tower'),       48, NOW() - INTERVAL '15 days'),
  ('BIKE-008','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='UTS Tower'),       33, NOW() - INTERVAL '22 days'),
  ('BIKE-009','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='UTS Tower'),       19, NOW() - INTERVAL '35 days'),
  ('BIKE-010','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='UTS Tower'),       62, NOW() - INTERVAL '5 days'),
  ('BIKE-011','City Cruiser',  'maintenance', NULL,                                                    71, NOW() - INTERVAL '2 days'),
  -- ── TAFE Ultimo (5)
  ('BIKE-012','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='TAFE Ultimo'),     27, NOW() - INTERVAL '12 days'),
  ('BIKE-013','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='TAFE Ultimo'),     39, NOW() - INTERVAL '8 days'),
  ('BIKE-014','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='TAFE Ultimo'),     14, NOW() - INTERVAL '45 days'),
  ('BIKE-015','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='TAFE Ultimo'),     22, NOW() - INTERVAL '28 days'),
  ('BIKE-016','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='TAFE Ultimo'),     37, NOW() - INTERVAL '17 days'),
  -- ── Broadway Shopping Centre (6)
  ('BIKE-017','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Broadway Shopping Centre'), 41, NOW() - INTERVAL '14 days'),
  ('BIKE-018','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Broadway Shopping Centre'), 29, NOW() - INTERVAL '24 days'),
  ('BIKE-019','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Broadway Shopping Centre'), 53, NOW() - INTERVAL '9 days'),
  ('BIKE-020','City Cruiser',  'maintenance', NULL,                                                            44, NOW() - INTERVAL '3 days'),
  ('BIKE-021','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Broadway Shopping Centre'), 17, NOW() - INTERVAL '36 days'),
  ('BIKE-022','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Broadway Shopping Centre'), 26, NOW() - INTERVAL '21 days'),
  -- ── Central Station (8)
  ('BIKE-023','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Central Station'), 71, NOW() - INTERVAL '7 days'),
  ('BIKE-024','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Central Station'), 59, NOW() - INTERVAL '11 days'),
  ('BIKE-025','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Central Station'), 48, NOW() - INTERVAL '16 days'),
  ('BIKE-026','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Central Station'), 38, NOW() - INTERVAL '19 days'),
  ('BIKE-027','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Central Station'), 64, NOW() - INTERVAL '6 days'),
  ('BIKE-028','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Central Station'), 51, NOW() - INTERVAL '13 days'),
  ('BIKE-029','Mountain Trail','maintenance', NULL,                                                    33, NOW() - INTERVAL '1 days'),
  ('BIKE-030','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Central Station'), 25, NOW() - INTERVAL '23 days'),
  -- ── Darling Harbour (6)
  ('BIKE-031','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Darling Harbour'), 47, NOW() - INTERVAL '8 days'),
  ('BIKE-032','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Darling Harbour'), 39, NOW() - INTERVAL '15 days'),
  ('BIKE-033','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Darling Harbour'), 32, NOW() - INTERVAL '20 days'),
  ('BIKE-034','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Darling Harbour'), 18, NOW() - INTERVAL '32 days'),
  ('BIKE-035','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Darling Harbour'), 56, NOW() - INTERVAL '10 days'),
  ('BIKE-036','City Cruiser',  'retired',     NULL,                                                    89, NOW() - INTERVAL '60 days'),
  -- ── Barangaroo (5)
  ('BIKE-037','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Barangaroo'),      29, NOW() - INTERVAL '22 days'),
  ('BIKE-038','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Barangaroo'),      41, NOW() - INTERVAL '14 days'),
  ('BIKE-039','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Barangaroo'),      36, NOW() - INTERVAL '17 days'),
  ('BIKE-040','City Cruiser',  'maintenance', NULL,                                                    52, NOW() - INTERVAL '4 days'),
  ('BIKE-041','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Barangaroo'),      21, NOW() - INTERVAL '27 days'),
  -- ── Wynyard (5)
  ('BIKE-042','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Wynyard'),         44, NOW() - INTERVAL '11 days'),
  ('BIKE-043','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Wynyard'),         37, NOW() - INTERVAL '16 days'),
  ('BIKE-044','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Wynyard'),         25, NOW() - INTERVAL '25 days'),
  ('BIKE-045','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Wynyard'),         33, NOW() - INTERVAL '18 days'),
  ('BIKE-046','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Wynyard'),         48, NOW() - INTERVAL '12 days'),
  -- ── Town Hall (5)
  ('BIKE-047','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Town Hall'),       58, NOW() - INTERVAL '9 days'),
  ('BIKE-048','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Town Hall'),       41, NOW() - INTERVAL '14 days'),
  ('BIKE-049','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Town Hall'),       29, NOW() - INTERVAL '21 days'),
  ('BIKE-050','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Town Hall'),       36, NOW() - INTERVAL '17 days'),
  ('BIKE-051','Mountain Trail','retired',     NULL,                                                    93, NOW() - INTERVAL '90 days'),
  -- ── Hyde Park (4)
  ('BIKE-052','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Hyde Park'),       42, NOW() - INTERVAL '13 days'),
  ('BIKE-053','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Hyde Park'),       28, NOW() - INTERVAL '22 days'),
  ('BIKE-054','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Hyde Park'),       35, NOW() - INTERVAL '18 days'),
  ('BIKE-055','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Hyde Park'),       19, NOW() - INTERVAL '33 days'),
  -- ── Circular Quay (6)
  ('BIKE-056','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Circular Quay'),   51, NOW() - INTERVAL '10 days'),
  ('BIKE-057','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Circular Quay'),   44, NOW() - INTERVAL '15 days'),
  ('BIKE-058','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Circular Quay'),   38, NOW() - INTERVAL '19 days'),
  ('BIKE-059','City Cruiser',  'maintenance', NULL,                                                    47, NOW() - INTERVAL '2 days'),
  ('BIKE-060','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Circular Quay'),   32, NOW() - INTERVAL '20 days'),
  ('BIKE-061','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Circular Quay'),   26, NOW() - INTERVAL '24 days'),
  -- ── Pyrmont (4)
  ('BIKE-062','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Pyrmont'),         33, NOW() - INTERVAL '16 days'),
  ('BIKE-063','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Pyrmont'),         41, NOW() - INTERVAL '12 days'),
  ('BIKE-064','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Pyrmont'),         24, NOW() - INTERVAL '27 days'),
  ('BIKE-065','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Pyrmont'),         18, NOW() - INTERVAL '38 days'),
  -- ── Haymarket (5)
  ('BIKE-066','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Haymarket'),       46, NOW() - INTERVAL '11 days'),
  ('BIKE-067','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Haymarket'),       35, NOW() - INTERVAL '17 days'),
  ('BIKE-068','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Haymarket'),       29, NOW() - INTERVAL '23 days'),
  ('BIKE-069','City Cruiser',  'maintenance', NULL,                                                    42, NOW() - INTERVAL '5 days'),
  ('BIKE-070','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Haymarket'),       38, NOW() - INTERVAL '15 days'),
  -- ── Surry Hills (4)
  ('BIKE-071','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Surry Hills'),     31, NOW() - INTERVAL '18 days'),
  ('BIKE-072','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Surry Hills'),     27, NOW() - INTERVAL '21 days'),
  ('BIKE-073','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Surry Hills'),     22, NOW() - INTERVAL '26 days'),
  ('BIKE-074','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Surry Hills'),     15, NOW() - INTERVAL '34 days'),
  -- ── Redfern (4)
  ('BIKE-075','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Redfern'),         28, NOW() - INTERVAL '19 days'),
  ('BIKE-076','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Redfern'),         34, NOW() - INTERVAL '16 days'),
  ('BIKE-077','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Redfern'),         19, NOW() - INTERVAL '29 days'),
  ('BIKE-078','City Cruiser',  'retired',     NULL,                                                    78, NOW() - INTERVAL '120 days'),
  -- ── Ultimo Library (3)
  ('BIKE-079','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Ultimo Library'),  21, NOW() - INTERVAL '25 days'),
  ('BIKE-080','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Ultimo Library'),  29, NOW() - INTERVAL '20 days'),
  ('BIKE-081','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Ultimo Library'),  17, NOW() - INTERVAL '31 days'),
  -- ── Business School (4)
  ('BIKE-082','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Business School'), 23, NOW() - INTERVAL '24 days'),
  ('BIKE-083','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Business School'), 31, NOW() - INTERVAL '18 days'),
  ('BIKE-084','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Business School'), 26, NOW() - INTERVAL '22 days'),
  ('BIKE-085','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Business School'), 18, NOW() - INTERVAL '30 days'),
  -- ── Chinatown (4)
  ('BIKE-086','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Chinatown'),       33, NOW() - INTERVAL '17 days'),
  ('BIKE-087','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Chinatown'),       38, NOW() - INTERVAL '14 days'),
  ('BIKE-088','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Chinatown'),       25, NOW() - INTERVAL '23 days'),
  ('BIKE-089','City Cruiser',  'maintenance', NULL,                                                    44, NOW() - INTERVAL '6 days'),
  -- ── Martin Place (5)
  ('BIKE-090','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Martin Place'),    49, NOW() - INTERVAL '10 days'),
  ('BIKE-091','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Martin Place'),    37, NOW() - INTERVAL '15 days'),
  ('BIKE-092','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Martin Place'),    28, NOW() - INTERVAL '21 days'),
  ('BIKE-093','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='Martin Place'),    32, NOW() - INTERVAL '19 days'),
  ('BIKE-094','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='Martin Place'),    41, NOW() - INTERVAL '13 days'),
  -- ── The Rocks (6)
  ('BIKE-095','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='The Rocks'),       36, NOW() - INTERVAL '16 days'),
  ('BIKE-096','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='The Rocks'),       29, NOW() - INTERVAL '20 days'),
  ('BIKE-097','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='The Rocks'),       24, NOW() - INTERVAL '25 days'),
  ('BIKE-098','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='The Rocks'),       19, NOW() - INTERVAL '28 days'),
  ('BIKE-099','Mountain Trail','available',  (SELECT id FROM s WHERE station_name='The Rocks'),       33, NOW() - INTERVAL '18 days'),
  ('BIKE-100','City Cruiser',  'available',  (SELECT id FROM s WHERE station_name='The Rocks'),       27, NOW() - INTERVAL '22 days')
ON CONFLICT (bike_code) DO NOTHING;


-- ── 5. Bookings (active + upcoming + completed + cancelled + expired)
-- The `notes` column carries a stable "seed:<TAG>" so re-running the
-- file is a no-op. Each booking respects the UNIQUE indexes that
-- enforce one pending/active row per user and per bike.
WITH demo_bookings(tag, user_email, bike_code, pickup_name, return_name, status_text, start_offset_hours, end_offset_hours, duration_min, fee) AS (
  VALUES
    -- ── 1 active ride (Alice on BIKE-001) ─────────────
    ('B001', 'alice.johnson@university.edu', 'BIKE-001', 'Academic Quad', NULL::text,            'active',     -1,    NULL::int, NULL::int, 1.00),
    -- ── 4 upcoming reservations (next 1-7 days) ───────
    ('B002', 'bob.smith@university.edu',     'BIKE-010', 'UTS Tower',     'UTS Tower',           'pending',    -24,   -23,       60,        13.00),
    ('B003', 'daniel.kim@university.edu',    'BIKE-023', 'Central Station','Central Station',    'pending',    -48,   -47,       30,         7.00),
    ('B004', 'emma.wilson@university.edu',   'BIKE-056', 'Circular Quay', 'Darling Harbour',     'pending',    -72,   -71,       60,        13.00),
    ('B005', 'sophia.nguyen@university.edu', 'BIKE-066', 'Haymarket',     'Town Hall',           'pending',    -168,  -167,      120,       25.00),
    -- ── Today: 6 completed rides ──────────────────────
    ('B010', 'alice.johnson@university.edu', 'BIKE-002', 'Academic Quad', 'UTS Tower',           'completed',  3,     2,         45,        10.00),
    ('B011', 'bob.smith@university.edu',     'BIKE-007', 'UTS Tower',     'Central Station',     'completed',  5,     4,         30,         7.00),
    ('B012', 'michael.brown@university.edu', 'BIKE-024', 'Central Station','Wynyard',            'completed',  6,     5,         60,        13.00),
    ('B013', 'sarah.taylor@university.edu',  'BIKE-031', 'Darling Harbour','Barangaroo',         'completed',  4,     3,         25,         6.00),
    ('B014', 'james.carter@university.edu',  'BIKE-047', 'Town Hall',     'Hyde Park',           'completed',  8,     7,         40,         9.00),
    ('B015', 'priya.patel@university.edu',   'BIKE-052', 'Hyde Park',     'Surry Hills',         'completed',  10,    9,         55,        12.00),
    -- ── This week (1-6 days ago): 14 completed ────────
    ('B020', 'alice.johnson@university.edu', 'BIKE-008', 'UTS Tower',     'Broadway Shopping Centre','completed', 30,  29,        50,        11.00),
    ('B021', 'bob.smith@university.edu',     'BIKE-018', 'Broadway Shopping Centre','UTS Tower', 'completed',  50,    49,        60,        13.00),
    ('B022', 'daniel.kim@university.edu',    'BIKE-025', 'Central Station','Town Hall',          'completed',  72,    71,        35,         8.00),
    ('B023', 'emma.wilson@university.edu',   'BIKE-032', 'Darling Harbour','Circular Quay',      'completed',  76,    75,        45,        10.00),
    ('B024', 'sophia.nguyen@university.edu', 'BIKE-038', 'Barangaroo',    'Wynyard',             'completed',  80,    79,        40,         9.00),
    ('B025', 'michael.brown@university.edu', 'BIKE-042', 'Wynyard',       'Martin Place',        'completed',  96,    95,        25,         6.00),
    ('B026', 'sarah.taylor@university.edu',  'BIKE-048', 'Town Hall',     'Pyrmont',             'completed',  100,   99,        65,        14.00),
    ('B027', 'james.carter@university.edu',  'BIKE-057', 'Circular Quay', 'The Rocks',           'completed',  104,   103,       30,         7.00),
    ('B028', 'priya.patel@university.edu',   'BIKE-062', 'Pyrmont',       'Ultimo Library',      'completed',  120,   119,       50,        11.00),
    ('B029', 'liam.anderson@university.edu', 'BIKE-067', 'Haymarket',     'Chinatown',           'completed',  124,   123,       20,         5.00),
    ('B030', 'alice.johnson@university.edu', 'BIKE-071', 'Surry Hills',   'Hyde Park',           'completed',  140,   139,       45,        10.00),
    ('B031', 'bob.smith@university.edu',     'BIKE-076', 'Redfern',       'Central Station',     'completed',  144,   143,       30,         7.00),
    ('B032', 'daniel.kim@university.edu',    'BIKE-082', 'Business School','Redfern',            'completed',  148,   147,       75,        16.00),
    ('B033', 'emma.wilson@university.edu',   'BIKE-091', 'Martin Place',  'Wynyard',             'completed',  150,   149,       25,         6.00),
    -- ── This month (7-30 days ago): 12 completed ──────
    ('B040', 'sophia.nguyen@university.edu', 'BIKE-014', 'TAFE Ultimo',   'UTS Tower',           'completed',  192,   191,       40,         9.00),
    ('B041', 'michael.brown@university.edu', 'BIKE-019', 'Broadway Shopping Centre','Wynyard',   'completed',  240,   239,       55,        12.00),
    ('B042', 'sarah.taylor@university.edu',  'BIKE-026', 'Central Station','Haymarket',          'completed',  264,   263,       30,         7.00),
    ('B043', 'james.carter@university.edu',  'BIKE-033', 'Darling Harbour','Pyrmont',            'completed',  312,   311,       45,        10.00),
    ('B044', 'priya.patel@university.edu',   'BIKE-039', 'Barangaroo',    'Circular Quay',       'completed',  360,   359,       35,         8.00),
    ('B045', 'liam.anderson@university.edu', 'BIKE-043', 'Wynyard',       'Town Hall',           'completed',  408,   407,       20,         5.00),
    ('B046', 'alice.johnson@university.edu', 'BIKE-053', 'Hyde Park',     'Surry Hills',         'completed',  456,   455,       60,        13.00),
    ('B047', 'bob.smith@university.edu',     'BIKE-060', 'Circular Quay', 'Martin Place',        'completed',  504,   503,       30,         7.00),
    ('B048', 'daniel.kim@university.edu',    'BIKE-063', 'Pyrmont',       'Broadway Shopping Centre','completed', 552, 551,      45,        10.00),
    ('B049', 'emma.wilson@university.edu',   'BIKE-068', 'Haymarket',     'Surry Hills',         'completed',  600,   599,       55,        12.00),
    ('B050', 'sophia.nguyen@university.edu', 'BIKE-072', 'Surry Hills',   'Redfern',             'completed',  648,   647,       25,         6.00),
    ('B051', 'michael.brown@university.edu', 'BIKE-083', 'Business School','Central Station',    'completed',  696,   695,       70,        15.00),
    -- ── Previous month (30-60 days): 8 completed ──────
    ('B060', 'sarah.taylor@university.edu',  'BIKE-005', 'Academic Quad', 'TAFE Ultimo',         'completed',  744,   743,       40,         9.00),
    ('B061', 'james.carter@university.edu',  'BIKE-022', 'Broadway Shopping Centre','Hyde Park', 'completed',  840,   839,       50,        11.00),
    ('B062', 'priya.patel@university.edu',   'BIKE-027', 'Central Station','Darling Harbour',    'completed',  936,   935,       35,         8.00),
    ('B063', 'liam.anderson@university.edu', 'BIKE-035', 'Darling Harbour','Wynyard',            'completed',  1032,  1031,      45,        10.00),
    ('B064', 'alice.johnson@university.edu', 'BIKE-046', 'Wynyard',       'The Rocks',           'completed',  1128,  1127,      30,         7.00),
    ('B065', 'bob.smith@university.edu',     'BIKE-058', 'Circular Quay', 'Town Hall',           'completed',  1224,  1223,      55,        12.00),
    ('B066', 'daniel.kim@university.edu',    'BIKE-074', 'Surry Hills',   'Hyde Park',           'completed',  1320,  1319,      25,         6.00),
    ('B067', 'emma.wilson@university.edu',   'BIKE-090', 'Martin Place',  'Pyrmont',             'completed',  1416,  1415,      60,        13.00),
    -- ── 3-6 months ago: 6 completed ───────────────────
    ('B070', 'sophia.nguyen@university.edu', 'BIKE-015', 'TAFE Ultimo',   'Broadway Shopping Centre','completed', 2160, 2159,    40,         9.00),
    ('B071', 'michael.brown@university.edu', 'BIKE-030', 'Central Station','Redfern',            'completed',  2880,  2879,      50,        11.00),
    ('B072', 'sarah.taylor@university.edu',  'BIKE-041', 'Barangaroo',    'Martin Place',        'completed',  3600,  3599,      35,         8.00),
    ('B073', 'james.carter@university.edu',  'BIKE-055', 'Hyde Park',     'Surry Hills',         'completed',  4320,  4319,      45,        10.00),
    ('B074', 'priya.patel@university.edu',   'BIKE-085', 'Business School','Redfern',            'completed',  4800,  4799,      30,         7.00),
    ('B075', 'liam.anderson@university.edu', 'BIKE-094', 'Martin Place',  'The Rocks',           'completed',  5040,  5039,      55,        12.00),
    -- ── Cancelled (7): mix of recent + older ──────────
    ('B080', 'alice.johnson@university.edu', 'BIKE-088', 'Chinatown',     NULL::text,            'cancelled',  240,   NULL::int, 60,        13.00),
    ('B081', 'bob.smith@university.edu',     'BIKE-093', 'Martin Place',  NULL::text,            'cancelled',  480,   NULL::int, 30,         7.00),
    ('B082', 'daniel.kim@university.edu',    'BIKE-097', 'The Rocks',     NULL::text,            'cancelled',  720,   NULL::int, 45,        10.00),
    ('B083', 'emma.wilson@university.edu',   'BIKE-080', 'Ultimo Library', NULL::text,           'cancelled',  168,   NULL::int, 25,         6.00),
    ('B084', 'sarah.taylor@university.edu',  'BIKE-064', 'Pyrmont',       NULL::text,            'cancelled',  1080,  NULL::int, 55,        12.00),
    ('B085', 'james.carter@university.edu',  'BIKE-075', 'Redfern',       NULL::text,            'cancelled',  2400,  NULL::int, 40,         9.00),
    ('B086', 'liam.anderson@university.edu', 'BIKE-098', 'The Rocks',     NULL::text,            'cancelled',  120,   NULL::int, 35,         8.00),
    -- ── Expired / no-show (5) ─────────────────────────
    ('B090', 'priya.patel@university.edu',   'BIKE-044', 'Wynyard',       NULL::text,            'expired',    192,   NULL::int, 30,         7.00),
    ('B091', 'liam.anderson@university.edu', 'BIKE-049', 'Town Hall',     NULL::text,            'expired',    384,   NULL::int, 60,        13.00),
    ('B092', 'sophia.nguyen@university.edu', 'BIKE-079', 'Ultimo Library', NULL::text,           'expired',    576,   NULL::int, 25,         6.00),
    ('B093', 'michael.brown@university.edu', 'BIKE-084', 'Business School',NULL::text,           'expired',    768,   NULL::int, 45,        10.00),
    ('B094', 'sarah.taylor@university.edu',  'BIKE-099', 'The Rocks',     NULL::text,            'expired',    960,   NULL::int, 55,        12.00)
)
INSERT INTO bookings (user_id, bike_id, pickup_station_id, return_station_id, start_time, end_time, status, duration_minutes, fee_amount, notes)
SELECT
  u.id, bi.id, sp.id, sr.id,
  CASE
    WHEN d.start_offset_hours < 0 THEN NOW() + (ABS(d.start_offset_hours) || ' hours')::INTERVAL
    ELSE NOW() - (d.start_offset_hours || ' hours')::INTERVAL
  END,
  CASE
    WHEN d.end_offset_hours IS NULL THEN NULL
    WHEN d.end_offset_hours < 0 THEN NOW() + (ABS(d.end_offset_hours) || ' hours')::INTERVAL
    ELSE NOW() - (d.end_offset_hours || ' hours')::INTERVAL
  END,
  d.status_text::booking_status,
  d.duration_min,
  d.fee,
  'seed:' || d.tag
FROM demo_bookings d
JOIN users u    ON u.email = d.user_email
JOIN bikes bi   ON bi.bike_code = d.bike_code
JOIN stations sp ON sp.station_name = d.pickup_name
LEFT JOIN stations sr ON sr.station_name = d.return_name
WHERE NOT EXISTS (SELECT 1 FROM bookings bk WHERE bk.notes = 'seed:' || d.tag);

-- Demo "active ride" needs BIKE-001 marked in_use + no station
UPDATE bikes SET status = 'in_use', station_id = NULL
 WHERE bike_code = 'BIKE-001'
   AND EXISTS (SELECT 1 FROM bookings WHERE notes = 'seed:B001' AND status = 'active');


-- ── 6. Payments (mirrors the bookings above, with mix) ─────
WITH demo_payments(booking_tag, amount, method_text, status_text, txref, paid_offset_hours) AS (
  VALUES
    -- Paid completed rides
    ('B010', 10.00, 'credit_card', 'paid', 'pay_seed_010', 2),
    ('B011',  7.00, 'credit_card', 'paid', 'pay_seed_011', 4),
    ('B012', 13.00, 'campus_card', 'paid', 'pay_seed_012', 5),
    ('B013',  6.00, 'credit_card', 'paid', 'pay_seed_013', 3),
    ('B014',  9.00, 'wallet',      'paid', 'pay_seed_014', 7),
    ('B015', 12.00, 'credit_card', 'paid', 'pay_seed_015', 9),
    ('B020', 11.00, 'credit_card', 'paid', 'pay_seed_020', 29),
    ('B021', 13.00, 'credit_card', 'paid', 'pay_seed_021', 49),
    ('B022',  8.00, 'campus_card', 'paid', 'pay_seed_022', 71),
    ('B023', 10.00, 'credit_card', 'paid', 'pay_seed_023', 75),
    ('B024',  9.00, 'credit_card', 'paid', 'pay_seed_024', 79),
    ('B025',  6.00, 'wallet',      'paid', 'pay_seed_025', 95),
    ('B026', 14.00, 'credit_card', 'paid', 'pay_seed_026', 99),
    ('B027',  7.00, 'credit_card', 'paid', 'pay_seed_027', 103),
    ('B028', 11.00, 'campus_card', 'paid', 'pay_seed_028', 119),
    ('B029',  5.00, 'credit_card', 'paid', 'pay_seed_029', 123),
    ('B030', 10.00, 'credit_card', 'paid', 'pay_seed_030', 139),
    ('B031',  7.00, 'wallet',      'paid', 'pay_seed_031', 143),
    ('B032', 16.00, 'credit_card', 'paid', 'pay_seed_032', 147),
    ('B033',  6.00, 'credit_card', 'paid', 'pay_seed_033', 149),
    ('B040',  9.00, 'campus_card', 'paid', 'pay_seed_040', 191),
    ('B041', 12.00, 'credit_card', 'paid', 'pay_seed_041', 239),
    ('B042',  7.00, 'credit_card', 'paid', 'pay_seed_042', 263),
    ('B043', 10.00, 'credit_card', 'paid', 'pay_seed_043', 311),
    ('B044',  8.00, 'wallet',      'paid', 'pay_seed_044', 359),
    ('B045',  5.00, 'campus_card', 'paid', 'pay_seed_045', 407),
    ('B046', 13.00, 'credit_card', 'paid', 'pay_seed_046', 455),
    ('B047',  7.00, 'credit_card', 'paid', 'pay_seed_047', 503),
    ('B048', 10.00, 'credit_card', 'paid', 'pay_seed_048', 551),
    ('B049', 12.00, 'wallet',      'paid', 'pay_seed_049', 599),
    ('B050',  6.00, 'credit_card', 'paid', 'pay_seed_050', 647),
    ('B051', 15.00, 'credit_card', 'paid', 'pay_seed_051', 695),
    ('B060',  9.00, 'credit_card', 'paid', 'pay_seed_060', 743),
    ('B061', 11.00, 'credit_card', 'paid', 'pay_seed_061', 839),
    ('B062',  8.00, 'campus_card', 'paid', 'pay_seed_062', 935),
    ('B063', 10.00, 'credit_card', 'paid', 'pay_seed_063', 1031),
    ('B064',  7.00, 'wallet',      'paid', 'pay_seed_064', 1127),
    ('B065', 12.00, 'credit_card', 'paid', 'pay_seed_065', 1223),
    ('B066',  6.00, 'credit_card', 'paid', 'pay_seed_066', 1319),
    ('B067', 13.00, 'credit_card', 'paid', 'pay_seed_067', 1415),
    ('B070',  9.00, 'credit_card', 'paid', 'pay_seed_070', 2159),
    ('B071', 11.00, 'campus_card', 'paid', 'pay_seed_071', 2879),
    ('B072',  8.00, 'credit_card', 'paid', 'pay_seed_072', 3599),
    ('B073', 10.00, 'credit_card', 'paid', 'pay_seed_073', 4319),
    ('B074',  7.00, 'wallet',      'paid', 'pay_seed_074', 4799),
    ('B075', 12.00, 'credit_card', 'paid', 'pay_seed_075', 5039),
    -- Active ride: $1 PAYG unlock charged at start
    ('B001',  1.00, 'credit_card', 'paid', 'pay_seed_001_unlock', 1),
    -- Refunded (cancelled bookings)
    ('B080', 13.00, 'credit_card', 'refunded', 'pay_seed_080', 239),
    ('B081',  7.00, 'credit_card', 'refunded', 'pay_seed_081', 479),
    ('B082', 10.00, 'campus_card', 'refunded', 'pay_seed_082', 719),
    -- Pending (waiting for processing)
    ('B083',  6.00, 'credit_card', 'pending', 'pay_seed_083', NULL::int),
    ('B084', 12.00, 'wallet',      'pending', 'pay_seed_084', NULL::int),
    -- Failed
    ('B085',  9.00, 'credit_card', 'failed',  'pay_seed_085', NULL::int),
    ('B086',  8.00, 'credit_card', 'failed',  'pay_seed_086', NULL::int)
)
INSERT INTO payments (booking_id, user_id, amount, currency, payment_method, status, transaction_reference, paid_at, created_at)
SELECT
  bk.id, bk.user_id, p.amount, 'AUD', p.method_text::payment_method, p.status_text::payment_status,
  p.txref,
  CASE WHEN p.status_text = 'paid' OR p.status_text = 'refunded'
       THEN NOW() - (p.paid_offset_hours || ' hours')::INTERVAL
       ELSE NULL END,
  COALESCE(NOW() - (p.paid_offset_hours || ' hours')::INTERVAL, NOW() - INTERVAL '1 hour')
FROM demo_payments p
JOIN bookings bk ON bk.notes = 'seed:' || p.booking_tag
WHERE NOT EXISTS (SELECT 1 FROM payments x WHERE x.transaction_reference = p.txref);


-- ── 7. Maintenance logs (25 across severities/statuses) ────
WITH demo_maint(tag, bike_code, reporter_email, resolver_email, issue, severity_text, status_text, reported_offset_hours, resolved_offset_hours) AS (
  VALUES
    -- Open / reported
    ('M01', 'BIKE-011', 'alice.johnson@university.edu', NULL::text,            'brake',         'high',     'reported',    2,    NULL::int),
    ('M02', 'BIKE-020', 'bob.smith@university.edu',     NULL::text,            'flat_tire',     'medium',   'reported',    8,    NULL::int),
    ('M03', 'BIKE-029', 'daniel.kim@university.edu',    NULL::text,            'chain',         'low',      'reported',    18,   NULL::int),
    ('M04', 'BIKE-040', 'emma.wilson@university.edu',   NULL::text,            'battery',       'medium',   'reported',    36,   NULL::int),
    ('M05', 'BIKE-059', 'sophia.nguyen@university.edu', NULL::text,            'other',         'low',      'reported',    72,   NULL::int),
    -- In progress
    ('M06', 'BIKE-069', 'michael.brown@university.edu', 'admin@university.edu', 'brake',        'high',     'in_progress', 12,   NULL::int),
    ('M07', 'BIKE-089', 'sarah.taylor@university.edu',  'admin@university.edu', 'tyre',         'medium',   'in_progress', 24,   NULL::int),
    -- Resolved (recent)
    ('M10', 'BIKE-002', 'james.carter@university.edu',  'admin@university.edu', 'chain',        'low',      'resolved',    96,   72),
    ('M11', 'BIKE-013', 'priya.patel@university.edu',   'admin@university.edu', 'flat_tire',    'medium',   'resolved',    120,  96),
    ('M12', 'BIKE-024', 'liam.anderson@university.edu', 'admin@university.edu', 'brake',        'high',     'resolved',    144,  120),
    ('M13', 'BIKE-035', 'alice.johnson@university.edu', 'admin@university.edu', 'general',      'low',      'resolved',    168,  144),
    ('M14', 'BIKE-048', 'bob.smith@university.edu',     'admin@university.edu', 'battery',      'medium',   'resolved',    240,  216),
    ('M15', 'BIKE-057', 'daniel.kim@university.edu',    'admin@university.edu', 'tyre',         'low',      'resolved',    312,  288),
    ('M16', 'BIKE-072', 'emma.wilson@university.edu',   'admin@university.edu', 'chain',        'medium',   'resolved',    360,  336),
    ('M17', 'BIKE-088', 'sophia.nguyen@university.edu', 'admin@university.edu', 'brake',        'high',     'resolved',    480,  456),
    -- Closed (older completed)
    ('M20', 'BIKE-036', 'michael.brown@university.edu', 'admin@university.edu', 'general',      'medium',   'closed',      720,  696),
    ('M21', 'BIKE-051', 'sarah.taylor@university.edu',  'admin@university.edu', 'flat_tire',    'low',      'closed',      960,  912),
    ('M22', 'BIKE-078', 'james.carter@university.edu',  'admin@university.edu', 'chain',        'medium',   'closed',      1200, 1152),
    ('M23', 'BIKE-022', 'priya.patel@university.edu',   'admin@university.edu', 'tyre',         'high',     'closed',      1440, 1392),
    ('M24', 'BIKE-046', 'liam.anderson@university.edu', 'admin@university.edu', 'battery',      'low',      'closed',      1680, 1632),
    ('M25', 'BIKE-095', 'alice.johnson@university.edu', 'admin@university.edu', 'brake',        'critical', 'closed',      2160, 2112),
    ('M26', 'BIKE-007', 'bob.smith@university.edu',     'admin@university.edu', 'general',      'low',      'closed',      2400, 2376),
    ('M27', 'BIKE-031', 'daniel.kim@university.edu',    'admin@university.edu', 'flat_tire',    'medium',   'closed',      2880, 2832),
    ('M28', 'BIKE-067', 'emma.wilson@university.edu',   'admin@university.edu', 'chain',        'low',      'closed',      3360, 3312),
    ('M29', 'BIKE-099', 'sophia.nguyen@university.edu', 'admin@university.edu', 'brake',        'high',     'closed',      4320, 4272)
)
INSERT INTO maintenance_logs (bike_id, reported_by_user_id, resolved_by_admin_id, issue_type, description, severity, status, reported_at, resolved_at, resolution_notes)
SELECT
  bi.id, u_rep.id, u_res.id, m.issue,
  'Seeded maintenance log (' || m.tag || ', ' || m.issue || ', ' || m.severity_text || ')',
  m.severity_text::maintenance_severity,
  m.status_text::maintenance_status,
  NOW() - (m.reported_offset_hours || ' hours')::INTERVAL,
  CASE WHEN m.resolved_offset_hours IS NOT NULL
       THEN NOW() - (m.resolved_offset_hours || ' hours')::INTERVAL
       ELSE NULL END,
  CASE WHEN m.status_text IN ('resolved','closed') THEN 'Demo seed: bike returned to service.' ELSE NULL END
FROM demo_maint m
JOIN bikes bi    ON bi.bike_code = m.bike_code
JOIN users u_rep ON u_rep.email = m.reporter_email
LEFT JOIN users u_res ON u_res.email = m.resolver_email
WHERE NOT EXISTS (
  SELECT 1 FROM maintenance_logs ml
   WHERE ml.bike_id = bi.id
     AND ml.description = 'Seeded maintenance log (' || m.tag || ', ' || m.issue || ', ' || m.severity_text || ')'
);


-- ── 8. Support tickets (30 across categories/priorities) ───
WITH demo_tickets(tag, user_email, category_text, priority_text, status_text, subject, message, created_offset_hours, resolved_offset_hours) AS (
  VALUES
    -- Open
    ('T01', 'alice.johnson@university.edu', 'booking',  'medium', 'open',         'Booking won''t confirm',           'Stripe returned but my booking is not visible.',         3,    NULL::int),
    ('T02', 'bob.smith@university.edu',     'payment',  'high',   'open',         'Charged twice for one ride',       'Two charges on my statement for the same trip.',         6,    NULL::int),
    ('T03', 'daniel.kim@university.edu',    'bike',     'urgent', 'open',         'Brake failure on BIKE-024',        'Brakes barely worked when I returned to Central.',       2,    NULL::int),
    ('T04', 'emma.wilson@university.edu',   'station',  'low',    'open',         'Dock not releasing',               'Station screen flashed but the bike stayed locked.',     24,   NULL::int),
    ('T05', 'sophia.nguyen@university.edu', 'account',  'medium', 'open',         'Cannot update phone number',       'Profile edit fails silently for phone field.',           48,   NULL::int),
    ('T06', 'michael.brown@university.edu', 'other',    'low',    'open',         'Receipt formatting',               'PDF receipt header is cut off in print preview.',        72,   NULL::int),
    -- In progress
    ('T10', 'sarah.taylor@university.edu',  'payment',  'high',   'in_progress',  'Refund still pending',             'Cancelled 3 days ago, refund not received.',             96,   NULL::int),
    ('T11', 'james.carter@university.edu',  'booking',  'urgent', 'in_progress',  'Cannot end PAYG ride',             'End Ride says "no active ride" but my timer is running.',120,  NULL::int),
    ('T12', 'priya.patel@university.edu',   'bike',     'high',   'in_progress',  'Bike making grinding noise',       'BIKE-057 chain rattles, needs inspection.',              48,   NULL::int),
    ('T13', 'liam.anderson@university.edu', 'account',  'medium', 'in_progress',  'Lost access to email',             'Need help recovering account on previous .edu address.', 168,  NULL::int),
    -- Resolved
    ('T20', 'alice.johnson@university.edu', 'booking',  'medium', 'resolved',     'Lost reservation hold',            'Pickup hold expired before I could get there.',          240,  216),
    ('T21', 'bob.smith@university.edu',     'station',  'low',    'resolved',     'Station map outdated',             'Map showed Pyrmont has bikes but station was empty.',    312,  288),
    ('T22', 'daniel.kim@university.edu',    'bike',     'high',   'resolved',     'Saddle wobbled badly',             'Reported BIKE-022 — needs tightening.',                  360,  336),
    ('T23', 'emma.wilson@university.edu',   'payment',  'medium', 'resolved',     'Receipt missing GST',              'AUD receipt did not show tax line.',                     432,  408),
    ('T24', 'sophia.nguyen@university.edu', 'account',  'low',    'resolved',     'Email notifications too noisy',    'Got 6 emails for one ride. Adjusted preferences.',       480,  456),
    ('T25', 'michael.brown@university.edu', 'other',    'medium', 'resolved',     'Google Maps not loading',          'Map blank on Ride History page.',                        576,  552),
    ('T26', 'sarah.taylor@university.edu',  'booking',  'urgent', 'resolved',     'Booking double-charged after cancel','Cancelled reservation was charged again.',             672,  648),
    ('T27', 'james.carter@university.edu',  'bike',     'medium', 'resolved',     'Battery warning light',            'BIKE-040 showed low battery icon during ride.',          720,  696),
    -- Closed
    ('T30', 'priya.patel@university.edu',   'booking',  'medium', 'closed',       'Old upcoming not removed',         'Cancelled booking still showed for a day.',              960,  912),
    ('T31', 'liam.anderson@university.edu', 'payment',  'high',   'closed',       'Stripe webhook failed',            'Payment marked pending for hours after Stripe success.', 1080, 1032),
    ('T32', 'alice.johnson@university.edu', 'station',  'low',    'closed',       'Wrong station name',               'Library North Stand vs Library Main — confusing.',       1320, 1272),
    ('T33', 'bob.smith@university.edu',     'bike',     'urgent', 'closed',       'Bike code mismatch',               'Selected BIKE-006 but app gave BIKE-008.',               1560, 1512),
    ('T34', 'daniel.kim@university.edu',    'account',  'medium', 'closed',       'Profile photo upload failed',      'Avatar upload returned 500.',                            1800, 1752),
    ('T35', 'emma.wilson@university.edu',   'other',    'low',    'closed',       'Suggestion: dark mode',            'Would be great to have a dark theme.',                   2160, 2112),
    ('T36', 'sophia.nguyen@university.edu', 'booking',  'medium', 'closed',       'Overlap rule confusing',           'Wanted second reserve but blocked by first.',            2400, 2352),
    ('T37', 'michael.brown@university.edu', 'payment',  'low',    'closed',       'Wallet credit not visible',        'Could not see my wallet balance.',                       2880, 2832),
    ('T38', 'sarah.taylor@university.edu',  'bike',     'high',   'closed',       'Pedal came loose',                 'Right pedal on BIKE-031 wobbled mid-ride.',              3360, 3312),
    ('T39', 'james.carter@university.edu',  'station',  'medium', 'closed',       'Need new station at Central',      'Suggestion to add a Central platform 1 location.',       3840, 3792),
    ('T40', 'priya.patel@university.edu',   'other',    'urgent', 'closed',       'Lost wallet on bike',              'Left wallet in BIKE-094 basket, missing.',               4320, 4248)
)
INSERT INTO support_tickets (ticket_code, user_id, student_name, subject, category, priority, status, message, description, admin_response, resolved_at, created_at, updated_at)
SELECT
  t.tag, u.id, u.full_name, t.subject,
  t.category_text::ticket_category,
  t.priority_text::ticket_priority,
  t.status_text::ticket_status,
  t.message, t.message,
  CASE WHEN t.status_text IN ('resolved','closed') THEN 'Resolved by admin. Demo seed.' ELSE NULL END,
  CASE WHEN t.resolved_offset_hours IS NOT NULL THEN NOW() - (t.resolved_offset_hours || ' hours')::INTERVAL ELSE NULL END,
  NOW() - (t.created_offset_hours || ' hours')::INTERVAL,
  NOW() - (t.created_offset_hours || ' hours')::INTERVAL
FROM demo_tickets t
JOIN users u ON u.email = t.user_email
WHERE NOT EXISTS (SELECT 1 FROM support_tickets st WHERE st.ticket_code = t.tag);


-- ── 9. Refund requests (8 across statuses) ─────────────────
WITH demo_refunds(tag, booking_tag, reason, refund_type, status, amount_paid, calculated, approved, requested_offset, reviewed_offset, reviewer_email) AS (
  VALUES
    ('R01', 'B080', 'Plan changed - no longer needed.',     'cancelled',  'pending_review', 13.00, 13.00, NULL::numeric, 240,  NULL::int, NULL::text),
    ('R02', 'B081', 'Booked wrong time slot.',              'cancelled',  'pending_review',  7.00,  7.00, NULL::numeric, 480,  NULL::int, NULL::text),
    ('R03', 'B082', 'Bike not at station as shown.',        'cancelled',  'approved',       10.00, 10.00, 10.00,         720,  696,       'admin@university.edu'),
    ('R04', 'B090', 'Expired - couldn''t reach pickup.',    'expired',    'approved',        7.00,  7.00,  7.00,         192,  168,       'admin@university.edu'),
    ('R05', 'B091', 'Missed grace window due to traffic.',  'expired',    'rejected',       13.00, 13.00,  0.00,         384,  360,       'admin@university.edu'),
    ('R06', 'B092', 'Phone died - couldn''t open app.',     'expired',    'refunded',        6.00,  6.00,  6.00,         576,  552,       'admin@university.edu'),
    ('R07', 'B093', 'Schedule conflict came up.',           'expired',    'refunded',       10.00, 10.00, 10.00,         768,  744,       'admin@university.edu'),
    ('R08', 'B094', 'Family emergency.',                    'expired',    'refunded',       12.00, 12.00, 12.00,         960,  936,       'admin@university.edu')
)
INSERT INTO refund_requests (booking_id, user_id, payment_id, amount_paid, calculated_refund_amount, approved_refund_amount, reason, admin_note, refund_type, status, requested_at, reviewed_at, reviewed_by)
SELECT
  bk.id, bk.user_id, p.id,
  r.amount_paid, r.calculated, r.approved,
  r.reason,
  CASE WHEN r.status IN ('approved','rejected','refunded') THEN 'Reviewed by admin (demo seed)' ELSE NULL END,
  r.refund_type, r.status,
  NOW() - (r.requested_offset || ' hours')::INTERVAL,
  CASE WHEN r.reviewed_offset IS NOT NULL THEN NOW() - (r.reviewed_offset || ' hours')::INTERVAL ELSE NULL END,
  u_rev.id
FROM demo_refunds r
JOIN bookings bk ON bk.notes = 'seed:' || r.booking_tag
LEFT JOIN payments p ON p.booking_id = bk.id
LEFT JOIN users u_rev ON u_rev.email = r.reviewer_email
WHERE NOT EXISTS (
  SELECT 1 FROM refund_requests rr
   WHERE rr.booking_id = bk.id
     AND rr.reason = r.reason
);


-- ── 10. Notifications (~55 across users and types) ─────────
WITH demo_notif(tag, user_email, type_text, kind_text, title, message, offset_hours) AS (
  VALUES
    -- Recent activity (today)
    ('N01', 'alice.johnson@university.edu', 'ride_started',    'success', 'Your ride has started',      'Bike BIKE-001 unlocked. Tap End Ride when done.',                 1),
    ('N02', 'alice.johnson@university.edu', 'payment_received','success', 'Payment of $1.00 received',  'Unlock fee charged.',                                             1),
    ('N03', 'bob.smith@university.edu',     'ride_completed',  'success', 'Ride complete - 30 min',     'Thanks for riding! Total $7.00.',                                 4),
    ('N04', 'bob.smith@university.edu',     'payment_received','success', 'Payment received: $7.00',    'Booking #seed B011.',                                             4),
    ('N05', 'daniel.kim@university.edu',    'booking_ready',   'info',    'Your ride is ready to start','Open My Bookings to start within 15 minutes.',                    2),
    ('N06', 'emma.wilson@university.edu',   'booking_created', 'success', 'Booking #seed B004 confirmed','Your bike booking is confirmed for Circular Quay.',              72),
    ('N07', 'sophia.nguyen@university.edu', 'booking_created', 'success', 'Booking confirmed',          'Your reservation at Haymarket is confirmed.',                     168),
    ('N08', 'michael.brown@university.edu', 'ride_completed',  'success', 'Ride complete',              'Total $13.00 for 60 minute ride.',                                5),
    ('N09', 'sarah.taylor@university.edu',  'ride_completed',  'success', 'Ride complete',              'Total $6.00 for 25 minute ride.',                                 3),
    ('N10', 'james.carter@university.edu',  'ride_completed',  'success', 'Ride complete',              'Total $9.00 for 40 minute ride.',                                 7),
    ('N11', 'priya.patel@university.edu',   'ride_completed',  'success', 'Ride complete',              'Total $12.00 for 55 minute ride.',                                9),
    -- This week
    ('N12', 'alice.johnson@university.edu', 'payment_received','success', 'Payment received: $11.00',   'Booking #seed B020.',                                             29),
    ('N13', 'bob.smith@university.edu',     'payment_received','success', 'Payment received: $13.00',   'Booking #seed B021.',                                             49),
    ('N14', 'daniel.kim@university.edu',    'payment_received','success', 'Payment received: $8.00',    'Booking #seed B022.',                                             71),
    ('N15', 'emma.wilson@university.edu',   'payment_received','success', 'Payment received: $10.00',   'Booking #seed B023.',                                             75),
    ('N16', 'sophia.nguyen@university.edu', 'ride_completed',  'success', 'Ride complete - 40 min',     'Total $9.00.',                                                    79),
    -- Cancellations
    ('N20', 'alice.johnson@university.edu', 'booking_cancelled','warning','Booking cancelled',          'Refund requested for cancelled booking.',                         240),
    ('N21', 'bob.smith@university.edu',     'booking_cancelled','warning','Booking cancelled',          'Refund requested for cancelled booking.',                         480),
    ('N22', 'daniel.kim@university.edu',    'booking_cancelled','warning','Booking cancelled',          'Refund issued.',                                                  720),
    -- Expired no-show
    ('N25', 'priya.patel@university.edu',   'booking_expired',  'warning','Booking expired',            'Booking was not started within 15 minutes. Refund pending.',     168),
    ('N26', 'liam.anderson@university.edu', 'booking_expired',  'warning','Booking expired',            'Booking was not started in time.',                                360),
    ('N27', 'michael.brown@university.edu', 'booking_expired',  'warning','Booking expired',            'Booking was not started in time.',                                744),
    -- Maintenance alerts
    ('N30', 'alice.johnson@university.edu', 'maintenance_alert','info',   'BIKE-011 reported',          'You reported brake issue on BIKE-011.',                           2),
    ('N31', 'bob.smith@university.edu',     'maintenance_alert','info',   'BIKE-020 reported',          'Flat tyre report logged.',                                        8),
    ('N32', 'daniel.kim@university.edu',    'maintenance_alert','info',   'BIKE-029 reported',          'Chain issue logged.',                                             18),
    -- Refund updates
    ('N40', 'alice.johnson@university.edu', 'refund_requested','info',    'Refund request received',   'We''ll review your request within 24 hours.',                     240),
    ('N41', 'bob.smith@university.edu',     'refund_requested','info',    'Refund request received',   'We''ll review your request within 24 hours.',                     480),
    ('N42', 'daniel.kim@university.edu',    'refund_processed','success', 'Refund processed',           '$10.00 refunded to your card.',                                   696),
    ('N43', 'sophia.nguyen@university.edu', 'refund_processed','success', 'Refund processed',           '$6.00 refunded to your card.',                                    552),
    ('N44', 'michael.brown@university.edu', 'refund_processed','success', 'Refund processed',           '$10.00 refunded to your card.',                                   744),
    ('N45', 'liam.anderson@university.edu', 'refund_rejected', 'warning', 'Refund request rejected',    'Refund not eligible — outside grace window.',                     360),
    -- Older completed ride receipts
    ('N50', 'alice.johnson@university.edu', 'ride_completed',  'success', 'Ride complete',              'Receipt available in Ride History.',                              456),
    ('N51', 'bob.smith@university.edu',     'ride_completed',  'success', 'Ride complete',              'Receipt available in Ride History.',                              504),
    ('N52', 'daniel.kim@university.edu',    'ride_completed',  'success', 'Ride complete',              'Receipt available in Ride History.',                              552),
    ('N53', 'emma.wilson@university.edu',   'ride_completed',  'success', 'Ride complete',              'Receipt available in Ride History.',                              600),
    ('N54', 'sophia.nguyen@university.edu', 'ride_completed',  'success', 'Ride complete',              'Receipt available in Ride History.',                              648),
    ('N55', 'michael.brown@university.edu', 'ride_completed',  'success', 'Ride complete',              'Receipt available in Ride History.',                              696),
    ('N56', 'sarah.taylor@university.edu',  'ride_completed',  'success', 'Ride complete',              'Receipt available in Ride History.',                              744),
    ('N57', 'james.carter@university.edu',  'ride_completed',  'success', 'Ride complete',              'Receipt available in Ride History.',                              840),
    ('N58', 'priya.patel@university.edu',   'ride_completed',  'success', 'Ride complete',              'Receipt available in Ride History.',                              936),
    ('N59', 'liam.anderson@university.edu', 'ride_completed',  'success', 'Ride complete',              'Receipt available in Ride History.',                              1032),
    -- Admin notifications (sent to admin user)
    ('N70', 'admin@university.edu',         'new_booking',     'info',    'New booking by Alice Johnson','Ride Now started on BIKE-001.',                                  1),
    ('N71', 'admin@university.edu',         'new_booking',     'info',    'New booking by Sarah Taylor', 'Completed - $6.00.',                                             3),
    ('N72', 'admin@university.edu',         'maintenance_flag','warning', 'Maintenance flagged',         'BIKE-011 brake issue.',                                          2),
    ('N73', 'admin@university.edu',         'support_ticket',  'info',    'New support ticket',          'Bob Smith - Charged twice for one ride.',                         6),
    ('N74', 'admin@university.edu',         'support_ticket',  'warning', 'Urgent support ticket',       'Daniel Kim - Brake failure on BIKE-024.',                         2),
    ('N75', 'admin@university.edu',         'refund_requested','info',    'New refund request',          'Alice Johnson - $13.00.',                                         240),
    ('N76', 'admin@university.edu',         'low_availability','warning', 'Low bike availability',      'Only 2 bikes available at Central Station.',                      4),
    ('N77', 'admin@university.edu',         'payment_received','success', 'Payment received: $13.00',   'Booking by Bob Smith.',                                           49),
    ('N78', 'admin@university.edu',         'payment_received','success', 'Payment received: $14.00',   'Booking by Sarah Taylor.',                                        99)
)
INSERT INTO notifications (user_id, type, kind, title, message, is_read, created_at)
SELECT
  u.id, n.type_text, n.kind_text::notification_kind,
  n.title, n.message,
  CASE WHEN n.offset_hours > 48 THEN TRUE ELSE FALSE END,
  NOW() - (n.offset_hours || ' hours')::INTERVAL
FROM demo_notif n
JOIN users u ON u.email = n.user_email
WHERE NOT EXISTS (
  SELECT 1 FROM notifications x
   WHERE x.user_id = u.id
     AND x.title = n.title
     AND x.message = n.message
);


-- ── 11. Admin expenses (maintenance + refund operating costs) ──
WITH demo_expenses(tag, type_text, description, amount, related_booking_tag, related_bike_code, offset_hours) AS (
  VALUES
    ('E01', 'maintenance',  'Brake pad replacement BIKE-011',         85.00,  NULL::text, 'BIKE-011',   12),
    ('E02', 'maintenance',  'Flat tyre repair BIKE-020',              45.00,  NULL::text, 'BIKE-020',   24),
    ('E03', 'maintenance',  'Chain replacement BIKE-029',             60.00,  NULL::text, 'BIKE-029',   48),
    ('E04', 'maintenance',  'Battery replacement BIKE-040',          120.00,  NULL::text, 'BIKE-040',   72),
    ('E05', 'maintenance',  'General inspection BIKE-059',            30.00,  NULL::text, 'BIKE-059',   96),
    ('E06', 'maintenance',  'Brake adjustment BIKE-069',              50.00,  NULL::text, 'BIKE-069',   120),
    ('E07', 'maintenance',  'Tyre replacement BIKE-089',              80.00,  NULL::text, 'BIKE-089',   144),
    ('E08', 'repair',       'Wheel truing BIKE-022',                  40.00,  NULL::text, 'BIKE-022',   240),
    ('E09', 'repair',       'Frame inspection BIKE-051',              60.00,  NULL::text, 'BIKE-051',   720),
    ('E10', 'refund',       'Approved refund - booking B082',         10.00,  'B082',     NULL::text,   696),
    ('E11', 'refund',       'Approved refund - booking B090',          7.00,  'B090',     NULL::text,   168),
    ('E12', 'refund',       'Approved refund - booking B092',          6.00,  'B092',     NULL::text,   552),
    ('E13', 'refund',       'Approved refund - booking B093',         10.00,  'B093',     NULL::text,   744),
    ('E14', 'refund',       'Approved refund - booking B094',         12.00,  'B094',     NULL::text,   936),
    ('E15', 'operational',  'Station rebalancing trips - this week',  220.00, NULL::text, NULL::text,   24),
    ('E16', 'operational',  'Cleaning + lubrication batch',           180.00, NULL::text, NULL::text,   168),
    ('E17', 'operational',  'Helmet restock + safety check',          150.00, NULL::text, NULL::text,   360)
)
INSERT INTO admin_expenses (expense_type, description, amount, related_booking_id, related_bike_id, created_at)
SELECT
  e.type_text::admin_expense_type, e.description, e.amount,
  bk.id, bi.id,
  NOW() - (e.offset_hours || ' hours')::INTERVAL
FROM demo_expenses e
LEFT JOIN bookings bk ON bk.notes = 'seed:' || e.related_booking_tag
LEFT JOIN bikes bi ON bi.bike_code = e.related_bike_code
WHERE NOT EXISTS (
  SELECT 1 FROM admin_expenses x WHERE x.description = e.description
);


-- ── 12. Admin activity log (Recent Activity widget) ────────
WITH demo_activity(tag, type_text, title, description, booking_tag, user_email, bike_code, offset_hours) AS (
  VALUES
    ('A01', 'payment_received',       'Payment received: $1.00',           'Alice Johnson - Ride Now unlock',           'B001', 'alice.johnson@university.edu', 'BIKE-001', 1),
    ('A02', 'payment_received',       'Payment received: $10.00',          'Alice Johnson - 45 min ride',               'B010', 'alice.johnson@university.edu', 'BIKE-002', 2),
    ('A03', 'payment_received',       'Payment received: $7.00',           'Bob Smith - 30 min ride',                   'B011', 'bob.smith@university.edu',     'BIKE-007', 4),
    ('A04', 'payment_received',       'Payment received: $13.00',          'Michael Brown - 60 min ride',               'B012', 'michael.brown@university.edu', 'BIKE-024', 5),
    ('A05', 'payment_received',       'Payment received: $6.00',           'Sarah Taylor - 25 min ride',                'B013', 'sarah.taylor@university.edu',  'BIKE-031', 3),
    ('A06', 'booking_completed',      'Ride completed',                    'James Carter - 40 min on BIKE-047',         'B014', 'james.carter@university.edu',  'BIKE-047', 7),
    ('A07', 'booking_completed',      'Ride completed',                    'Priya Patel - 55 min on BIKE-052',          'B015', 'priya.patel@university.edu',   'BIKE-052', 9),
    ('A08', 'bike_returned',          'Bike returned',                     'BIKE-002 returned to UTS Tower',            'B010', 'alice.johnson@university.edu', 'BIKE-002', 2),
    ('A09', 'bike_returned',          'Bike returned',                     'BIKE-007 returned to Central Station',      'B011', 'bob.smith@university.edu',     'BIKE-007', 4),
    ('A10', 'maintenance_flagged',    'Maintenance flagged: BIKE-011',     'Brake issue reported by Alice Johnson',     NULL::text, 'alice.johnson@university.edu', 'BIKE-011', 2),
    ('A11', 'maintenance_flagged',    'Maintenance flagged: BIKE-020',     'Flat tyre reported by Bob Smith',           NULL::text, 'bob.smith@university.edu',     'BIKE-020', 8),
    ('A12', 'maintenance_flagged',    'Maintenance flagged: BIKE-029',     'Chain issue reported by Daniel Kim',        NULL::text, 'daniel.kim@university.edu',    'BIKE-029', 18),
    ('A13', 'maintenance_flagged',    'Maintenance flagged: BIKE-040',     'Battery low - reported by Emma Wilson',     NULL::text, 'emma.wilson@university.edu',   'BIKE-040', 36),
    ('A14', 'support_ticket_received','New support ticket',                'Daniel Kim - URGENT - Brake failure',       NULL::text, 'daniel.kim@university.edu',    NULL::text, 2),
    ('A15', 'support_ticket_received','New support ticket',                'Bob Smith - Charged twice for one ride',    NULL::text, 'bob.smith@university.edu',     NULL::text, 6),
    ('A16', 'support_ticket_received','New support ticket',                'Sarah Taylor - Refund still pending',       NULL::text, 'sarah.taylor@university.edu',  NULL::text, 96),
    ('A17', 'support_ticket_received','New support ticket',                'James Carter - Cannot end PAYG ride',       NULL::text, 'james.carter@university.edu',  NULL::text, 120),
    ('A18', 'refund_requested',       'Refund requested',                  'Alice Johnson - $13.00 (cancelled)',        'B080', 'alice.johnson@university.edu', NULL::text, 240),
    ('A19', 'refund_requested',       'Refund requested',                  'Bob Smith - $7.00 (cancelled)',             'B081', 'bob.smith@university.edu',     NULL::text, 480),
    ('A20', 'refund_requested',       'Refund requested',                  'Priya Patel - $7.00 (expired)',             'B090', 'priya.patel@university.edu',   NULL::text, 168),
    ('A21', 'payment_received',       'Payment received: $11.00',          'Alice Johnson - Weekly ride',               'B020', 'alice.johnson@university.edu', NULL::text, 29),
    ('A22', 'payment_received',       'Payment received: $13.00',          'Bob Smith - Weekly ride',                   'B021', 'bob.smith@university.edu',     NULL::text, 49),
    ('A23', 'payment_received',       'Payment received: $8.00',           'Daniel Kim - Weekly ride',                  'B022', 'daniel.kim@university.edu',    NULL::text, 71),
    ('A24', 'payment_received',       'Payment received: $12.00',          'Sarah Taylor - 65 min ride',                'B026', 'sarah.taylor@university.edu',  NULL::text, 99),
    ('A25', 'payment_received',       'Payment received: $16.00',          'Daniel Kim - Long ride',                    'B032', 'daniel.kim@university.edu',    NULL::text, 147),
    ('A26', 'booking_completed',      'Ride completed',                    'Sophia Nguyen - 40 min',                    'B040', 'sophia.nguyen@university.edu', NULL::text, 191),
    ('A27', 'booking_completed',      'Ride completed',                    'Michael Brown - 55 min',                    'B041', 'michael.brown@university.edu', NULL::text, 239),
    ('A28', 'booking_completed',      'Ride completed',                    'Sarah Taylor - 30 min',                     'B042', 'sarah.taylor@university.edu',  NULL::text, 263),
    ('A29', 'booking_completed',      'Ride completed',                    'James Carter - 45 min',                     'B043', 'james.carter@university.edu',  NULL::text, 311),
    ('A30', 'booking_completed',      'Ride completed',                    'Priya Patel - 35 min',                      'B044', 'priya.patel@university.edu',   NULL::text, 359)
)
INSERT INTO admin_activity_log (activity_type, title, description, related_booking_id, related_user_id, related_bike_id, created_at)
SELECT
  a.type_text::admin_activity_type, a.title, a.description,
  bk.id, u.id, bi.id,
  NOW() - (a.offset_hours || ' hours')::INTERVAL
FROM demo_activity a
LEFT JOIN bookings bk ON bk.notes = 'seed:' || a.booking_tag
LEFT JOIN users u    ON u.email = a.user_email
LEFT JOIN bikes bi   ON bi.bike_code = a.bike_code
WHERE NOT EXISTS (
  SELECT 1 FROM admin_activity_log x WHERE x.title = a.title AND x.description = a.description
);


COMMIT;

-- ============================================================
--  Seed summary (verify after running):
--    users:              11   (1 admin + 5 students + 5 staff)
--    stations:           20
--    bikes:             100   (mostly available, some maintenance/in_use/retired)
--    bookings:           60   (1 active + 4 upcoming + 46 completed + 7 cancelled + 5 expired - 3 cancelled w/ refunds)
--    payments:           54
--    maintenance_logs:   25
--    support_tickets:    30
--    refund_requests:     8
--    notifications:      56
--    admin_expenses:     17
--    admin_activity_log: 30
-- ============================================================
