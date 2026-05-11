'use strict';

// Migration 0011: EIM certification + volunteer ministry tracking.
//
// EIM ("Ethics and Integrity in Ministry") is a Catholic-diocese safe-
// environment training that volunteers and staff complete on a recurring
// cycle (typically every 3 years). Parishes need to know — at a glance —
// whether each adult on a ministry roster is currently certified, when the
// cert lapses, and to whom the dashboard should send a renewal nudge.
//
// Field choices on persons:
//   eim_status         TEXT  NULL | 'pending' | 'certified' | 'expired'
//   eim_completed_on   TEXT  ISO-8601 date the cert was issued
//   eim_expires_on     TEXT  ISO-8601 expiration; queried by date range
//   eim_notes_ct       BLOB  ciphertext of operator notes (waiver, vendor)
//
// Dates are stored plaintext on purpose: the operator needs to ask
// "who's expiring in the next 30 days?" without decrypting the entire
// persons table. The field-level secret is the *reason* in eim_notes_ct
// (which can mention diocese, waiver, vendor, etc.).
//
// Volunteer ministries are first-class. Two new tables:
//   ministries              roster catalog (Lectors, Ushers, Eucharistic
//                           Ministers, Faith Formation aides, etc.)
//   ministry_assignments    who's on the list. Exactly one of person_code
//                           or family_code is set per row, so a single
//                           ministry can carry both individuals (Cantor:
//                           Mary Smith) and whole-family commitments
//                           (Coffee & Donuts: the Smith family).

exports.up = function up(db) {
  const personCols = db.prepare(`PRAGMA table_info(persons)`).all().map(r => r.name);
  if (!personCols.includes('eim_status')) {
    db.exec(`ALTER TABLE persons ADD COLUMN eim_status TEXT`);
  }
  if (!personCols.includes('eim_completed_on')) {
    db.exec(`ALTER TABLE persons ADD COLUMN eim_completed_on TEXT`);
  }
  if (!personCols.includes('eim_expires_on')) {
    db.exec(`ALTER TABLE persons ADD COLUMN eim_expires_on TEXT`);
  }
  if (!personCols.includes('eim_notes_ct')) {
    db.exec(`ALTER TABLE persons ADD COLUMN eim_notes_ct BLOB`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS persons_eim_expires_idx ON persons (eim_expires_on)`);
  db.exec(`CREATE INDEX IF NOT EXISTS persons_eim_status_idx  ON persons (eim_status)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ministries (
      code           TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      description    TEXT,
      requires_eim   INTEGER NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'active',
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (status IN ('active','archived'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ministries_name_active_uniq
      ON ministries (name) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS ministries_status_idx ON ministries (status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ministry_assignments (
      code           TEXT PRIMARY KEY,
      ministry_code  TEXT NOT NULL REFERENCES ministries(code) ON DELETE CASCADE,
      person_code    TEXT REFERENCES persons(code)  ON DELETE CASCADE,
      family_code    TEXT REFERENCES families(code) ON DELETE CASCADE,
      role           TEXT NOT NULL DEFAULT 'member',
      started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ended_at       TEXT,
      notes_ct       BLOB,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (role IN ('member','coordinator','lead')),
      CHECK (
        (person_code IS NOT NULL AND family_code IS NULL)
        OR (person_code IS NULL AND family_code IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS ministry_assignments_ministry_idx ON ministry_assignments (ministry_code);
    CREATE INDEX IF NOT EXISTS ministry_assignments_person_idx   ON ministry_assignments (person_code);
    CREATE INDEX IF NOT EXISTS ministry_assignments_family_idx   ON ministry_assignments (family_code);
    CREATE INDEX IF NOT EXISTS ministry_assignments_active_idx   ON ministry_assignments (ministry_code, ended_at);
    CREATE UNIQUE INDEX IF NOT EXISTS ministry_assignments_active_person_uniq
      ON ministry_assignments (ministry_code, person_code) WHERE ended_at IS NULL AND person_code IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ministry_assignments_active_family_uniq
      ON ministry_assignments (ministry_code, family_code) WHERE ended_at IS NULL AND family_code IS NOT NULL;
  `);
};
