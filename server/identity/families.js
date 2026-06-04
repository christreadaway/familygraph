'use strict';

const enc = require('../crypto/encryption');
const { newCode, isValidCode } = require('../crypto/identifiers');
const aliases = require('./aliases');
const history = require('./history');

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
    primary_contact_person_code: row.primary_contact_person_code || null,
    communication_language: row.communication_language || null,
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

function create(db, secrets, input = {}, audit = {}) {
  const code = newCode('family');
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO families (code, display_name_ct, notes_ct) VALUES (?, ?, ?)`
    ).run(
      code,
      enc.encrypt(secrets, input.display_name || null),
      enc.encrypt(secrets, input.notes || null)
    );
    const after = db.prepare(`SELECT * FROM families WHERE code = ?`).get(code);
    history.record(db, {
      entityKind: 'family', entityCode: code, operation: 'create',
      before: null, after,
      actor: audit.actor || 'system', actorKind: audit.actorKind || null,
      requestId: audit.requestId || null, reason: audit.reason || null,
    });
  });
  tx();
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
  // Annotate each family with whether any active member has do_not_contact
  // set. This is the signal the Families list view uses to render its
  // "Add to do-not-call" / "Clear" quick-action button without having to
  // round-trip through every family's detail.
  const dncStmt = db.prepare(
    `SELECT 1 FROM memberships m
       JOIN persons p ON p.code = m.person_code
      WHERE m.family_code = ? AND m.ended_at IS NULL AND p.do_not_contact = 1
      LIMIT 1`
  );
  return rows.map(r => {
    const fam = row2family(r, secrets, { includePii });
    fam.do_not_contact_any = !!dncStmt.get(r.code);
    return fam;
  });
}

function update(db, secrets, code, patch, audit = {}) {
  const target = aliases.resolveAlias(db, code);
  const row = db.prepare('SELECT * FROM families WHERE code = ?').get(target);
  if (!row) return null;
  const display = 'display_name' in patch ? patch.display_name : enc.decrypt(secrets, row.display_name_ct);
  const notes = 'notes' in patch ? patch.notes : enc.decrypt(secrets, row.notes_ct);
  const primary = 'primary_contact_person_code' in patch
    ? patch.primary_contact_person_code
    : (row.primary_contact_person_code || null);
  const lang = 'communication_language' in patch
    ? (patch.communication_language || null)
    : (row.communication_language || null);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE families SET display_name_ct = ?, notes_ct = ?,
           primary_contact_person_code = ?, communication_language = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE code = ?`
    ).run(
      enc.encrypt(secrets, display),
      enc.encrypt(secrets, notes),
      primary,
      lang,
      target
    );
    const after = db.prepare(`SELECT * FROM families WHERE code = ?`).get(target);
    history.record(db, {
      entityKind: 'family', entityCode: target, operation: 'update',
      before: row, after,
      actor: audit.actor || 'system', actorKind: audit.actorKind || null,
      requestId: audit.requestId || null, reason: audit.reason || null,
    });
  });
  tx();
  return target;
}

// Bump updated_at without changing any other column. Used by the
// Integration contract layer when a linked person / consent / membership
// changes — the household-changed feed needs to surface the family.
function touchUpdatedAt(db, code) {
  const target = aliases.resolveAlias(db, code);
  db.prepare(
    `UPDATE families SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
  ).run(target);
  return target;
}

// Soft-archive a household. Status flips to 'archived'; the row stays
// in place. Active memberships ride along under the archived parent (a
// `members(activeOnly: true)` call still returns them, which is what
// reinstate needs to put things back).
function archive(db, code, { actor = 'system', actorKind = null, reason = null, requestId = null } = {}) {
  const literal = db.prepare('SELECT status FROM families WHERE code = ?').get(code);
  if (literal && literal.status === 'merged') {
    throw new Error('cannot archive a merged family; merge owns the row');
  }
  const target = aliases.resolveAlias(db, code);
  const before = db.prepare('SELECT * FROM families WHERE code = ?').get(target);
  if (!before) return null;
  if (before.status === 'merged') {
    throw new Error('cannot archive a merged family; merge owns the row');
  }
  const tx = db.transaction(() => {
    if (before.status === 'archived') {
      history.record(db, {
        entityKind: 'family', entityCode: target, operation: 'archive',
        before, after: before, actor, actorKind, requestId, reason,
      });
      return { code: target, before, after: before, noop: true };
    }
    db.prepare(
      `UPDATE families SET status = 'archived', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
    ).run(target);
    const after = db.prepare('SELECT * FROM families WHERE code = ?').get(target);
    history.record(db, {
      entityKind: 'family', entityCode: target, operation: 'archive',
      before, after, actor, actorKind, requestId, reason,
    });
    return { code: target, before, after };
  });
  return tx();
}

