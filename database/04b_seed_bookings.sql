-- ============================================================
--  CAMPUS BIKE SHARING PLATFORM — Extra booking history seed
--  04b_seed_bookings.sql
--
--  Adds varied per-user booking history on top of 04_seed.sql so
--  the My Bookings page looks populated for every demo student.
--  Each demo user gets a DIFFERENT mix of statuses — when Alice
--  logs in she sees Alice's bookings; Bob sees Bob's; etc.
--
--  Pricing reflects the current rate of $1.00 unlock + $0.20/min:
--    15 min ride =  $1.00 + (15 × $0.20) = $4.00
--    30 min ride =  $1.00 + (30 × $0.20) = $7.00
--    45 min ride =  $1.00 + (45 × $0.20) = $10.00
--    60 min ride =  $1.00 + (60 × $0.20) = $13.00
--    90 min ride =  $1.00 + (90 × $0.20) = $19.00
--
--  Idempotent re-runs: blow away the rows we add here so the file
--  can be applied repeatedly during development.
--
--  Run order:
--    psql -d campus_bike_sharing -f 01_schema.sql
--    psql -d campus_bike_sharing -f 02_functions.sql
--    psql -d campus_bike_sharing -f 03_views.sql
--    psql -d campus_bike_sharing -f 04_seed.sql
--    psql -d campus_bike_sharing -f 04b_seed_bookings.sql   ← this file
-- ============================================================


-- ──────────────────────────────────────────────────────────────
-- Clear our extra seed rows so the file is safely re-runnable.
-- We tag every booking inserted here with 'demo-seed' in `notes`
-- so this DELETE only nukes our own rows, not real user bookings.
-- ──────────────────────────────────────────────────────────────
DELETE FROM payments     WHERE booking_id IN (SELECT id FROM bookings WHERE notes LIKE 'demo-seed%');
DELETE FROM bike_ratings WHERE booking_id IN (SELECT id FROM bookings WHERE notes LIKE 'demo-seed%');
DELETE FROM bookings     WHERE notes LIKE 'demo-seed%';


-- ──────────────────────────────────────────────────────────────
-- Helper: resolve user/bike/station ids from human-readable names
-- so this seed survives renumbering. We CTE them all once.
-- ──────────────────────────────────────────────────────────────

-- ─── ALICE (user_id = 3) ───────────────────────────────────────
--   1 currently active ride, 2 upcoming reservations,
--   5 completed rides (some rated), 1 cancelled
INSERT INTO bookings
  (user_id, bike_id, pickup_station_id, return_station_id,
   start_time, end_time, status, expires_at, duration_minutes, fee_amount, notes)
SELECT
  u.id, bk.id, sp.id, sr.id,
  v.start_time, v.end_time, v.status::booking_status, v.start_time + INTERVAL '15 min',
  v.duration_minutes, v.fee_amount, 'demo-seed:alice'
