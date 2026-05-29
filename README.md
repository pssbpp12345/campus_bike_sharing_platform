# Campus Bike Sharing Platform

A web-based bike-sharing system for university campuses. Students and staff log in to the same user portal, book a bike (Ride Now or Reserve for Later), and either ride immediately or schedule a future pick-up. Admins get a separate dashboard for fleet management, reports, refunds, support tickets, and platform settings.

## Tech stack

- **Backend:** Node.js + Express, PostgreSQL.
- **Frontend:** Static HTML + React (CDN, no build step), Tailwind via inline classes for the Admin pages, vanilla CSS for the User pages.
- **Payments:** Stripe Checkout (one-off payments + setup-mode card saving) + Stripe PaymentIntents (off-session charges for PAYG final amounts).
- **Maps:** Google Maps JavaScript API.
- **Email/notifications:** Optional SMTP for transactional email; in-app notifications stored in Postgres.

## Project layout

```
campus-bike-sharing/
├── index.html, login.html, register.html, … # Public site
├── backend/
│   ├── server.js                            # Express entry point
│   ├── routes/                              # auth, bookings, payments, admin*, …
│   ├── utils/, services/, middleware/, db.js
│   └── package.json
├── frontend/
│   ├── User/                                # User_dashboard / User_profile / User_my_bookings / …
│   └── Admin/                               # Admin_dashboard / Admin_bookings / Admin_payments / …
├── database/
│   ├── 01_schema.sql                        # Tables, indexes
│   ├── 02_functions.sql                     # Helper functions
│   ├── 03_views.sql                         # Read views
│   ├── 04_seed.sql                          # Idempotent demo seed
│   ├── 05_queries.sql                       # Reference queries
│   └── README.md
├── Images/, Uploads/                        # Static assets / user uploads
└── _legacy/                                 # Archived experiments + retired Student/ files
```

## Setup

### 1. Database

```bash
createdb campus_bike_sharing
psql -d campus_bike_sharing -f database/01_schema.sql
psql -d campus_bike_sharing -f database/02_functions.sql
psql -d campus_bike_sharing -f database/03_views.sql
psql -d campus_bike_sharing -f database/04_seed.sql
```

### 2. Backend

```bash
cd backend
cp .env.example .env       # then edit .env with real values
npm install
npm start                  # listens on http://localhost:8001
```

The backend serves both the API (`/api/*`) and the static frontend from the project root, so the whole app is reachable on one origin.

### 3. Frontend

No build step. Open `http://localhost:8001/` once the backend is up:

- Home: `http://localhost:8001/`
- Login: `http://localhost:8001/login.html`
- User dashboard: `http://localhost:8001/frontend/User/User_dashboard.html`
- Admin dashboard: `http://localhost:8001/frontend/Admin/Admin_dashboard.html`

## Demo logins

All seeded accounts share the same demo password — change it before going live.

| Role | Email |
| --- | --- |
| Admin | `admin@university.edu` |
| Student | `alice.johnson@university.edu` (and 4 more, see `database/README.md`) |
| Staff | `michael.brown@university.edu` (and 4 more) |

After login, admin lands on the Admin dashboard; students and staff land on the same User dashboard.

## Stripe setup

The booking and end-ride flows use Stripe Checkout and Stripe PaymentIntents. Set the following in `backend/.env`:

- `STRIPE_SECRET_KEY` — your test or live secret key.
- `STRIPE_PUBLISHABLE_KEY` — only needed if you want inline card forms; the redirect-based Checkout flow this project uses does not require it.
- `STRIPE_WEBHOOK_SECRET` — recommended in production. The webhook endpoint is `/api/payments/stripe/webhook`.
- `STRIPE_CURRENCY` — defaults to `aud`.
- `BOOKING_UNLOCK_FEE_CENTS`, `BOOKING_PER_MINUTE_CENTS` — fallback pricing if `system_settings` is empty.

Without `STRIPE_SECRET_KEY` set, the booking flow falls back to a local "simulated Stripe" checkout so the demo still works end-to-end.

## Google Maps

The User dashboard map and the Ride History route preview use Google Maps JS API. The key is fetched at runtime from `/api/config/google-maps-key`, which reads `GOOGLE_MAPS_API_KEY` from `backend/.env`. There's also a fallback key baked into the frontend for offline demos.

## Deployment notes

- The backend serves the entire frontend statically — there is no separate frontend host. One Node process is enough.
- Run the database migration block once at startup. The backend self-heals any missing payment-flow columns / saved-card table on boot.
- For Stripe webhooks in production, set `STRIPE_WEBHOOK_SECRET` and point Stripe at `https://your-host/api/payments/stripe/webhook`.
- Set `APP_BASE_URL` so Stripe success/cancel URLs use the right public hostname (otherwise the request's host is used).
- The `_legacy/` directory is excluded from production builds — delete it if your deploy pipeline can't ignore it.

## Useful scripts

- `backend/npm start` — boots Express.
- `node --check backend/server.js` — quick syntax check.
- `psql -d campus_bike_sharing -f database/04_seed.sql` — re-seed demo data (idempotent).
