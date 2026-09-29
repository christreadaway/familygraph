'use strict';

// Migration 0021: grandparent links and alumni class year (2026-09-29).
//
// 1. relationships.kind gains 'grandparent_of' / 'grandchild_of'. SQLite
//    cannot alter a CHECK constraint, so a database created before this
//    rebuilds the table (same columns, same rows, same indexes). A database
//    whose schema.sql already carries the new kinds is left alone.
// 2. affiliations.class_year: optional graduating class (school alumni,
//    mostly). Nullable integer, 1900-2100, validated in
//    server/identity/organizations.js.
module.exports.up = function up(db) {
  const rel = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'relationships'`).get();
  if (rel && !rel.sql.includes('grandparent_of')) {
    db.exec(`
      CREATE TABLE relationships_new (
        code         TEXT PRIMARY KEY,
        from_code    TEXT NOT NULL,
        to_code      TEXT NOT NULL,
        kind         TEXT NOT NULL,
        detail       TEXT,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK (kind IN (
          'parent_of','child_of','spouse_of','godparent_of','sibling_of',
          'related_household','custody_of','guardian_of','other',
          'grandparent_of','grandchild_of'
        ))
      );
      INSERT INTO relationships_new (code, from_code, to_code, kind, detail, created_at, updated_at)
        SELECT code, from_code, to_code, kind, detail, created_at, updated_at FROM relationships;
      DROP TABLE relationships;
      ALTER TABLE relationships_new RENAME TO relationships;
      CREATE INDEX IF NOT EXISTS relationships_from_idx ON relationships (from_code);
      CREATE INDEX IF NOT EXISTS relationships_to_idx   ON relationships (to_code);
      CREATE INDEX IF NOT EXISTS relationships_kind_idx ON relationships (kind);
    `);
  }
  const cols = db.prepare(`PRAGMA table_info(affiliations)`).all().map(c => c.name);
  if (!cols.includes('class_year')) {
    db.exec(`ALTER TABLE affiliations ADD COLUMN class_year INTEGER`);
  }
};
