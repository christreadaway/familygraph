'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const migrationsRunner = require('./migrations');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
// Schema versions:
//   1 — bootstrap (families, persons, contacts, memberships, etc.)
//   2 — api_keys table.
//   3 — conflicts.assigned_to + assigned_at + assignment_expires_at.
//   4 — notifications queue + conflicts.reminder_sent_at.
//   5 — source_records.category/tags/import_run_code + import_runs table.
//   6 — entity tags on families and persons + persons.grade.
//   7 — import_runs.rows_skipped_blank.
//   8 — conflicts.resolution_notes + decided_by_rule (sticky decisions).
//   9 — persons.employer / title / do_not_contact / not_living_together.
//  10 — connector_runs table + conflicts.metadata + import_runs.trigger.
//  11 — persons.eim_* fields + ministries / ministry_assignments tables.
//  12 — Integration contract: persons.kind / preferred_name_ct,
//       families.primary_contact_person_code / communication_language,
//       memberships.relation_label, phones.e164 / sms_consent, plus
//       person_consents / eim_certifications / school_contexts /
//       webhook_subscriptions / webhook_deliveries /
//       idempotency_keys tables.
//  13 — Per-school consent overrides, diocesan EIM source of truth,
//       and the entity_changes log that lets soft-archived persons
//       and households be reinstated.
//  14 — organizations (parish/school) + dated affiliations with the
//       rolling last_verified_at marker + affiliation_verifications trail.
//  15 — staff accounts: organizations domain-verification columns +
//       admin_accounts / admin_login_tokens / admin_sessions.
const SCHEMA_VERSION = 15;

function open(dbPath, options = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath, { fileMustExist: false, ...options });
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

function migrate(db) {
  // Apply the bootstrap schema (idempotent, IF NOT EXISTS everywhere).
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  // Run incremental migrations on top of the bootstrap schema. The runner
  // tracks `schema_version` and is itself idempotent.
  migrationsRunner.run(db, MIGRATIONS_DIR);
  const cur = migrationsRunner.currentVersion(db);
  if (cur < SCHEMA_VERSION) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  }
  return migrationsRunner.currentVersion(db);
}

function init(dbPath) {
  const db = open(dbPath);
  migrate(db);
  // Seed the built-in profiles. Idempotent; INSERT OR IGNORE.
  const profiles = require('../identity/profiles');
  profiles.ensureBuiltins(db);
  return db;
}

module.exports = { open, migrate, init, SCHEMA_VERSION };
