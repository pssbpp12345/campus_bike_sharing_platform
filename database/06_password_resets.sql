-- ============================================================
--  CAMPUS BIKE SHARING — Password Reset (OTP) flow
--  Stores short-lived OTP hashes for the forgot-password feature.
--  Apply AFTER 01_schema.sql.
-- ============================================================

CREATE TABLE password_resets (
    id            SERIAL          PRIMARY KEY,
    user_id       INTEGER         NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- bcrypt hash of the 6-digit OTP — never store the OTP plaintext
    otp_hash      TEXT            NOT NULL,

    -- 5-minute window for the OTP to be used
    expires_at    TIMESTAMPTZ     NOT NULL,

    -- Timestamp when the OTP was redeemed; NULL while still pending
    used_at       TIMESTAMPTZ,

    -- Metadata
    ip_address    INET,
    user_agent    TEXT,

    created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_pwreset_window CHECK (expires_at > created_at)
);

CREATE INDEX idx_password_resets_user        ON password_resets(user_id);
CREATE INDEX idx_password_resets_created     ON password_resets(created_at DESC);
CREATE INDEX idx_password_resets_active      ON password_resets(user_id) WHERE used_at IS NULL;

COMMENT ON TABLE  password_resets IS 'Short-lived OTPs for the forgot-password flow.';
COMMENT ON COLUMN password_resets.otp_hash   IS 'bcrypt hash of the 6-digit numeric OTP.';
COMMENT ON COLUMN password_resets.expires_at IS 'OTP becomes invalid after this timestamp (typically created_at + 5 min).';
COMMENT ON COLUMN password_resets.used_at    IS 'Set once the OTP has been redeemed for a password reset.';
