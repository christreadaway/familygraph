'use strict';

// Migration 0007: track rows skipped during an import because no person or
// family-level data could be extracted from them. Surfacing this number is
// what lets the dashboard tell the operator "we saw 370 rows but only 12
// produced anything — your column mapping is wrong."

exports.up = function up(db) {
  const cols = db.prepare(`PRAGMA table_info(import_runs)`).all().map(r => r.name);
  if (!cols.includes('rows_skipped_blank')) {
    db.exec(`ALTER TABLE import_runs ADD COLUMN rows_skipped_blank INTEGER NOT NULL DEFAULT 0`);
  }
};
