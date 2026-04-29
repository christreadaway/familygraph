'use strict';

const enc = require('../crypto/encryption');
const { newCode, isValidCode } = require('../crypto/identifiers');
const aliases = require('./aliases');

function row2family(row, secrets, { includePii }) {
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (!includePii) return base;
  return {
    ...base,
    display_name: enc.decrypt(secrets, row.display_name_ct),
    notes: enc.decrypt(secrets, row.notes_ct),
  };
}

function create(db, secrets, input = {}) {
  const code = newCode('family');
  db.prepare(
    `INSERT INTO families (code, display_name_ct, notes_ct) VALUES (?, ?, ?)`
  ).run(
    code,
    enc.encrypt(secrets, input.display_name || null),
    enc.encrypt(secrets, input.notes || null)
  );
  return code;
}

function get(db, secrets, code, opts = {}) {
  if (!isValidCode(code, 'family')) return null;
  const target = aliases.resolveAlias(db, code);
  const row = db.prepare('SELECT * FROM families WHERE code = ?').get(target);
  return row2family(row, secrets, { includePii: !!opts.includePii });
}

function list(db, secrets, { limit = 50, status = 'active', includePii = false } = {}) {
  const rows = db
    .prepare(`SELECT * FROM families WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
    .all(status, Math.max(1, Math.min(1000, Number(limit) || 50)));
  return rows.map(r => row2family(r, secrets, { includePii }));
}

function update(db, secrets, code, patch) {
  const target = aliases.resolveAlias(db, code);
  const row = db.prepare('SELECT * FROM families WHERE code = ?').get(target);
  if (!row) return null;
  const display = 'display_name' in patch ? patch.display_name : enc.decrypt(secrets, row.display_name_ct);
  const notes = 'notes' in patch ? patch.notes : enc.decrypt(secrets, row.notes_ct);
  db.prepare(
    `UPDATE families SET display_name_ct = ?, notes_ct = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
  ).run(enc.encrypt(secrets, display), enc.encrypt(secrets, notes), target);
  return target;
}

function members(db, secrets, code, { activeOnly = true, includePii = false } = {}) {
  const target = aliases.resolveAlias(db, code);
  const where = activeOnly ? `AND m.ended_at IS NULL` : '';
  const rows = db
    .prepare(
      `SELECT m.*, p.given_name_ct, p.family_name_ct, p.display_name_ct
         FROM memberships m
         JOIN persons p ON p.code = m.person_code
        WHERE m.family_code = ? ${where}
        ORDER BY m.started_at ASC`
    )
    .all(target);
  return rows.map(r => ({
    membership_code: r.code,
    person_code: r.person_code,
    role: r.role,
    custody: r.custody,
    started_at: r.started_at,
    ended_at: r.ended_at,
    reason: r.reason,
    person: includePii
      ? {
          given_name: enc.decrypt(secrets, r.given_name_ct),
          family_name: enc.decrypt(secrets, r.family_name_ct),
          display_name: enc.decrypt(secrets, r.display_name_ct),
        }
      : { code: r.person_code },
  }));
}

function addMember(db, secrets, familyCode, personCode, { role = 'member', custody = null } = {}) {
  const family = aliases.resolveAlias(db, familyCode);
  const person = aliases.resolveAlias(db, personCode);
  const code = newCode('membership');
  db.prepare(
    `INSERT INTO memberships (code, family_code, person_code, role, custody) VALUES (?, ?, ?, ?, ?)`
  ).run(code, family, person, role, custody);
  return code;
}

function endMembership(db, membershipCode, reason = 'edit') {
  db.prepare(
    `UPDATE memberships SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reason = ? WHERE code = ?`
  ).run(reason, membershipCode);
}

function merge(db, secrets, loserCode, winnerCode) {
  const loser = aliases.resolveAlias(db, loserCode);
  const winner = aliases.resolveAlias(db, winnerCode);
  if (loser === winner) return winner;
  const lr = db.prepare('SELECT * FROM families WHERE code = ?').get(loser);
  const wr = db.prepare('SELECT * FROM families WHERE code = ?').get(winner);
  if (!lr || !wr) throw new Error('family not found');

  const tx = db.transaction(() => {
    // Re-point memberships: anyone in loser becomes a member of winner. End the
    // old row, open a new one preserving role/custody.
    const memberships = db.prepare('SELECT * FROM memberships WHERE family_code = ? AND ended_at IS NULL').all(loser);
    for (const m of memberships) {
      // If person is already a member of winner, just end the loser's row.
      const existing = db
        .prepare(`SELECT 1 FROM memberships WHERE family_code = ? AND person_code = ? AND ended_at IS NULL`)
        .get(winner, m.person_code);
      if (existing) {
        db.prepare(
          `UPDATE memberships SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reason = 'family_merge_dedupe' WHERE code = ?`
        ).run(m.code);
      } else {
        db.prepare('UPDATE memberships SET family_code = ? WHERE code = ?').run(winner, m.code);
      }
    }
    // Closed memberships keep their old family_code historically; re-point the
    // family_code so audit reads still resolve.
    db.prepare('UPDATE memberships SET family_code = ? WHERE family_code = ?').run(winner, loser);

    db.prepare('UPDATE OR IGNORE family_addresses SET family_code = ? WHERE family_code = ?').run(winner, loser);
    db.prepare('DELETE FROM family_addresses WHERE family_code = ?').run(loser);
    db.prepare('UPDATE relationships SET from_code = ? WHERE from_code = ?').run(winner, loser);
    db.prepare('UPDATE relationships SET to_code = ? WHERE to_code = ?').run(winner, loser);
    db.prepare('UPDATE provenance SET entity_code = ? WHERE entity_code = ?').run(winner, loser);

    db.prepare(
      `UPDATE families SET status = 'merged', merged_into = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
    ).run(winner, loser);
    aliases.recordAlias(db, loser, winner, 'family');
  });
  tx();
  return winner;
}

// Split a family by promoting a subset of person codes into a new family.
// History is preserved: the existing memberships are ended (reason='split')
// and new memberships are opened in the new family.
function split(db, secrets, familyCode, personCodes, { displayName = null, notes = null } = {}) {
  const source = aliases.resolveAlias(db, familyCode);
  const personCodesResolved = personCodes.map(c => aliases.resolveAlias(db, c));
  const newFamily = create(db, secrets, { display_name: displayName, notes });
  const tx = db.transaction(() => {
    for (const pc of personCodesResolved) {
      const m = db
        .prepare(`SELECT * FROM memberships WHERE family_code = ? AND person_code = ? AND ended_at IS NULL`)
        .get(source, pc);
      if (m) {
        endMembership(db, m.code, 'split');
        addMember(db, secrets, newFamily, pc, { role: m.role, custody: m.custody });
      } else {
        addMember(db, secrets, newFamily, pc);
      }
    }
  });
  tx();
  return newFamily;
}

module.exports = { create, get, list, update, members, addMember, endMembership, merge, split };
