'use strict';

// Migration 0016: alumni role + per-year participation labels.
//
// Two operator rules drive this (see IDENTITY_MODEL_SUMMARY.md):
//
// 1. Leaving the student role doesn't mean leaving the community.
//    A kid who graduates or unenrolls (even to another school) becomes
//    an ALUMNUS — a new ongoing affiliation, not just an end-date. The
//    old student row survives, dated, with its reason; nothing is ever
//    removed. Same posture for families who leave the parish roster:
//    end-date + approximate date + reason, never a delete.
//
// 2. Each year of attendance/participation is worth noting. Verification
//    rows gain an optional free-text `period` label ('2025-2026' for a
//    school year, '2026' for a parish year), so "years in the
//    community" is a query over distinct periods — for students AND for
//    families on the parishioner roster.
//
// 3. WHY someone left should be classifiable, not just prose. `reason`
//    becomes a controlled vocabulary (graduated | transferred | moved |
//    deceased | withdrew | inactive | merge | other) with a free-text
//    `reason_detail` for the story behind it. Pre-existing free-text
//    reasons that aren't one of the classes migrate to 'other' with the
//    original text preserved in reason_detail.
//
// Mechanics: the affiliations role CHECK must grow 'alumni', and SQLite
// CHECKs can't be altered in place, so this is a rename-and-rebuild.
// The runner executes migrations inside a transaction with foreign
// keys ON; renaming `affiliations` automatically repoints the child
// FK in `affiliation_verifications` at `affiliations_old`, so the
// verifications table is rebuilt too (which is also where `period`
// comes in). Index names survive a table rename, so the old indexes
// are dropped explicitly before the new tables recreate them.

exports.up = function up(db) {
  // Fresh databases bootstrap from schema.sql, which already carries
  // the final table shapes — rebuilding them again would mean every
  // future column added to schema.sql must ALSO be added to this
  // migration's inline DDL or fresh and migrated databases drift
  // apart. Same guard pattern as 0015: presence of a v16 column means
  // there is nothing to do.
  const cols = db.prepare(`PRAGMA table_info(affiliations)`).all().map(r => r.name);
  if (cols.includes('reason_detail')) return;

  // --- affiliations: rebuild with 'alumni' in the role CHECK ---
  db.exec(`ALTER TABLE affiliations RENAME TO affiliations_old`);
  for (const idx of [
    'affiliations_org_idx', 'affiliations_person_idx', 'affiliations_family_idx',
    'affiliations_active_idx', 'affiliations_verified_idx',
    'affiliations_active_person_uniq', 'affiliations_active_family_uniq',
  ]) {
    db.exec(`DROP INDEX IF EXISTS ${idx}`);
  }

  db.exec(`
    CREATE TABLE affiliations (
      code             TEXT PRIMARY KEY,
      org_code         TEXT NOT NULL REFERENCES organizations(code) ON DELETE CASCADE,
      person_code      TEXT REFERENCES persons(code)  ON DELETE CASCADE,
      family_code      TEXT REFERENCES families(code) ON DELETE CASCADE,
      role             TEXT NOT NULL DEFAULT 'member',
      started_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ended_at         TEXT,
      reason           TEXT,
      reason_detail    TEXT,
      last_verified_at TEXT,
      notes_ct         BLOB,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (role IN ('registered','parishioner','student','alumni','staff','volunteer','clergy','member','other')),
      CHECK (reason IS NULL OR reason IN ('graduated','transferred','moved','deceased','withdrew','inactive','merge','other')),
      CHECK (
        (person_code IS NOT NULL AND family_code IS NULL)
        OR (person_code IS NULL AND family_code IS NOT NULL)
      )
    )
  `);
  db.exec(`
    INSERT INTO affiliations
        (code, org_code, person_code, family_code, role, started_at, ended_at,
         reason, reason_detail, last_verified_at, notes_ct, created_at, updated_at)
      SELECT code, org_code, person_code, family_code, role, started_at, ended_at,
             CASE
               WHEN reason IS NULL THEN NULL
               WHEN reason IN ('graduated','transferred','moved','deceased','withdrew','inactive','merge','other') THEN reason
               ELSE 'other'
             END,
             CASE
               WHEN reason IS NOT NULL
                AND reason NOT IN ('graduated','transferred','moved','deceased','withdrew','inactive','merge','other') THEN reason
               ELSE NULL
             END,
             last_verified_at, notes_ct, created_at, updated_at
        FROM affiliations_old
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS affiliations_org_idx      ON affiliations (org_code);
    CREATE INDEX IF NOT EXISTS affiliations_person_idx   ON affiliations (person_code);
    CREATE INDEX IF NOT EXISTS affiliations_family_idx   ON affiliations (family_code);
    CREATE INDEX IF NOT EXISTS affiliations_active_idx   ON affiliations (org_code, ended_at);
    CREATE INDEX IF NOT EXISTS affiliations_verified_idx ON affiliations (org_code, last_verified_at);
    CREATE UNIQUE INDEX IF NOT EXISTS affiliations_active_person_uniq
      ON affiliations (org_code, person_code) WHERE ended_at IS NULL AND person_code IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS affiliations_active_family_uniq
      ON affiliations (org_code, family_code) WHERE ended_at IS NULL AND family_code IS NOT NULL;
  `);

  // --- affiliation_verifications: rebuild pointing at the new
  // affiliations table, gaining the `period` participation label ---
  db.exec(`DROP INDEX IF EXISTS affiliation_verifications_affiliation_idx`);
  db.exec(`
    CREATE TABLE affiliation_verifications_new (
      code             TEXT PRIMARY KEY,
      affiliation_code TEXT NOT NULL REFERENCES affiliations(code) ON DELETE CASCADE,
      method           TEXT NOT NULL,
      source           TEXT,
      period           TEXT,
      verified_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      notes_ct         BLOB,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (method IN ('registration','sacrament','liturgy','ministry','giving','communication','connector_sync','attestation','other'))
    )
  `);
  db.exec(`
    INSERT INTO affiliation_verifications_new
        (code, affiliation_code, method, source, period, verified_at, notes_ct, created_at)
      SELECT code, affiliation_code, method, source, NULL, verified_at, notes_ct, created_at
        FROM affiliation_verifications
  `);
  db.exec(`DROP TABLE affiliation_verifications`);
  db.exec(`ALTER TABLE affiliation_verifications_new RENAME TO affiliation_verifications`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS affiliation_verifications_affiliation_idx
      ON affiliation_verifications (affiliation_code, verified_at);
    CREATE INDEX IF NOT EXISTS affiliation_verifications_period_idx
      ON affiliation_verifications (affiliation_code, period);
  `);

  db.exec(`DROP TABLE affiliations_old`);

  const violations = db.prepare(`PRAGMA foreign_key_check(affiliation_verifications)`).all();
  if (violations.length) {
    throw new Error(`migration 0016 left ${violations.length} foreign-key violations`);
  }
};