FROM (
  VALUES
    -- (bike_code, pickup_station, return_station, start_time, end_time, status, duration_minutes, fee_amount)
    ('BIKE-003',  'Library North Stand',   'Engineering Block A', NOW() - INTERVAL '15 min',                    NULL,                                  'active',    NULL, 0.00),
    ('BIKE-005',  'Student Union Hub',     'Student Union Hub',   NOW() + INTERVAL '2 day 9 hours',             NOW() + INTERVAL '2 day 9 hours 30 min','upcoming',  30,  7.00),
    ('BIKE-009',  'Main Gate East',        'Business School',     NOW() + INTERVAL '5 day 1 hour',              NOW() + INTERVAL '5 day 1 hour 45 min', 'upcoming',  45, 10.00),
    ('BIKE-002',  'Library North Stand',   'Business School',     NOW() - INTERVAL '4 hours',                   NOW() - INTERVAL '3 hours 30 min',     'completed', 30,  7.00),
    ('BIKE-006',  'Student Union Hub',     'Science Building',    NOW() - INTERVAL '2 day 5 hours',             NOW() - INTERVAL '2 day 4 hours 15 min','completed', 45, 10.00),
    ('BIKE-010',  'Main Gate East',        'Residence Hall North',NOW() - INTERVAL '6 day 10 hours',            NOW() - INTERVAL '6 day 9 hours 35 min','completed', 25,  6.00),
    ('BIKE-012',  'Residence Hall North',  'Library North Stand', NOW() - INTERVAL '9 day 8 hours',             NOW() - INTERVAL '9 day 7 hours 5 min', 'completed', 55, 12.00),
    ('BIKE-013',  'Residence Hall North',  'Engineering Block A', NOW() - INTERVAL '14 day 7 hours',            NOW() - INTERVAL '14 day 6 hours 20 min','completed',40,  9.00),
    ('BIKE-014',  'Business School',       NULL,                  NOW() - INTERVAL '19 day 6 hours',            NOW() - INTERVAL '19 day 5 hours 55 min','cancelled', 5,  0.00)
) AS v(bike_code, pickup_station, return_station, start_time, end_time, status, duration_minutes, fee_amount)
JOIN users    u  ON u.email = 'alice@university.edu'
JOIN bikes    bk ON bk.bike_code   = v.bike_code
JOIN stations sp ON sp.station_name = v.pickup_station
LEFT JOIN stations sr ON sr.station_name = v.return_station;


-- ─── BOB (user_id = 4) ─────────────────────────────────────────
--   Already has an active ride in 04_seed.sql, so we only add:
--   1 upcoming, 4 completed, 1 cancelled
INSERT INTO bookings
  (user_id, bike_id, pickup_station_id, return_station_id,
   start_time, end_time, status, expires_at, duration_minutes, fee_amount, notes)
SELECT
  u.id, bk.id, sp.id, sr.id,
  v.start_time, v.end_time, v.status::booking_status, v.start_time + INTERVAL '15 min',
  v.duration_minutes, v.fee_amount, 'demo-seed:bob'
FROM (
  VALUES
    ('BIKE-008',  'Sports Complex Entry',  'Sports Complex Entry',NOW() + INTERVAL '1 day 4 hours',             NOW() + INTERVAL '1 day 5 hours',       'upcoming',  60, 13.00),
    ('BIKE-001',  'Library North Stand',   'Student Union Hub',   NOW() - INTERVAL '7 hours',                   NOW() - INTERVAL '6 hours 25 min',     'completed', 35,  8.00),
    ('BIKE-005',  'Student Union Hub',     'Library North Stand', NOW() - INTERVAL '1 day 6 hours',             NOW() - INTERVAL '1 day 5 hours 20 min','completed', 40,  9.00),
    ('BIKE-009',  'Main Gate East',        'Sports Complex Entry',NOW() - INTERVAL '4 day 9 hours',             NOW() - INTERVAL '4 day 8 hours 45 min','completed', 15,  4.00),
    ('BIKE-011',  'Science Building',      'Main Gate East',      NOW() - INTERVAL '8 day 3 hours',             NOW() - INTERVAL '8 day 1 hour 30 min', 'completed', 90, 19.00),
    ('BIKE-012',  'Residence Hall North',  NULL,                  NOW() - INTERVAL '12 day 10 hours',           NOW() - INTERVAL '12 day 9 hours 56 min','cancelled', 4,  0.00)
) AS v(bike_code, pickup_station, return_station, start_time, end_time, status, duration_minutes, fee_amount)
JOIN users    u  ON u.email = 'bob@university.edu'
JOIN bikes    bk ON bk.bike_code    = v.bike_code
JOIN stations sp ON sp.station_name = v.pickup_station
LEFT JOIN stations sr ON sr.station_name = v.return_station;


