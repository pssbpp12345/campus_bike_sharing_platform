# Campus Bike Sharing — Database

This folder holds every SQL file needed to bring a fresh PostgreSQL (or Supabase) database up to a state where the backend can boot and every admin page renders with rich demo data.

## Files

| File | Purpose |
| --- | --- |
| `01_schema.sql` | Types (enums), tables, indexes, constraints. Drop-and-create — clears existing tables, so only run on a fresh DB. |
| `02_functions.sql` | Helper SQL functions (booking auto-expiry, ride duration math, etc.). |
| `03_views.sql` | Read views the admin reports rely on. |
| `04_seed.sql` | **Idempotent rich demo seed.** 1 admin + 5 students + 5 staff, 20 Sydney CBD stations, ~100 bikes, ~60 bookings across every status + time range, ~50 payments, 30 support tickets, 8 refund requests, 50+ notifications, maintenance logs, admin expenses, admin activity feed. Safe to re-run — see "Idempotency" below. |
| `05_queries.sql` | Reference queries (read-only). Not run as part of setup. |
| `ERD.md` | Entity-relationship diagram. |

`_legacy/database/` at the project root contains every retired migration file. None of it is needed for a fresh install. The backend recreates any runtime-only schema bits (saved-card table, admin activity log, support tickets, payment-flow columns) on first boot via `ensurePaymentMethodSchema()` and `ensureStudentSchema()`.

## Run order

```bash
psql "$DATABASE_URL" -f database/01_schema.sql
psql "$DATABASE_URL" -f database/02_functions.sql
psql "$DATABASE_URL" -f database/03_views.sql
psql "$DATABASE_URL" -f database/04_seed.sql
```

On Supabase the easiest path is to open **SQL Editor → New query**, paste the contents of each file in order, and click **Run**. The seed file uses `BEGIN; … COMMIT;` so any error aborts cleanly.

## Idempotency

You can re-run `04_seed.sql` any number of times safely:

- **users** → `ON CONFLICT (email) DO UPDATE` — refreshes `password_hash`, `role`, `is_active`, `email_verified`, `phone`, `full_name`. This is the line that fixes the demo login if a previous seed left a bad hash in the DB.
- **stations** → `ON CONFLICT (station_name) DO NOTHING`.
- **bikes** → `ON CONFLICT (bike_code) DO NOTHING`.
- **system_settings** → `ON CONFLICT (key) DO UPDATE`.
- **bookings, payments, support_tickets, refund_requests, notifications, admin_expenses, admin_activity_log, maintenance_logs** → guarded by `WHERE NOT EXISTS` on a deterministic tag (`notes = 'seed:Bxxx'`, `transaction_reference = 'pay_seed_xxx'`, `ticket_code = 'Txx'`, etc.) so re-running is a no-op.

## Demo logins — all use password `Password123!`

| Role | Email | Notes |
| --- | --- | --- |
| Admin | `admin@university.edu` | Lands on `frontend/Admin/Admin_dashboard.html`. |
| Student | `alice.johnson@university.edu` | Has an active ride for demo purposes. |
| Student | `bob.smith@university.edu` | |
| Student | `daniel.kim@university.edu` | |
| Student | `emma.wilson@university.edu` | |
| Student | `sophia.nguyen@university.edu` | |
| Staff | `michael.brown@university.edu` | Both staff + students land on `frontend/User/User_dashboard.html`. |
| Staff | `sarah.taylor@university.edu` | |
| Staff | `james.carter@university.edu` | |
| Staff | `priya.patel@university.edu` | |
| Staff | `liam.anderson@university.edu` | |

If your DB already has these users and the login fails, just re-run `04_seed.sql` — the new `ON CONFLICT … DO UPDATE` will overwrite the bad hash. Or paste this one-liner into Supabase SQL Editor:

```sql
UPDATE users
   SET password_hash = '$2b$12$2XR4YE5ErGGoZA/.X.Gw9uAIkrUjcBov2JLXnib9C5T0NHl8sT/Py',
       is_active = TRUE,
       email_verified = TRUE,
       updated_at = NOW()
 WHERE email IN (
   'admin@university.edu',
   'alice.johnson@university.edu','bob.smith@university.edu','daniel.kim@university.edu',
   'emma.wilson@university.edu','sophia.nguyen@university.edu',
   'michael.brown@university.edu','sarah.taylor@university.edu','james.carter@university.edu',
   'priya.patel@university.edu','liam.anderson@university.edu'
 );
```

That hash is `bcryptjs.hashSync('Password123!', 12)` — verified by the backend on every login through `bcrypt.compare()` in `backend/routes/auth.js`.

## Supabase deployment notes

1. **Create the project.** In Supabase, create a new project. Use a strong DB password — that becomes part of the connection string.
2. **Get the connection string.** Project Settings → Database → Connection string → URI. It looks like `postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres`.
3. **Run the four SQL files** through the SQL Editor (paste each one in turn). `01_schema.sql` first — it drops existing tables, so only do this once on a fresh DB.
4. **(Optional) point the live Render service at it.** Set `DATABASE_URL` in the Render env vars to the same Supabase URI.

Supabase pooler quirks — if you see "Tenant or user not found":

- Use the **direct connection** URL (port `5432`), not the pgbouncer pool URL (port `6543`), for the seed run. The seed has multi-statement transactions which pgbouncer in transaction-mode rejects.
- For the running backend you can use either, but the simplest path is direct on port `5432`.

## Render environment variables

The Render backend service needs these at minimum:

| Var | Example | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://postgres:…@db.xxxxx.supabase.co:5432/postgres` | Supabase URI. |
| `PORT` | `8001` | Render also injects its own `PORT`; the server picks whichever is set. |
| `APP_BASE_URL` | `https://your-app.onrender.com` | Used in Stripe success/cancel URLs. **Set this** so Stripe redirects come back to the live host. |
| `JWT_SECRET` | long random string | Sign auth tokens. |
| `STRIPE_SECRET_KEY` | `sk_test_…` or `sk_live_…` | Required for real Stripe Checkout. Without it, a local "simulated Stripe" fallback kicks in. |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` | Optional; only needed if you ever surface Stripe Elements inline. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | Recommended in production. Point the Stripe webhook at `<APP_BASE_URL>/api/payments/stripe/webhook`. |
| `STRIPE_CURRENCY` | `aud` | Defaults to `aud`. |
| `GOOGLE_MAPS_API_KEY` | `AIzaSy…` | Fetched at runtime by `/api/config/google-maps-key`. |
| `READY_TO_START_GRACE_MINUTES` | `15` | Optional. Defaults to 15. |
| `OPENAI_API_KEY` | `sk-…` | Only if you use the Admin AI assistant page. |

Make sure none of these are committed to the repo. `.env` is in `.gitignore`; `backend/.env.example` is the only `.env` file in git.
