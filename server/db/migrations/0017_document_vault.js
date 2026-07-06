'use strict';

// Migration 0017: Document Vault + health safety flags (DOCUMENT_VAULT).
//
// FamilyGraph becomes the authoritative ACCESS GATE for sensitive child
// documents (sacramental records, learning-accommodation plans, health /
// allergy records). Bytes live encrypted at rest in FG and surface to
// The partner app JUST-IN-TIME via the existing outbox/inbox + sync transport
// ("no open doors" — FG opens no inbound ports). The partner app never holds the bytes;
// it asks FG for them per fetch and FG makes the policy decision + audits it.
//
// Two tables come online:
//
// 1. `documents` — the vault. The file bytes and the title are encrypted at
//    rest with the local dataKey (AES-256-GCM, the crypto/encryption.js BLOB
//    layout). `content_ct` is at-rest encryption, NOT the wire envelope; when
//    a fetch is authorized the bytes are RE-SEALED with the pairing envelope
//    key for transport. `code` is an opaque `doc_<hex>` ref that is safe to
//    show the partner app. `policy_key` is derived from kind/subtype and drives the access
//    matrix. No document bytes and no title ever sit in a plaintext column.
//
// 2. `health_safety` — the mirrored life-safety summary (allergens, severity,
//    medication, emergency contact) keyed by person. Every field is encrypted
//    at rest (`_ct`). This is the summary that rides INSIDE the already-sealed
//    sync `changes` envelope to the partner app on each check-in, released regardless of
//    directory/photo consent because it is life-safety information.
//
// `updated_at` on both tables feeds the changed-feed so document + safety
// changes flow to the partner app alongside person/household changes.

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      code          TEXT PRIMARY KEY,
      person_code   TEXT NOT NULL,
      kind          TEXT NOT NULL,
      subtype       TEXT NOT NULL,
      title_ct      BLOB,
      content_ct    BLOB NOT NULL,
      content_type  TEXT NOT NULL,
      byte_size     INTEGER NOT NULL,
      source        TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      policy_key    TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (kind IN ('sacramental','accommodation','health','other')),
      CHECK (status IN ('active','archived'))
    );
    CREATE INDEX IF NOT EXISTS documents_person_idx ON documents (person_code, status);
    CREATE INDEX IF NOT EXISTS documents_updated_idx ON documents (updated_at);
    CREATE INDEX IF NOT EXISTS documents_policy_idx ON documents (policy_key);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS health_safety (
      person_code          TEXT PRIMARY KEY,
      allergens_ct         BLOB,
      severity_ct          BLOB,
      medication_ct        BLOB,
      emergency_contact_ct BLOB,
      status               TEXT NOT NULL DEFAULT 'active',
      created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (status IN ('active','cleared'))
    );
    CREATE INDEX IF NOT EXISTS health_safety_updated_idx ON health_safety (updated_at);
  `);
};
