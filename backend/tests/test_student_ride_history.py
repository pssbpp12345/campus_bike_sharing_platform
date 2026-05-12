"""Backend tests for the rebuilt Student Ride History page.

Covers /api/student/rides list/single/receipt/cancel scoped to JWT user.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL",
    "https://a3e84cb7-f3c9-4bd0-9672-d21217a9e4ea.preview.emergentagent.com",
).rstrip("/")

PRIYA = {"email": "priya.student@uni.edu.au", "password": "TestPass123!"}
LIAM = {"email": "liam.chen@uni.edu.au", "password": "Student2024!"}


def _login(creds):
    r = requests.post(f"{BASE_URL}/api/auth/login", json=creds, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="session")
def priya_headers():
    return {"Authorization": f"Bearer {_login(PRIYA)}", "Content-Type": "application/json"}


@pytest.fixture(scope="session")
def liam_headers():
    return {"Authorization": f"Bearer {_login(LIAM)}", "Content-Type": "application/json"}


# ── Auth scoping ──────────────────────────────────────────────
class TestAuth:
    def test_rides_unauthorized(self):
        assert requests.get(f"{BASE_URL}/api/student/rides", timeout=15).status_code == 401

    def test_rides_invalid_token(self):
        r = requests.get(
            f"{BASE_URL}/api/student/rides",
            headers={"Authorization": "Bearer not-a-jwt"},
            timeout=15,
        )
        assert r.status_code == 401


# ── List + summary scoping ─────────────────────────────────────
class TestRideList:
    def test_priya_has_5_rides(self, priya_headers):
        r = requests.get(f"{BASE_URL}/api/student/rides", headers=priya_headers, timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert len(data["rides"]) == 5, f"expected 5 rides, got {len(data['rides'])}"
        # Summary numbers
        s = data["summary"]
        assert s["total_completed"] == 3
        assert s["upcoming"] == 0
        assert s["active"] == 1
        assert s["cancelled"] == 1
        assert s["total_spend"] == 36.90
        assert s["co2_saved_kg"] == pytest.approx(3.71, abs=0.05)
        assert s["total_distance_km"] == pytest.approx(19.30, abs=0.05)

    def test_liam_has_4_rides(self, liam_headers):
        r = requests.get(f"{BASE_URL}/api/student/rides", headers=liam_headers, timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert len(data["rides"]) == 4, f"expected 4 rides, got {len(data['rides'])}"
        s = data["summary"]
        assert s["total_completed"] == 2
        assert s["upcoming"] == 1
        assert s["cancelled"] == 1

    def test_no_cross_user_overlap(self, priya_headers, liam_headers):
        p_ids = {r["ride_id"] for r in requests.get(
            f"{BASE_URL}/api/student/rides", headers=priya_headers, timeout=15).json()["rides"]}
        l_ids = {r["ride_id"] for r in requests.get(
            f"{BASE_URL}/api/student/rides", headers=liam_headers, timeout=15).json()["rides"]}
        assert p_ids.isdisjoint(l_ids), f"Overlap detected: {p_ids & l_ids}"

    def test_tab_completed(self, priya_headers):
        r = requests.get(f"{BASE_URL}/api/student/rides?tab=completed",
                         headers=priya_headers, timeout=15)
        rides = r.json()["rides"]
        assert len(rides) == 3
        assert all(rd["status"] == "completed" for rd in rides)

    def test_tab_active(self, priya_headers):
        rides = requests.get(f"{BASE_URL}/api/student/rides?tab=active",
                             headers=priya_headers, timeout=15).json()["rides"]
        assert len(rides) == 1
        assert rides[0]["status"] == "active"

    def test_tab_cancelled(self, priya_headers):
        rides = requests.get(f"{BASE_URL}/api/student/rides?tab=cancelled",
                             headers=priya_headers, timeout=15).json()["rides"]
        assert len(rides) == 1
        assert rides[0]["status"] == "cancelled"

    def test_sort_oldest_newest(self, priya_headers):
        new = requests.get(f"{BASE_URL}/api/student/rides?sort=newest",
                           headers=priya_headers, timeout=15).json()["rides"]
        old = requests.get(f"{BASE_URL}/api/student/rides?sort=oldest",
                           headers=priya_headers, timeout=15).json()["rides"]
        assert [r["ride_id"] for r in new] == list(reversed([r["ride_id"] for r in old]))

    def test_search_filter(self, priya_headers):
        rides = requests.get(f"{BASE_URL}/api/student/rides?q=BIKE-001",
                             headers=priya_headers, timeout=15).json()["rides"]
        assert len(rides) >= 1
        assert all("BIKE-001" in (r.get("bike_code") or "") for r in rides)


# ── Single ride + cross-user isolation ────────────────────────
class TestSingleRide:
    def test_priya_ride_20(self, priya_headers):
        r = requests.get(f"{BASE_URL}/api/student/rides/20", headers=priya_headers, timeout=15)
        assert r.status_code == 200
        ride = r.json()["ride"]
        assert ride["ride_id"] == 20
        assert ride["status"] == "completed"

    def test_liam_cannot_access_priya_ride(self, liam_headers):
        r = requests.get(f"{BASE_URL}/api/student/rides/20", headers=liam_headers, timeout=15)
        assert r.status_code == 404

    def test_invalid_ride_id(self, priya_headers):
        r = requests.get(f"{BASE_URL}/api/student/rides/abc", headers=priya_headers, timeout=15)
        assert r.status_code == 400


# ── Receipt ───────────────────────────────────────────────────
class TestReceipt:
    def test_receipt_completed_ride(self, priya_headers):
        r = requests.get(f"{BASE_URL}/api/student/rides/20/receipt",
                         headers=priya_headers, timeout=15)
        assert r.status_code == 200
        rec = r.json()["receipt"]
        assert rec["receipt_number"] == "CBS-2026-000020"
        assert rec["ride_id"] == 20
        assert rec["total_paid"] == 9.50
        assert rec["student_email"] == PRIYA["email"]

    def test_receipt_non_completed_ride_rejected(self, priya_headers):
        # Find a cancelled or active ride for Priya
        rides = requests.get(f"{BASE_URL}/api/student/rides",
                             headers=priya_headers, timeout=15).json()["rides"]
        non_completed = [rd for rd in rides if rd["status"] != "completed"]
        assert non_completed, "expected at least one non-completed ride"
        rid = non_completed[0]["ride_id"]
        r = requests.get(f"{BASE_URL}/api/student/rides/{rid}/receipt",
                         headers=priya_headers, timeout=15)
        assert r.status_code == 400

    def test_receipt_cross_user_404(self, liam_headers):
        r = requests.get(f"{BASE_URL}/api/student/rides/20/receipt",
                         headers=liam_headers, timeout=15)
        assert r.status_code == 404


# ── Cancel ride ───────────────────────────────────────────────
class TestCancelRide:
    def test_cancel_requires_long_reason(self, liam_headers):
        # Find Liam's upcoming ride
        rides = requests.get(f"{BASE_URL}/api/student/rides",
                             headers=liam_headers, timeout=15).json()["rides"]
        upcoming = [r for r in rides if r["status"] == "upcoming"]
        if not upcoming:
            pytest.skip("Liam has no upcoming rides (may have been cancelled by previous test run)")
        rid = upcoming[0]["ride_id"]
        r = requests.post(
            f"{BASE_URL}/api/student/rides/{rid}/cancel",
            headers=liam_headers, json={"reason": "too short"}, timeout=15,
        )
        assert r.status_code == 400

    def test_cancel_cross_user_blocked(self, liam_headers):
        # Liam tries to cancel one of Priya's rides
        r = requests.post(
            f"{BASE_URL}/api/student/rides/20/cancel",
            headers=liam_headers, json={"reason": "Trying to cancel someone else's ride"}, timeout=15,
        )
        # Should NOT succeed — server returns 400 with Forbidden or Ride not found
        assert r.status_code in (400, 403, 404)

    def test_cancel_upcoming_success(self, liam_headers):
        rides = requests.get(f"{BASE_URL}/api/student/rides",
                             headers=liam_headers, timeout=15).json()["rides"]
        upcoming = [r for r in rides if r["status"] == "upcoming"]
        if not upcoming:
            pytest.skip("Liam has no upcoming rides to cancel")
        rid = upcoming[0]["ride_id"]
        r = requests.post(
            f"{BASE_URL}/api/student/rides/{rid}/cancel",
            headers=liam_headers,
            json={"reason": "Plans changed and I no longer need this ride today."},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json().get("status") == "cancelled"

        # Verify it now shows as cancelled
        single = requests.get(f"{BASE_URL}/api/student/rides/{rid}",
                              headers=liam_headers, timeout=15).json()["ride"]
        assert single["status"] == "cancelled"