-- ─── CAROL (user_id = 5) ───────────────────────────────────────
--   No active ride, 2 upcoming, 4 completed, 1 cancelled
INSERT INTO bookings
  (user_id, bike_id, pickup_station_id, return_station_id,
   start_time, end_time, status, expires_at, duration_minutes, fee_amount, notes)
SELECT
  u.id, bk.id, sp.id, sr.id,
  v.start_time, v.end_time, v.status::booking_status, v.start_time + INTERVAL '15 min',
  v.duration_minutes, v.fee_amount, 'demo-seed:carol'
FROM (
  VALUES
    ('BIKE-002',  'Library North Stand',   'Library North Stand', NOW() + INTERVAL '3 hours',                   NOW() + INTERVAL '3 hours 30 min',     'upcoming',  30,  7.00),
    ('BIKE-006',  'Student Union Hub',     'Engineering Block A', NOW() + INTERVAL '3 day 6 hours',             NOW() + INTERVAL '3 day 7 hours',       'upcoming',  60, 13.00),
    ('BIKE-001',  'Library North Stand',   'Business School',     NOW() - INTERVAL '10 hours',                  NOW() - INTERVAL '9 hours 10 min',     'completed', 50, 11.00),
    ('BIKE-005',  'Student Union Hub',     'Sports Complex Entry',NOW() - INTERVAL '2 day 13 hours',            NOW() - INTERVAL '2 day 12 hours 35 min','completed',25,  6.00),
    ('BIKE-008',  'Sports Complex Entry',  'Residence Hall North',NOW() - INTERVAL '5 day 17 hours',            NOW() - INTERVAL '5 day 16 hours 15 min','completed',45, 10.00),
    ('BIKE-013',  'Residence Hall North',  'Library North Stand', NOW() - INTERVAL '11 day 4 hours',            NOW() - INTERVAL '11 day 3 hours 25 min','completed',35,  8.00),
    ('BIKE-014',  'Business School',       NULL,                  NOW() - INTERVAL '16 day 9 hours',            NOW() - INTERVAL '16 day 8 hours 50 min','cancelled', 10, 0.00)
) AS v(bike_code, pickup_station, return_station, start_time, end_time, status, duration_minutes, fee_amount)
JOIN users    u  ON u.email = 'carol@university.edu'
JOIN bikes    bk ON bk.bike_code    = v.bike_code
JOIN stations sp ON sp.station_name = v.pickup_station
LEFT JOIN stations sr ON sr.station_name = v.return_station;


-- ─── DAVID (user_id = 6) ───────────────────────────────────────
--   Lighter history: 3 completed, 2 cancelled, 1 upcoming
INSERT INTO bookings
  (user_id, bike_id, pickup_station_id, return_station_id,
   start_time, end_time, status, expires_at, duration_minutes, fee_amount, notes)
SELECT
  u.id, bk.id, sp.id, sr.id,
  v.start_time, v.end_time, v.status::booking_status, v.start_time + INTERVAL '15 min',
  v.duration_minutes, v.fee_amount, 'demo-seed:david'
FROM (
  VALUES
    ('BIKE-003',  'Engineering Block A',   'Library North Stand', NOW() + INTERVAL '4 day 2 hours',             NOW() + INTERVAL '4 day 2 hours 30 min','upcoming',  30,  7.00),
    ('BIKE-009',  'Main Gate East',        'Student Union Hub',   NOW() - INTERVAL '1 day 9 hours',             NOW() - INTERVAL '1 day 8 hours 5 min', 'completed', 55, 12.00),
    ('BIKE-010',  'Main Gate East',        'Residence Hall North',NOW() - INTERVAL '6 day 13 hours',            NOW() - INTERVAL '6 day 12 hours 40 min','completed', 20,  5.00),
    ('BIKE-013',  'Residence Hall North',  'Business School',     NOW() - INTERVAL '13 day 5 hours',            NOW() - INTERVAL '13 day 4 hours 25 min','completed',35,  8.00),
    ('BIKE-001',  'Library North Stand',   NULL,                  NOW() - INTERVAL '17 day 11 hours',           NOW() - INTERVAL '17 day 10 hours 51 min','cancelled', 9,  0.00),
    ('BIKE-011',  'Science Building',      NULL,                  NOW() - INTERVAL '20 day 6 hours',            NOW() - INTERVAL '20 day 5 hours 53 min','cancelled', 7,  0.00)
) AS v(bike_code, pickup_station, return_station, start_time, end_time, status, duration_minutes, fee_amount)
JOIN users    u  ON u.email = 'david@university.edu'
JOIN bikes    bk ON bk.bike_code    = v.bike_code
JOIN stations sp ON sp.station_name = v.pickup_station
LEFT JOIN stations sr ON sr.station_name = v.return_station;


