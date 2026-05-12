"""Backend tests for new Student pages: Profile, Support, Ride History."""
import os
import pytest
import requests

BASE_URL = "https://a3e84cb7-f3c9-4bd0-9672-d21217a9e4ea.preview.emergentagent.com"
EMAIL = "priya.student@uni.edu.au"
PASSWORD = "TestPass123!"


@pytest.fixture(scope="session")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": EMAIL, "password": PASSWORD}, timeout=15)
    assert r.status_code == 200, f"login failed {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="session")
def auth_headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# ── Profile ────────────────────────────────────────────────────
class TestProfile:
    def test_get_profile(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/profile", headers=auth_headers, timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d["user"]["full_name"] == "Priya Kumar"
        assert d["user"]["email"] == EMAIL
        assert d["user"]["student_id"] == "STU-000007"
        assert d["user"]["phone"] == "+61 412 345 678"
        stats = d["stats"]
        assert stats["total_bookings"] == 3
        assert stats["completed_rides"] == 2
        assert stats["active_bookings"] == 0
        assert stats["total_spent"] == 12.5
        assert len(d["recent_activity"]) >= 3

    def test_get_profile_unauthorized(self):
        r = requests.get(f"{BASE_URL}/api/profile", timeout=15)
        assert r.status_code == 401

    def test_patch_profile_name_then_revert(self, auth_headers):
        # Get original name
        orig = requests.get(f"{BASE_URL}/api/profile", headers=auth_headers).json()["user"]["full_name"]
        # Update
        r = requests.patch(f"{BASE_URL}/api/profile", headers=auth_headers,
                           json={"fullName": "TEST_Priya Updated"}, timeout=15)
        assert r.status_code == 200
        assert r.json()["user"]["full_name"] == "TEST_Priya Updated"
        # Verify persistence via GET
        g = requests.get(f"{BASE_URL}/api/profile", headers=auth_headers).json()
        assert g["user"]["full_name"] == "TEST_Priya Updated"
        # Revert
        r2 = requests.patch(f"{BASE_URL}/api/profile", headers=auth_headers,
                            json={"fullName": orig}, timeout=15)
        assert r2.status_code == 200
        assert r2.json()["user"]["full_name"] == orig

    def test_patch_profile_invalid_email(self, auth_headers):
        r = requests.patch(f"{BASE_URL}/api/profile", headers=auth_headers,
                           json={"email": "not-an-email"}, timeout=15)
        assert r.status_code == 400

    def test_change_password_wrong_current(self, auth_headers):
        r = requests.post(f"{BASE_URL}/api/profile/change-password", headers=auth_headers,
                          json={"currentPassword": "WrongPassword!", "newPassword": "Whatever123!"}, timeout=15)
        assert r.status_code == 401

    def test_change_password_flow_and_revert(self, auth_headers):
        # change to NewPass456!
        r1 = requests.post(f"{BASE_URL}/api/profile/change-password", headers=auth_headers,
                           json={"currentPassword": PASSWORD, "newPassword": "NewPass456!"}, timeout=15)
        assert r1.status_code == 200
        # login with new password
        lr = requests.post(f"{BASE_URL}/api/auth/login",
                           json={"email": EMAIL, "password": "NewPass456!"}, timeout=15)
        assert lr.status_code == 200
        new_token = lr.json()["token"]
        new_headers = {"Authorization": f"Bearer {new_token}", "Content-Type": "application/json"}
        # revert
        r2 = requests.post(f"{BASE_URL}/api/profile/change-password", headers=new_headers,
                           json={"currentPassword": "NewPass456!", "newPassword": PASSWORD}, timeout=15)
        assert r2.status_code == 200
        # verify revert
        lr2 = requests.post(f"{BASE_URL}/api/auth/login",
                            json={"email": EMAIL, "password": PASSWORD}, timeout=15)
        assert lr2.status_code == 200


# ── Support ────────────────────────────────────────────────────
class TestSupport:
    def test_get_faq(self):
        r = requests.get(f"{BASE_URL}/api/support/faq", timeout=15)
        assert r.status_code == 200
        faqs = r.json()["faqs"]
        assert len(faqs) == 10
        assert all("q" in f and "a" in f and "category" in f for f in faqs)

    def test_list_tickets(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/support/tickets", headers=auth_headers, timeout=15)
        assert r.status_code == 200
        assert "tickets" in r.json()

    def test_create_ticket(self, auth_headers):
        payload = {
            "category": "booking",
            "subject": "TEST_Cannot find my booking",
            "description": "I cannot see my booking in the My Bookings list. Please assist.",
            "priority": "medium"
        }
        r = requests.post(f"{BASE_URL}/api/support/tickets", headers=auth_headers,
                          json=payload, timeout=15)
        assert r.status_code == 201, r.text
        t = r.json()["ticket"]
        assert t["status"] in ("open", "Open")
        assert t["category"] == "booking"
        assert t["subject"] == payload["subject"]
        # verify ticket appears in list
        lst = requests.get(f"{BASE_URL}/api/support/tickets", headers=auth_headers).json()["tickets"]
        assert any(x["id"] == t["id"] for x in lst)

    def test_create_ticket_invalid_category(self, auth_headers):
        r = requests.post(f"{BASE_URL}/api/support/tickets", headers=auth_headers,
                          json={"category": "invalid", "subject": "TEST_abc",
                                "description": "long enough description here"}, timeout=15)
        assert r.status_code == 400

    def test_create_ticket_short_subject(self, auth_headers):
        r = requests.post(f"{BASE_URL}/api/support/tickets", headers=auth_headers,
                          json={"category": "other", "subject": "x",
                                "description": "long enough description here"}, timeout=15)
        assert r.status_code == 400

    def test_tickets_unauthorized(self):
        r = requests.get(f"{BASE_URL}/api/support/tickets", timeout=15)
        assert r.status_code == 401


# ── Bookings/Ride History ──────────────────────────────────────
class TestBookingsHistory:
    def test_history_all(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/bookings/history?status=all&sort=newest",
                         headers=auth_headers, timeout=15)
        assert r.status_code == 200
        bookings = r.json()["bookings"]
        assert len(bookings) == 3
        # 2 completed, 1 cancelled
        statuses = [b["status"] for b in bookings]
        assert statuses.count("completed") == 2
        assert statuses.count("cancelled") == 1

    def test_history_completed_only(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/bookings/history?status=completed",
                         headers=auth_headers, timeout=15)
        assert r.status_code == 200
        bks = r.json()["bookings"]
        assert len(bks) == 2
        assert all(b["status"] == "completed" for b in bks)

    def test_history_cancelled_only(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/bookings/history?status=cancelled",
                         headers=auth_headers, timeout=15)
        assert r.status_code == 200
        bks = r.json()["bookings"]
        assert len(bks) == 1
        assert bks[0]["status"] == "cancelled"

    def test_history_sort_oldest(self, auth_headers):
        new = requests.get(f"{BASE_URL}/api/bookings/history?sort=newest",
                           headers=auth_headers).json()["bookings"]
        old = requests.get(f"{BASE_URL}/api/bookings/history?sort=oldest",
                           headers=auth_headers).json()["bookings"]
        assert [b["booking_id"] for b in new] == list(reversed([b["booking_id"] for b in old]))

    def test_history_unauthorized(self):
        r = requests.get(f"{BASE_URL}/api/bookings/history", timeout=15)
        assert r.status_code == 401
