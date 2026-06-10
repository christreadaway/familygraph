'use strict';

// Migration 0014: Organizations (parish / school) and dated, verifiable
// affiliations.
//
// The model decision behind this migration: community membership is
// temporal. Kids graduate, families move, people die or stop attending.
// So "parish, school, or both" is never a stored flag — it's a query
// over affiliation rows with started_at / ended_at, exactly the way
// `memberships` already treats household composition. Leaving a
// community is an end-date with a reason, not a delete.
//
// Three tables come online:
//
// 1. `organizations` — first-class entities with their own `org_` codes.
//    Today `school_contexts.school_id` is a bare TEXT id minted by the
//    external school app; organizations give parishes and schools a real
//    FamilyGraph identity. `diocese_code` is a soft FK (same posture as
//    `eim_certifications.diocese_code`).
//
// 2. `affiliations` — links a person OR a family (exactly one, the
//    `ministry_assignments` pattern) to an organization with a role and
//    a lifespan. Parish registration is family-level by convention;
//    school enrollment is person-level. `last_verified_at` is the
//    rolling freshness marker: verification refreshes confidence, never
//    gates existence. An unverified affiliation goes visibly stale on
//    the dashboard; it never auto-expires.
//
// 3. `affiliation_verifications` — append-only trail of WHY we believe
//    an affiliation is alive. Methods mirror how parishes actually see
//    activity: a registration form, a sacrament, liturgy or ministry
//    participation, giving, communications still landing (envelopes,
//    mailings, emails that don't bounce), a connector sync that returned
//    the record, or an explicit operator attestation. Most verification
//    should be passive (harvested from activity FG already sees), so
//    each row records its source. Absence works the same way in
//    reverse: a family that stops giving, stops participating, and
//    stops receiving mail simply stops accruing verification rows, and
//    the staleness report surfaces them for a human to confirm.

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      code         TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      kind         TEXT NOT NULL,
      diocese_code TEXT,
      notes_ct     BLOB,
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (kind IN ('parish','school','other')),
      CHECK (status IN ('active','archived'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS organizations_kind_name_active_uniq
      ON organizations (kind, name) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS organizations_kind_idx       ON organizations (kind);
    CREATE INDEX IF NOT EXISTS organizations_status_idx     ON organizations (status);
    CREATE INDEX IF NOT EXISTS organizations_updated_at_idx ON organizations (updated_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS affiliations (
      code             TEXT PRIMARY KEY,
      org_code         TEXT NOT NULL REFERENCES organizations(code) ON DELETE CASCADE,
      person_code      TEXT REFERENCES persons(code)  ON DELETE CASCADE,
      family_code      TEXT REFERENCES families(code) ON DELETE CASCADE,
      role             TEXT NOT NULL DEFAULT 'member',
      started_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ended_at         TEXT,
      reason           TEXT,
      last_verified_at TEXT,
      notes_ct         BLOB,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (role IN ('registered','parishioner','student','staff','volunteer','clergy','member','other')),
      CHECK (
        (person_code IS NOT NULL AND family_code IS NULL)
        OR (person_code IS NULL AND family_code IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS affiliations_org_idx    ON affiliations (org_code);
    CREATE INDEX IF NOT EXISTS affiliations_person_idx ON affiliations (person_code);
    CREATE INDEX IF NOT EXISTS affiliations_family_idx ON affiliations (family_code);
    CREATE INDEX IF NOT EXISTS affiliations_active_idx ON affiliations (org_code, ended_at);
    CREATE INDEX IF NOT EXISTS affiliations_verified_idx ON affiliations (org_code, last_verified_at);
    CREATE UNIQUE INDEX IF NOT EXISTS affiliations_active_person_uniq
      ON affiliations (org_code, person_code) WHERE ended_at IS NULL AND person_code IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS affiliations_active_family_uniq
      ON affiliations (org_code, family_code) WHERE ended_at IS NULL AND family_code IS NOT NULL;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS affiliation_verifications (
      code             TEXT PRIMARY KEY,
      affiliation_code TEXT NOT NULL REFERENCES affiliations(code) ON DELETE CASCADE,
      method           TEXT NOT NULL,
      source           TEXT,
      verified_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      notes_ct         BLOB,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (method IN ('registration','sacrament','liturgy','ministry','giving','communication','connector_sync','attestation','other'))
    );
    CREATE INDEX IF NOT EXISTS affiliation_verifications_affiliation_idx
      ON affiliation_verifications (affiliation_code, verified_at);
  `);
};
