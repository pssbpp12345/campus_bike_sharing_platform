-- ============================================================
--  CAMPUS BIKE SHARING PLATFORM — PostgreSQL Schema (Part 4/5)
--  04_seed.sql  —  Demo data for local development & SRS screenshots
--
--  NOTE: The password_hash values below are bcrypt hashes for the
--        plaintext password "Password123!". Replace in production.
--        Generated via: bcrypt.hash("Password123!", 12)
-- ============================================================


-- ------------------------------------------------------------
-- System settings (admin-tunable)
-- ------------------------------------------------------------
INSERT INTO system_settings (key, value, description) VALUES
    ('booking_timeout_minutes', '15',   'Auto-expire bookings after this many idle minutes.'),
    ('hourly_rate_usd',         '0.00', 'Default per-hour rental fee. 0 = free for campus users.'),
    ('campus_email_domain',     'university.edu', 'Required email domain for registration.'),
    ('max_active_bookings',     '1',    'Max simultaneous active bookings per user.');


-- ------------------------------------------------------------
-- Users  (1 admin, 1 staff, 4 students)
-- ------------------------------------------------------------
INSERT INTO users (full_name, email, password_hash, role, phone, email_verified) VALUES
    ('Admin User',    'admin@university.edu',   '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'admin',   '+1-555-0100', TRUE),
    ('Prof. Janet L', 'janet.l@university.edu', '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'staff',   '+1-555-0101', TRUE),
    ('Alice Johnson', 'alice@university.edu',   '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'student', '+1-555-0102', TRUE),
    ('Bob Smith',     'bob@university.edu',     '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'student', '+1-555-0103', TRUE),
    ('Carol White',   'carol@university.edu',   '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'student', '+1-555-0104', TRUE),
    ('David Kim',     'david@university.edu',   '$2b$12$eZ8J3o0m1NvT5gYQv2LRq.Rn.G4qB5bYvQ0cW8RKkN1dFh7p6eSIy', 'student', '+1-555-0105', FALSE);


-- ------------------------------------------------------------
-- Stations  (8 across the campus)
-- ------------------------------------------------------------
INSERT INTO stations (station_name, latitude, longitude, capacity, campus_zone, address) VALUES
    ('Library North Stand',      -33.886100,  151.199400, 10, 'North',    'Main Library, North Entrance'),
    ('Engineering Block A',      -33.887200,  151.200100,  8, 'East',     'Engineering Quad, Building A'),
    ('Student Union Hub',        -33.885500,  151.198700, 12, 'Central',  'Student Union Plaza'),
    ('Sports Complex Entry',     -33.889000,  151.201500,  6, 'South',    'Sports Complex Main Gate'),
    ('Main Gate East',           -33.884800,  151.202300,  8, 'Main Gate','Campus East Gate'),
    ('Science Building',         -33.886800,  151.197500,  8, 'Central',  'Faculty of Science'),
    ('Residence Hall North',     -33.883900,  151.199900, 12, 'North',    'Dormitory Complex'),
    ('Business School',          -33.887800,  151.196900,  6, 'West',     'Business Faculty');


-- ------------------------------------------------------------
-- Bikes  (15 mixed statuses)
-- ------------------------------------------------------------
INSERT INTO bikes (bike_code, model, status, station_id) VALUES
    ('BIKE-001', 'City Cruiser',    'available',   1),
    ('BIKE-002', 'City Cruiser',    'available',   1),
    ('BIKE-003', 'Mountain Trail',  'available',   2),
    ('BIKE-004', 'City Cruiser',    'in_use',      NULL),       -- currently booked
    ('BIKE-005', 'Mountain Trail',  'available',   3),
    ('BIKE-006', 'City Cruiser',    'available',   3),
    ('BIKE-007', 'City Cruiser',    'maintenance', NULL),
    ('BIKE-008', 'Mountain Trail',  'available',   4),
    ('BIKE-009', 'City Cruiser',    'available',   5),
    ('BIKE-010', 'Mountain Trail',  'available',   5),
    ('BIKE-011', 'City Cruiser',    'available',   6),
    ('BIKE-012', 'City Cruiser',    'available',   7),
    ('BIKE-013', 'Mountain Trail',  'available',   7),
    ('BIKE-014', 'City Cruiser',    'available',   8),
    ('BIKE-015', 'Mountain Trail',  'retired',     NULL);


-- ------------------------------------------------------------
-- Bookings  (historical + one active)
-- ------------------------------------------------------------
INSERT INTO bookings
    (user_id, bike_id, pickup_station_id, return_station_id,
     start_time,                         end_time,                             status,      duration_minutes, fee_amount)
VALUES
    -- Alice: completed — Library → Engineering (30 min)
    (3, 3, 1, 2, NOW() - INTERVAL '2 hours',                NOW() - INTERVAL '1 hour 30 min',  'completed', 30, 0.00),
    -- Bob: currently active — BIKE-004 from Engineering
    (4, 4, 2, NULL, NOW() - INTERVAL '20 min',              NULL,                               'active',    NULL, 0.00),
    -- Carol: cancelled quickly
    (5, 9, 5, NULL, NOW() - INTERVAL '3 hours',             NOW() - INTERVAL '2 hours 50 min', 'cancelled', 10, 0.00),
    -- David: completed — Student Union → Residence Hall (45 min)
    (6, 6, 3, 7, NOW() - INTERVAL '1 day 4 hours',          NOW() - INTERVAL '1 day 3 hours 15 min', 'completed', 45, 0.00),
    -- Alice: completed another ride — Science → Business (20 min)
    (3, 11, 6, 8, NOW() - INTERVAL '3 days',                NOW() - INTERVAL '2 days 23 hours 40 min', 'completed', 20, 0.00),
    -- Bob: completed — Library → Library (60 min round trip)
    (4, 1, 1, 1, NOW() - INTERVAL '5 days',                 NOW() - INTERVAL '5 days' + INTERVAL '60 min', 'completed', 60, 0.00);

-- Update bike_004 — matches the active booking above
UPDATE bikes SET station_id = NULL WHERE id = 4;


-- ------------------------------------------------------------
-- Ratings (only on completed bookings)
-- ------------------------------------------------------------
INSERT INTO bike_ratings (booking_id, user_id, bike_id, rating, comment) VALUES
    (1, 3, 3,  5, 'Smooth ride, brakes felt solid.'),
    (4, 6, 6,  4, 'Comfortable but seat was a bit low.'),
    (5, 3, 11, 5, 'Perfect for the cross-campus route.'),
    (6, 4, 1,  3, 'Chain slipped once, otherwise fine.');


-- ------------------------------------------------------------
-- Maintenance logs
-- ------------------------------------------------------------
INSERT INTO maintenance_logs
    (bike_id, reported_by_user_id, issue_type, description, severity, status, reported_at)
VALUES
    (7,  4, 'flat_tire', 'Front tire flat after short ride.',             'high',    'in_progress', NOW() - INTERVAL '6 hours'),
    (1,  4, 'chain',     'Chain slipped during use, reported on return.', 'medium',  'reported',    NOW() - INTERVAL '5 days'),
    (15, 1, 'frame',     'Frame crack — bike retired.',                    'critical','resolved',    NOW() - INTERVAL '10 days');

UPDATE maintenance_logs
   SET resolved_at = NOW() - INTERVAL '9 days',
       resolved_by_admin_id = 1,
       resolution_notes = 'Bike retired from fleet; frame unsafe.'
 WHERE id = 3;


-- ------------------------------------------------------------
-- Admin audit log (a few realistic actions)
-- ------------------------------------------------------------
INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, details) VALUES
    (1, 'create_station', 'station', 7, '{"name":"Residence Hall North","capacity":12}'::jsonb),
    (1, 'retire_bike',    'bike',    15, '{"reason":"frame crack","log_id":3}'::jsonb),
    (1, 'update_setting', 'system_setting', NULL, '{"key":"booking_timeout_minutes","from":"10","to":"15"}'::jsonb);


-- ------------------------------------------------------------
-- Payments (all free campus rides in this demo)
-- ------------------------------------------------------------
INSERT INTO payments (booking_id, user_id, amount, payment_method, status, paid_at) VALUES
    (1, 3, 0.00, 'waived', 'paid', NOW() - INTERVAL '1 hour 29 min'),
    (4, 6, 0.00, 'waived', 'paid', NOW() - INTERVAL '1 day 3 hours'),
    (5, 3, 0.00, 'waived', 'paid', NOW() - INTERVAL '2 days 23 hours'),
    (6, 4, 0.00, 'waived', 'paid', NOW() - INTERVAL '5 days' + INTERVAL '61 min');


-- ------------------------------------------------------------
-- Sanity check (run this after seeding)
-- ------------------------------------------------------------
-- SELECT * FROM vw_station_availability ORDER BY station_id;
-- SELECT * FROM vw_active_bookings;
-- SELECT * FROM vw_booking_history LIMIT 10;
-- SELECT * FROM vw_bike_fleet_status;
-- SELECT * FROM vw_open_maintenance;
