'use strict';

// Organizations (parish / school) and dated, verifiable affiliations.
//
// The model rule: community membership is temporal. Kids graduate,
// families move, people die or stop attending. "Parish, school, or
// both" is never a stored flag — it's a query over affiliation rows
// with started_at / ended_at. Leaving is an end-date with a reason,
// not a delete.
//
// Verification refreshes confidence, never gates existence. Staff will
// know when a family is truly gone, but the SIGNAL that they're gone is
// the absence of activity: no more giving, no ministry participation,
// no communications landing. Each piece of observed activity appends an
// affiliation_verifications row and bumps last_verified_at; a family
// that goes quiet simply stops accruing rows and surfaces on the
// staleness report for a human to confirm. Nothing auto-expires.
//
// Parish registration is family-level by convention ("the [Family Name]
// family is registered"); school enrollment is person-level (the
// student). The schema allows either on any affiliation except that a
// 'student' role must be a person — a family can't be enrolled in
// third grade.

const enc = require('../crypto/encryption');
const { newCode, isValidCode } = require('../crypto/identifiers');
const aliases = require('./aliases');
const history = require('./history');

const KINDS = new Set(['parish', 'school', 'other']);
const ROLES = new Set(['registered', 'parishioner', 'student', 'staff', 'volunteer', 'clergy', 'member', 'other']);
const PERSON_ONLY_ROLES = new Set(['student']);
const VERIFICATION_METHODS = new Set([
  'registration', 'sacrament', 'liturgy', 'ministry', 'giving',
  'communication', 'connector_sync', 'attestation', 'other',
]);

function row2org(row) {
  if (!row) return null;
  return {
    code: row.code,
    name: row.name,
    kind: row.kind,
    diocese_code: row.diocese_code || null,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function row2affiliation(row, secrets, { includePii = false } = {}) {
  if (!row) return null;
  const base = {
    code: row.code,
    org_code: row.org_code,
    person_code: row.person_code || null,
    family_code: row.family_code || null,
    role: row.role,
    started_at: row.started_at,
    ended_at: row.ended_at,
    reason: row.reason || null,
    last_verified_at: row.last_verified_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (!includePii) return base;
  return { ...base, notes: enc.decrypt(secrets, row.notes_ct) };
}

function row2verification(row, secrets, { includePii = false } = {}) {
  if (!row) return null;
  const base = {
    code: row.code,
    affiliation_code: row.affiliation_code,
    method: row.method,
    source: row.source || null,
    verified_at: row.verified_at,
    created_at: row.created_at,
  };
  if (!includePii) return base;
  return { ...base, notes: enc.decrypt(secrets, row.notes_ct) };
}

// ---------------------------------------------------------------------------
// Organization catalog
// ---------------------------------------------------------------------------

function createOrganization(db, secrets, input = {}, audit = {}) {
  if (!input.name || !String(input.name).trim()) {
    throw new Error('organization name is required');
  }
  const kind = input.kind ? String(input.kind).toLowerCase() : null;
  if (!KINDS.has(kind)) {
    throw new Error(`organization kind must be one of: ${[...KINDS].join(', ')}`);
  }
  if (input.diocese_code && !isValidCode(input.diocese_code, 'diocese')) {
    throw new Error('invalid diocese_code');
  }
  const code = newCode('organization');
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO organizations (code, name, kind, diocese_code, notes_ct)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      code,
      String(input.name).trim(),
      kind,
      input.diocese_code || null,
      enc.encrypt(secrets, input.notes),
    );
    const row = db.prepare(`SELECT * FROM organizations WHERE code = ?`).get(code);
    history.record(db, {
      entityKind: 'organization', entityCode: code, operation: 'create',
      before: null, after: row,
      actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
    });
    return code;
  });
  return tx();
}

function listOrganizations(db, { status = 'active', kind = null } = {}) {
  const where = [];
  const params = [];
  if (status !== 'all') { where.push('status = ?'); params.push(status); }
  if (kind) { where.push('kind = ?'); params.push(kind); }
  const sql = `SELECT * FROM organizations${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY name`;
  return db.prepare(sql).all(...params).map(row2org);
}

function getOrganization(db, code) {
  if (!isValidCode(code, 'organization')) return null;
  return row2org(db.prepare(`SELECT * FROM organizations WHERE code = ?`).get(code));
}

