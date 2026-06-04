'use strict';

// Migration 0009: rich profile fields, vendored from the upstream identity engine's contacts
// table. These are person-level details that matter for Catholic
// institutional workflows but didn't make it into the v1 person schema:
//
//   - employer / title         — donor research, parish directory listings
//   - do_not_contact + reason  — compliance flag, must propagate to every
//                                outbound channel
//   - not_living_together      — flag for custody-aware messaging so we
//                                don't address mail to "Mom and Dad" when
//                                they're divorced
//
// Stored as ciphertext like other PII columns. The flag fields are stored
// as plaintext INTEGER (0/1) since they're not PII themselves.

exports.up = function up(db) {
  const cols = db.prepare(`PRAGMA table_info(persons)`).all().map(r => r.name);
  if (!cols.includes('employer_ct')) {
    db.exec(`ALTER TABLE persons ADD COLUMN employer_ct BLOB`);
  }
  if (!cols.includes('title_ct')) {
    db.exec(`ALTER TABLE persons ADD COLUMN title_ct BLOB`);
  }
  if (!cols.includes('do_not_contact')) {
    db.exec(`ALTER TABLE persons ADD COLUMN do_not_contact INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.includes('do_not_contact_reason_ct')) {
    db.exec(`ALTER TABLE persons ADD COLUMN do_not_contact_reason_ct BLOB`);
  }
  if (!cols.includes('not_living_together')) {
    db.exec(`ALTER TABLE persons ADD COLUMN not_living_together INTEGER NOT NULL DEFAULT 0`);
  }
};
