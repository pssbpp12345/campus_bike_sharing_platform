# Campus Bike Sharing Platform — Database

Complete PostgreSQL schema backing every feature in the ERD, DFDs, use case diagram, and architecture diagram.

## What's in here

| File | Purpose |
|------|---------|
| `01_schema.sql` | ENUM types, all tables, constraints, indexes |
| `02_functions.sql` | Trigger functions + business-logic procedures (`fn_create_booking`, `fn_return_bike`, `fn_expire_stale_bookings`, etc.) |
| `03_views.sql` | Views for the map dashboard, admin dashboard, analytics |
| `04_seed.sql` | Demo data (6 users, 8 stations, 15 bikes, sample bookings/ratings/maintenance) |
| `04b_seed_bookings.sql` | Extra per-user booking history so the My Bookings page is populated for every demo student — each user sees a different mix of active/upcoming/completed/cancelled rides |
| `05_queries.sql` | Reference catalog of queries used by the backend — paste into your route handlers |
| `ERD.md` | Text-form ERD with all relationships documented |

## Tables

Core (matches your ERD):

- `users` — students, staff, admins with bcrypt password, role, email verification
- `stations` — dock locations with lat/lng, capacity, campus zone
- `bikes` — fleet with status lifecycle (`available` / `in_use` / `maintenance` / `retired`)
- `bookings` — every pickup/return with 15-minute auto-expiry, duration, fee

Extras you asked for:

- `maintenance_logs` — "Flag Bike for Maintenance" use case; issue type, severity, resolution tracking
- `admin_audit_log` — tamper-evident record of all admin actions with JSONB details
- `bike_ratings` — 1-to-5 post-ride feedback, one rating per booking
- `payments` — fee ledger supporting campus card / credit card / wallet / waived
- `system_settings` — key/value store for tunable parameters (timeout, rates, etc.)

## Setting up PostgreSQL on Windows

XAMPP doesn't ship with PostgreSQL, so install it separately:

1. Download the installer from https://www.postgresql.org/download/windows/ (pick 16.x or 17.x).
2. During setup, set a password for the `postgres` superuser and remember it.
3. Default port: `5432`. Optionally install pgAdmin 4 in the same installer.

## Creating the database

Open **SQL Shell (psql)** from the Start menu (or run `psql -U postgres` from the command line):

```sql
-- Create database and dedicated app user
CREATE DATABASE campus_bike_sharing;
CREATE USER cbs_app WITH PASSWORD 'change_me_strong_password';
GRANT ALL PRIVILEGES ON DATABASE campus_bike_sharing TO cbs_app;
\c campus_bike_sharing
GRANT ALL ON SCHEMA public TO cbs_app;
```

## Running the migrations

From this folder:

```bash
psql -U postgres -d campus_bike_sharing -f 01_schema.sql
psql -U postgres -d campus_bike_sharing -f 02_functions.sql
psql -U postgres -d campus_bike_sharing -f 03_views.sql
psql -U postgres -d campus_bike_sharing -f 04_seed.sql
psql -U postgres -d campus_bike_sharing -f 04b_seed_bookings.sql
```

Or in one shot (bash / PowerShell):

```bash
for f in 01_schema.sql 02_functions.sql 03_views.sql 04_seed.sql 04b_seed_bookings.sql; do
  psql -U postgres -d campus_bike_sharing -f "$f"
done
```

`04b_seed_bookings.sql` is safe to re-run on demand — it deletes its own
rows (tagged `notes LIKE 'demo-seed%'`) before re-inserting, so you can use
it to refresh your demo data between presentations.

## Connecting from Node.js

Install the driver: `npm i pg`. Then:

```js
// db.js
import { Pool } from "pg";

export const pool = new Pool({
  host:     process.env.DB_HOST     || "localhost",
  port:     process.env.DB_PORT     || 5432,
  database: process.env.DB_NAME     || "campus_bike_sharing",
  user:     process.env.DB_USER     || "cbs_app",
  password: process.env.DB_PASSWORD || "change_me_strong_password",
  max: 20, idleTimeoutMillis: 30000,
});

// Example: login lookup
export async function findUserByEmail(email) {
  const { rows } = await pool.query(
    "SELECT id, full_name, email, password_hash, role, is_active FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1",
    [email]
  );
  return rows[0];
}
```

