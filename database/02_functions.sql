-- ============================================================
--  CAMPUS BIKE SHARING PLATFORM — PostgreSQL Schema (Part 2/5)
--  02_functions.sql  —  Trigger functions, business logic helpers,
--                       background-worker procedures
-- ============================================================


-- ------------------------------------------------------------
-- Generic: keep updated_at in sync
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

-- Attach to every table that has updated_at
DROP TRIGGER IF EXISTS trg_users_updated              ON users;
DROP TRIGGER IF EXISTS trg_stations_updated           ON stations;
DROP TRIGGER IF EXISTS trg_bikes_updated              ON bikes;
DROP TRIGGER IF EXISTS trg_bookings_updated           ON bookings;
DROP TRIGGER IF EXISTS trg_maint_updated              ON maintenance_logs;
DROP TRIGGER IF EXISTS trg_payments_updated           ON payments;

CREATE TRIGGER trg_users_updated     BEFORE UPDATE ON users            FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_stations_updated  BEFORE UPDATE ON stations         FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_bikes_updated     BEFORE UPDATE ON bikes            FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_bookings_updated  BEFORE UPDATE ON bookings         FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_maint_updated     BEFORE UPDATE ON maintenance_logs FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_payments_updated  BEFORE UPDATE ON payments         FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();


-- ------------------------------------------------------------
-- fn_create_booking — atomic: locks bike, inserts booking, flips bike status
--   Used by: POST /api/bookings  (Booking Service, ACID section of arch diagram)
--   Raises an exception if the bike isn't available. The caller should
--   wrap this in a transaction.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_create_booking(
    p_user_id              INTEGER,
    p_bike_id              INTEGER,
    p_pickup_station_id    INTEGER,
    p_timeout_minutes      INTEGER DEFAULT 15
)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_bike_status    bike_status;
    v_bike_station   INTEGER;
    v_booking_id     INTEGER;
BEGIN
    -- Lock the bike row to prevent double-booking race
    SELECT status, station_id
      INTO v_bike_status, v_bike_station
      FROM bikes
     WHERE id = p_bike_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bike % does not exist', p_bike_id;
    END IF;
    IF v_bike_status <> 'available' THEN
        RAISE EXCEPTION 'Bike % is not available (current status: %)', p_bike_id, v_bike_status;
    END IF;
    IF v_bike_station IS DISTINCT FROM p_pickup_station_id THEN
        RAISE EXCEPTION 'Bike % is not at station % (actually at %)', p_bike_id, p_pickup_station_id, v_bike_station;
    END IF;

    INSERT INTO bookings (user_id, bike_id, pickup_station_id, status, expires_at)
    VALUES (p_user_id, p_bike_id, p_pickup_station_id, 'active',
            NOW() + make_interval(mins => p_timeout_minutes))
    RETURNING id INTO v_booking_id;

    UPDATE bikes
       SET status = 'in_use',
           station_id = NULL
     WHERE id = p_bike_id;

    RETURN v_booking_id;
END;
$$;


-- ------------------------------------------------------------
-- fn_return_bike — atomic: closes booking, docks bike, computes duration & fee
--   Used by: POST /api/bookings/:id/return  (4.0 Return Bike DFD)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_return_bike(
    p_booking_id           INTEGER,
    p_return_station_id    INTEGER,
    p_hourly_rate          DECIMAL DEFAULT 0.00
)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_bike_id       INTEGER;
    v_start_time    TIMESTAMPTZ;
    v_duration_min  INTEGER;
    v_fee           DECIMAL(10,2);
    v_station_cap   INTEGER;
    v_station_used  INTEGER;
