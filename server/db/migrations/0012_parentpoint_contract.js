'use strict';

// Migration 0012: ParentPoint × FamilyGraph integration contract.
//
// Adds the schema FamilyGraph needs to expose the read / write surface
// described in FAMILYGRAPH_INTEGRATION.md (v0.1). All additions are
// additive — existing rows keep working, and the contract API gracefully
// degrades on data that was created before this migration ran.
//
// New columns on existing tables:
//   persons.kind                  TEXT  'adult' | 'child' | NULL
//                                       Populated when ParentPoint POSTs a
//                                       new person and PP knows; NULL for
//                                       pre-contract rows (the operator can
//                                       hand-edit later).
//   persons.preferred_name_ct     BLOB  AES-256-GCM ciphertext. Surfaced as
//                                       `preferredName` in the PP person
//                                       object so messaging can use "Mandy"
//                                       instead of "Amanda".
//   families.primary_contact_person_code  TEXT  Soft pointer at the
//                                                 household's primary
//                                                 contact (the household
//                                                 object's
//                                                 `primaryContactPersonId`).
//                                                 Soft because a merge can
//                                                 retire the code; the API
//                                                 falls back to the first
//                                                 active adult member.
//   families.communication_language       TEXT  ISO-639-1 short code. Default
//                                                 'en'. Surfaced as
//                                                 `communicationLanguage`.
//   memberships.relation_label    TEXT  'mother' | 'father' | 'step_parent'
//                                       | 'guardian' | 'grandparent'
//                                       | 'other' | 'child' | NULL
//                                       Finer-grained label than the existing
//                                       `role` bucket; lets PP's household
//                                       members[] round-trip without losing
//                                       the mother-vs-father distinction.
//   phones.e164                   TEXT  Normalized to +<country><digits>
//                                       (no spaces or punctuation). Provides
//                                       a deterministic write target and
//                                       lets PP queries match phone numbers
//                                       across sources cleanly.
//   phones.sms_consent            INTEGER NOT NULL DEFAULT 0  Per-phone SMS
//                                       opt-in flag. Surfaced inside the
//                                       phones[] array of the person object.
//
// New tables:
//   person_consents               Per-person photo + directory consent. One
//                                 row per person, lazy-created on first set.
//   eim_certifications            History of EIM certs per person. The
//                                 existing persons.eim_* columns continue to
//                                 hold the "current" cert (queried by the
//                                 expiring-soon view); this table preserves
//                                 the audit trail of every renewal.
//   school_contexts               PP-pushed enrichment snapshot keyed by
//                                 (school_id, person_code). One row per
//                                 (school, person) pair; the doc says PP
//                                 overwrites on every POST so we model that
//                                 as an upsert.
//   pp_webhook_subscriptions      Subscribed PP cloud-function endpoints.
//                                 Body signed with HMAC-SHA256 over the
//                                 secret.
//   pp_webhook_deliveries         Per-attempt delivery rows with exponential
//                                 backoff (mirrors the notifications queue).
//   pp_idempotency_keys           X-Request-Id dedupe for inbound PP writes.
//                                 Per §7.2: "FamilyGraph dedupes within 24h
//                                 so retries on flaky networks don't
//                                 double-create."
//
// The contract API also needs to answer `GET /v1/persons/changed?since=`
// efficiently. We reuse `persons.updated_at` (already indexed implicitly via
// the primary-key scan; we add a real index here) and bump it whenever a
// linked email / phone / consent changes via the contract write path. Same
// for `families.updated_at` covering household changes.

