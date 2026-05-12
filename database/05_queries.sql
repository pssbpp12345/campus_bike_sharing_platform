-- ============================================================
--  CAMPUS BIKE SHARING PLATFORM — PostgreSQL Schema (Part 5/5)
--  05_queries.sql  —  REFERENCE ONLY
--
--  This file is NOT executed against the database. It's a catalog
--  of the queries the Node.js/Express.js backend will run, grouped
--  by endpoint. Treat it as the bridge between the API spec and
--  the SQL layer — paste them into your route handlers as-is.
-- ============================================================


-- ============================================================
-- AUTH (1.0 DFD)
-- ============================================================

-- POST /api/auth/register
-- Params: $1 full_name, $2 email, $3 bcrypt(password), $4 role
INSERT INTO users (full_name, email, password_hash, role)
VALUES ($1, LOWER($2), $3, $4)
RETURNING id, full_name, email, role, created_at;

-- POST /api/auth/login (step 1: lookup)
-- Params: $1 email
SELECT id, full_name, email, password_hash, role, is_active
  FROM users
 WHERE LOWER(email) = LOWER($1)
 LIMIT 1;

-- POST /api/auth/login (step 2: record successful login)
-- Params: $1 user_id
UPDATE users SET last_login_at = NOW() WHERE id = $1;


-- ============================================================
-- STATIONS & MAP (2.0 DFD)
-- ============================================================

-- GET /api/stations  — map markers with live counts
SELECT * FROM vw_station_availability
 WHERE is_active = TRUE
 ORDER BY station_name;

-- GET /api/stations/:id  — station detail + docked bikes
SELECT s.*,
       (SELECT json_agg(json_build_object(
                'bike_id',   b.id,
                'bike_code', b.bike_code,
                'model',     b.model,
                'status',    b.status))
          FROM bikes b
         WHERE b.station_id = s.id)      AS bikes
  FROM stations s
 WHERE s.id = $1;


-- ============================================================
-- BOOK BIKE (3.0 DFD)
-- ============================================================

-- GET /api/stations/:id/available-bikes  — populates the Book Bike screen
SELECT id AS bike_id, bike_code, model
  FROM bikes
 WHERE station_id = $1 AND status = 'available'
 ORDER BY bike_code;

-- POST /api/bookings  — uses stored procedure for atomicity
-- Params: $1 user_id, $2 bike_id, $3 pickup_station_id
SELECT fn_create_booking($1, $2, $3) AS booking_id;

-- Pre-check: does this user already have an active booking?
-- (Backend should check before calling fn_create_booking for a better UX.)
SELECT id FROM bookings
 WHERE user_id = $1 AND status IN ('pending','active')
 LIMIT 1;


-- ============================================================
-- RETURN BIKE (4.0 DFD)
-- ============================================================

-- POST /api/bookings/:id/return
-- Params: $1 booking_id, $2 return_station_id, $3 hourly_rate (from system_settings)
SELECT fn_return_bike($1, $2, $3::DECIMAL);

-- POST /api/bookings/:id/rate  — optional post-ride rating
-- Params: $1 booking_id, $2 user_id, $3 bike_id, $4 rating, $5 comment
INSERT INTO bike_ratings (booking_id, user_id, bike_id, rating, comment)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (booking_id) DO UPDATE
   SET rating = EXCLUDED.rating, comment = EXCLUDED.comment;


-- ============================================================
-- MY BOOKINGS (General User — View Booking History UC)
-- ============================================================

-- GET /api/me/bookings
-- Params: $1 user_id, $2 limit, $3 offset
SELECT booking_id, bike_code, bike_model, pickup_station, return_station,
       start_time, end_time, duration_minutes, status, fee_amount,
       rating, rating_comment
  FROM vw_booking_history
 WHERE user_id = $1
 ORDER BY start_time DESC
 LIMIT $2 OFFSET $3;

