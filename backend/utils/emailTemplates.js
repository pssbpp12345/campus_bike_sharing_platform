// ──────────────────────────────────────────────────────────────
// utils/emailTemplates.js
//
// Shared HTML email templates for the Campus Bike Sharing platform.
//
// Design notes:
// • All styling is inlined — most email clients (Gmail, Outlook, Yahoo)
//   strip <style> blocks or unsupported CSS, so inline is the only
//   reliable way to render consistent visuals.
// • Outer layout uses <table> tags (not flexbox/grid) because Outlook
//   on Windows still renders with the Word engine and ignores modern CSS.
// • Brand palette mirrors the front-end:
//     primary blue : #2D7FF9
//     accent green : #22C55E
//     ink          : #0F172A
//     muted        : #64748B
// • Each template returns { subject, text, html } so the mailer can
//   pick whichever the recipient client prefers.
// ──────────────────────────────────────────────────────────────

const BRAND = {
  name:         "Campus Bike Sharing",
  tagline:      "Sustainable rides across campus",
  primary:      "#2D7FF9",
  accent:       "#22C55E",
  ink:          "#0F172A",
  muted:        "#64748B",
  border:       "#E2E8F0",
  bgSoft:       "#F8FAFC",
  supportEmail: process.env.ADMIN_EMAIL || "campusbikesharing@gmail.com",
  websiteUrl:   process.env.PUBLIC_URL || "http://localhost:5000/",
};

// ── HTML helpers ──────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(d) {
  try {
    return new Date(d).toLocaleString("en-AU", {
      weekday: "short", year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", timeZoneName: "short"
    });
  } catch (_) { return new Date(d).toUTCString(); }
}

