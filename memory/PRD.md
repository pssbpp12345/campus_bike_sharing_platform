# Campus Bike Sharing — PRD

## Original Problem Statement
Build 3 new student pages (Ride History, Profile, Need Help) for Campus Bike Sharing. UI must match the existing dashboard exactly. Iteration 2: rebuild ONLY the Ride History page to be professional/launch-ready, with topbar simplified to match dashboard exactly (Home, My Bookings, bell, avatar — NO Ride History or Help in topbar).

## Tech Stack
- Frontend: static HTML + React-in-browser (Babel standalone), shared `student-shared.{css,js}` modules; page-specific `ride-history.css`
- Backend: Node.js Express on internal port 5050, FastAPI proxy on port 8001 (supervisor-managed)
- Static server: Express on port 3000 (serves HTML, proxies /api/* to backend)
- Database: PostgreSQL (`campus_bike_sharing`)
- Auth: JWT bearer; localStorage `cbs_token` + `cbs_user`

## What's Been Implemented (2026-05-12)
### Iteration 1
- Installed PostgreSQL + ran full schema/seed; added `support_tickets` table
- Created shared chrome (`student-shared.{css,js}`) and 3 new pages (Ride History v1, Profile, Need Help)
- Backend routes: `/api/profile`, `/api/support/*`
- Tested 17/17 backend, 100% frontend flows

### Iteration 2 — Ride History rebuild
- **Topbar simplified across ALL student pages** to match dashboard exactly: Home / My Bookings / 🔔 / 👤 (removed Ride History + Help links)
- **Ride History page**:
  - 6 summary cards (Completed, Upcoming, Active, Total Spend, CO₂ Saved, Total Distance) with colored top-strips
  - "You're on a ride right now" active-ride banner with pulse animation + End Ride
  - Tabs with live counts: All / Upcoming / Active / Completed / Cancelled
  - Cleaner table (sticky header, hover state, status badges with pulse for Live, payment chips)
  - Mobile card layout under 900px
  - Per-status action buttons: View (all) / Receipt (completed) / Cancel (upcoming) / End Ride (active)
  - Cancel modal with 12-char min reason validation
  - Ride detail modal showing all fields + notes
  - **Professional Receipt modal**: dark header with brand, receipt#, student name+email, trip details, itemised charges (unlock fee + minute charge), payment status, total paid; Print button (window.print() with print-only CSS) and Download HTML button (Blob + auto-click)
  - Loading skeletons, error state, empty state, toast notifications
  - Search by ride#/bike/station; sort newest/oldest; date-range filter; Reset filters button
- **Backend** new file `/app/backend/routes/student.js`:
  - GET /api/student/rides (list + summary, scoped by JWT user id)
  - GET /api/student/rides/:id
  - GET /api/student/rides/:id/receipt (only for completed)
  - POST /api/student/rides/:id/cancel (reason 12+ chars)
- **Database** migration `08_ride_history.sql`: added `distance_km`, `unlock_fee`, `per_minute_fee` columns
- Seeded 2 test students (Priya + Liam) with diverse ride states across all 4 statuses
- **Bug fix from testing agent**: `student.js` cancel — added `$2::text` cast in CONCAT() to avoid Postgres type-inference error
- **Mobile fix**: brand text doesn't wrap on narrow widths (480px breakpoint)
- All 19/19 backend pytest tests passed; all critical frontend flows verified; cross-user isolation confirmed (Liam cannot read Priya's rides)

## Files Created/Changed
**Created (iteration 2):**
- `/app/frontend/Student/ride-history.css`
- `/app/backend/routes/student.js`
- `/app/database/08_ride_history.sql`
- `/app/backend/tests/test_student_ride_history.py` (by testing agent)

**Modified (iteration 2):**
- `/app/frontend/Student/Student_ride_history.html` — full rewrite
- `/app/frontend/Student/student-shared.js` — simplified topbar
- `/app/frontend/Student/student-shared.css` — added 480px breakpoint
- `/app/backend/server.js` — mounts `/api/student`

## Backlog
- P1: Re-seed Liam's upcoming ride after each test consumes it (currently re-seeded once manually)
- P1: Extract `requireUser` middleware shared across 4 route files
- P1: Move FAQ list to DB; admin ticket triage UI; email notifications on ticket events
- P2: Pre-compile JSX (drop Babel-standalone) for faster first paint
- P2: Replace estimated distance (`0.18 km/min`) with real GPS-tracked distance
- P2: Fix bucketize() so stale pending rides past start_time aren't bucketed as 'active'
- P2: Require JWT_SECRET env var at startup; remove insecure fallback

## Test Credentials
See `/app/memory/test_credentials.md`. Quick reference:
- Priya: `priya.student@uni.edu.au / TestPass123!` (5 rides)
- Liam:  `liam.chen@uni.edu.au / Student2024!` (4 rides)
