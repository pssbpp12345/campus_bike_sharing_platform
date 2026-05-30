(function () {
  "use strict";

  const API_BASE = "/api/admin/settings";
  const PROFILE_IMAGE_KEY = "cbs_admin_profile_image";
  const SECTION_LABELS = {
    profile: ["Profile Settings", "Manage your administrator account, contact details, timezone, and display preferences."],
    platform: ["Platform Settings", "Control the public platform name, operating details, default currency, language, and registration rules."],
    pricing: ["Pricing Rules", "Update the booking unlock fee, per-minute ride fee, ride limits, cancellation fee, and refund window."],
    access: ["Access Control", "Review and update role-based permissions for admins, support, maintenance, and viewer accounts."],
    notifications: ["Notifications", "Choose which operational alerts admins receive and set thresholds for availability and battery warnings."],
    security: ["Security Settings", "Manage password rules, admin session limits, login alerts, and activity logging preferences."],
    backup: ["Data & Backup", "Export operational data, review system status, and keep backup actions in one place."],
    integrations: ["Integrations", "Check connected services without exposing secret keys or private credentials."],
  };
  const PERMISSION_LABELS = {
    view_dashboard: "Dashboard",
    manage_bookings: "Bookings",
    manage_payments: "Payments",
    manage_bikes: "Bikes",
    manage_stations: "Stations",
    manage_maintenance: "Maintenance",
    manage_reports: "Reports",
    manage_support_tickets: "Support",
    manage_settings: "Settings",
  };
  const PERMISSION_TITLES = {
    view_dashboard: "View Dashboard",
    manage_bookings: "Manage Bookings",
    manage_payments: "Manage Payments",
    manage_bikes: "Manage Bikes",
    manage_stations: "Manage Stations",
    manage_maintenance: "Manage Maintenance",
    manage_reports: "Manage Reports",
    manage_support_tickets: "Manage Support Tickets",
    manage_settings: "Manage Settings",
  };
  const EXPORT_LABELS = {
    bookings: ["Bookings CSV", "Booking records, statuses, ride times, and amounts"],
    payments: ["Payments CSV", "Payment amounts, methods, statuses, and booking links"],
    support: ["Support Tickets CSV", "Student issues, categories, priorities, and statuses"],
    maintenance: ["Maintenance CSV", "Repair tasks, assets, statuses, and costs"],
    stations: ["Stations CSV", "Station capacity, activity, and operational status"],
    bikes: ["Bikes CSV", "Bike fleet status, assigned station, and condition"],
  };

  const state = {
    currentSection: "profile",
    settings: {},
    profile: null,
    accessControl: { roles: [], permissions: [], matrix: {} },
    integrations: [],
    systemStats: {},
    modalCallback: null,
  };

  const $ = (id) => document.getElementById(id);
  const numberFmt = new Intl.NumberFormat("en-AU");
  const moneyFmt = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dateFmt = new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

  function getProfileImage() {
    try { return localStorage.getItem(PROFILE_IMAGE_KEY) || ""; } catch (_) { return ""; }
  }

  function initials(name) {
    return String(name || "Admin User").split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  }

  function applyProfileImageToAvatars(image = getProfileImage()) {
    ["admin-avatar", "admin-avatar-menu", "as-avatar-preview"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.classList.toggle("has-image", Boolean(image));
      el.style.backgroundImage = image ? `url("${image}")` : "";
    });
  }

  function getToken() {
    try { return localStorage.getItem("cbs_token"); } catch (_) { return null; }
  }

  async function api(path, options = {}) {
    const token = getToken();
    if (!token) {
      window.location.replace("/login.html?admin=1&next=" + encodeURIComponent(location.pathname));
      throw new Error("Admin login required.");
    }
    const res = await fetch(path, {
      ...options,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      try {
        localStorage.removeItem("cbs_token");
        localStorage.removeItem("cbs_user");
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        localStorage.removeItem("role");
      } catch (_) {}
      window.location.replace("/login.html?admin=1&next=" + encodeURIComponent(location.pathname));
      throw new Error("Admin session expired.");
    }
    if (!res.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  async function apiBlob(path, options = {}) {
    const token = getToken();
    if (!token) {
      window.location.replace("/login.html?admin=1&next=" + encodeURIComponent(location.pathname));
      throw new Error("Admin login required.");
    }
    const res = await fetch(path, {
      ...options,
      headers: { Authorization: "Bearer " + token, ...(options.headers || {}) },
      cache: "no-store",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Export failed.");
    }
    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/i);
    return { blob: await res.blob(), filename: match ? match[1] : "admin-export.csv" };
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function hydrateIcons(root = document) {
    if (window.__hydrateAdminIcons) window.__hydrateAdminIcons(root);
  }

  function showToast(message, type = "success") {
    const toast = $("admin-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.dataset.type = type;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.hidden = true;
      toast.textContent = "";
      delete toast.dataset.type;
    }, 3000);
  }

  function formatDate(value, fallback = "Not yet") {
    if (!value) return fallback;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? fallback : dateFmt.format(d);
  }

  function checked(value) {
    return value ? "checked" : "";
  }

  function moneyValue(value) {
    return Number(value || 0).toFixed(2);
  }

  function settingsGroup(name) {
    return state.settings[name] || {};
  }

  async function loadSettings() {
    const [all, profile, integrations] = await Promise.all([
      api(API_BASE),
      api(`${API_BASE}/profile`),
      api(`${API_BASE}/integrations`),
    ]);
    state.settings = all.settings || {};
    state.accessControl = all.accessControl || { roles: [], permissions: [], matrix: {} };
    state.systemStats = all.systemStats || {};
    state.profile = profile.profile;
    state.integrations = integrations.integrations || [];
    renderSettingsSection(state.currentSection);
  }

  function panelHead(section, status = "Saved") {
    const [title, subtitle] = SECTION_LABELS[section];
    return `
      <div class="as-panel-head">
        <div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div>
        <span class="as-status-pill"><span data-icon="check"></span>${escapeHtml(status)}</span>
      </div>
    `;
  }

  function field(label, name, value, options = {}) {
    const type = options.type || "text";
    const full = options.full ? " full" : "";
    const readonly = options.readonly ? " readonly" : "";
    const cls = options.readonly ? " class=\"as-readonly\"" : "";
    const step = options.step ? ` step="${escapeHtml(options.step)}"` : "";
    const min = options.min != null ? ` min="${escapeHtml(options.min)}"` : "";
    const help = options.help ? `<small>${escapeHtml(options.help)}</small>` : "";
    if (options.kind === "select") {
      return `
        <label class="as-field${full}"><span>${escapeHtml(label)}</span>
          <select name="${escapeHtml(name)}"${readonly}${cls}>
            ${(options.choices || []).map((item) => `<option value="${escapeHtml(item[0])}" ${String(item[0]) === String(value) ? "selected" : ""}>${escapeHtml(item[1])}</option>`).join("")}
          </select>${help}
        </label>`;
    }
    return `
      <label class="as-field${full}"><span>${escapeHtml(label)}</span>
        <input type="${escapeHtml(type)}" name="${escapeHtml(name)}" value="${escapeHtml(value ?? "")}"${readonly}${cls}${step}${min} />
        ${help}
      </label>`;
  }

  function toggle(label, name, value, help = "") {
    return `
      <label class="as-toggle-row">
        <span><span>${escapeHtml(label)}</span>${help ? `<small>${escapeHtml(help)}</small>` : ""}</span>
        <span class="as-switch"><input type="checkbox" name="${escapeHtml(name)}" ${checked(Boolean(value))} /><i></i></span>
      </label>`;
  }

  function disabledToggle(label, name, value, help = "") {
    return `
      <label class="as-toggle-row disabled">
        <span><span>${escapeHtml(label)}</span>${help ? `<small>${escapeHtml(help)}</small>` : ""}</span>
        <span class="as-switch"><input type="checkbox" name="${escapeHtml(name)}" ${checked(Boolean(value))} disabled /><i></i></span>
      </label>`;
  }

  function renderProfile() {
    const p = state.profile || {};
    const displayInitials = p.avatarInitials || initials(p.name || "Admin User");
    const profileImage = getProfileImage();
    return `
      <form class="as-panel-card" id="settings-form" data-section="profile">
        ${panelHead("profile")}
        <div class="as-avatar-uploader">
          <span class="as-avatar-preview ${profileImage ? "has-image" : ""}" id="as-avatar-preview" style="${profileImage ? `background-image:url('${profileImage.replace(/'/g, "%27")}')` : ""}">${escapeHtml(displayInitials)}</span>
          <div class="as-avatar-copy">
            <strong>Admin Profile Image</strong>
            <span>Choose a profile image for the admin navbar. It is saved locally until backend file storage is connected.</span>
            <label for="admin-profile-image-input">Change Profile Image<input id="admin-profile-image-input" type="file" accept="image/*" /></label>
          </div>
        </div>
        <div class="as-form-grid">
          ${field("Admin Name", "name", p.name || "Admin User")}
          ${field("Email", "email", p.email || "")}
          ${field("Role", "role", "Administrator", { readonly: true })}
          ${field("Phone", "phone", p.phone || "", { type: "tel" })}
          ${field("Avatar Initials", "avatarInitials", displayInitials, { readonly: true })}
          ${field("Timezone", "timezone", p.timezone || "Australia/Sydney", { kind: "select", choices: [["Australia/Sydney", "Australia/Sydney"], ["UTC", "UTC"], ["Asia/Kolkata", "Asia/Kolkata"], ["Europe/London", "Europe/London"]] })}
          ${field("Preferred Date Format", "preferredDateFormat", p.preferredDateFormat || "DD MMM YYYY", { kind: "select", choices: [["DD MMM YYYY", "DD MMM YYYY"], ["YYYY-MM-DD", "YYYY-MM-DD"], ["DD/MM/YYYY", "DD/MM/YYYY"], ["MMM DD, YYYY", "MMM DD, YYYY"]] })}
        </div>
        <div class="as-section-actions"><button class="ab-btn-primary" type="submit"><span data-icon="check"></span>Save Profile</button><button class="ab-btn-secondary" type="button" data-action="change-password"><span data-icon="settings"></span>Change Password</button></div>
      </form>`;
  }

  function renderPlatform() {
    const s = settingsGroup("platform");
    return `
      <form class="as-panel-card" id="settings-form" data-section="platform">
        ${panelHead("platform")}
        <div class="as-form-grid">
          ${field("Platform Name", "platform_name", s.platform_name || "Campus Bike Sharing")}
          ${field("Default Campus/City", "default_city", s.default_city || "Sydney Campus")}
          ${field("Operating Hours", "operating_hours", s.operating_hours || "6:00 AM - 10:00 PM")}
          ${field("Support Email", "support_email", s.support_email || "support@campusbikesharing.local", { type: "email" })}
          ${field("Default Currency", "default_currency", s.default_currency || "AUD", { kind: "select", choices: [["AUD", "AUD"], ["USD", "USD"], ["GBP", "GBP"], ["EUR", "EUR"]] })}
          ${field("Default Language", "default_language", s.default_language || "English", { kind: "select", choices: [["English", "English"], ["Spanish", "Spanish"], ["French", "French"]] })}
        </div>
        <div class="as-toggle-grid" style="margin-top:16px;">
          ${toggle("Maintenance Mode", "maintenance_mode", s.maintenance_mode, "Temporarily restrict public booking access.")}
          ${toggle("Allow New Registrations", "allow_new_registrations", s.allow_new_registrations !== false, "Let new students create accounts.")}
        </div>
        <div class="as-section-actions"><button class="ab-btn-primary" type="submit"><span data-icon="check"></span>Save Platform Settings</button></div>
      </form>`;
  }

  function renderPricing() {
    const s = settingsGroup("pricing");
    return `
      <form class="as-panel-card" id="settings-form" data-section="pricing">
        ${panelHead("pricing")}
        <div class="as-form-grid">
          ${field("Unlock Fee", "unlockFee", moneyValue(s.unlock_fee ?? 1), { type: "number", step: "0.01", min: 0, help: "Current project default is $1.00." })}
          ${field("Per Minute Fee", "perMinuteFee", moneyValue(s.per_minute_fee ?? 0.2), { type: "number", step: "0.01", min: 0, help: "Current project default is $0.20." })}
          ${field("Minimum Ride Duration", "minimumRideDuration", s.min_ride_duration_minutes ?? 5, { type: "number", min: 0 })}
          ${field("Maximum Ride Duration", "maximumRideDuration", s.max_ride_duration_minutes ?? 180, { type: "number", min: 1 })}
          ${field("Late Return Fee", "lateReturnFee", moneyValue(s.late_return_fee ?? 5), { type: "number", step: "0.01", min: 0 })}
          ${field("Cancellation Fee", "cancellationFee", moneyValue(s.cancellation_fee ?? 0), { type: "number", step: "0.01", min: 0 })}
          ${field("Refund Window", "refundWindow", s.refund_window_hours ?? 24, { type: "number", min: 0, help: "Hours after payment when refund review is allowed." })}
        </div>
        <div class="as-section-actions"><button class="ab-btn-primary" type="submit"><span data-icon="check"></span>Save Pricing Rules</button></div>
      </form>`;
  }

  function accessHint(role) {
    if (role === "Super Admin") return "All permissions are always enabled.";
    if (role === "Support Staff") return "Focused on support tickets and reports.";
    if (role === "Maintenance Staff") return "Focused on bikes, stations, and repairs.";
    if (role === "Viewer") return "Read-only dashboard access.";
    return "Operational admin permissions.";
  }

  function renderAccess() {
    const access = state.accessControl;
    const roles = access.roles || [];
    const permissions = access.permissions || [];
    const matrix = access.matrix || {};
    return `
      <form class="as-panel-card" id="settings-form" data-section="access">
        ${panelHead("access")}
        <div class="as-access-wrap">
          <table class="as-access-table">
            <thead><tr><th>Role</th>${permissions.map((p) => `<th title="${escapeHtml(PERMISSION_TITLES[p] || p)}">${escapeHtml(PERMISSION_LABELS[p] || p)}</th>`).join("")}</tr></thead>
            <tbody>
              ${roles.map((role) => `
                <tr>
                  <td><strong>${escapeHtml(role)}</strong><small>${escapeHtml(accessHint(role))}</small></td>
                  ${permissions.map((p) => {
                    const disabled = role === "Super Admin";
                    const title = `${role}: ${PERMISSION_TITLES[p] || p}`;
                    return `<td title="${escapeHtml(title)}"><label class="as-switch permission-toggle" aria-label="${escapeHtml(title)}"><input type="checkbox" name="${escapeHtml(role)}::${escapeHtml(p)}" data-role="${escapeHtml(role)}" data-permission="${escapeHtml(p)}" ${checked(matrix[role]?.[p] || disabled)} ${disabled ? "disabled" : ""} /><i></i></label></td>`;
                  }).join("")}
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div class="as-section-actions"><button class="ab-btn-primary" type="submit"><span data-icon="check"></span>Save Access Control</button></div>
      </form>`;
  }

  function renderNotifications() {
    const s = settingsGroup("notifications");
    return `
      <form class="as-panel-card" id="settings-form" data-section="notifications">
        ${panelHead("notifications")}
        <div class="as-toggle-grid">
          ${toggle("New booking notification", "new_booking_notification", s.new_booking_notification)}
          ${toggle("Payment received notification", "payment_received_notification", s.payment_received_notification)}
          ${toggle("Failed payment notification", "failed_payment_notification", s.failed_payment_notification)}
          ${toggle("Refund request notification", "refund_request_notification", s.refund_request_notification)}
          ${toggle("Maintenance alert notification", "maintenance_alert_notification", s.maintenance_alert_notification)}
          ${toggle("Low bike availability notification", "low_bike_availability_notification", s.low_bike_availability_notification)}
          ${toggle("Support ticket notification", "support_ticket_notification", s.support_ticket_notification)}
          ${toggle("Daily summary email", "daily_summary_email", s.daily_summary_email)}
        </div>
        <div class="as-form-grid" style="margin-top:16px;">
          ${field("Notification Email", "notification_email", s.notification_email || "admin@university.edu", { type: "email" })}
          ${field("Low Bike Availability Threshold", "low_availability_threshold", s.low_availability_threshold ?? 3, { type: "number", min: 0 })}
          ${field("Low Battery Threshold", "low_battery_threshold", s.low_battery_threshold ?? 25, { type: "number", min: 0 })}
        </div>
        <div class="as-section-actions"><button class="ab-btn-primary" type="submit"><span data-icon="check"></span>Save Notifications</button></div>
      </form>`;
  }

  function renderSecurity() {
    const s = settingsGroup("security");
    return `
      <form class="as-panel-card" id="settings-form" data-section="security">
        ${panelHead("security")}
        <div class="as-toggle-grid">
          ${toggle("Require strong password", "require_strong_password", s.require_strong_password !== false)}
          ${toggle("Auto logout inactive admins", "auto_logout_inactive_admins", s.auto_logout_inactive_admins !== false)}
          ${disabledToggle("Two-factor authentication", "two_factor_authentication", false, "Coming soon. This will be enabled after an authenticator flow is added.")}
          ${toggle("Login alert notification", "login_alert_notification", s.login_alert_notification)}
          ${toggle("Admin activity logging", "admin_activity_logging", s.admin_activity_logging)}
        </div>
        <div class="as-form-grid" style="margin-top:16px;">
          ${field("Session Timeout Minutes", "session_timeout_minutes", s.session_timeout_minutes ?? 60, { type: "number", min: 5 })}
        </div>
        <div class="as-section-actions"><button class="ab-btn-primary" type="submit"><span data-icon="check"></span>Save Security Settings</button><button class="ab-btn-secondary danger" type="button" data-action="force-logout"><span data-icon="logout"></span>Force Logout All Sessions</button></div>
      </form>`;
  }

  function renderBackup() {
    const stats = state.systemStats || {};
    return `
      <section class="as-panel-card">
        ${panelHead("backup", "Ready")}
        <div class="as-data-grid">
          <article class="as-mini-card"><span>Last Backup</span><strong title="${escapeHtml(formatDate(stats.lastBackupAt))}">${escapeHtml(formatDate(stats.lastBackupAt))}</strong></article>
          <article class="as-mini-card"><span>Database Status</span><strong>${escapeHtml(stats.databaseStatus || "Healthy")}</strong></article>
          <article class="as-mini-card"><span>Total Records</span><strong>${escapeHtml(numberFmt.format(stats.totalRecords || 0))}</strong></article>
          <article class="as-mini-card"><span>Storage Used</span><strong title="${escapeHtml(stats.storageUsed || "Managed by PostgreSQL")}">${escapeHtml(stats.storageUsed || "Managed by PostgreSQL")}</strong></article>
        </div>
        <div class="as-export-grid">
          ${Object.entries(EXPORT_LABELS).map(([type, info]) => `
            <article class="as-export-card">
              <span><strong>${escapeHtml(info[0])}</strong><span>${escapeHtml(info[1])}</span></span>
              <button class="ab-btn-secondary" type="button" data-export-type="${escapeHtml(type)}"><span data-icon="bar-chart"></span>Export</button>
            </article>`).join("")}
          <article class="as-export-card"><span><strong>Clear Old Notifications</strong><span>Remove read notifications older than 7 days and stale notifications older than 60 days.</span></span><button class="ab-btn-secondary" type="button" data-action="clear-notifications">Run</button></article>
          <article class="as-export-card"><span><strong>View Audit Logs</strong><span>Review settings changes, login activity, account creation, and system actions.</span></span><button class="ab-btn-secondary" type="button" data-action="audit-logs">Open</button></article>
        </div>
      </section>`;
  }

  function renderIntegrations() {
    return `
      <section class="as-panel-card">
        ${panelHead("integrations", "Secrets hidden")}
        <div class="as-integration-grid">
          ${state.integrations.map((item) => `
            <article class="as-integration-card">
              <div class="as-integration-top"><strong>${escapeHtml(item.name)}</strong><span class="as-badge ${item.status === "connected" ? "connected" : ""}">${escapeHtml(item.status === "connected" ? "Connected" : "Not configured")}</span></div>
              <p>${escapeHtml(item.description)}</p>
              ${item.maskedValue ? `<span class="as-masked">${escapeHtml(item.maskedValue)}</span>` : `<span class="as-masked">No key configured</span>`}
              <div class="as-section-actions"><button class="ab-btn-secondary" type="button" data-action="configure-integration" data-integration-key="${escapeHtml(item.key)}">Configure</button></div>
            </article>`).join("")}
        </div>
      </section>`;
  }

  function normaliseSection(section) {
    return section === "data" ? "backup" : (SECTION_LABELS[section] ? section : "profile");
  }

  function switchSettingsSection(section, updateHash = true) {
    renderSettingsSection(section, updateHash);
  }

  function renderSettingsSection(section, updateHash = true) {
    section = normaliseSection(section);
    state.currentSection = section;
    document.querySelectorAll(".settings-nav-item, .as-menu-item").forEach((button) => button.classList.toggle("active", button.dataset.section === section));
    if (updateHash && window.location.hash !== `#${section}`) {
      history.replaceState(null, "", `#${section}`);
    }
    const panel = $("settings-panel");
    if (!panel) return;
    const renderers = {
      profile: renderProfile,
      platform: renderPlatform,
      pricing: renderPricing,
      access: renderAccess,
      notifications: renderNotifications,
      security: renderSecurity,
      backup: renderBackup,
      integrations: renderIntegrations,
    };
    panel.innerHTML = (renderers[section] || renderProfile)();
    hydrateIcons(panel);
  }

  function collectForm(form) {
    const data = {};
    const fd = new FormData(form);
    form.querySelectorAll("input, select, textarea").forEach((el) => {
      if (!el.name || el.readOnly) return;
      data[el.name] = el.type === "checkbox" ? el.checked : fd.get(el.name);
    });
    return data;
  }

  async function saveProfileSettings() {
    const data = collectForm($("settings-form"));
    const result = await api(`${API_BASE}/profile`, { method: "PATCH", body: JSON.stringify(data) });
    state.profile = result.profile;
    try {
      const user = JSON.parse(localStorage.getItem("cbs_user") || "{}");
      user.full_name = result.profile.name;
      user.email = result.profile.email;
      localStorage.setItem("cbs_user", JSON.stringify(user));
    } catch (_) {}
    applyProfileImageToAvatars();
    showToast("Profile settings saved.");
  }

  function handleProfileImageChange(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("Please choose an image file.", "warning");
      input.value = "";
      return;
    }
    if (file.size > 1.5 * 1024 * 1024) {
      showToast("Please choose an image under 1.5 MB.", "warning");
      input.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const image = String(reader.result || "");
      try { localStorage.setItem(PROFILE_IMAGE_KEY, image); } catch (_) {}
      applyProfileImageToAvatars(image);
      showToast("Profile image updated locally.");
    };
    reader.onerror = () => showToast("Could not read the selected image.", "error");
    reader.readAsDataURL(file);
  }

  async function savePlatformSettings() {
    const data = collectForm($("settings-form"));
    const result = await api(`${API_BASE}/platform`, { method: "PUT", body: JSON.stringify({ settings: data }) });
    state.settings = result.settings;
    showToast("Platform settings saved.");
  }

  async function savePricingRules() {
    const data = collectForm($("settings-form"));
    const result = await api(`${API_BASE}/pricing`, { method: "PUT", body: JSON.stringify(data) });
    state.settings = result.settings;
    showToast("Pricing rules saved.");
  }

  async function saveAccessControl() {
    const form = $("settings-form");
    const access = state.accessControl;
    const matrix = {};
    (access.roles || []).forEach((role) => {
      matrix[role] = {};
      (access.permissions || []).forEach((permission) => {
        const input = form.elements.namedItem(role + "::" + permission);
        matrix[role][permission] = Boolean(input?.checked);
      });
    });
    const result = await api(`${API_BASE}/access-control`, { method: "PATCH", body: JSON.stringify({ permissions: matrix }) });
    state.accessControl = result;
    showToast("Access control saved.");
  }

  async function saveNotificationSettings() {
    const data = collectForm($("settings-form"));
    const result = await api(`${API_BASE}/notifications`, { method: "PUT", body: JSON.stringify({ settings: data }) });
    state.settings = result.settings;
    showToast("Notification settings saved.");
  }

  async function saveSecuritySettings() {
    const data = collectForm($("settings-form"));
    const result = await api(`${API_BASE}/security`, { method: "PUT", body: JSON.stringify({ settings: data }) });
    state.settings = result.settings;
    showToast("Security settings saved.");
  }

  async function saveCurrentSection() {
    const section = state.currentSection;
    if (section === "backup" || section === "integrations") {
      showToast("This section uses action buttons instead of saved form fields.", "warning");
      return;
    }
    const handlers = {
      profile: saveProfileSettings,
      platform: savePlatformSettings,
      pricing: savePricingRules,
      access: saveAccessControl,
      notifications: saveNotificationSettings,
      security: saveSecuritySettings,
    };
    await handlers[section]();
    renderSettingsSection(section);
  }

  async function loadIntegrationStatus() {
    const data = await api(`${API_BASE}/integrations`);
    state.integrations = data.integrations || [];
    if (state.currentSection === "integrations") renderSettingsSection("integrations");
  }

  async function exportData(type) {
    const { blob, filename } = await apiBlob(`${API_BASE}/export/${encodeURIComponent(type)}`, { method: "POST" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(`${EXPORT_LABELS[type]?.[0] || "Data"} exported.`);
  }

  function renderLogRows(rows, type) {
    if (!rows || !rows.length) return `<div class="as-empty small">No activity recorded yet.</div>`;
    return rows.map((row) => {
      if (type === "accounts") {
        return `<article class="as-log-row"><strong>${escapeHtml(row.full_name || row.name || "User")}</strong><span>${escapeHtml(row.email || "N/A")} - ${escapeHtml(row.role || "student")} - ${escapeHtml(row.is_active === false ? "Inactive" : "Active")}</span><small>${escapeHtml(formatDate(row.created_at))}</small></article>`;
      }
      if (type === "logins") {
        return `<article class="as-log-row"><strong>${escapeHtml(row.admin_name || row.name || "Admin")}</strong><span>${escapeHtml(row.admin_email || row.email || "N/A")} - ${escapeHtml(row.status || "success")} - ${escapeHtml(row.user_agent || "N/A")}</span><small>${escapeHtml(formatDate(row.created_at))}</small></article>`;
      }
      const details = row.details && typeof row.details === "object" ? row.details : {};
      const changes = Array.isArray(details.changes) && details.changes.length
        ? details.changes.slice(0, 2).map((c) => `${c.key}: ${c.oldValue || "blank"} -> ${c.newValue || "blank"}`).join("; ")
        : (details.description || row.action || "System action");
      return `<article class="as-log-row"><strong>${escapeHtml(row.action || "Activity")}</strong><span>${escapeHtml(changes)}</span><small>${escapeHtml(formatDate(row.created_at))}</small></article>`;
    }).join("");
  }

  async function openAuditLogs(type = "settings") {
    const data = await api(`${API_BASE}/audit-logs?type=${encodeURIComponent(type)}&limit=60`);
    state.modalCallback = null;
    $("settings-modal-title").textContent = "Admin Audit Logs";
    $("settings-modal-body").innerHTML = `
      <div class="as-audit-tabs">
        <button type="button" data-audit-tab="settings" class="${type === "settings" ? "active" : ""}">Settings Changes</button>
        <button type="button" data-audit-tab="logins" class="${type === "logins" ? "active" : ""}">Login Activity</button>
        <button type="button" data-audit-tab="accounts" class="${type === "accounts" ? "active" : ""}">Account Creations</button>
        <button type="button" data-audit-tab="system" class="${type === "system" ? "active" : ""}">System Actions</button>
      </div>
      <div class="as-audit-list">${renderLogRows(data.logs || [], type)}</div>
    `;
    $("settings-modal-confirm").textContent = "Close";
    $("settings-modal").dataset.size = "wide";
    $("settings-modal").hidden = false;
    hydrateIcons($("settings-modal"));
  }

  function clearOldNotifications() {
    openModal(
      "Clear Old Notifications",
      "This will remove read notifications older than 7 days and stale notifications older than 60 days. Users, bookings, payments, and tickets are not deleted.",
      "Clear Notifications",
      async () => {
        const result = await api("/api/admin/notifications/clear-old", { method: "POST", body: JSON.stringify({}) });
        closeModal();
        showToast(`${result.cleared || 0} old notifications cleared.`);
      }
    );
  }

  function configureIntegration(key) {
    const item = state.integrations.find((integration) => integration.key === key);
    if (!item) return;
    state.modalCallback = null;
    $("settings-modal-title").textContent = `${item.name} Configuration`;
    $("settings-modal-body").innerHTML = `
      <div class="as-config-modal">
        <p><strong>Status:</strong> ${escapeHtml(item.status === "connected" ? "Connected" : "Not configured")}</p>
        <p><strong>Masked value:</strong> ${escapeHtml(item.maskedValue || "No key configured")}</p>
        <p>${escapeHtml(item.description || "")}</p>
        <div class="as-inline-note">Runtime secret editing is disabled. Update this key in the environment configuration, then restart the backend.</div>
      </div>
    `;
    $("settings-modal-confirm").textContent = "Close";
    $("settings-modal").dataset.size = "";
    $("settings-modal").hidden = false;
  }

  function openModal(title, message, confirmText, callback) {
    state.modalCallback = callback;
    $("settings-modal-title").textContent = title;
    $("settings-modal-body").innerHTML = `<p>${escapeHtml(message)}</p>`;
    $("settings-modal-confirm").textContent = confirmText;
    $("settings-modal").dataset.size = "";
    $("settings-modal").hidden = false;
    hydrateIcons($("settings-modal"));
  }

  function closeModal() {
    $("settings-modal").hidden = true;
    $("settings-modal").dataset.size = "";
    state.modalCallback = null;
  }

  function resetSettings() {
    const section = state.currentSection;
    if (section === "backup" || section === "integrations") {
      openModal("Reset Section", "This section does not have editable defaults. Use the action buttons in the section instead.", "OK", async () => closeModal());
      return;
    }
    openModal(
      "Reset Settings",
      `This will restore the active ${SECTION_LABELS[section][0]} section to its default values. Existing users, bookings, payments, and tickets will not be deleted.`,
      "Reset Defaults",
      async () => {
        const result = await api(`${API_BASE}/reset-defaults`, { method: "POST", body: JSON.stringify({ section }) });
        state.settings = result.settings;
        if (result.accessControl) state.accessControl = result.accessControl;
        closeModal();
        renderSettingsSection(state.currentSection);
        showToast("Default settings restored.");
      }
    );
  }

  function wireEvents() {
    document.querySelectorAll(".settings-nav-item, .as-menu-item").forEach((button) => {
      button.addEventListener("click", () => switchSettingsSection(button.dataset.section || "profile"));
    });
    $("settings-panel").addEventListener("submit", (event) => {
      event.preventDefault();
      saveCurrentSection().catch((err) => showToast(err.message, "error"));
    });
    $("settings-panel").addEventListener("click", (event) => {
      const exportButton = event.target.closest("[data-export-type]");
      if (exportButton) {
        exportData(exportButton.dataset.exportType).catch((err) => showToast(err.message, "error"));
        return;
      }
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (!action) return;
      if (action === "change-password") showToast("Password changes are handled through the existing forgot-password flow.", "warning");
      if (action === "force-logout") showToast("Session invalidation will be added when server-side sessions are introduced.", "warning");
      if (action === "clear-notifications") clearOldNotifications();
      if (action === "audit-logs") openAuditLogs("settings").catch((err) => showToast(err.message, "error"));
      if (action === "configure-integration") configureIntegration(event.target.closest("[data-integration-key]")?.dataset.integrationKey);
    });
    $("settings-panel").addEventListener("change", (event) => {
      if (event.target && event.target.id === "admin-profile-image-input") {
        handleProfileImageChange(event.target);
      }
    });
    $("save-current-section").addEventListener("click", () => saveCurrentSection().catch((err) => showToast(err.message, "error")));
    $("reset-defaults").addEventListener("click", resetSettings);
    $("refresh-dashboard").addEventListener("click", () => loadSettings().then(() => showToast("Settings refreshed.")).catch((err) => showToast(err.message, "error")));
    $("export-report").addEventListener("click", () => {
      switchSettingsSection("backup");
      showToast("Choose a dataset to export.");
    });
    document.querySelectorAll("[data-close-settings-modal]").forEach((el) => el.addEventListener("click", closeModal));
    $("settings-modal-confirm").addEventListener("click", () => {
      if (!state.modalCallback) {
        closeModal();
        return;
      }
      if (state.modalCallback) state.modalCallback().catch((err) => {
        closeModal();
        showToast(err.message, "error");
      });
    });
    $("settings-modal-body").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-audit-tab]");
      if (!tab) return;
      openAuditLogs(tab.dataset.auditTab).catch((err) => showToast(err.message, "error"));
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("settings-modal").hidden) closeModal();
    });
  }

  async function initSettingsPage() {
    wireEvents();
    try {
      const params = new URLSearchParams(window.location.search);
      const initialSection = normaliseSection(params.get("section") || (location.hash || "").replace("#", "") || "profile");
      state.currentSection = initialSection;
      await loadSettings();
      await loadIntegrationStatus();
      applyProfileImageToAvatars();
      hydrateIcons(document);
    } catch (err) {
      $("settings-panel").innerHTML = `<div class="as-empty">${escapeHtml(err.message || "Could not load admin settings.")}</div>`;
      showToast(err.message || "Could not load admin settings.", "error");
    }
  }

  window.initSettingsPage = initSettingsPage;
  window.loadSettings = loadSettings;
  window.switchSettingsSection = switchSettingsSection;
  window.renderSettingsSection = renderSettingsSection;
  window.renderProfileSection = renderProfile;
  window.renderPlatformSection = renderPlatform;
  window.renderPricingSection = renderPricing;
  window.renderAccessControlSection = renderAccess;
  window.renderNotificationsSection = renderNotifications;
  window.renderSecuritySection = renderSecurity;
  window.renderBackupSection = renderBackup;
  window.renderIntegrationsSection = renderIntegrations;
  window.saveProfileSettings = saveProfileSettings;
  window.savePlatformSettings = savePlatformSettings;
  window.savePricingRules = savePricingRules;
  window.saveAccessControl = saveAccessControl;
  window.saveNotificationSettings = saveNotificationSettings;
  window.saveSecuritySettings = saveSecuritySettings;
  window.loadIntegrationStatus = loadIntegrationStatus;
  window.exportData = exportData;
  window.resetCurrentSection = resetSettings;
  window.resetSettings = resetSettings;
  window.showSettingsToast = showToast;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSettingsPage);
  } else {
    initSettingsPage();
  }
})();