function updateOrganization(db, secrets, code, patch = {}, audit = {}) {
  if (!isValidCode(code, 'organization')) return null;
  const existing = db.prepare(`SELECT * FROM organizations WHERE code = ?`).get(code);
  if (!existing) return null;
  const name = 'name' in patch && patch.name != null ? String(patch.name).trim() : existing.name;
  if (!name) throw new Error('organization name cannot be empty');
  let kind = existing.kind;
  if ('kind' in patch) {
    kind = String(patch.kind).toLowerCase();
    if (!KINDS.has(kind)) throw new Error(`invalid organization kind: ${patch.kind}`);
  }
  let dioceseCode = existing.diocese_code;
  if ('diocese_code' in patch) {
    if (patch.diocese_code && !isValidCode(patch.diocese_code, 'diocese')) {
      throw new Error('invalid diocese_code');
    }
    dioceseCode = patch.diocese_code || null;
  }
  let status = existing.status;
  if ('status' in patch) {
    if (patch.status !== 'active' && patch.status !== 'archived') {
      throw new Error(`invalid organization status: ${patch.status}`);
    }
    status = patch.status;
  }
  const notesCt = 'notes' in patch ? enc.encrypt(secrets, patch.notes) : existing.notes_ct;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE organizations SET name = ?, kind = ?, diocese_code = ?, status = ?, notes_ct = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE code = ?`
    ).run(name, kind, dioceseCode, status, notesCt, code);
    const after = db.prepare(`SELECT * FROM organizations WHERE code = ?`).get(code);
    history.record(db, {
      entityKind: 'organization', entityCode: code,
      operation: audit.operation || 'update',
      before: existing, after,
      actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
    });
    return code;
  });
  return tx();
}

function archiveOrganization(db, secrets, code, audit = {}) {
  return updateOrganization(db, secrets, code, { status: 'archived' }, { ...audit, operation: 'archive' });
}

// ---------------------------------------------------------------------------
// Affiliations
// ---------------------------------------------------------------------------

function affiliate(db, secrets, orgCode, input = {}, audit = {}) {
  if (!isValidCode(orgCode, 'organization')) throw new Error('invalid organization code');
  const org = db.prepare(`SELECT * FROM organizations WHERE code = ?`).get(orgCode);
  if (!org) throw new Error('organization not found');
  if (org.status !== 'active') {
    throw new Error('organization is archived; un-archive before adding new affiliations');
  }

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
    if (!db.prepare(`SELECT 1 FROM persons WHERE code = ?`).get(resolvedPerson)) {
      throw new Error('person not found');
    }
  } else {
    if (!isValidCode(familyCode, 'family')) throw new Error('invalid family_code');
    resolvedFamily = aliases.resolveAlias(db, familyCode);
    if (!db.prepare(`SELECT 1 FROM families WHERE code = ?`).get(resolvedFamily)) {
      throw new Error('family not found');
    }
  }

  const role = input.role
    ? String(input.role).toLowerCase()
    : (org.kind === 'parish' && resolvedFamily ? 'registered' : 'member');
  if (!ROLES.has(role)) throw new Error(`invalid role: ${role}`);
  if (PERSON_ONLY_ROLES.has(role) && !resolvedPerson) {
    throw new Error(`role '${role}' requires a person_code`);
  }

  // Re-activate an existing active affiliation rather than stacking
  // duplicates — the active-row unique index would reject the insert.
  const existingActive = db.prepare(
    resolvedPerson
      ? `SELECT * FROM affiliations WHERE org_code = ? AND person_code = ? AND ended_at IS NULL`
      : `SELECT * FROM affiliations WHERE org_code = ? AND family_code = ? AND ended_at IS NULL`
  ).get(orgCode, resolvedPerson || resolvedFamily);
  if (existingActive) {
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE affiliations SET role = ?, notes_ct = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE code = ?`
      ).run(role, enc.encrypt(secrets, input.notes), existingActive.code);
      const after = db.prepare(`SELECT * FROM affiliations WHERE code = ?`).get(existingActive.code);
      history.record(db, {
        entityKind: 'affiliation', entityCode: existingActive.code, operation: 'update',
        before: existingActive, after,
        actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
      });
      return existingActive.code;
    });
    return tx();
  }

  const code = newCode('affiliation');
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO affiliations (code, org_code, person_code, family_code, role, notes_ct)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(code, orgCode, resolvedPerson, resolvedFamily, role, enc.encrypt(secrets, input.notes));
    const row = db.prepare(`SELECT * FROM affiliations WHERE code = ?`).get(code);
    history.record(db, {
      entityKind: 'affiliation', entityCode: code, operation: 'create',
      before: null, after: row,
      actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
    });
    return code;
  });
  return tx();
}

