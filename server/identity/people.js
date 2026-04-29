'use strict';

const enc = require('../crypto/encryption');
const { newCode, isValidCode } = require('../crypto/identifiers');
const aliases = require('./aliases');

function row2person(row, secrets, { includePii }) {
  if (!row) return null;
  let tags = [];
  if (row.tags) {
    try { const arr = JSON.parse(row.tags); if (Array.isArray(arr)) tags = arr; } catch (_) { /* ignore */ }
  }
  const base = {
    code: row.code,
    status: row.status,
    merged_into: row.merged_into,
    tags,
    grade: row.grade || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (!includePii) return base;
  return {
    ...base,
    given_name: enc.decrypt(secrets, row.given_name_ct),
    family_name: enc.decrypt(secrets, row.family_name_ct),
    middle_name: enc.decrypt(secrets, row.middle_name_ct),
    prefix: enc.decrypt(secrets, row.prefix_ct),
    suffix: enc.decrypt(secrets, row.suffix_ct),
    display_name: enc.decrypt(secrets, row.display_name_ct),
    date_of_birth: enc.decrypt(secrets, row.date_of_birth_ct),
    gender: enc.decrypt(secrets, row.gender_ct),
    notes: enc.decrypt(secrets, row.notes_ct),
  };
}

function buildDisplayName(input) {
  return [input.prefix, input.given_name, input.middle_name, input.family_name, input.suffix]
    .filter(Boolean)
    .map(s => String(s).trim())
    .filter(Boolean)
    .join(' ');
}

function create(db, secrets, input) {
  const code = newCode('person');
  const display = input.display_name || buildDisplayName(input);
  const stmt = db.prepare(
    `INSERT INTO persons (
       code, given_name_ct, family_name_ct, middle_name_ct, prefix_ct, suffix_ct,
       display_name_ct, given_name_hash, family_name_hash,
       date_of_birth_ct, gender_ct, notes_ct
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    code,
    enc.encrypt(secrets, input.given_name),
    enc.encrypt(secrets, input.family_name),
    enc.encrypt(secrets, input.middle_name),
    enc.encrypt(secrets, input.prefix),
    enc.encrypt(secrets, input.suffix),
    enc.encrypt(secrets, display),
    enc.hmac(secrets, enc.normalizeName(input.given_name)),
    enc.hmac(secrets, enc.normalizeName(input.family_name)),
    enc.encrypt(secrets, input.date_of_birth),
    enc.encrypt(secrets, input.gender),
    enc.encrypt(secrets, input.notes)
  );
  return code;
}

function get(db, secrets, code, opts = {}) {
  if (!isValidCode(code, 'person')) return null;
  const target = aliases.resolveAlias(db, code);
  const row = db.prepare('SELECT * FROM persons WHERE code = ?').get(target);
  return row2person(row, secrets, { includePii: !!opts.includePii });
}

function list(db, secrets, { limit = 50, status = 'active', includePii = false } = {}) {
  const rows = db
    .prepare(`SELECT * FROM persons WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
    .all(status, Math.max(1, Math.min(1000, Number(limit) || 50)));
  return rows.map(r => row2person(r, secrets, { includePii }));
}

function findByName(db, secrets, given, family) {
  const gh = enc.hmac(secrets, enc.normalizeName(given));
  const fh = enc.hmac(secrets, enc.normalizeName(family));
  if (!gh || !fh) return [];
  return db
    .prepare(
      `SELECT * FROM persons WHERE status = 'active' AND given_name_hash = ? AND family_name_hash = ?`
    )
    .all(gh, fh)
    .map(r => row2person(r, secrets, { includePii: true }));
}

function update(db, secrets, code, patch) {
  const target = aliases.resolveAlias(db, code);
  const existing = db.prepare('SELECT * FROM persons WHERE code = ?').get(target);
  if (!existing) return null;
  const merged = {
    given_name: 'given_name' in patch ? patch.given_name : enc.decrypt(secrets, existing.given_name_ct),
    family_name: 'family_name' in patch ? patch.family_name : enc.decrypt(secrets, existing.family_name_ct),
    middle_name: 'middle_name' in patch ? patch.middle_name : enc.decrypt(secrets, existing.middle_name_ct),
    prefix: 'prefix' in patch ? patch.prefix : enc.decrypt(secrets, existing.prefix_ct),
    suffix: 'suffix' in patch ? patch.suffix : enc.decrypt(secrets, existing.suffix_ct),
    date_of_birth: 'date_of_birth' in patch ? patch.date_of_birth : enc.decrypt(secrets, existing.date_of_birth_ct),
    gender: 'gender' in patch ? patch.gender : enc.decrypt(secrets, existing.gender_ct),
    notes: 'notes' in patch ? patch.notes : enc.decrypt(secrets, existing.notes_ct),
  };
  const display = patch.display_name || buildDisplayName(merged);
  db.prepare(
    `UPDATE persons SET
       given_name_ct = ?, family_name_ct = ?, middle_name_ct = ?, prefix_ct = ?,
       suffix_ct = ?, display_name_ct = ?, given_name_hash = ?, family_name_hash = ?,
       date_of_birth_ct = ?, gender_ct = ?, notes_ct = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE code = ?`
  ).run(
    enc.encrypt(secrets, merged.given_name),
    enc.encrypt(secrets, merged.family_name),
    enc.encrypt(secrets, merged.middle_name),
    enc.encrypt(secrets, merged.prefix),
    enc.encrypt(secrets, merged.suffix),
    enc.encrypt(secrets, display),
    enc.hmac(secrets, enc.normalizeName(merged.given_name)),
    enc.hmac(secrets, enc.normalizeName(merged.family_name)),
    enc.encrypt(secrets, merged.date_of_birth),
    enc.encrypt(secrets, merged.gender),
    enc.encrypt(secrets, merged.notes),
    target
  );
  return target;
}

// Merge `loserCode` into `winnerCode`. Memberships, addresses, emails, phones,
// relationships, and provenance carry over. The loser's row is marked merged
// and an alias row is recorded.
function merge(db, secrets, loserCode, winnerCode) {
  const loser = aliases.resolveAlias(db, loserCode);
  const winner = aliases.resolveAlias(db, winnerCode);
  if (loser === winner) return winner;
  const loserRow = db.prepare('SELECT * FROM persons WHERE code = ?').get(loser);
  const winnerRow = db.prepare('SELECT * FROM persons WHERE code = ?').get(winner);
  if (!loserRow || !winnerRow) throw new Error('person not found');

  const tx = db.transaction(() => {
    // Move memberships: loser's active rows become winner's; close any duplicates.
    const loserMemberships = db.prepare('SELECT * FROM memberships WHERE person_code = ?').all(loser);
    for (const m of loserMemberships) {
      const dupe = db
        .prepare(
          `SELECT 1 FROM memberships WHERE person_code = ? AND family_code = ? AND ended_at IS NULL`
        )
        .get(winner, m.family_code);
      if (dupe && m.ended_at == null) {
        // Already covered: end the loser's row.
        db.prepare(
          `UPDATE memberships SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reason = 'merge_dedupe' WHERE code = ?`
        ).run(m.code);
      } else {
        db.prepare('UPDATE memberships SET person_code = ? WHERE code = ?').run(winner, m.code);
      }
    }
    // Re-point relationships, emails, phones, person_addresses, provenance.
    db.prepare('UPDATE relationships SET from_code = ? WHERE from_code = ?').run(winner, loser);
    db.prepare('UPDATE relationships SET to_code = ? WHERE to_code = ?').run(winner, loser);
    db.prepare('UPDATE OR IGNORE person_emails SET person_code = ? WHERE person_code = ?').run(winner, loser);
    db.prepare('DELETE FROM person_emails WHERE person_code = ?').run(loser);
    db.prepare('UPDATE OR IGNORE person_phones SET person_code = ? WHERE person_code = ?').run(winner, loser);
    db.prepare('DELETE FROM person_phones WHERE person_code = ?').run(loser);
    db.prepare('UPDATE OR IGNORE person_addresses SET person_code = ? WHERE person_code = ?').run(winner, loser);
    db.prepare('DELETE FROM person_addresses WHERE person_code = ?').run(loser);
    db.prepare('UPDATE provenance SET entity_code = ? WHERE entity_code = ?').run(winner, loser);

    db.prepare(
      `UPDATE persons SET status = 'merged', merged_into = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
    ).run(winner, loser);
    aliases.recordAlias(db, loser, winner, 'person');
  });
  tx();
  return winner;
}

module.exports = { create, get, list, findByName, update, merge };
