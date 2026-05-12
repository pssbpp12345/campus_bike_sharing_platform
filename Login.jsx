import React, { useState, useEffect } from "react";
import "./Login.css";

/**
 * Campus Bike Sharing — Login page (separate from Register).
 *
 * - Wired to POST /api/auth/login
 * - Error banner is hidden until a real failure happens
 * - On success: stores JWT + user in localStorage and shows a welcome card
 * - The "Create Account" button navigates to register.html
 */

const API_BASE = "/api";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState(null);

  useEffect(() => {
    try {
      const token = localStorage.getItem("cbs_token");
      const stored = localStorage.getItem("cbs_user");
      if (token && stored) setUser(JSON.parse(stored));
    } catch (_) { /* ignore */ }

    const params = new URLSearchParams(window.location.search);
    if (params.get("registered") === "1") {
      setSuccess("Account created. You can log in now.");
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.get("loggedout") === "1") {
      setSuccess("You have been logged out.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!email || !password) {
      setError("Please enter both email and password.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Please enter a valid email address.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Invalid email or password. Please try again.");
        return;
      }
      localStorage.setItem("cbs_token", data.token);
      localStorage.setItem("cbs_user", JSON.stringify(data.user));
      setUser(data.user);
      setPassword("");
    } catch (err) {
      setError("Cannot reach the server. Make sure the backend is running on port 5000.");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("cbs_token");
    localStorage.removeItem("cbs_user");
    window.location.href = "index.html?loggedout=1";
  };

  return (
    <div className="cbs-app">
      {/* Top Navigation — identical on both pages */}
      <nav className="cbs-nav">
        <a href="index.html" className="cbs-logo" aria-label="Campus Bike Sharing — Home">
          <svg className="cbs-logo-icon" viewBox="0 0 48 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="12" cy="22" r="8" fill="none" stroke="#2D7FF9" strokeWidth="2.5" />
            <circle cx="36" cy="22" r="8" fill="none" stroke="#22C55E" strokeWidth="2.5" />
            <path d="M12 22 L22 8 L30 22 L36 22" fill="none" stroke="#2D7FF9" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M22 8 L28 8" stroke="#22C55E" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          <span className="cbs-logo-text">
            Campus <span className="cbs-logo-accent">Bike Sharing</span>
          </span>
        </a>
        <ul className="cbs-nav-links">
          <li><a href="index.html">Home</a></li>
          <li><a href="how-it-works.html">How It Works</a></li>
          <li><a href="about.html">About Us</a></li>
          <li><a href="contact.html">Contact</a></li>
        </ul>
            <a href="login.html" className="cbs-nav-cta">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
              Login
            </a>
            <button className="cbs-mobile-toggle" aria-label="Open menu">
          <span /><span /><span />
        </button>
      </nav>

      <main className="cbs-main">
        {/* LEFT — bike background image + branding */}
        <section className="cbs-left">
          <div className="cbs-left-inner">
            <p className="cbs-eyebrow">CAMPUS BIKE SHARING PLATFORM</p>
            <h1 className="cbs-headline">
              Smart &amp;<br />
              Sustainable<br />
              <span className="cbs-headline-accent">Campus Mobility</span>
            </h1>
            <p className="cbs-subheadline">
              Making everyday commutes easier, greener,
              <br className="cbs-br-desktop" /> and smarter for our campus community.
            </p>
            <div className="cbs-accent-bar" />
            <ul className="cbs-feature-list">
              <li>
                <span className="cbs-feat-icon cbs-feat-icon--green">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 20A7 7 0 019.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z" />
                    <path d="M2 21c0-3 1.85-5.36 5.08-6" />
                  </svg>
                </span>
                <div>
                  <strong>Eco-Friendly</strong>
                  <span>Reduce carbon footprint</span>
                </div>
              </li>
              <li>
                <span className="cbs-feat-icon cbs-feat-icon--blue">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </span>
                <div>
                  <strong>Safe &amp; Reliable</strong>
                  <span>Well-maintained bicycles</span>
                </div>
              </li>
              <li>
                <span className="cbs-feat-icon cbs-feat-icon--green">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                </span>
                <div>
                  <strong>Accessible</strong>
                  <span>Across the entire campus</span>
                </div>
              </li>
            </ul>
          </div>
        </section>

        {/* RIGHT — Login card */}
        <section className="cbs-right">
          <div className="cbs-card">
            <div className="cbs-card-icon">
              <svg viewBox="0 0 48 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <circle cx="14" cy="22" r="7" fill="none" stroke="#2D7FF9" strokeWidth="2.5" />
                <circle cx="34" cy="22" r="7" fill="none" stroke="#22C55E" strokeWidth="2.5" />
                <path d="M14 22 L22 10 L28 22 L34 22" fill="none" stroke="#22C55E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>

            {user ? (
              <div className="cbs-welcome">
                <h2 className="cbs-card-title">Welcome, {user.full_name}!</h2>
                <p className="cbs-card-subtitle">{user.email}</p>
                <span className={`cbs-role-badge cbs-role-badge--${user.role}`}>
                  {user.role.toUpperCase()}
                </span>

                <div className="cbs-success" role="status">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  <span>You are signed in. Continue to the dashboard to book a bike.</span>
                </div>

                <button
                  type="button"
                  className="cbs-btn cbs-btn-primary"
                  onClick={() => alert("Dashboard coming next — login is fully wired to the database.")}
                >
                  <span>Go to Dashboard</span>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </button>
                <button type="button" className="cbs-btn cbs-btn-secondary" onClick={handleLogout}>
                  <span>Log out</span>
                </button>
              </div>
            ) : (
              <>
                <h2 className="cbs-card-title">Welcome Back</h2>
                <p className="cbs-card-subtitle">Login to your account</p>

                {error && (
                  <div className="cbs-error" role="alert">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>{error}</span>
                  </div>
                )}
                {success && (
                  <div className="cbs-success" role="status">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                    <span>{success}</span>
                  </div>
                )}

                <form onSubmit={handleLogin} noValidate>
                  <div className="cbs-field">
                    <label htmlFor="email">University Email</label>
                    <div className="cbs-input-wrap">
                      <svg className="cbs-input-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                        <polyline points="22,6 12,13 2,6" />
                      </svg>
                      <input
                        id="email"
                        type="email"
                        placeholder="you@university.edu"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        autoComplete="email"
                      />
                    </div>
                  </div>

                  <div className="cbs-field">
                    <label htmlFor="password">Password</label>
                    <div className="cbs-input-wrap">
                      <svg className="cbs-input-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0110 0v4" />
                      </svg>
                      <input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        placeholder="Enter your password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                      />
                      <button
                        type="button"
                        className="cbs-eye-btn"
                        onClick={() => setShowPassword((s) => !s)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                      >
                        {showPassword ? (
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="cbs-forgot">
                    <a href="#forgot">Forgot Password?</a>
                  </div>

                  <button type="submit" className="cbs-btn cbs-btn-primary" disabled={loading}>
                    {loading ? (
                      <span className="cbs-spinner" />
                    ) : (
                      <>
                        <span>Login</span>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="5" y1="12" x2="19" y2="12" />
                          <polyline points="12 5 19 12 12 19" />
                        </svg>
                      </>
                    )}
                  </button>

                  <div className="cbs-divider">
                    <span>or</span>
                  </div>

                  <a href="register.html" className="cbs-btn cbs-btn-secondary cbs-btn-link">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <line x1="19" y1="8" x2="19" y2="14" />
                      <line x1="22" y1="11" x2="16" y2="11" />
                    </svg>
                    <span>Create Account</span>
                  </a>

                  <p className="cbs-terms">
                    By logging in, you agree to our{" "}
                    <a href="Terms_of_use.html">Terms of Use</a> and <a href="Privacy_policy.html">Privacy Policy</a>.
                  </p>
                </form>
              </>
            )}
          </div>
        </section>
      </main>

      <footer className="cbs-footer">
        <span>© 2026 Campus Bike Sharing Platform. All rights reserved.</span>
        <div className="cbs-footer-links">
          <a href="Privacy_policy.html">Privacy Policy</a>
          <span className="cbs-footer-sep">|</span>
          <a href="Terms_of_use.html">Terms of Use</a>
        </div>
      </footer>
    </div>
  );
}