exports.up = function up(db) {
  // --- persons additions ---
  const personCols = db.prepare(`PRAGMA table_info(persons)`).all().map(r => r.name);
  if (!personCols.includes('kind')) {
    db.exec(`ALTER TABLE persons ADD COLUMN kind TEXT`);
  }
  if (!personCols.includes('preferred_name_ct')) {
    db.exec(`ALTER TABLE persons ADD COLUMN preferred_name_ct BLOB`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS persons_kind_idx ON persons (kind)`);
  db.exec(`CREATE INDEX IF NOT EXISTS persons_updated_at_idx ON persons (updated_at)`);

  // --- families additions ---
  const familyCols = db.prepare(`PRAGMA table_info(families)`).all().map(r => r.name);
  if (!familyCols.includes('primary_contact_person_code')) {
    db.exec(`ALTER TABLE families ADD COLUMN primary_contact_person_code TEXT`);
  }
  if (!familyCols.includes('communication_language')) {
    db.exec(`ALTER TABLE families ADD COLUMN communication_language TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS families_updated_at_idx ON families (updated_at)`);

  // --- memberships additions ---
  const membershipCols = db.prepare(`PRAGMA table_info(memberships)`).all().map(r => r.name);
  if (!membershipCols.includes('relation_label')) {
    db.exec(`ALTER TABLE memberships ADD COLUMN relation_label TEXT`);
  }

  // --- phones additions ---
  const phoneCols = db.prepare(`PRAGMA table_info(phones)`).all().map(r => r.name);
  if (!phoneCols.includes('e164')) {
    db.exec(`ALTER TABLE phones ADD COLUMN e164 TEXT`);
  }
  if (!phoneCols.includes('sms_consent')) {
    db.exec(`ALTER TABLE phones ADD COLUMN sms_consent INTEGER NOT NULL DEFAULT 0`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS phones_e164_idx ON phones (e164)`);

  // --- person_consents ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_consents (
      person_code        TEXT PRIMARY KEY REFERENCES persons(code) ON DELETE CASCADE,
      photo_consent      TEXT NOT NULL DEFAULT 'allow',
      directory_listing  TEXT NOT NULL DEFAULT 'allow',
      updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (photo_consent IN ('allow','group_only','deny')),
      CHECK (directory_listing IN ('allow','deny'))
    );
    CREATE INDEX IF NOT EXISTS person_consents_updated_at_idx ON person_consents (updated_at);
  `);

  // --- eim_certifications history ---
  // Keeps the per-renewal trail; persons.eim_* still holds the "current" cert
  // pointer so the existing dashboard queries don't change shape. Notes are
  // encrypted because they often name a diocese or vendor.
  db.exec(`
    CREATE TABLE IF NOT EXISTS eim_certifications (
      code              TEXT PRIMARY KEY,
      person_code       TEXT NOT NULL REFERENCES persons(code) ON DELETE CASCADE,
      status            TEXT NOT NULL,
      completed_on      TEXT,
      expires_on        TEXT,
      source            TEXT,
      notes_ct          BLOB,
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (status IN ('pending','certified','expired'))
    );
    CREATE INDEX IF NOT EXISTS eim_certifications_person_idx     ON eim_certifications (person_code);
    CREATE INDEX IF NOT EXISTS eim_certifications_expires_on_idx ON eim_certifications (expires_on);
  `);

  // --- school_contexts ---
  // PP's enrichment snapshot. Unique on (person_code, school_id) — PP
  // overwrites on every POST (§7.3). Activities + allergies are JSON arrays
  // because the shape is fully controlled by PP; FG just stores and serves.
  db.exec(`
    CREATE TABLE IF NOT EXISTS school_contexts (
      code                              TEXT PRIMARY KEY,
      person_code                       TEXT NOT NULL REFERENCES persons(code) ON DELETE CASCADE,
      school_id                         TEXT NOT NULL,
      school_year                       TEXT,
      grade                             TEXT,
      classroom_id                      TEXT,
      classroom_name                    TEXT,
      homeroom_teacher_person_code      TEXT,
      activities                        TEXT,
      allergies                         TEXT,
      snapshot_at                       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      source_app                        TEXT,
      created_at                        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at                        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS school_contexts_person_school_uniq
      ON school_contexts (person_code, school_id);
    CREATE INDEX IF NOT EXISTS school_contexts_school_idx     ON school_contexts (school_id);
    CREATE INDEX IF NOT EXISTS school_contexts_updated_at_idx ON school_contexts (updated_at);
  `);

  // --- pp_webhook_subscriptions ---
  // Secret stored as ciphertext: even though it's symmetric and primarily
  // used for HMAC computation on our side, the file-leak threat model says
  // any rotating secret should be encrypted at rest.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pp_webhook_subscriptions (
      code               TEXT PRIMARY KEY,
      url                TEXT NOT NULL,
      secret_ct          BLOB,
      events             TEXT NOT NULL DEFAULT '*',
      school_hint        TEXT,
      enabled            INTEGER NOT NULL DEFAULT 1,
      created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_delivered_at  TEXT,
      last_status        TEXT,
      last_error         TEXT
    );
    CREATE INDEX IF NOT EXISTS pp_webhook_subs_enabled_idx ON pp_webhook_subscriptions (enabled);
  `);

  // --- pp_webhook_deliveries ---
  // Same shape as notifications: pending rows get picked up by the
  // dispatcher, success flips to 'sent', failure backs off exponentially
  // until MAX_ATTEMPTS, then 'failed'.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pp_webhook_deliveries (
      code               TEXT PRIMARY KEY,
      subscription_code  TEXT NOT NULL REFERENCES pp_webhook_subscriptions(code) ON DELETE CASCADE,
      event              TEXT NOT NULL,
      person_code        TEXT,
      family_code        TEXT,
      payload            TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'pending',
      attempts           INTEGER NOT NULL DEFAULT 0,
      next_attempt_at    TEXT,
      last_error         TEXT,
      provider_status    INTEGER,
      created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      sent_at            TEXT,
      CHECK (status IN ('pending','sent','failed','cancelled'))
    );
    CREATE INDEX IF NOT EXISTS pp_deliveries_sub_idx           ON pp_webhook_deliveries (subscription_code);
    CREATE INDEX IF NOT EXISTS pp_deliveries_status_idx        ON pp_webhook_deliveries (status);
    CREATE INDEX IF NOT EXISTS pp_deliveries_next_attempt_idx  ON pp_webhook_deliveries (status, next_attempt_at);
  `);

  // --- pp_idempotency_keys ---
  // We cache the response by (request_id, method, path) for 24h. The body
  // is small JSON; we store it inline. Sweep happens lazily on each lookup
  // and via the daily audit sweep loop.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pp_idempotency_keys (
      request_id    TEXT NOT NULL,
      method        TEXT NOT NULL,
      path          TEXT NOT NULL,
      response_code INTEGER NOT NULL,
      response_body TEXT,
      expires_at    TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (request_id, method, path)
    );
    CREATE INDEX IF NOT EXISTS pp_idempotency_expires_idx ON pp_idempotency_keys (expires_at);
  `);
};
