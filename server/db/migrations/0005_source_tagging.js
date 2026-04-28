'use strict';

// Migration 0005: source-record tagging (category + tags + import_run_code)
// plus the new import_runs summary table. Idempotent.

exports.up = function up(db) {
  const cols = db.prepare(`PRAGMA table_info(source_records)`).all().map(r => r.name);
  if (!cols.includes('category')) {
    db.exec(`ALTER TABLE source_records ADD COLUMN category TEXT`);
  }
  if (!cols.includes('tags')) {
    db.exec(`ALTER TABLE source_records ADD COLUMN tags TEXT`);
  }
  if (!cols.includes('import_run_code')) {
    db.exec(`ALTER TABLE source_records ADD COLUMN import_run_code TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS source_records_category_idx ON source_records (category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS source_records_import_run_idx ON source_records (import_run_code)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS import_runs (
      code                 TEXT PRIMARY KEY,
      source               TEXT NOT NULL,
      source_ref           TEXT,
      category             TEXT,
      tags                 TEXT,
      rows                 INTEGER NOT NULL DEFAULT 0,
      families_created     INTEGER NOT NULL DEFAULT 0,
      families_attached    INTEGER NOT NULL DEFAULT 0,
      persons_created      INTEGER NOT NULL DEFAULT 0,
      persons_attached     INTEGER NOT NULL DEFAULT 0,
      persons_enqueued     INTEGER NOT NULL DEFAULT 0,
      conflicts_opened     INTEGER NOT NULL DEFAULT 0,
      addresses_attached   INTEGER NOT NULL DEFAULT 0,
      emails_attached      INTEGER NOT NULL DEFAULT 0,
      phones_attached      INTEGER NOT NULL DEFAULT 0,
      memberships_opened   INTEGER NOT NULL DEFAULT 0,
      memberships_ended    INTEGER NOT NULL DEFAULT 0,
      actor                TEXT,
      created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS import_runs_created_at_idx ON import_runs (created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS import_runs_category_idx ON import_runs (category)`);
};
