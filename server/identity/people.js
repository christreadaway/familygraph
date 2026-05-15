'use strict';

const enc = require('../crypto/encryption');
const { newCode, isValidCode } = require('../crypto/identifiers');
const aliases = require('./aliases');
const eim = require('./eim');
const history = require('./history');

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
    kind: row.kind || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  // EIM fields are queryable plaintext (status + dates) so the dashboard can
  // surface "expiring soon" without decrypting every row. They flow through
  // the safe surface too — knowing that someone holds a current cert is not
  // PII on its own, and ministry coordinators need that signal even when
  // they're not reading PII columns.
  const eim = {
    eim_status: row.eim_status || null,
    eim_completed_on: row.eim_completed_on || null,
    eim_expires_on: row.eim_expires_on || null,
  };
  if (!includePii) {
    return {
      ...base,
      ...eim,
      do_not_contact: !!row.do_not_contact,
      not_living_together: !!row.not_living_together,
    };
  }
  return {
    ...base,
    ...eim,
    given_name: enc.decrypt(secrets, row.given_name_ct),
    family_name: enc.decrypt(secrets, row.family_name_ct),
    middle_name: enc.decrypt(secrets, row.middle_name_ct),
    preferred_name: enc.decrypt(secrets, row.preferred_name_ct),
    prefix: enc.decrypt(secrets, row.prefix_ct),
    suffix: enc.decrypt(secrets, row.suffix_ct),
    display_name: enc.decrypt(secrets, row.display_name_ct),
    date_of_birth: enc.decrypt(secrets, row.date_of_birth_ct),
    gender: enc.decrypt(secrets, row.gender_ct),
    notes: enc.decrypt(secrets, row.notes_ct),
    employer: enc.decrypt(secrets, row.employer_ct),
    title: enc.decrypt(secrets, row.title_ct),
    do_not_contact: !!row.do_not_contact,
    do_not_contact_reason: enc.decrypt(secrets, row.do_not_contact_reason_ct),
    not_living_together: !!row.not_living_together,
    eim_notes: enc.decrypt(secrets, row.eim_notes_ct),
  };
}

const KIND_VALUES = new Set(['adult', 'child']);
function normalizeKind(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).toLowerCase();
  if (!KIND_VALUES.has(s)) throw new Error(`invalid kind: ${v}`);
  return s;
}

const EIM_STATUSES = new Set(['pending', 'certified', 'expired']);

function normalizeEimStatus(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).toLowerCase();
  if (!EIM_STATUSES.has(s)) {
    throw new Error(`invalid eim_status: ${v}`);
  }
  return s;
}

function normalizeIsoDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`invalid date (want YYYY-MM-DD): ${v}`);
  }
  return s;
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
  const enriched = eim.deriveExpiration(db, input);
  const eimStatus = normalizeEimStatus(enriched.eim_status);
  const eimCompleted = normalizeIsoDate(enriched.eim_completed_on);
  const eimExpires = normalizeIsoDate(enriched.eim_expires_on);
  const kind = normalizeKind(input.kind);
  const stmt = db.prepare(
    `INSERT INTO persons (
       code, given_name_ct, family_name_ct, middle_name_ct, preferred_name_ct, prefix_ct, suffix_ct,
       display_name_ct, given_name_hash, family_name_hash,
       date_of_birth_ct, gender_ct, notes_ct,
       employer_ct, title_ct, do_not_contact, do_not_contact_reason_ct, not_living_together,
       eim_status, eim_completed_on, eim_expires_on, eim_notes_ct, kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    code,
    enc.encrypt(secrets, input.given_name),
    enc.encrypt(secrets, input.family_name),
    enc.encrypt(secrets, input.middle_name),
    enc.encrypt(secrets, input.preferred_name),
    enc.encrypt(secrets, input.prefix),
    enc.encrypt(secrets, input.suffix),
    enc.encrypt(secrets, display),
    enc.hmac(secrets, enc.normalizeName(input.given_name)),
    enc.hmac(secrets, enc.normalizeName(input.family_name)),
    enc.encrypt(secrets, input.date_of_birth),
    enc.encrypt(secrets, input.gender),
    enc.encrypt(secrets, input.notes),
    enc.encrypt(secrets, input.employer),
    enc.encrypt(secrets, input.title),
    input.do_not_contact ? 1 : 0,
    enc.encrypt(secrets, input.do_not_contact_reason),
    input.not_living_together ? 1 : 0,
    eimStatus,
    eimCompleted,
    eimExpires,
    enc.encrypt(secrets, input.eim_notes),
    kind,
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
    preferred_name: 'preferred_name' in patch ? patch.preferred_name : enc.decrypt(secrets, existing.preferred_name_ct),
    prefix: 'prefix' in patch ? patch.prefix : enc.decrypt(secrets, existing.prefix_ct),
    suffix: 'suffix' in patch ? patch.suffix : enc.decrypt(secrets, existing.suffix_ct),
    date_of_birth: 'date_of_birth' in patch ? patch.date_of_birth : enc.decrypt(secrets, existing.date_of_birth_ct),
    gender: 'gender' in patch ? patch.gender : enc.decrypt(secrets, existing.gender_ct),
    notes: 'notes' in patch ? patch.notes : enc.decrypt(secrets, existing.notes_ct),
    employer: 'employer' in patch ? patch.employer : enc.decrypt(secrets, existing.employer_ct),
    title: 'title' in patch ? patch.title : enc.decrypt(secrets, existing.title_ct),
    do_not_contact_reason: 'do_not_contact_reason' in patch ? patch.do_not_contact_reason : enc.decrypt(secrets, existing.do_not_contact_reason_ct),
  };
  const dnc = 'do_not_contact' in patch ? (patch.do_not_contact ? 1 : 0) : (existing.do_not_contact || 0);
  const nlt = 'not_living_together' in patch ? (patch.not_living_together ? 1 : 0) : (existing.not_living_together || 0);
  // Auto-derive expiration when the operator updates only the completion
  // date. If they explicitly clear or override eim_expires_on, the patch
  // wins.
  const eimPatch = eim.deriveExpiration(db, patch);
  const eimStatus = 'eim_status' in eimPatch ? normalizeEimStatus(eimPatch.eim_status) : (existing.eim_status || null);
  const eimCompleted = 'eim_completed_on' in eimPatch ? normalizeIsoDate(eimPatch.eim_completed_on) : (existing.eim_completed_on || null);
  const eimExpires = 'eim_expires_on' in eimPatch ? normalizeIsoDate(eimPatch.eim_expires_on) : (existing.eim_expires_on || null);
  const eimNotesCt = 'eim_notes' in patch
    ? enc.encrypt(secrets, patch.eim_notes)
    : existing.eim_notes_ct;
  const kind = 'kind' in patch ? normalizeKind(patch.kind) : (existing.kind || null);
  const display = patch.display_name || buildDisplayName(merged);
  db.prepare(
    `UPDATE persons SET
       given_name_ct = ?, family_name_ct = ?, middle_name_ct = ?, preferred_name_ct = ?, prefix_ct = ?,
       suffix_ct = ?, display_name_ct = ?, given_name_hash = ?, family_name_hash = ?,
       date_of_birth_ct = ?, gender_ct = ?, notes_ct = ?,
       employer_ct = ?, title_ct = ?, do_not_contact = ?, do_not_contact_reason_ct = ?, not_living_together = ?,
       eim_status = ?, eim_completed_on = ?, eim_expires_on = ?, eim_notes_ct = ?, kind = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE code = ?`
  ).run(
    enc.encrypt(secrets, merged.given_name),
    enc.encrypt(secrets, merged.family_name),
    enc.encrypt(secrets, merged.middle_name),
    enc.encrypt(secrets, merged.preferred_name),
    enc.encrypt(secrets, merged.prefix),
    enc.encrypt(secrets, merged.suffix),
    enc.encrypt(secrets, display),
    enc.hmac(secrets, enc.normalizeName(merged.given_name)),
    enc.hmac(secrets, enc.normalizeName(merged.family_name)),
    enc.encrypt(secrets, merged.date_of_birth),
    enc.encrypt(secrets, merged.gender),
    enc.encrypt(secrets, merged.notes),
    enc.encrypt(secrets, merged.employer),
    enc.encrypt(secrets, merged.title),
    dnc,
    enc.encrypt(secrets, merged.do_not_contact_reason),
    nlt,
    eimStatus,
    eimCompleted,
    eimExpires,
    eimNotesCt,
    kind,
    target
  );
  return target;
}

// Helper used by the ParentPoint contract layer (and other write paths) to
// bump `updated_at` without changing any other column. Surfaced as a public
// API so callers don't have to embed strftime in their own SQL.
function touchUpdatedAt(db, code) {
  const target = aliases.resolveAlias(db, code);
  db.prepare(
    `UPDATE persons SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
  ).run(target);
  return target;
}