`.env` (do NOT commit):

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=campus_bike_sharing
DB_USER=cbs_app
DB_PASSWORD=change_me_strong_password
JWT_SECRET=pick-a-long-random-string
```

## How the schema maps to your diagrams

**Use Case → Table / Function**

| Use case | SQL entry point |
|----------|-----------------|
| Register | `INSERT INTO users ...` |
| Login | `SELECT ... FROM users WHERE LOWER(email) = ...` |
| Authenticate User | JWT verify + `SELECT role FROM users` |
| View Station Map | `SELECT * FROM vw_station_availability` |
| Book a Bike | `SELECT fn_create_booking($1,$2,$3)` |
| Return a Bike | `SELECT fn_return_bike($1,$2,$3)` |
| View Booking History | `SELECT * FROM vw_booking_history WHERE user_id = $1` |
| Flag Bike for Maintenance | `SELECT fn_flag_bike_for_maintenance(...)` |
| Manage Bikes & Stations | CRUD on `bikes` / `stations` |
| View Analytics | Views in `03_views.sql` + summary query in `05_queries.sql` |
| View All Bookings (Admin) | `vw_booking_history` |
| Auto-expire Booking (System) | `SELECT fn_expire_stale_bookings()` via cron |
| Update Availability (System) | Handled automatically inside `fn_create_booking` / `fn_return_bike` |

**Architecture diagram coverage**

- *Booking Service* — `fn_create_booking` wraps the ACID-safe bike-lock + insert
- *Availability Service* — `vw_station_availability` view
- *Auth Service* — `users` table, bcrypt hashes, `last_login_at`
- *Analytics Service* — `vw_analytics_peak_hours`, `vw_analytics_top_stations`, `vw_analytics_daily_summary`
- *Admin Service* — `admin_audit_log`, `fn_log_admin_action`, `vw_bike_fleet_status`
- *Background Worker (Cron)* — call `SELECT fn_expire_stale_bookings()` every minute
- *Redis Cache (optional)* — cache `vw_station_availability` for 5–10 seconds to reduce DB load

## Safety features baked in

- **Double-booking prevention** — partial unique indexes on `bookings(user_id)` and `bookings(bike_id)` WHERE `status IN ('pending','active')`. PostgreSQL will reject the second insert.
- **ACID booking** — `fn_create_booking` uses `SELECT ... FOR UPDATE` on the bike row.
- **Auto-expire** — every pending/active booking carries `expires_at = NOW() + 15 min`; `fn_expire_stale_bookings` sweeps them.
- **Return capacity check** — `fn_return_bike` rejects returns to a full station.
- **Email format** — CHECK constraint enforces basic RFC-style email on `users.email`.
- **Email uniqueness is case-insensitive** — unique index on `LOWER(email)`.
- **Soft-delete** — `users.is_active` and `stations.is_active` instead of hard deletes; bikes use a `retired` status.

## Demo login

After seeding, you can log in as any of these (all passwords: **Password123!**):

| Email | Role |
|-------|------|
| `admin@university.edu` | admin |
| `janet.l@university.edu` | staff |
| `alice@university.edu` | student |
| `bob@university.edu` | student |
| `carol@university.edu` | student |
| `david@university.edu` | student (not email-verified) |

> The seeded bcrypt hashes are placeholders. Before you demo, run once in Node:
> `const hash = await bcrypt.hash("Password123!", 12); console.log(hash);`
> and `UPDATE users SET password_hash = '<that hash>';`

## Resetting during development

Every SQL file starts with a `DROP ... IF EXISTS` block so you can safely re-run `01_schema.sql` to reset the schema. Re-run `02_functions.sql`, `03_views.sql`, `04_seed.sql` after that.