// ── Base layout ───────────────────────────────────────────────
// Wraps any inner-HTML body in a branded shell with header + footer.
function shell({ preheader = "", body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${esc(BRAND.name)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bgSoft};font-family:'Segoe UI',Roboto,Inter,Helvetica,Arial,sans-serif;color:${BRAND.ink};-webkit-font-smoothing:antialiased;">
  <!-- Hidden preheader: shows up next to the subject in inbox previews -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">${esc(preheader)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.bgSoft};padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid ${BRAND.border};border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(15,23,42,.06);">

          <!-- Header / brand bar -->
          <tr>
            <td style="background:linear-gradient(135deg,${BRAND.primary} 0%, ${BRAND.accent} 100%);padding:22px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle" style="vertical-align:middle;">
                    <span style="display:inline-block;width:38px;height:38px;border-radius:11px;background:rgba(255,255,255,.18);text-align:center;line-height:38px;font-size:20px;vertical-align:middle;margin-right:12px;">🚲</span>
                    <span style="display:inline-block;color:#FFFFFF;font-size:18px;font-weight:700;letter-spacing:.2px;vertical-align:middle;">${esc(BRAND.name)}</span>
                  </td>
                  <td align="right" valign="middle" style="vertical-align:middle;">
                    <span style="color:rgba(255,255,255,.85);font-size:12px;font-weight:500;">${esc(BRAND.tagline)}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding:32px 36px 12px;">
              ${body}
            </td>
          </tr>

          <!-- Signature -->
          <tr>
            <td style="padding:0 36px 28px;">
              <p style="margin:18px 0 4px;color:${BRAND.ink};font-size:15px;line-height:1.6;">Warm regards,</p>
              <p style="margin:0;color:${BRAND.ink};font-size:15px;font-weight:700;line-height:1.4;">The ${esc(BRAND.name)} Team</p>
              <p style="margin:2px 0 0;color:${BRAND.muted};font-size:13px;line-height:1.5;">${esc(BRAND.tagline)}</p>
              <p style="margin:6px 0 0;color:${BRAND.muted};font-size:13px;line-height:1.5;">
                <a href="mailto:${esc(BRAND.supportEmail)}" style="color:${BRAND.primary};text-decoration:none;">${esc(BRAND.supportEmail)}</a>
                &nbsp;·&nbsp;
                <a href="${esc(BRAND.websiteUrl)}" style="color:${BRAND.primary};text-decoration:none;">${esc(BRAND.websiteUrl.replace(/^https?:\/\//,"").replace(/\/$/,""))}</a>
              </p>
            </td>
          </tr>

          <!-- Footer / disclaimer -->
          <tr>
            <td style="background:${BRAND.bgSoft};border-top:1px solid ${BRAND.border};padding:18px 36px;">
              <p style="margin:0;color:${BRAND.muted};font-size:11px;line-height:1.6;text-align:center;">
                You received this email because an action was performed on your ${esc(BRAND.name)} account.<br>
                If this wasn't you, please reply to this email or contact <a href="mailto:${esc(BRAND.supportEmail)}" style="color:${BRAND.primary};text-decoration:none;">${esc(BRAND.supportEmail)}</a> immediately.
              </p>
              <p style="margin:8px 0 0;color:${BRAND.muted};font-size:11px;line-height:1.6;text-align:center;">
                © ${new Date().getFullYear()} ${esc(BRAND.name)}. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Reusable inner-HTML pieces ────────────────────────────────
function bigButton({ href, label }) {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;">
      <tr>
        <td align="center" style="border-radius:12px;background:linear-gradient(135deg,${BRAND.primary} 0%, ${BRAND.accent} 100%);">
          <a href="${esc(href)}" style="display:inline-block;padding:13px 26px;color:#FFFFFF;font-weight:700;font-size:14px;text-decoration:none;border-radius:12px;letter-spacing:.2px;">
            ${esc(label)}
          </a>
        </td>
      </tr>
    </table>`;
}

function infoBox({ title, body, tone = "info" }) {
  const palette = {
    info:    { bg: "#EFF6FF", border: "#BFDBFE", text: "#1E3A8A" },
    success: { bg: "#ECFDF5", border: "#A7F3D0", text: "#065F46" },
    warn:    { bg: "#FFFBEB", border: "#FDE68A", text: "#92400E" },
  }[tone] || { bg: "#EFF6FF", border: "#BFDBFE", text: "#1E3A8A" };
  return `
    <div style="margin:16px 0;padding:14px 16px;background:${palette.bg};border:1px solid ${palette.border};border-radius:12px;">
      <p style="margin:0 0 4px;color:${palette.text};font-size:13px;font-weight:700;">${esc(title)}</p>
      <p style="margin:0;color:${palette.text};font-size:13px;line-height:1.5;">${body}</p>
    </div>`;
}

// ──────────────────────────────────────────────────────────────
// 1) WELCOME EMAIL — sent when a new user registers
// ──────────────────────────────────────────────────────────────
function welcomeEmail({ name, email, role = "student", loginUrl }) {
  const safeName = esc(name || "there");
  const url = loginUrl || `${BRAND.websiteUrl.replace(/\/$/,"")}/login.html`;
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);

  const subject = `Welcome to ${BRAND.name}, ${name ? name.split(" ")[0] : "rider"}! 🚲`;
  const preheader = "Your account is ready — hop on and start riding.";

  const body = `
    <h1 style="margin:0 0 6px;color:${BRAND.ink};font-size:24px;font-weight:800;letter-spacing:-.2px;">Welcome aboard, ${safeName}!</h1>
    <p style="margin:0 0 14px;color:${BRAND.muted};font-size:14px;">Your ${esc(BRAND.name)} account has been created successfully.</p>

    <p style="margin:16px 0 8px;color:${BRAND.ink};font-size:15px;line-height:1.7;">
      We're delighted to have you join a community of riders helping make our campus greener, healthier, and a little more fun to get around.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;background:${BRAND.bgSoft};border:1px solid ${BRAND.border};border-radius:12px;">
      <tr>
        <td style="padding:14px 18px;">
          <p style="margin:0 0 6px;color:${BRAND.muted};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Your account</p>
          <p style="margin:0;color:${BRAND.ink};font-size:14px;line-height:1.7;">
            <strong>Name:</strong> ${safeName}<br>
            <strong>Email:</strong> ${esc(email)}<br>
            <strong>Role:</strong> <span style="display:inline-block;padding:2px 10px;background:${BRAND.primary};color:#FFFFFF;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.3px;">${esc(roleLabel)}</span>
          </p>
        </td>
      </tr>
    </table>

    <p style="margin:14px 0 6px;color:${BRAND.ink};font-size:15px;line-height:1.7;">Here's what you can do next:</p>
    <ul style="margin:0 0 14px 18px;padding:0;color:${BRAND.ink};font-size:14px;line-height:1.8;">
      <li>Browse available bikes near your campus building</li>
      <li>Book a ride in seconds, unlock with a tap</li>
      <li>Track your kilometres, calories, and CO₂ saved</li>
    </ul>

    ${bigButton({ href: url, label: "Sign in to your account →" })}

    ${infoBox({
      tone: "success",
      title: "Pay-as-you-ride pricing",
      body: `$1.00 to unlock the bike + $0.20 per minute of riding. No subscription, no deposit, no monthly fee. A typical 10-minute hop between buildings is only $3.`
    })}

    ${infoBox({
      tone: "info",
      title: "Quick tip",
      body: `Keep your university email up to date — we use it for trip receipts, booking reminders, and security alerts. Need to change your role to staff or admin? Just reply to this email.`
    })}

    <p style="margin:18px 0 0;color:${BRAND.muted};font-size:13px;line-height:1.6;">If you didn't create this account, please let us know right away by replying to this message.</p>
  `;

  const text =
`Welcome aboard, ${name || "there"}!

Your ${BRAND.name} account has been created successfully.

  Name:  ${name || ""}
  Email: ${email}
  Role:  ${roleLabel}

Sign in here: ${url}

Here's what you can do next:
  • Browse available bikes near your campus building
  • Book a ride in seconds, unlock with a tap
  • Track your kilometres, calories, and CO₂ saved

Pricing: $1.00 to unlock + $0.20 per minute. No subscription, no deposit. A 10-minute ride is just $3.

If you didn't create this account, just reply to this email and we'll sort it out.

— The ${BRAND.name} Team
${BRAND.supportEmail}
${BRAND.websiteUrl}`;

  return { subject, text, html: shell({ preheader, body }) };
}

// ──────────────────────────────────────────────────────────────
// 2) PASSWORD-CHANGED EMAIL — sent after a successful reset
// ──────────────────────────────────────────────────────────────
function passwordChangedEmail({ name, email, ip, userAgent, when, loginUrl }) {
  const safeName = esc(name || "there");
  const url = loginUrl || `${BRAND.websiteUrl.replace(/\/$/,"")}/login.html`;
  const subject = `Your ${BRAND.name} password was changed`;
  const preheader = "Confirming a recent change to your account.";

  const body = `
    <h1 style="margin:0 0 6px;color:${BRAND.ink};font-size:24px;font-weight:800;letter-spacing:-.2px;">Your password was changed</h1>
    <p style="margin:0 0 14px;color:${BRAND.muted};font-size:14px;">We're letting you know about a recent change to your account.</p>

    <p style="margin:16px 0 8px;color:${BRAND.ink};font-size:15px;line-height:1.7;">
      Hi ${safeName}, the password for your ${esc(BRAND.name)} account (<strong>${esc(email)}</strong>) was successfully updated.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;background:${BRAND.bgSoft};border:1px solid ${BRAND.border};border-radius:12px;">
      <tr>
        <td style="padding:14px 18px;">
          <p style="margin:0 0 6px;color:${BRAND.muted};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Change details</p>
          <p style="margin:0;color:${BRAND.ink};font-size:14px;line-height:1.7;">
            <strong>When:</strong> ${esc(fmtDate(when || new Date()))}<br>
            ${ip ? `<strong>IP address:</strong> ${esc(ip)}<br>` : ""}
            ${userAgent ? `<strong>Device:</strong> ${esc(String(userAgent).slice(0, 120))}` : ""}
          </p>
        </td>
      </tr>
    </table>

    ${infoBox({
      tone: "success",
      title: "All set",
      body: `You can now sign in with your new password. For your security, any older sessions on other devices may need to log in again.`
    })}

    ${bigButton({ href: url, label: "Sign in" })}

    ${infoBox({
      tone: "warn",
      title: "Wasn't you?",
      body: `If you didn't make this change, your account may be at risk. Reply to this email immediately or contact <a href="mailto:${esc(BRAND.supportEmail)}" style="color:#92400E;text-decoration:underline;">${esc(BRAND.supportEmail)}</a> so we can help secure it.`
    })}
  `;

  const text =
`Your ${BRAND.name} password was changed

Hi ${name || "there"}, the password for your account (${email}) was successfully updated.

  When: ${fmtDate(when || new Date())}
  ${ip ? `IP address: ${ip}\n  ` : ""}${userAgent ? `Device: ${String(userAgent).slice(0, 120)}` : ""}

If you didn't make this change, contact us right away: ${BRAND.supportEmail}

Sign in here: ${url}

— The ${BRAND.name} Team
${BRAND.supportEmail}
${BRAND.websiteUrl}`;

  return { subject, text, html: shell({ preheader, body }) };
}

// ──────────────────────────────────────────────────────────────
// 3) OTP EMAIL — sent on forgot-password requests
// ──────────────────────────────────────────────────────────────
function otpEmail({ name, email, otp, expiresMin = 5 }) {
  const safeName = esc(name || "there");
  const subject = `Your ${BRAND.name} password-reset code`;
  const preheader = `Use code ${otp} — valid for ${expiresMin} minutes.`;

  const otpDisplay = String(otp).split("").map(d =>
    `<span style="display:inline-block;min-width:38px;padding:10px 4px;margin:0 3px;background:#FFFFFF;border:1px solid ${BRAND.border};border-radius:10px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:24px;font-weight:800;color:${BRAND.ink};">${esc(d)}</span>`
  ).join("");

  const body = `
    <h1 style="margin:0 0 6px;color:${BRAND.ink};font-size:24px;font-weight:800;letter-spacing:-.2px;">Reset your password</h1>
    <p style="margin:0 0 14px;color:${BRAND.muted};font-size:14px;">Use the code below to confirm it's you.</p>

    <p style="margin:16px 0 8px;color:${BRAND.ink};font-size:15px;line-height:1.7;">
      Hi ${safeName}, here is your one-time password for ${esc(BRAND.name)}:
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0;background:${BRAND.bgSoft};border:1px solid ${BRAND.border};border-radius:14px;">
      <tr>
        <td align="center" style="padding:22px 14px;">
          ${otpDisplay}
        </td>
      </tr>
    </table>

    ${infoBox({
      tone: "info",
      title: `Valid for ${expiresMin} minutes`,
      body: `Enter this code on the password-reset page to set a new password. For your security, never share this code with anyone — not even our team.`
    })}

    <p style="margin:14px 0 0;color:${BRAND.muted};font-size:13px;line-height:1.6;">
      Didn't request a password reset? You can safely ignore this email — your account is still secure.
    </p>
  `;

  const text =
`Reset your password

Hi ${name || "there"}, your ${BRAND.name} one-time password is:

  ${otp}

This code is valid for ${expiresMin} minutes. Never share it with anyone.

If you didn't request this, you can safely ignore this email.

— The ${BRAND.name} Team
${BRAND.supportEmail}
${BRAND.websiteUrl}`;

  return { subject, text, html: shell({ preheader, body }) };
}

module.exports = {
  BRAND,
  welcomeEmail,
  passwordChangedEmail,
  otpEmail,
};
