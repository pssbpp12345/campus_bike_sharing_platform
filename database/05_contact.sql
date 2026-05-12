-- ============================================================
--  CAMPUS BIKE SHARING — Contact Messages
--  Adds the contact form storage layer.
--  Run AFTER 01_schema.sql (it references users.id).
-- ============================================================


-- ============================================================
-- STEP 1: ENUMs
-- ============================================================

CREATE TYPE contact_category AS ENUM (
    'general',
    'support',
    'feedback',
    'partnership',
    'press',
    'bug_report'
);

CREATE TYPE contact_status AS ENUM (
    'new',
    'read',
    'replied',
    'archived'
);


-- ============================================================
-- STEP 2: TABLE
-- ============================================================

CREATE TABLE contact_messages (
    id              SERIAL              PRIMARY KEY,

    -- Linked user account if the sender was logged in (optional).
    user_id         INTEGER             REFERENCES users(id) ON DELETE SET NULL,

    -- Always captured from the form
    full_name       VARCHAR(150)        NOT NULL,
    email           VARCHAR(150)        NOT NULL,
    phone           VARCHAR(40),
    category        contact_category    NOT NULL DEFAULT 'general',
    subject         VARCHAR(200)        NOT NULL,
    message         TEXT                NOT NULL,

    -- Lifecycle
    status          contact_status      NOT NULL DEFAULT 'new',
    admin_notes     TEXT,
    replied_at      TIMESTAMPTZ,
    replied_by      INTEGER             REFERENCES users(id) ON DELETE SET NULL,

    -- Forensic / spam-fighting metadata
    ip_address      INET,
    user_agent      TEXT,

    created_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_contact_email      CHECK (email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
    CONSTRAINT chk_contact_message_len CHECK (char_length(message) BETWEEN 5 AND 10000),
    CONSTRAINT chk_contact_subject_len CHECK (char_length(subject) BETWEEN 2 AND 200)
);


-- ============================================================
-- STEP 3: INDEXES
-- ============================================================

CREATE INDEX idx_contact_messages_status   ON contact_messages(status);
CREATE INDEX idx_contact_messages_category ON contact_messages(category);
CREATE INDEX idx_contact_messages_email    ON contact_messages(email);
CREATE INDEX idx_contact_messages_created  ON contact_messages(created_at DESC);
CREATE INDEX idx_contact_messages_user     ON contact_messages(user_id);


-- ============================================================
-- STEP 4: AUTOMATIC updated_at TOUCH
-- (relies on fn_touch_updated_at created in 02_functions.sql)
-- ============================================================

CREATE TRIGGER trg_touch_contact_messages
BEFORE UPDATE ON contact_messages
FOR EACH ROW
EXECUTE FUNCTION fn_touch_updated_at();


-- ============================================================
-- STEP 5: ADMIN VIEW — newest unread first
-- ============================================================

CREATE OR REPLACE VIEW vw_contact_inbox AS
SELECT
    cm.id,
    cm.created_at,
    cm.status,
    cm.category,
    cm.full_name,
    cm.email,
    cm.phone,
    cm.subject,
    cm.message,
    cm.user_id,
    u.full_name AS sender_account_name,
    cm.admin_notes,
    cm.replied_at,
    rb.full_name AS replied_by_name
FROM contact_messages cm
LEFT JOIN users u  ON u.id  = cm.user_id
LEFT JOIN users rb ON rb.id = cm.replied_by
ORDER BY
    CASE cm.status WHEN 'new' THEN 0 WHEN 'read' THEN 1 WHEN 'replied' THEN 2 ELSE 3 END,
    cm.created_at DESC;
