'use strict';

// Migration 0013: Per-school consent overrides, diocesan EIM source of
// truth, and the entity-change log (the foundation for restorable
// "deletions").
//
// This migration is additive: existing columns and rows continue to
// behave as before. Three new mechanisms come online:
//
// 1. `person_consent_overrides` — per-school override of the identity-
//    level consent flags in `person_consents`. The effective consent for
//    a (person, school) pair is `override-or-base`. A school can express
//    "Annie's parents said no photos at school events" without
//    affecting her photo consent for the parish, the diocese, etc.
//
// 2. `dioceses` table + `eim_certifications.diocese_code` /
//    `diocese_record_id`. The diocese is the system of record for EIM;
//    FamilyGraph caches what it knows. Each cached cert points back at
//    the issuing diocese plus the diocesan record id so the operator
//    can reconcile with a paper or vendor record.
//
// 3. `entity_changes` — append-only change log capturing before/after
//    snapshots on every meaningful write. This is what lets a soft-
//    archived person be reinstated cleanly: we look up the most recent
//    pre-archive snapshot, flip status back, and emit a change row that
//    records the restoration. Encrypted columns stay in ciphertext form
//    in the snapshot (we serialise the row as-is, so the BLOB columns
//    survive as base64-encoded strings rather than plaintext).
//
// New columns on existing tables:
//   eim_certifications.diocese_code        TEXT  Soft FK to dioceses.code.
//                                                Soft because we want a
//                                                cert row to survive even
//                                                if the diocese row gets
//                                                archived for any reason.
//   eim_certifications.diocese_record_id   TEXT  External id issued by
//                                                the diocese (the vendor
//                                                record or paper form
//                                                number). Operator-
//                                                visible only.
//
// `persons.status` and `families.status` already include 'archived'.
// This migration doesn't change them, but the new /v1 archive/reinstate
// surface uses them as the soft-delete switch.

exports.up = function up(db) {
  // --- dioceses ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS dioceses (
      code              TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      region            TEXT,
      contact_url       TEXT,
      eim_program_name  TEXT,
      eim_renewal_years INTEGER,
      notes_ct          BLOB,
      status            TEXT NOT NULL DEFAULT 'active',
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (status IN ('active','archived'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS dioceses_name_active_uniq
      ON dioceses (name) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS dioceses_status_idx ON dioceses (status);
    CREATE INDEX IF NOT EXISTS dioceses_updated_at_idx ON dioceses (updated_at);
  `);

  // --- eim_certifications: diocese link ---
  const certCols = db.prepare(`PRAGMA table_info(eim_certifications)`).all().map(r => r.name);
  if (!certCols.includes('diocese_code')) {
    db.exec(`ALTER TABLE eim_certifications ADD COLUMN diocese_code TEXT`);
  }
  if (!certCols.includes('diocese_record_id')) {
    db.exec(`ALTER TABLE eim_certifications ADD COLUMN diocese_record_id TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS eim_certifications_diocese_idx ON eim_certifications (diocese_code)`);

  // --- person_consent_overrides ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_consent_overrides (
      person_code        TEXT NOT NULL REFERENCES persons(code) ON DELETE CASCADE,
      school_id          TEXT NOT NULL,
      photo_consent      TEXT,
      directory_listing  TEXT,
      updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (person_code, school_id),
      CHECK (photo_consent IS NULL OR photo_consent IN ('allow','group_only','deny')),
      CHECK (directory_listing IS NULL OR directory_listing IN ('allow','deny'))
    );
    CREATE INDEX IF NOT EXISTS person_consent_overrides_updated_at_idx
      ON person_consent_overrides (updated_at);
    CREATE INDEX IF NOT EXISTS person_consent_overrides_school_idx
      ON person_consent_overrides (school_id);
  `);

  // --- entity_changes ---
  // before_json / after_json hold the full row serialised as JSON.
  // Encrypted (ct) columns serialise as base64 strings; the dataKey is
  // still required to decrypt. The snapshot is sized at most a few
  // kilobytes per row (a person has maybe a dozen ct fields); for very
  // large rows we cap the serialiser's output to MAX_SNAPSHOT_BYTES in
  // the application layer.
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_changes (
      code          TEXT PRIMARY KEY,
      entity_kind   TEXT NOT NULL,
      entity_code   TEXT NOT NULL,
      operation     TEXT NOT NULL,
      before_json   TEXT,
      after_json    TEXT,
      actor         TEXT NOT NULL DEFAULT 'system',
      actor_kind    TEXT,
      request_id    TEXT,
      related_codes TEXT,
      reason        TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS entity_changes_entity_idx     ON entity_changes (entity_kind, entity_code);
    CREATE INDEX IF NOT EXISTS entity_changes_created_at_idx ON entity_changes (created_at);
    CREATE INDEX IF NOT EXISTS entity_changes_operation_idx  ON entity_changes (operation);
    CREATE INDEX IF NOT EXISTS entity_changes_actor_idx      ON entity_changes (actor);
  `);
};
