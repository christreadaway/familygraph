'use strict';

// Migration 0008: capture operator's free-form note on a conflict resolution.
// The conflict status (merged | rejected | dismissed) records WHAT was
// decided; resolution_notes records WHY. Surfaced in audit log and family
// detail history so a future operator can see "Sarah dismissed this in
// March — same name, different DOB, confirmed via parish records."

exports.up = function up(db) {
  const cols = db.prepare(`PRAGMA table_info(conflicts)`).all().map(r => r.name);
  if (!cols.includes('resolution_notes')) {
    db.exec(`ALTER TABLE conflicts ADD COLUMN resolution_notes TEXT`);
  }
  if (!cols.includes('decided_by_rule')) {
    db.exec(`ALTER TABLE conflicts ADD COLUMN decided_by_rule TEXT`);
  }
};
