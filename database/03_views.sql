-- ============================================================
--  CAMPUS BIKE SHARING PLATFORM — PostgreSQL Schema (Part 3/5)
--  03_views.sql  —  Views powering the dashboards & map
-- ============================================================


-- ------------------------------------------------------------
-- vw_station_availability
--   Drives the Map Dashboard (2.0 View Stations & Map).
--   Returns per-station live counts of available bikes, docked bikes,
--   and open dock slots.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_station_availability AS
SELECT
    s.id                  AS station_id,
    s.station_name,
    s.latitude,
    s.longitude,
    s.capacity,
    s.campus_zone,
    s.is_active,
    COUNT(b.id) FILTER (WHERE b.status = 'available')   AS available_bikes,
    COUNT(b.id) FILTER (WHERE b.status = 'maintenance') AS bikes_in_maintenance,
    COUNT(b.id)                                         AS bikes_docked,
    GREATEST(s.capacity - COUNT(b.id), 0)               AS free_slots
FROM stations s
LEFT JOIN bikes b ON b.station_id = s.id
GROUP BY s.id;


-- ------------------------------------------------------------
-- vw_active_bookings
--   Admin view for "who has what out right now".
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_active_bookings AS
SELECT
    bk.id                 AS booking_id,
    bk.user_id,
    u.full_name           AS user_name,
    u.email               AS user_email,
    bk.bike_id,
    bi.bike_code,
    bi.model              AS bike_model,
    bk.pickup_station_id,
    sp.station_name       AS pickup_station,
    bk.start_time,
    bk.expires_at,
    EXTRACT(EPOCH FROM (NOW() - bk.start_time))::INT / 60 AS minutes_out
FROM bookings bk
JOIN users    u  ON u.id  = bk.user_id
JOIN bikes    bi ON bi.id = bk.bike_id
JOIN stations sp ON sp.id = bk.pickup_station_id
WHERE bk.status IN ('pending','active')
ORDER BY bk.start_time DESC;


-- ------------------------------------------------------------
-- vw_booking_history
--   Powers the "My Bookings" page and admin history view.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_booking_history AS
SELECT
    bk.id                  AS booking_id,
    bk.user_id,
    u.full_name            AS user_name,
    bi.bike_code,
    bi.model               AS bike_model,
    sp.station_name        AS pickup_station,
    sr.station_name        AS return_station,
    bk.start_time,
    bk.end_time,
    bk.duration_minutes,
    bk.status,
    bk.fee_amount,
    r.rating,
    r.comment              AS rating_comment
FROM bookings bk
JOIN users    u  ON u.id  = bk.user_id
JOIN bikes    bi ON bi.id = bk.bike_id
JOIN stations sp ON sp.id = bk.pickup_station_id
LEFT JOIN stations sr ON sr.id = bk.return_station_id
LEFT JOIN bike_ratings r ON r.booking_id = bk.id
ORDER BY bk.start_time DESC;


-- ------------------------------------------------------------
-- vw_bike_fleet_status
--   Admin fleet overview: each bike's current status, location, ride count,
--   and whether it has any open maintenance issues.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_bike_fleet_status AS
SELECT
    bi.id                                                         AS bike_id,
    bi.bike_code,
    bi.model,
    bi.status,
    bi.total_rides,
    bi.last_maintenance_at,
    s.station_name                                                AS current_station,
    s.campus_zone,
    (SELECT COUNT(*) FROM maintenance_logs m
       WHERE m.bike_id = bi.id AND m.status IN ('reported','in_progress')) AS open_issues,
    (SELECT AVG(rating)::NUMERIC(3,2) FROM bike_ratings r
       WHERE r.bike_id = bi.id)                                   AS avg_rating
FROM bikes bi
LEFT JOIN stations s ON s.id = bi.station_id;


-- ------------------------------------------------------------
-- vw_analytics_peak_hours
--   Used by 6.0 Analytics: bookings per hour-of-day.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_analytics_peak_hours AS
SELECT
    EXTRACT(HOUR FROM start_time)::INT  AS hour_of_day,
    COUNT(*)                            AS booking_count
FROM bookings
WHERE start_time >= NOW() - INTERVAL '30 days'
GROUP BY hour_of_day
ORDER BY hour_of_day;


-- ------------------------------------------------------------
-- vw_analytics_top_stations
--   Most-used pickup stations over the last 30 days.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_analytics_top_stations AS
SELECT
    s.id                   AS station_id,
    s.station_name,
    s.campus_zone,
    COUNT(bk.id)           AS pickup_count,
    COUNT(bkr.id)          AS return_count
FROM stations s
LEFT JOIN bookings bk  ON bk.pickup_station_id = s.id  AND bk.start_time >= NOW() - INTERVAL '30 days'
LEFT JOIN bookings bkr ON bkr.return_station_id = s.id AND bkr.end_time   >= NOW() - INTERVAL '30 days'
GROUP BY s.id
ORDER BY pickup_count DESC;


-- ------------------------------------------------------------
-- vw_analytics_daily_summary
--   30-day trend line for the admin analytics dashboard.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_analytics_daily_summary AS
SELECT
    DATE(start_time)                                       AS day,
    COUNT(*)                                               AS total_bookings,
    COUNT(*) FILTER (WHERE status = 'completed')           AS completed,
    COUNT(*) FILTER (WHERE status = 'cancelled')           AS cancelled,
    COUNT(*) FILTER (WHERE status = 'expired')             AS expired,
    COALESCE(SUM(fee_amount), 0)                           AS revenue,
    COALESCE(ROUND(AVG(duration_minutes)::NUMERIC, 1), 0)  AS avg_duration_min
FROM bookings
WHERE start_time >= NOW() - INTERVAL '30 days'
GROUP BY day
ORDER BY day DESC;


-- ------------------------------------------------------------
-- vw_open_maintenance
--   Admin work queue: all unresolved maintenance items.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_open_maintenance AS
SELECT
    m.id                                       AS log_id,
    m.bike_id,
    bi.bike_code,
    bi.model,
    m.issue_type,
    m.severity,
    m.status,
    m.reported_at,
    r.full_name                                AS reported_by,
    EXTRACT(EPOCH FROM (NOW() - m.reported_at))::INT / 3600 AS hours_open
FROM maintenance_logs m
JOIN bikes bi       ON bi.id = m.bike_id
LEFT JOIN users r   ON r.id  = m.reported_by_user_id
WHERE m.status IN ('reported','in_progress')
ORDER BY
    CASE m.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
    m.reported_at;
