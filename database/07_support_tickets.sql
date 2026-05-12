-- Support tickets table for student help/support page
DROP TABLE IF EXISTS support_tickets CASCADE;

CREATE TYPE ticket_status   AS ENUM ('open', 'in_progress', 'resolved', 'closed');
CREATE TYPE ticket_priority AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE ticket_category AS ENUM ('booking', 'bike', 'payment', 'account', 'station', 'other');

CREATE TABLE support_tickets (
    id              SERIAL          PRIMARY KEY,
    user_id         INTEGER         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category        ticket_category NOT NULL DEFAULT 'other',
    subject         VARCHAR(200)    NOT NULL,
    description     TEXT            NOT NULL,
    priority        ticket_priority NOT NULL DEFAULT 'medium',
    booking_id      INTEGER         REFERENCES bookings(id) ON DELETE SET NULL,
    status          ticket_status   NOT NULL DEFAULT 'open',
    admin_response  TEXT,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tickets_user        ON support_tickets(user_id);
CREATE INDEX idx_tickets_status      ON support_tickets(status);
CREATE INDEX idx_tickets_created     ON support_tickets(created_at DESC);