function reinstate(db, code, { actor = 'system', actorKind = null, reason = null, requestId = null } = {}) {
  const literal = db.prepare('SELECT status FROM families WHERE code = ?').get(code);
  if (literal && literal.status === 'merged') {
    throw new Error('cannot reinstate a merged family; un-merge is a manual operator workflow');
  }
  const target = aliases.resolveAlias(db, code);
  const before = db.prepare('SELECT * FROM families WHERE code = ?').get(target);
  if (!before) return null;
  if (before.status === 'merged') {
    throw new Error('cannot reinstate a merged family; un-merge is a manual operator workflow');
  }
  const tx = db.transaction(() => {
    if (before.status === 'active') {
      history.record(db, {
        entityKind: 'family', entityCode: target, operation: 'reinstate',
        before, after: before, actor, actorKind, requestId, reason,
      });
      return { code: target, before, after: before, noop: true };
    }
    db.prepare(
      `UPDATE families SET status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
    ).run(target);
    const after = db.prepare('SELECT * FROM families WHERE code = ?').get(target);
    history.record(db, {
      entityKind: 'family', entityCode: target, operation: 'reinstate',
      before, after, actor, actorKind, requestId, reason,
    });
    return { code: target, before, after };
  });
  return tx();
}

function members(db, secrets, code, { activeOnly = true, includePii = false } = {}) {
  const target = aliases.resolveAlias(db, code);
  const where = activeOnly ? `AND m.ended_at IS NULL` : '';
  const rows = db
    .prepare(
      `SELECT m.*, p.given_name_ct, p.family_name_ct, p.display_name_ct,
              p.date_of_birth_ct, p.gender_ct, p.grade,
              p.employer_ct, p.title_ct,
              p.do_not_contact, p.do_not_contact_reason_ct, p.not_living_together
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
    relation_label: r.relation_label || null,
    custody: r.custody,
    started_at: r.started_at,
    ended_at: r.ended_at,
    reason: r.reason,
    person: includePii
      ? {
          given_name: enc.decrypt(secrets, r.given_name_ct),
          family_name: enc.decrypt(secrets, r.family_name_ct),
          display_name: enc.decrypt(secrets, r.display_name_ct),
          date_of_birth: enc.decrypt(secrets, r.date_of_birth_ct),
          gender: enc.decrypt(secrets, r.gender_ct),
          grade: r.grade || null,
          employer: enc.decrypt(secrets, r.employer_ct),
          title: enc.decrypt(secrets, r.title_ct),
          do_not_contact: !!r.do_not_contact,
          do_not_contact_reason: enc.decrypt(secrets, r.do_not_contact_reason_ct),
          not_living_together: !!r.not_living_together,
        }
      : {
          code: r.person_code,
          // Non-PII flags safe for the safe surface — they classify behavior,
          // not identity.
          do_not_contact: !!r.do_not_contact,
          not_living_together: !!r.not_living_together,
        },
  }));
}

function addMember(db, secrets, familyCode, personCode, { role = 'member', custody = null, relationLabel = null } = {}) {
  const family = aliases.resolveAlias(db, familyCode);
  const person = aliases.resolveAlias(db, personCode);
  const code = newCode('membership');
  db.prepare(
    `INSERT INTO memberships (code, family_code, person_code, role, relation_label, custody) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(code, family, person, role, relationLabel, custody);
  return code;
}

function endMembership(db, membershipCode, reason = 'edit') {
  db.prepare(
    `UPDATE memberships SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reason = ? WHERE code = ?`
  ).run(reason, membershipCode);
}

function merge(db, secrets, loserCode, winnerCode, opts = {}) {
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

    // Carry the loser's ministry assignments onto the winner. Whole-family
    // rosters (Coffee & Donuts: the Smith family) survive the merge.
    const ministries = require('./ministries');
    ministries.repointFamilyAssignments(db, loser, winner);

    db.prepare(
      `UPDATE families SET status = 'merged', merged_into = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
    ).run(winner, loser);
    aliases.recordAlias(db, loser, winner, 'family');

    const winnerAfter = db.prepare('SELECT * FROM families WHERE code = ?').get(winner);
    history.record(db, {
      entityKind: 'family', entityCode: winner, operation: 'merge',
      before: lr, after: winnerAfter,
      actor: opts.actor || 'system', actorKind: opts.actorKind || null,
      requestId: opts.requestId || null, reason: opts.reason || null,
      relatedCodes: [loser],
    });
  });
  tx();
  return winner;
}

// Split a family by promoting a subset of person codes into a new family.
// History is preserved: the existing memberships are ended (reason='split')
// and new memberships are opened in the new family.
function split(db, secrets, familyCode, personCodes, { displayName = null, notes = null } = {}, opts = {}) {
  const source = aliases.resolveAlias(db, familyCode);
  const personCodesResolved = personCodes.map(c => aliases.resolveAlias(db, c));
  const newFamily = create(db, secrets, { display_name: displayName, notes });
  const sourceBefore = db.prepare('SELECT * FROM families WHERE code = ?').get(source);
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
    const sourceAfter = db.prepare('SELECT * FROM families WHERE code = ?').get(source);
    const newAfter = db.prepare('SELECT * FROM families WHERE code = ?').get(newFamily);
    history.record(db, {
      entityKind: 'family', entityCode: source, operation: 'split',
      before: sourceBefore, after: sourceAfter,
      actor: opts.actor || 'system', actorKind: opts.actorKind || null,
      requestId: opts.requestId || null, reason: opts.reason || null,
      relatedCodes: [newFamily, ...personCodesResolved],
    });
    history.record(db, {
      entityKind: 'family', entityCode: newFamily, operation: 'create',
      before: null, after: newAfter,
      actor: opts.actor || 'system', actorKind: opts.actorKind || null,
      requestId: opts.requestId || null, reason: opts.reason || 'split',
      relatedCodes: [source, ...personCodesResolved],
    });
  });
  tx();
  return newFamily;
}

module.exports = { create, get, list, update, members, addMember, endMembership, merge, split, touchUpdatedAt, archive, reinstate };
