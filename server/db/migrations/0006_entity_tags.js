'use strict';

// Migration 0006: per-entity tags on families and persons.
//
// Tags propagate from import-time category/tags onto the entities themselves so
// the directory can be sliced fluidly: "show me parishioners", "show me school
// parents", "show me incoming alumni". Storage is JSON array TEXT; queries use
// json_each() for membership tests.
//
// Auto-tags applied by the import pipeline:
//   category = 'church'  -> persons get 'parishioner'
//   category = 'school'  -> families get 'school-parent';
//                            person grade=8 also gets 'school-alumni-incoming'
// Custom tags supplied with the import are applied on top of the auto-tags.

exports.up = function up(db) {
  const famCols = db.prepare(`PRAGMA table_info(families)`).all().map(r => r.name);
  if (!famCols.includes('tags')) {
    db.exec(`ALTER TABLE families ADD COLUMN tags TEXT`);
  }
  const personCols = db.prepare(`PRAGMA table_info(persons)`).all().map(r => r.name);
  if (!personCols.includes('tags')) {
    db.exec(`ALTER TABLE persons ADD COLUMN tags TEXT`);
  }
  if (!personCols.includes('grade')) {
    db.exec(`ALTER TABLE persons ADD COLUMN grade TEXT`);
  }
};
