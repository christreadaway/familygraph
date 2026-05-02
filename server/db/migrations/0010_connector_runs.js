'use strict';

// Migration 0010: live API connectors.
//
//  - connector_runs: per-sync row, mirrors import_runs but specific to
//    scheduled / manual / cli connector activity. Each row links back to
//    the import_runs row produced by the sync (when one was produced).
//  - conflicts.metadata: JSON column for extra annotations the resolver
//    couldn't fit in the existing reasons[] array. Cross-source conflicts
//    use this to carry { cross_source: true, sources: ['facts_api', ...] }
//    so the dashboard can filter to "school + parish" pairs without a new
//    column per future flag.

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_runs (
      code           TEXT PRIMARY KEY,
      connector      TEXT NOT NULL,
      trigger        TEXT NOT NULL,
      status         TEXT NOT NULL,
      started_at     INTEGER NOT NULL,
      ended_at       INTEGER,
      import_run     TEXT,
      reason         TEXT,
      metadata       TEXT,
      CHECK (status IN ('running','ok','error','timeout'))
    );
    CREATE INDEX IF NOT EXISTS connector_runs_connector_idx ON connector_runs (connector);
    CREATE INDEX IF NOT EXISTS connector_runs_status_idx    ON connector_runs (status);
    CREATE INDEX IF NOT EXISTS connector_runs_started_idx   ON connector_runs (started_at);
  `);

  const conflictCols = db.prepare(`PRAGMA table_info(conflicts)`).all().map(r => r.name);
  if (!conflictCols.includes('metadata')) {
    db.exec(`ALTER TABLE conflicts ADD COLUMN metadata TEXT`);
  }

  // PRD §4.2: imports log gains a `trigger` field — `scheduled`, `manual`,
  // `cli`, or `file` — so the operator can tell at a glance whether a run
  // was a CSV upload vs. a connector sync vs. a CLI invocation. Existing
  // file-based runs (pre-0010) are tagged `file` retroactively so the
  // column never displays NULL.
  const importCols = db.prepare(`PRAGMA table_info(import_runs)`).all().map(r => r.name);
  if (!importCols.includes('trigger')) {
    db.exec(`ALTER TABLE import_runs ADD COLUMN trigger TEXT`);
    db.exec(`UPDATE import_runs SET trigger = 'file' WHERE trigger IS NULL`);
  }
};