// Soft-archive a person. The row stays in the database; status flips to
// 'archived'. A change-log row captures the pre-archive snapshot so a
// later reinstate can verify state and explain what was undone.
//
// Returns `{ code, before, after }` on success or null when the person
// doesn't exist. Throws when the person is already merged (a merged
// row is owned by its winner; archiving it would lose data).
function archive(db, code, { actor = 'system', actorKind = null, reason = null, requestId = null } = {}) {
  // Look up the literal code BEFORE resolving aliases. A caller passing
  // a merged-loser code should fail loudly rather than silently archive
  // the winner (which would surprise everyone holding the surviving
  // record).
  const literal = db.prepare('SELECT status FROM persons WHERE code = ?').get(code);
  if (literal && literal.status === 'merged') {
    throw new Error('cannot archive a merged person; merge owns the row');
  }
  const target = aliases.resolveAlias(db, code);
  const before = db.prepare('SELECT * FROM persons WHERE code = ?').get(target);
  if (!before) return null;
  if (before.status === 'merged') {
    throw new Error('cannot archive a merged person; merge owns the row');
  }
  if (before.status === 'archived') {
    // Idempotent: just record a no-op change row so the operator sees
    // the second click landed somewhere.
    history.record(db, {
      entityKind: 'person', entityCode: target, operation: 'archive',
      before, after: before, actor, actorKind, requestId, reason,
    });
    return { code: target, before, after: before, noop: true };
  }
  db.prepare(
    `UPDATE persons SET status = 'archived', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
  ).run(target);
  const after = db.prepare('SELECT * FROM persons WHERE code = ?').get(target);
  history.record(db, {
    entityKind: 'person', entityCode: target, operation: 'archive',
    before, after, actor, actorKind, requestId, reason,
  });
  return { code: target, before, after };
}

// Reverse an archive. Status flips back to 'active'; a change-log row
// captures the pre-reinstate state so the trail is complete.
function reinstate(db, code, { actor = 'system', actorKind = null, reason = null, requestId = null } = {}) {
  const literal = db.prepare('SELECT status FROM persons WHERE code = ?').get(code);
  if (literal && literal.status === 'merged') {
    throw new Error('cannot reinstate a merged person; un-merge is a manual operator workflow');
  }
  const target = aliases.resolveAlias(db, code);
  const before = db.prepare('SELECT * FROM persons WHERE code = ?').get(target);
  if (!before) return null;
  if (before.status === 'merged') {
    throw new Error('cannot reinstate a merged person; un-merge is a manual operator workflow');
  }
  if (before.status === 'active') {
    history.record(db, {
      entityKind: 'person', entityCode: target, operation: 'reinstate',
      before, after: before, actor, actorKind, requestId, reason,
    });
    return { code: target, before, after: before, noop: true };
  }
  db.prepare(
    `UPDATE persons SET status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
  ).run(target);
  const after = db.prepare('SELECT * FROM persons WHERE code = ?').get(target);
  history.record(db, {
    entityKind: 'person', entityCode: target, operation: 'reinstate',
    before, after, actor, actorKind, requestId, reason,
  });
  return { code: target, before, after };
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

    // Move ministry assignments. The active-row uniqueness index on
    // ministry_assignments would reject a stacked second active row, so
    // duplicates get ended on the loser before the rest get re-pointed.
    const ministries = require('./ministries');
    ministries.repointPersonAssignments(db, loser, winner);

    db.prepare(
      `UPDATE persons SET status = 'merged', merged_into = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
    ).run(winner, loser);
    aliases.recordAlias(db, loser, winner, 'person');
  });
  tx();
  return winner;
}

module.exports = { create, get, list, findByName, update, merge, touchUpdatedAt, archive, reinstate };
