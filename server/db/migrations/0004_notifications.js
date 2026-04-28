'use strict';

// Migration 0004: notifications queue + reminder_sent_at on conflicts.
// Idempotent. Bootstrap schema declares the same shape so fresh installs are
// already compatible; the migration only does work on databases born under
// schema versions 1–3.

exports.up = function up(db) {
  // notifications table — bootstrap-schema parity. CREATE IF NOT EXISTS is
  // safe on fresh and existing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      code              TEXT PRIMARY KEY,
      kind              TEXT NOT NULL,
      to_email          TEXT NOT NULL,
      subject           TEXT NOT NULL,
      body_text         TEXT NOT NULL,
      body_html         TEXT,
      related_codes     TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      attempts          INTEGER NOT NULL DEFAULT 0,
      next_attempt_at   TEXT,
      last_error        TEXT,
      transport         TEXT,
      provider_message_id TEXT,
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      sent_at           TEXT,
      CHECK (status IN ('pending','sent','failed','cancelled'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS notifications_status_idx ON notifications (status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS notifications_kind_idx   ON notifications (kind)`);
  db.exec(`CREATE INDEX IF NOT EXISTS notifications_next_attempt_idx ON notifications (status, next_attempt_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS notifications_to_email_idx ON notifications (to_email)`);

  // Track whether a reminder has been sent for an assignment so the dispatcher
  // doesn't spam the same conflict every minute as it nears expiry.
  const cols = db.prepare(`PRAGMA table_info(conflicts)`).all().map(r => r.name);
  if (!cols.includes('reminder_sent_at')) {
    db.exec(`ALTER TABLE conflicts ADD COLUMN reminder_sent_at TEXT`);
  }
};
