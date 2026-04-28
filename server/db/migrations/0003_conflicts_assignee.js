'use strict';

// Migration 0003: add assignment columns to conflicts.
// Idempotent — safe to run on a database whose bootstrap schema already
// declared these columns (PRAGMA-checked before each ALTER).

exports.up = function up(db) {
  const cols = db.prepare(`PRAGMA table_info(conflicts)`).all().map(r => r.name);
  if (!cols.includes('assigned_to')) {
    db.exec(`ALTER TABLE conflicts ADD COLUMN assigned_to TEXT`);
  }
  if (!cols.includes('assigned_at')) {
    db.exec(`ALTER TABLE conflicts ADD COLUMN assigned_at TEXT`);
  }
  if (!cols.includes('assignment_expires_at')) {
    db.exec(`ALTER TABLE conflicts ADD COLUMN assignment_expires_at TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS conflicts_assigned_to_idx ON conflicts (assigned_to)`);
  db.exec(`CREATE INDEX IF NOT EXISTS conflicts_assignment_exp_idx ON conflicts (assignment_expires_at)`);
};