BEGIN
    SELECT bike_id, start_time
      INTO v_bike_id, v_start_time
      FROM bookings
     WHERE id = p_booking_id AND status = 'active'
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % not found or not active', p_booking_id;
    END IF;

    -- Capacity check on return station
    SELECT capacity INTO v_station_cap FROM stations WHERE id = p_return_station_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Return station % does not exist', p_return_station_id;
    END IF;
    SELECT COUNT(*) INTO v_station_used FROM bikes WHERE station_id = p_return_station_id;
    IF v_station_used >= v_station_cap THEN
        RAISE EXCEPTION 'Return station % is full (%/%)', p_return_station_id, v_station_used, v_station_cap;
    END IF;

    v_duration_min := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (NOW() - v_start_time)) / 60)::INT);
    v_fee := ROUND(p_hourly_rate * v_duration_min / 60.0, 2);

    UPDATE bookings
       SET status            = 'completed',
           end_time          = NOW(),
           return_station_id = p_return_station_id,
           duration_minutes  = v_duration_min,
           fee_amount        = v_fee
     WHERE id = p_booking_id;

    UPDATE bikes
       SET status      = 'available',
           station_id  = p_return_station_id,
           total_rides = total_rides + 1
     WHERE id = v_bike_id;
END;
$$;


-- ------------------------------------------------------------
-- fn_expire_stale_bookings — called by background worker (cron)
--   Marks pending/active bookings past their expires_at as 'expired'
--   and releases the held bike back to 'available'.
--   See "Background Worker" box in the architecture diagram.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_expire_stale_bookings()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_count INTEGER := 0;
    r RECORD;
BEGIN
    FOR r IN
        SELECT id, bike_id, pickup_station_id
          FROM bookings
         WHERE status IN ('pending','active')
           AND expires_at < NOW()
           FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE bookings
           SET status = 'expired',
               end_time = NOW()
         WHERE id = r.id;

        UPDATE bikes
           SET status = 'available',
               station_id = COALESCE(station_id, r.pickup_station_id)
         WHERE id = r.bike_id AND status = 'in_use';

        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$;


-- ------------------------------------------------------------
-- fn_flag_bike_for_maintenance — admin or user triggered
--   Creates a maintenance log and sets bike.status = 'maintenance'.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_flag_bike_for_maintenance(
    p_bike_id        INTEGER,
    p_reporter_id    INTEGER,
    p_issue_type     VARCHAR,
    p_description    TEXT DEFAULT NULL,
    p_severity       maintenance_severity DEFAULT 'medium'
)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_log_id INTEGER;
BEGIN
    INSERT INTO maintenance_logs (bike_id, reported_by_user_id, issue_type, description, severity)
    VALUES (p_bike_id, p_reporter_id, p_issue_type, p_description, p_severity)
    RETURNING id INTO v_log_id;

    UPDATE bikes
       SET status = 'maintenance'
     WHERE id = p_bike_id AND status <> 'retired';

    RETURN v_log_id;
END;
$$;


-- ------------------------------------------------------------
-- fn_resolve_maintenance — admin closes a maintenance log
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_resolve_maintenance(
    p_log_id             INTEGER,
    p_admin_id           INTEGER,
    p_resolution_notes   TEXT,
    p_return_to_station  INTEGER DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_bike_id INTEGER;
BEGIN
    UPDATE maintenance_logs
       SET status = 'resolved',
           resolved_at = NOW(),
           resolved_by_admin_id = p_admin_id,
           resolution_notes = p_resolution_notes
     WHERE id = p_log_id
     RETURNING bike_id INTO v_bike_id;

    IF v_bike_id IS NULL THEN
        RAISE EXCEPTION 'Maintenance log % not found', p_log_id;
    END IF;

    UPDATE bikes
       SET status = 'available',
           station_id = COALESCE(p_return_to_station, station_id),
           last_maintenance_at = NOW()
     WHERE id = v_bike_id;
END;
$$;


-- ------------------------------------------------------------
-- fn_log_admin_action — lightweight helper for audit trail
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_log_admin_action(
    p_admin_id    INTEGER,
    p_action      VARCHAR,
    p_entity      VARCHAR,
    p_entity_id   INTEGER,
    p_details     JSONB   DEFAULT NULL,
    p_ip          INET    DEFAULT NULL,
    p_user_agent  TEXT    DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, details, ip_address, user_agent)
    VALUES (p_admin_id, p_action, p_entity, p_entity_id, p_details, p_ip, p_user_agent);
END;
$$;
