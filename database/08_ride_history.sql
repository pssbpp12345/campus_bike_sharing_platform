-- 08: Add distance + receipt-friendly columns to bookings, seed multi-user demo data.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS distance_km    DECIMAL(8,2) DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS unlock_fee     DECIMAL(8,2) DEFAULT 2.50;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS per_minute_fee DECIMAL(8,2) DEFAULT 0.20;

-- Re-compute distance for existing rides (simple estimate: 0.18 km / minute)
UPDATE bookings SET distance_km = ROUND((COALESCE(duration_minutes,0) * 0.18)::numeric, 2) WHERE distance_km = 0;
