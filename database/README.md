# Campus Bike Sharing — Database

This folder holds the SQL needed to bring a fresh PostgreSQL database up to a state where the backend can boot and the frontend has demo data to render.

## Files

| File | Purpose |
| --- | --- |
| `01_schema.sql` | Types, tables, indexes, constraints. |
| `02_functions.sql` | Helper functions (auto-expiry, ride math, etc.). |
| `03_views.sql` | Read views the admin reports rely on. |
| `04_seed.sql` | Idempotent demo seed: 1 admin, 5 students, 5 staff, stations, bikes, baseline `system_settings`, a couple of demo bookings/payments. |
| `05_queries.sql` | Reference queries (read-only, never run as part of setup). |
| `ERD.md` | Entity-relationship diagram. |

`_legacy/` (at the project root) contains every other SQL file the project accumulated during development — incremental migrations, retired admin demo seeds, etc. Nothing there is needed for a fresh install. The backend recreates any runtime-only schema bits (saved-card table, admin activity log, support tickets, payment-flow columns) on first boot via `ensurePaymentMethodSchema()` and `ensureStudentSchema()`.

## Setup

```bash
# 1. Create the database (one-off)
createdb campus_bike_sharing

# 2. Run the four files in order
psql -d campus_bike_sharing -f database/01_schema.sql
psql -d campus_bike_sharing -f database/02_functions.sql
psql -d campus_bike_sharing -f database/03_views.sql
psql -d campus_bike_sharing -f database/04_seed.sql
```

`04_seed.sql` is **idempotent** — it uses `ON CONFLICT … DO NOTHING` for `users`, `stations`, `bikes`, `ON CONFLICT … DO UPDATE` for `system_settings`, and `IF NOT EXISTS` guards for the demo bookings. You can re-run it without creating duplicates.

## Demo credentials

All seeded accounts share the same demo password. The email addresses are:

- Admin: `admin@university.edu`
- Students: `alice.johnson@university.edu`, `bob.smith@university.edu`, `daniel.kim@university.edu`, `emma.wilson@university.edu`, `sophia.nguyen@university.edu`
- Staff: `michael.brown@university.edu`, `sarah.taylor@university.edu`, `james.carter@university.edu`, `priya.patel@university.edu`, `liam.anderson@university.edu`

After cloning, change every seeded password before deploying to a real environment.
