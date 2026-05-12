# Campus Bike Sharing — PRD

## Original Problem Statement
Build 3 new student pages (Ride History, Profile, Need Help) for an existing Campus Bike Sharing platform. The pages must match the existing Student Dashboard design exactly (same layout, sidebar, top navbar, white cards on light grey, green primary #22C55E, blue secondary #2D7FF9, rounded corners, Inter + Plus Jakarta Sans fonts, responsive). All pages must connect to backend/database (Node.js Express + PostgreSQL) and use the currently logged-in student.

## Tech Stack (existing)
- Frontend: static HTML + React-in-browser (Babel standalone), per-page <script>; shared CSS + JS modules
- Backend: Node.js Express on internal port 5050, wrapped by a Python FastAPI proxy on port 8001 (supervisor-managed)
- Database: PostgreSQL (`campus_bike_sharing`), full schema in `/app/database/*.sql`
- Static server: Express on port 3000 serves the static HTML and proxies /api/* to backend
- Auth: JWT bearer token in localStorage as `cbs_token`; user object as `cbs_user`

## User Persona
- **Student** — campus bike rider; logs in to book/return bikes, view ride history, manage profile, and request help.

## Core Requirements (Static)
1. **Ride History** — summary cards (Total Rides, Distance, CO₂ Saved, Total Spend), filterable/sortable table, view-details modal, empty state.
2. **Profile** — avatar with initials, full name, email, phone, student ID, role, account status, edit profile modal, change password modal, account statistics, recent activity, logout.
3. **Need Help** — FAQ search + accordion, 6 support categories, ticket submission form (category/subject/description/priority/optional booking ID), "My Support Tickets" list.
4. **Navigation** — consistent topbar + sidebar across all student pages (Home, My Bookings, Ride History, Profile, Need Help).

## What's Been Implemented (2026-05-12)
- ✅ Installed PostgreSQL, ran full schema + functions + views + seed (01–06 SQL files)
- ✅ Created `support_tickets` table + enums (`07_support_tickets.sql`)
- ✅ Backend routes: `/api/profile` (GET, PATCH, POST /change-password), `/api/support/tickets` (GET, POST), `/api/support/faq` (GET, 10 seeded FAQs)
- ✅ Shared frontend system: `student-shared.css`, `student-shared.js` (StudentTopbar, StudentSidebar, StudentToastStack, useStudentAuth, StudentIcons)
- ✅ 3 new pages built and visually matching the existing dashboard exactly:
  - `Student_ride_history.html` — summary, search, status filter, date range, sort, table, view modal, empty state, skeletons
  - `Student_profile.html` — avatar w/ initials, info list, statistics grid, recent activity, Edit Profile modal, Change Password modal, Logout
  - `Student_need_help.html` — FAQ search, FAQ accordion, 6 category cards, ticket form, My Tickets list with status pills
- ✅ Dashboard sidebar links updated to point to new pages (no more "coming soon" toasts)
- ✅ Test student seeded (Priya Kumar) with 3 sample bookings
- ✅ All endpoints tested end-to-end (17/17 backend pytest, 100% frontend Playwright)

## Files Created/Changed
**Created:**
- `/app/database/07_support_tickets.sql`
- `/app/backend/routes/profile.js`
- `/app/backend/routes/support.js`
- `/app/backend/server.py` (FastAPI wrapper for supervisor compat)
- `/app/frontend/Student/Student_ride_history.html`
- `/app/frontend/Student/Student_profile.html`
- `/app/frontend/Student/Student_need_help.html`
- `/app/frontend/Student/student-shared.css`
- `/app/frontend/Student/student-shared.js`
- `/app/frontend/static-server.js` + `package.json`
- `/app/backend/.env`
- `/app/backend/tests/test_student_new_pages.py` (created by testing agent)

**Modified:**
- `/app/backend/server.js` — mounted profile + support routes
- `/app/frontend/Student/Student_dashboard.html` — sidebar buttons now navigate to new pages; user menu actions go to real pages

## Prioritized Backlog
**P1:**
- Move FAQ list to a `faqs` DB table so admins can edit without redeploy
- Add admin-side ticket triage view + email notifications when tickets are submitted/resolved
- Pre-compile React JSX (replace Babel-in-browser) to speed up first paint

**P2:**
- Store actual `distance_km` per ride (currently estimated 3.5 km/ride) for accurate CO₂ figures
- Replace inline `requireUser` middleware copies with `/backend/middleware/requireUser.js`
- Add CSV export of ride history
- Add ride rating modal from Ride History (uses existing `bike_ratings` table)

## Test Credentials
See `/app/memory/test_credentials.md`. Quick reference:
- priya.student@uni.edu.au / TestPass123!  (student, 3 seeded bookings)