-- GET /api/me/bookings/active  — single active booking for the user (if any)
SELECT * FROM vw_active_bookings WHERE user_id = $1 LIMIT 1;


-- ============================================================
-- MAINTENANCE (Flag Bike for Maintenance UC)
-- ============================================================

-- POST /api/bikes/:id/flag  — user or admin triggered
-- Params: $1 bike_id, $2 reporter_user_id, $3 issue_type, $4 description, $5 severity
SELECT fn_flag_bike_for_maintenance($1, $2, $3, $4, $5::maintenance_severity) AS log_id;

-- GET /api/admin/maintenance  — open queue
SELECT * FROM vw_open_maintenance;

-- POST /api/admin/maintenance/:id/resolve
-- Params: $1 log_id, $2 admin_id, $3 resolution_notes, $4 return_station_id
SELECT fn_resolve_maintenance($1, $2, $3, $4);


-- ============================================================
-- ADMIN — MANAGE BIKES & STATIONS (5.0 DFD)
-- ============================================================

-- GET /api/admin/bikes  — fleet overview
SELECT * FROM vw_bike_fleet_status ORDER BY bike_code;

-- POST /api/admin/stations
INSERT INTO stations (station_name, latitude, longitude, capacity, campus_zone, address)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- PATCH /api/admin/stations/:id
UPDATE stations
   SET station_name = COALESCE($2, station_name),
       capacity     = COALESCE($3, capacity),
       campus_zone  = COALESCE($4, campus_zone),
       is_active    = COALESCE($5, is_active)
 WHERE id = $1
 RETURNING *;

-- POST /api/admin/bikes
INSERT INTO bikes (bike_code, model, status, station_id)
VALUES ($1, $2, COALESCE($3,'available')::bike_status, $4)
RETURNING *;

-- DELETE /api/admin/bikes/:id — retire rather than hard-delete
UPDATE bikes SET status = 'retired', station_id = NULL WHERE id = $1;

-- GET /api/admin/bookings  — all bookings with filters
-- Params: $1 status (nullable), $2 limit, $3 offset
SELECT * FROM vw_booking_history
 WHERE ($1::booking_status IS NULL OR status = $1)
 ORDER BY start_time DESC
 LIMIT $2 OFFSET $3;

-- Helper: record an admin action
-- Params: $1 admin_id, $2 action, $3 entity_type, $4 entity_id, $5 details
SELECT fn_log_admin_action($1, $2, $3, $4, $5::jsonb);


-- ============================================================
-- ANALYTICS (6.0 DFD)
-- ============================================================

-- GET /api/admin/analytics/summary  — top cards on the dashboard
SELECT
    (SELECT COUNT(*) FROM users   WHERE is_active)                         AS active_users,
    (SELECT COUNT(*) FROM bikes   WHERE status = 'available')              AS available_bikes,
    (SELECT COUNT(*) FROM bikes   WHERE status = 'in_use')                 AS bikes_in_use,
    (SELECT COUNT(*) FROM bikes   WHERE status = 'maintenance')            AS bikes_in_maintenance,
    (SELECT COUNT(*) FROM bookings WHERE start_time >= CURRENT_DATE)       AS bookings_today,
    (SELECT COUNT(*) FROM bookings WHERE status IN ('pending','active'))   AS active_bookings,
    (SELECT COALESCE(SUM(fee_amount),0) FROM bookings
       WHERE start_time >= NOW() - INTERVAL '30 days')                     AS revenue_30d;

-- GET /api/admin/analytics/peak-hours
SELECT * FROM vw_analytics_peak_hours;

-- GET /api/admin/analytics/top-stations
SELECT * FROM vw_analytics_top_stations;

-- GET /api/admin/analytics/daily
SELECT * FROM vw_analytics_daily_summary;


-- ============================================================
-- BACKGROUND WORKER  (architecture diagram: "Background Worker")
-- ============================================================

-- Run every minute via cron, node-schedule, or pg_cron:
SELECT fn_expire_stale_bookings() AS expired_count;
