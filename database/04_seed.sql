-- ============================================================
--  Campus Bike Sharing — Consolidated demo seed (4 / 4)
--
--  Run after:
--    01_schema.sql, 02_functions.sql, 03_views.sql
--
--  Seeds the data a fresh deployment needs to demonstrate the
--  full user + admin flow:
--    1 admin, 5 students, 5 staff
--    Sydney CBD stations
--    Bikes parked at stations
--    Baseline system_settings (pricing, hours)
--    A few demo bookings + payments for the dashboards
--
--  Idempotent. Re-running the file does NOT create duplicates:
--    users        — ON CONFLICT (email) DO NOTHING
--    stations     — ON CONFLICT (station_name) DO NOTHING
--    bikes        — ON CONFLICT (bike_code) DO NOTHING
--    settings     — UPSERT (ON CONFLICT (key) DO UPDATE)
--    bookings     — guarded by NOT EXISTS lookups
--    payments     — guarded by NOT EXISTS lookups
--  No foreign-key references are inserted before their parents.
-- ============================================================

BEGIN;

-- ── 1. System settings (admin-tunable) ─────────────────────
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


-- ── 2. Users (1 admin, 5 students, 5 staff) ────────────────
--    All demo accounts share the same bcrypt hash so they all
--    use the same demo password. Reset before going to prod.
INSERT INTO users (full_name, email, password_hash, role, phone, is_active, email_verified)
VALUES
  -- Admin
  ('Admin User',     'admin@university.edu',          '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'admin',   '+61-2-5550-0001', TRUE, TRUE),

  -- Students
  ('Alice Johnson',  'alice.johnson@university.edu',  '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'student', '+61-2-5550-1001', TRUE, TRUE),
  ('Bob Smith',      'bob.smith@university.edu',      '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'student', '+61-2-5550-1002', TRUE, TRUE),
  ('Daniel Kim',     'daniel.kim@university.edu',     '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'student', '+61-2-5550-1003', TRUE, TRUE),
  ('Emma Wilson',    'emma.wilson@university.edu',    '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'student', '+61-2-5550-1004', TRUE, TRUE),
  ('Sophia Nguyen',  'sophia.nguyen@university.edu',  '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'student', '+61-2-5550-1005', TRUE, TRUE),

  -- Staff
  ('Dr Michael Brown','michael.brown@university.edu', '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'staff',   '+61-2-5550-2001', TRUE, TRUE),
  ('Sarah Taylor',   'sarah.taylor@university.edu',   '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'staff',   '+61-2-5550-2002', TRUE, TRUE),
  ('James Carter',   'james.carter@university.edu',   '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'staff',   '+61-2-5550-2003', TRUE, TRUE),
  ('Priya Patel',    'priya.patel@university.edu',    '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'staff',   '+61-2-5550-2004', TRUE, TRUE),
  ('Liam Anderson',  'liam.anderson@university.edu',  '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'staff',   '+61-2-5550-2005', TRUE, TRUE)
ON CONFLICT (email) DO NOTHING;


-- ── 3. Stations (Sydney CBD) ───────────────────────────────
INSERT INTO stations (station_name, latitude, longitude, capacity, campus_zone, address, is_active) VALUES
  ('Library North Stand',  -33.886100, 151.199400, 10, 'North',    'Main Library, North Entrance',     TRUE),
  ('Engineering Block A',  -33.887200, 151.200100,  8, 'East',     'Engineering Quad, Building A',     TRUE),
  ('Student Union Hub',    -33.885500, 151.198700, 12, 'Central',  'Student Union Plaza',              TRUE),
  ('Sports Complex Entry', -33.889000, 151.201500,  6, 'South',    'Sports Complex Main Gate',         TRUE),
  ('Main Gate East',       -33.884800, 151.202300,  8, 'Main Gate','Campus East Gate',                 TRUE),
  ('Science Building',     -33.886800, 151.197500,  8, 'Central',  'Faculty of Science',               TRUE),
  ('Residence Hall North', -33.883900, 151.199900, 12, 'North',    'Dormitory Complex',                TRUE),
  ('Business School',      -33.887800, 151.196900,  6, 'West',     'Business Faculty',                 TRUE)
ON CONFLICT (station_name) DO NOTHING;


-- ── 4. Bikes (15) ──────────────────────────────────────────
-- station_id is looked up by name so this stays idempotent
-- and survives station re-seeding.
WITH s AS (SELECT id, station_name FROM stations)
INSERT INTO bikes (bike_code, model, status, station_id) VALUES
  ('BIKE-001', 'City Cruiser',   'available',   (SELECT id FROM s WHERE station_name = 'Library North Stand')),
  ('BIKE-002', 'City Cruiser',   'available',   (SELECT id FROM s WHERE station_name = 'Library North Stand')),
  ('BIKE-003', 'Mountain Trail', 'available',   (SELECT id FROM s WHERE station_name = 'Engineering Block A')),
  ('BIKE-004', 'City Cruiser',   'available',   (SELECT id FROM s WHERE station_name = 'Engineering Block A')),
  ('BIKE-005', 'Mountain Trail', 'available',   (SELECT id FROM s WHERE station_name = 'Student Union Hub')),
  ('BIKE-006', 'City Cruiser',   'available',   (SELECT id FROM s WHERE station_name = 'Student Union Hub')),
  ('BIKE-007', 'City Cruiser',   'maintenance', NULL),
  ('BIKE-008', 'Mountain Trail', 'available',   (SELECT id FROM s WHERE station_name = 'Sports Complex Entry')),
  ('BIKE-009', 'City Cruiser',   'available',   (SELECT id FROM s WHERE station_name = 'Main Gate East')),
  ('BIKE-010', 'Mountain Trail', 'available',   (SELECT id FROM s WHERE station_name = 'Main Gate East')),
  ('BIKE-011', 'City Cruiser',   'available',   (SELECT id FROM s WHERE station_name = 'Science Building')),
  ('BIKE-012', 'City Cruiser',   'available',   (SELECT id FROM s WHERE station_name = 'Residence Hall North')),
  ('BIKE-013', 'Mountain Trail', 'available',   (SELECT id FROM s WHERE station_name = 'Residence Hall North')),
  ('BIKE-014', 'City Cruiser',   'available',   (SELECT id FROM s WHERE station_name = 'Business School')),
  ('BIKE-015', 'Mountain Trail', 'available',   (SELECT id FROM s WHERE station_name = 'Business School'))
ON CONFLICT (bike_code) DO NOTHING;


-- ── 5. Demo bookings + payments ────────────────────────────
-- Two completed rides + one upcoming reservation so the User
-- dashboard / Ride History / Admin reports all have something
-- to render. Guarded by NOT EXISTS so re-running the seed
-- file is safe.
DO $$
DECLARE
  v_alice_id INTEGER;
  v_michael_id INTEGER;
  v_bike1 INTEGER;
  v_bike2 INTEGER;
  v_bike3 INTEGER;
  v_station_a INTEGER;
  v_station_b INTEGER;
  v_booking_id INTEGER;
BEGIN
  SELECT id INTO v_alice_id    FROM users    WHERE email = 'alice.johnson@university.edu';
  SELECT id INTO v_michael_id  FROM users    WHERE email = 'michael.brown@university.edu';
  SELECT id INTO v_bike1       FROM bikes    WHERE bike_code = 'BIKE-001';
  SELECT id INTO v_bike2       FROM bikes    WHERE bike_code = 'BIKE-005';
  SELECT id INTO v_bike3       FROM bikes    WHERE bike_code = 'BIKE-009';
  SELECT id INTO v_station_a   FROM stations WHERE station_name = 'Library North Stand';
  SELECT id INTO v_station_b   FROM stations WHERE station_name = 'Student Union Hub';

  -- Demo ride #1: completed fixed-duration booking by Alice
  IF NOT EXISTS (SELECT 1 FROM bookings WHERE user_id = v_alice_id AND bike_id = v_bike1 AND status = 'completed') THEN
    INSERT INTO bookings (user_id, bike_id, pickup_station_id, return_station_id, start_time, end_time, status, duration_minutes, fee_amount, notes)
    VALUES (v_alice_id, v_bike1, v_station_a, v_station_a, NOW() - INTERVAL '2 days' - INTERVAL '30 minutes', NOW() - INTERVAL '2 days', 'completed', 30, 7.00, 'Demo seed')
    RETURNING id INTO v_booking_id;

    INSERT INTO payments (booking_id, user_id, amount, currency, payment_method, status, transaction_reference, paid_at)
    VALUES (v_booking_id, v_alice_id, 7.00, 'AUD', 'credit_card', 'paid', 'demo_alice_completed', NOW() - INTERVAL '2 days');
  END IF;

  -- Demo ride #2: completed PAYG ride by staff member Michael
  IF NOT EXISTS (SELECT 1 FROM bookings WHERE user_id = v_michael_id AND bike_id = v_bike2 AND status = 'completed') THEN
    INSERT INTO bookings (user_id, bike_id, pickup_station_id, return_station_id, start_time, end_time, status, duration_minutes, fee_amount, notes)
    VALUES (v_michael_id, v_bike2, v_station_b, v_station_b, NOW() - INTERVAL '1 day' - INTERVAL '20 minutes', NOW() - INTERVAL '1 day', 'completed', 20, 5.00, 'Demo seed')
    RETURNING id INTO v_booking_id;

    INSERT INTO payments (booking_id, user_id, amount, currency, payment_method, status, transaction_reference, paid_at)
    VALUES (v_booking_id, v_michael_id, 5.00, 'AUD', 'credit_card', 'paid', 'demo_michael_completed', NOW() - INTERVAL '1 day');
  END IF;

  -- Demo upcoming reservation by Alice (so the My Bookings page has an "Upcoming")
  IF NOT EXISTS (SELECT 1 FROM bookings WHERE user_id = v_alice_id AND bike_id = v_bike3 AND status = 'pending' AND start_time > NOW()) THEN
    INSERT INTO bookings (user_id, bike_id, pickup_station_id, start_time, end_time, status, duration_minutes, fee_amount, notes)
    VALUES (v_alice_id, v_bike3, v_station_a, NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day' + INTERVAL '1 hour', 'pending', 60, 13.00, 'Demo seed');
  END IF;
END $$;


COMMIT;

-- ── 6. Schema extensions installed at runtime ──────────────
-- The application also creates the following on first boot:
--   * users.stripe_customer_id
--   * student_payment_methods (per-user saved cards)
--   * bookings: ride_mode, unlock_fee_paid, stripe_checkout_session_id,
--               stripe_payment_intent_id, final_payment_intent_id, …
--   * payments: type, stripe_payment_intent_id, stripe_checkout_session_id
--   * admin_activity_log + supporting enums
--   * support_tickets, refund_requests, notifications
-- All of those are created idempotently by ensurePaymentMethodSchema()
-- and ensureStudentSchema() in backend/utils/ — no manual SQL needed.
