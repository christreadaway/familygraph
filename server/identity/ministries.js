'use strict';

// Volunteer / ministry rosters. A ministry is a named list (Lectors,
// Eucharistic Ministers, Coffee & Donuts, Faith Formation aides). An
// assignment puts a person OR a family on that list, optionally with a role
// (member, coordinator, lead). Active assignments have ended_at = NULL.
//
// Why per-row toggle between person and family: parishes track both. A
// cantor schedule names individuals; a hospitality rotation often names
// whole families. Forcing one or the other distorts the data the operator
// already keeps in their spreadsheet.
//
// requires_eim is a flag on the ministry, not the assignment. The dashboard
// joins assignments to persons.eim_* to flag "X is on Lectors but their
// EIM lapsed last month".

const enc = require('../crypto/encryption');
const { newCode, isValidCode } = require('../crypto/identifiers');
const aliases = require('./aliases');

const ROLES = new Set(['member', 'coordinator', 'lead']);

function row2ministry(row) {
  if (!row) return null;
  return {
    code: row.code,
    name: row.name,
    description: row.description || null,
    requires_eim: !!row.requires_eim,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function row2assignment(row, secrets, { includePii }) {
  if (!row) return null;
  const base = {
    code: row.code,
    ministry_code: row.ministry_code,
    person_code: row.person_code || null,
    family_code: row.family_code || null,
    role: row.role,
    started_at: row.started_at,
    ended_at: row.ended_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (!includePii) return base;
  return {
    ...base,
    notes: enc.decrypt(secrets, row.notes_ct),
  };
}

function createMinistry(db, input) {
  if (!input || !input.name || !String(input.name).trim()) {
    throw new Error('ministry name is required');
  }
  const code = newCode('ministry');
  db.prepare(
    `INSERT INTO ministries (code, name, description, requires_eim, status)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    code,
    String(input.name).trim(),
    input.description ? String(input.description) : null,
    input.requires_eim ? 1 : 0,
    input.status === 'archived' ? 'archived' : 'active'
  );
  return code;
}

function listMinistries(db, { status = 'active' } = {}) {
  const rows = status === 'all'
    ? db.prepare(`SELECT * FROM ministries ORDER BY name`).all()
    : db.prepare(`SELECT * FROM ministries WHERE status = ? ORDER BY name`).all(status);
  return rows.map(row2ministry);
}

function getMinistry(db, code) {
  if (!isValidCode(code, 'ministry')) return null;
  const row = db.prepare(`SELECT * FROM ministries WHERE code = ?`).get(code);
  return row2ministry(row);
}

function updateMinistry(db, code, patch) {
  if (!isValidCode(code, 'ministry')) return null;
  const existing = db.prepare(`SELECT * FROM ministries WHERE code = ?`).get(code);
  if (!existing) return null;
  const name = 'name' in patch && patch.name != null
    ? String(patch.name).trim()
    : existing.name;
  if (!name) throw new Error('ministry name cannot be empty');
  const description = 'description' in patch
    ? (patch.description == null ? null : String(patch.description))
    : existing.description;
  const requiresEim = 'requires_eim' in patch
    ? (patch.requires_eim ? 1 : 0)
    : existing.requires_eim;
  let status = existing.status;
  if ('status' in patch) {
    if (patch.status !== 'active' && patch.status !== 'archived') {
      throw new Error(`invalid ministry status: ${patch.status}`);
    }
    status = patch.status;
  }
  db.prepare(
    `UPDATE ministries SET name = ?, description = ?, requires_eim = ?, status = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE code = ?`
  ).run(name, description, requiresEim, status, code);
  return code;
}

function archiveMinistry(db, code) {
  return updateMinistry(db, code, { status: 'archived' });
}

function assign(db, secrets, ministryCode, input) {
  if (!isValidCode(ministryCode, 'ministry')) {
    throw new Error('invalid ministry code');
  }
  const ministry = db.prepare(`SELECT * FROM ministries WHERE code = ?`).get(ministryCode);
  if (!ministry) throw new Error('ministry not found');

  const personCode = input.person_code || null;
  const familyCode = input.family_code || null;
  if ((personCode && familyCode) || (!personCode && !familyCode)) {
    throw new Error('exactly one of person_code or family_code is required');
  }

  let resolvedPerson = null;
  let resolvedFamily = null;
  if (personCode) {
    if (!isValidCode(personCode, 'person')) throw new Error('invalid person_code');
    resolvedPerson = aliases.resolveAlias(db, personCode);
    const p = db.prepare(`SELECT 1 FROM persons WHERE code = ?`).get(resolvedPerson);
    if (!p) throw new Error('person not found');
  } else {
    if (!isValidCode(familyCode, 'family')) throw new Error('invalid family_code');
    resolvedFamily = aliases.resolveAlias(db, familyCode);
    const f = db.prepare(`SELECT 1 FROM families WHERE code = ?`).get(resolvedFamily);
    if (!f) throw new Error('family not found');
  }

  const role = input.role ? String(input.role).toLowerCase() : 'member';
  if (!ROLES.has(role)) throw new Error(`invalid role: ${role}`);

  // Re-activate an existing inactive assignment rather than stacking duplicates.
  // The unique index on active rows would reject a second active assignment
  // anyway; this gives the operator a clean re-add story.
  const existingActive = db.prepare(
    resolvedPerson
      ? `SELECT * FROM ministry_assignments WHERE ministry_code = ? AND person_code = ? AND ended_at IS NULL`
      : `SELECT * FROM ministry_assignments WHERE ministry_code = ? AND family_code = ? AND ended_at IS NULL`
  ).get(ministryCode, resolvedPerson || resolvedFamily);
  if (existingActive) {
    db.prepare(
      `UPDATE ministry_assignments SET role = ?, notes_ct = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE code = ?`
    ).run(role, enc.encrypt(secrets, input.notes), existingActive.code);
    return existingActive.code;
  }

  const code = newCode('ministry_assignment');
  db.prepare(
    `INSERT INTO ministry_assignments (code, ministry_code, person_code, family_code, role, notes_ct)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    code,
    ministryCode,
    resolvedPerson,
    resolvedFamily,
    role,
    enc.encrypt(secrets, input.notes),
  );
  return code;
}

function endAssignment(db, secrets, assignmentCode, { reason } = {}) {
  if (!isValidCode(assignmentCode, 'ministry_assignment')) {
    throw new Error('invalid assignment code');
  }
  const row = db.prepare(`SELECT * FROM ministry_assignments WHERE code = ?`).get(assignmentCode);
  if (!row) return null;
  if (row.ended_at) return assignmentCode;
  let nextNotesCt = row.notes_ct;
  if (reason) {
    const priorNote = enc.decrypt(secrets, row.notes_ct);
    const composed = priorNote
      ? `${priorNote}\nended: ${reason}`
      : `ended: ${reason}`;
    nextNotesCt = enc.encrypt(secrets, composed);
  }
  db.prepare(
    `UPDATE ministry_assignments SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       notes_ct = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE code = ?`
  ).run(nextNotesCt, assignmentCode);
  return assignmentCode;
}

function listAssignments(db, secrets, { ministry_code, person_code, family_code, status = 'active', includePii = false } = {}) {
  const where = [];
  const params = [];
  if (ministry_code) { where.push('ministry_code = ?'); params.push(ministry_code); }
  if (person_code) {
    const target = aliases.resolveAlias(db, person_code);
    where.push('person_code = ?');
    params.push(target);
  }
  if (family_code) {
    const target = aliases.resolveAlias(db, family_code);
    where.push('family_code = ?');
    params.push(target);
  }
  if (status === 'active') {
    where.push('ended_at IS NULL');
  } else if (status === 'ended') {
    where.push('ended_at IS NOT NULL');
  }
  const sql = `SELECT * FROM ministry_assignments${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC`;
  const rows = db.prepare(sql).all(...params);
  return rows.map(r => row2assignment(r, secrets, { includePii }));
}

// Re-point a person's ministry assignments onto the merge winner. Called by
// people.merge so a conflict resolution doesn't strand someone on a roster
// under their losing code. The active-row uniqueness index forces us to end
// duplicates instead of trying to insert a second active row.
function repointPersonAssignments(db, loserCode, winnerCode) {
  const rows = db.prepare(
    `SELECT * FROM ministry_assignments WHERE person_code = ?`
  ).all(loserCode);
  for (const m of rows) {
    if (m.ended_at == null) {
      const dupe = db.prepare(
        `SELECT 1 FROM ministry_assignments
          WHERE ministry_code = ? AND person_code = ? AND ended_at IS NULL`
      ).get(m.ministry_code, winnerCode);
      if (dupe) {
        db.prepare(
          `UPDATE ministry_assignments SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE code = ?`
        ).run(m.code);
        continue;
      }
    }
    db.prepare(
      `UPDATE ministry_assignments SET person_code = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE code = ?`
    ).run(winnerCode, m.code);
  }
}

function repointFamilyAssignments(db, loserCode, winnerCode) {
  const rows = db.prepare(
    `SELECT * FROM ministry_assignments WHERE family_code = ?`
  ).all(loserCode);
  for (const m of rows) {
    if (m.ended_at == null) {
      const dupe = db.prepare(
        `SELECT 1 FROM ministry_assignments
          WHERE ministry_code = ? AND family_code = ? AND ended_at IS NULL`
      ).get(m.ministry_code, winnerCode);
      if (dupe) {
        db.prepare(
          `UPDATE ministry_assignments SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE code = ?`
        ).run(m.code);
        continue;
      }
    }
    db.prepare(
      `UPDATE ministry_assignments SET family_code = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE code = ?`
    ).run(winnerCode, m.code);
  }
}

module.exports = {
  createMinistry,
  listMinistries,
  getMinistry,
  updateMinistry,
  archiveMinistry,
  assign,
  endAssignment,
  listAssignments,
  repointPersonAssignments,
  repointFamilyAssignments,
  ROLES,
};