function endAffiliation(db, code, { reason, actor, actorKind, requestId } = {}) {
  if (!isValidCode(code, 'affiliation')) throw new Error('invalid affiliation code');
  const row = db.prepare(`SELECT * FROM affiliations WHERE code = ?`).get(code);
  if (!row) return null;
  if (row.ended_at) return code;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE affiliations SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE code = ?`
    ).run(reason ? String(reason) : null, code);
    const after = db.prepare(`SELECT * FROM affiliations WHERE code = ?`).get(code);
    history.record(db, {
      // 'archive' is the closest fit in the entity_changes operation
      // vocabulary: the row survives, dated and inactive.
      entityKind: 'affiliation', entityCode: code, operation: 'archive',
      before: row, after,
      actor: actor || 'system', actorKind, requestId,
      reason: reason ? String(reason) : null,
    });
    return code;
  });
  return tx();
}

// Record one observed piece of activity that demonstrates the
// affiliation is alive, and bump last_verified_at in the same
// transaction. verified_at may be supplied for backfilled activity
// (e.g. a giving batch imported a week late); last_verified_at only
// moves forward.
function verify(db, secrets, affiliationCode, input = {}, audit = {}) {
  if (!isValidCode(affiliationCode, 'affiliation')) {
    throw new Error('invalid affiliation code');
  }
  const row = db.prepare(`SELECT * FROM affiliations WHERE code = ?`).get(affiliationCode);
  if (!row) return null;
  const method = input.method ? String(input.method).toLowerCase() : null;
  if (!VERIFICATION_METHODS.has(method)) {
    throw new Error(`verification method must be one of: ${[...VERIFICATION_METHODS].join(', ')}`);
  }
  const verifiedAt = input.verified_at ? String(input.verified_at) : null;
  const code = newCode('affiliation_verification');
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO affiliation_verifications (code, affiliation_code, method, source, verified_at, notes_ct)
       VALUES (?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')), ?)`
    ).run(code, affiliationCode, method, input.source ? String(input.source) : null, verifiedAt, enc.encrypt(secrets, input.notes));
    const v = db.prepare(`SELECT * FROM affiliation_verifications WHERE code = ?`).get(code);
    db.prepare(
      `UPDATE affiliations
          SET last_verified_at = MAX(COALESCE(last_verified_at, ''), ?),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE code = ?`
    ).run(v.verified_at, affiliationCode);
    history.record(db, {
      entityKind: 'affiliation_verification', entityCode: code, operation: 'create',
      before: null, after: v,
      actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
      relatedCodes: [affiliationCode],
    });
    return code;
  });
  return tx();
}

function listVerifications(db, secrets, affiliationCode, { includePii = false, limit = 100 } = {}) {
  if (!isValidCode(affiliationCode, 'affiliation')) return [];
  const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
  const rows = db.prepare(
    `SELECT * FROM affiliation_verifications WHERE affiliation_code = ?
      ORDER BY verified_at DESC LIMIT ?`
  ).all(affiliationCode, lim);
  return rows.map(r => row2verification(r, secrets, { includePii }));
}

function listAffiliations(db, secrets, {
  org_code, person_code, family_code,
  status = 'active', stale_days = null, includePii = false,
} = {}) {
  const where = [];
  const params = [];
  if (org_code) { where.push('org_code = ?'); params.push(org_code); }
  if (person_code) { where.push('person_code = ?'); params.push(aliases.resolveAlias(db, person_code)); }
  if (family_code) { where.push('family_code = ?'); params.push(aliases.resolveAlias(db, family_code)); }
  if (status === 'active') where.push('ended_at IS NULL');
  else if (status === 'ended') where.push('ended_at IS NOT NULL');
  // The rolling-verification work queue: active rows that nothing has
  // confirmed within the window. A null last_verified_at falls back to
  // started_at so a brand-new affiliation isn't instantly "stale".
  if (stale_days != null) {
    const days = Math.max(1, Number(stale_days) || 365);
    where.push(`COALESCE(last_verified_at, started_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ? || ' days')`);
    params.push(days);
  }
  const sql = `SELECT * FROM affiliations${where.length ? ' WHERE ' + where.join(' AND ') : ''}
    ORDER BY COALESCE(last_verified_at, started_at) ASC`;
  return db.prepare(sql).all(...params).map(r => row2affiliation(r, secrets, { includePii }));
}

// ---------------------------------------------------------------------------
// Merge support — same contract as ministries.repoint*Assignments. The
// active-row unique indexes force ending duplicates on the loser instead
// of re-pointing into a collision.
// ---------------------------------------------------------------------------

function _repoint(db, column, loserCode, winnerCode) {
  const rows = db.prepare(`SELECT * FROM affiliations WHERE ${column} = ?`).all(loserCode);
  for (const a of rows) {
    if (a.ended_at == null) {
      const dupe = db.prepare(
        `SELECT 1 FROM affiliations WHERE org_code = ? AND ${column} = ? AND ended_at IS NULL`
      ).get(a.org_code, winnerCode);
      if (dupe) {
        db.prepare(
          `UPDATE affiliations SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             reason = 'merge', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE code = ?`
        ).run(a.code);
        continue;
      }
    }
    db.prepare(
      `UPDATE affiliations SET ${column} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE code = ?`
    ).run(winnerCode, a.code);
  }
}

function repointPersonAffiliations(db, loserCode, winnerCode) {
  _repoint(db, 'person_code', loserCode, winnerCode);
}

function repointFamilyAffiliations(db, loserCode, winnerCode) {
  _repoint(db, 'family_code', loserCode, winnerCode);
}

module.exports = {
  createOrganization,
  listOrganizations,
  getOrganization,
  updateOrganization,
  archiveOrganization,
  affiliate,
  endAffiliation,
  verify,
  listVerifications,
  listAffiliations,
  repointPersonAffiliations,
  repointFamilyAffiliations,
  KINDS,
  ROLES,
  VERIFICATION_METHODS,
};