-- ──────────────────────────────────────────────────────────────
-- Payment rows for every COMPLETED booking we inserted (cancelled
-- and upcoming rides don't get a payment record yet).
-- We split methods so the My Bookings table shows variety.
-- ──────────────────────────────────────────────────────────────
INSERT INTO payments (booking_id, user_id, amount, currency, payment_method, status, transaction_reference, paid_at)
SELECT
  b.id, b.user_id, b.fee_amount, 'AUD',
  -- Rotate payment methods so the UI has variety
  (ARRAY['credit_card','credit_card','wallet','campus_card','credit_card']::payment_method[])[1 + (b.id % 5)],
  'paid'::payment_status,
  'ch_demo_' || lpad(b.id::text, 8, '0'),
  b.end_time
FROM bookings b
WHERE b.notes LIKE 'demo-seed%' AND b.status = 'completed';


-- ──────────────────────────────────────────────────────────────
-- A few 4-5 star ratings on the most recent completed rides — so
-- the My Bookings page shows stars next to ride history items.
-- ──────────────────────────────────────────────────────────────
INSERT INTO bike_ratings (booking_id, user_id, bike_id, rating, comment)
SELECT b.id, b.user_id, b.bike_id,
  -- Deterministic: bookings ending in 0..1 get 5, 2..3 get 4, else 3
  CASE WHEN b.id % 5 < 2 THEN 5 WHEN b.id % 5 < 4 THEN 4 ELSE 3 END,
  CASE WHEN b.id % 5 < 2 THEN 'Smooth ride — exactly what I needed between classes.'
       WHEN b.id % 5 < 4 THEN 'Good bike. Seat could be more comfortable.'
       ELSE 'Did the job.' END
FROM bookings b
WHERE b.notes LIKE 'demo-seed%'
  AND b.status = 'completed'
  -- Only rate the most recent two per user so the page has unrated rows too
  AND b.id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY end_time DESC) AS rn
      FROM bookings WHERE notes LIKE 'demo-seed%' AND status = 'completed'
    ) ranked WHERE rn <= 2
  );


-- ──────────────────────────────────────────────────────────────
-- Keep bike state consistent: any bike that has an active demo
-- booking must itself be 'in_use' with no station (constraint
-- chk_bikes_in_use_requires_no_station). All others go back to
-- 'available' unless they were already in maintenance/retired.
-- ──────────────────────────────────────────────────────────────
UPDATE bikes
   SET status = 'in_use', station_id = NULL, updated_at = NOW()
 WHERE id IN (
   SELECT bike_id FROM bookings WHERE status = 'active' AND notes LIKE 'demo-seed%'
 );


-- Quick verification queries (optional — uncomment to inspect):
-- SELECT u.email, COUNT(*) AS total
--   FROM bookings b JOIN users u ON u.id = b.user_id
--   WHERE b.notes LIKE 'demo-seed%' GROUP BY u.email ORDER BY u.email;
--
-- SELECT u.email, b.status, COUNT(*) AS n
--   FROM bookings b JOIN users u ON u.id = b.user_id
--   WHERE b.notes LIKE 'demo-seed%'
--   GROUP BY u.email, b.status ORDER BY u.email, b.status;
