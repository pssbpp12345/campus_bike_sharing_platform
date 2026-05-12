# Campus Bike Sharing — Backend

Express + PostgreSQL API that powers login and registration for the Campus Bike
Sharing front-end. The same Express process also serves the static front-end
files (`index.html`, `Login.css`, `/UI/*`), so the browser, the API and the
assets all share `http://localhost:5000` — no CORS configuration required.

## 1. Prerequisites

- Node.js 18 or later (`node -v`)
- PostgreSQL 14 or later running locally
- The schema applied (see `../database/01_schema.sql` … `04_seed.sql`)

## 2. Install dependencies

```bash
cd backend
npm install
```

## 3. Configure environment variables

```bash
cp .env.example .env
```

Then edit `.env` and set your PostgreSQL credentials (`PGUSER`, `PGPASSWORD`,
`PGDATABASE`, …) and a long random `JWT_SECRET`.

## 4. Apply the database schema

From the project root:

```bash
psql -U postgres -c "CREATE DATABASE campus_bike_sharing;"
psql -U postgres -d campus_bike_sharing -f database/01_schema.sql
psql -U postgres -d campus_bike_sharing -f database/02_functions.sql
psql -U postgres -d campus_bike_sharing -f database/03_views.sql
psql -U postgres -d campus_bike_sharing -f database/04_seed.sql
```

## 5. Hash the demo passwords

The seed file ships with placeholder bcrypt hashes. Run the helper script to
replace them with real hashes for the demo password `Password123!`:

```bash
npm run setup-passwords
```

After this you can log in immediately as any of:

| Email                      | Role    | Password       |
| -------------------------- | ------- | -------------- |
| `admin@university.edu`     | admin   | `Password123!` |
| `janet.l@university.edu`   | admin   | `Password123!` |
| `alice@university.edu`     | student | `Password123!` |
| `bob@university.edu`       | student | `Password123!` |
| `carol@university.edu`     | student | `Password123!` |
| `david@university.edu`     | student | `Password123!` |

## 6. Start the server

```bash
npm start
```

Then open <http://localhost:5000/> — the login page is served from there and
the form is wired straight to the database.

## API surface

| Method | Path                 | Body                               | Notes                            |
| ------ | -------------------- | ---------------------------------- | -------------------------------- |
| GET    | `/api/health`        | —                                  | Verifies DB connectivity.        |
| POST   | `/api/auth/register` | `{ fullName, email, password }`    | Creates a `student` user.        |
| POST   | `/api/auth/login`    | `{ email, password }`              | Returns `{ user, token }`.       |
| GET    | `/api/auth/me`       | (Header `Authorization: Bearer …`) | Verifies and returns the user.   |

Tokens are signed with `JWT_SECRET` and expire after `JWT_EXPIRES_IN` (default
`7d`). The front-end stores the token in `localStorage` (`cbs_token`).

## Stripe test payments

The student dashboard now starts Stripe Checkout before saving a booking. Add
your Stripe test secret key to `backend/.env`:

```env
STRIPE_SECRET_KEY=sk_test_your_rotated_key_here
STRIPE_CURRENCY=aud
APP_BASE_URL=http://localhost:5000
```

Use Stripe test cards in Checkout, for example `4242 4242 4242 4242` with any
future expiry date and any CVC.
