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
const ROLES = new Set(['registered', 'parishioner', 'student', 'alumni', 'staff', 'volunteer', 'clergy', 'member', 'other']);
const PERSON_ONLY_ROLES = new Set(['student']);
// High-level departure classes. The free-text story goes in
// reason_detail; the class is what reports aggregate on ("how many
// families left for another school this year?").
const END_REASONS = new Set(['graduated', 'transferred', 'moved', 'deceased', 'withdrew', 'inactive', 'merge', 'other']);
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
    // Domain verification state rides on every org read so the
    // dashboard can render verify controls. The verification TOKEN is
    // deliberately omitted: it is returned once by setDomain and only
    // belongs in DNS / the well-known file, not on a pii.read surface.
    domain: row.domain || null,
    domain_verified_at: row.domain_verified_at || null,
    domain_verification_method: row.domain_verification_method || null,
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
    // Present when the row came through listAffiliations' join; older
    // single-row reads simply omit them.
    org_name: row.org_name || null,
    org_kind: row.org_kind || null,
    person_code: row.person_code || null,
    family_code: row.family_code || null,
    role: row.role,
    started_at: row.started_at,
    ended_at: row.ended_at,
    reason: row.reason || null,
    reason_detail: row.reason_detail || null,
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
    period: row.period || null,
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
    // Archiving an org breaks the trust chain its staff accounts hang
    // off; their live sessions and pending links die with it.
    if (status === 'archived' && existing.status !== 'archived') {
      require('../auth/accounts').revokeSessionsForOrg(db, code, { reason: 'org_archived' });
    }
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
  // Only fields the caller actually supplied are touched: a bare
  // re-affiliate call (a connector re-confirming presence, a second
  // operator click) must not downgrade a 'student' to the default role
  // or null out existing encrypted notes.
  const existingActive = db.prepare(
    resolvedPerson
      ? `SELECT * FROM affiliations WHERE org_code = ? AND person_code = ? AND ended_at IS NULL`
      : `SELECT * FROM affiliations WHERE org_code = ? AND family_code = ? AND ended_at IS NULL`
  ).get(orgCode, resolvedPerson || resolvedFamily);
  if (existingActive) {
    const nextRole = input.role ? role : existingActive.role;
    const nextNotesCt = 'notes' in input ? enc.encrypt(secrets, input.notes) : existingActive.notes_ct;
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE affiliations SET role = ?, notes_ct = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE code = ?`
      ).run(nextRole, nextNotesCt, existingActive.code);
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

// `ended_at` may be operator-supplied and approximate ("they left
// sometime in 2024"): YYYY, YYYY-MM, YYYY-MM-DD, or a full ISO stamp.
function _normalizeEndedAt(endedAt) {
  if (endedAt == null) return null;
  const s = String(endedAt).trim();
  if (!/^\d{4}(-\d{2}){0,2}(T[\d:.]+Z?)?$/.test(s)) {
    throw new Error('ended_at must be an ISO date (YYYY, YYYY-MM, or YYYY-MM-DD)');
  }
  return s;
}

function _validateReason(reason) {
  if (reason == null) return null;
  const r = String(reason).toLowerCase().trim();
  if (!END_REASONS.has(r)) {
    throw new Error(`reason must be one of: ${[...END_REASONS].join(', ')}`);
  }
  return r;
}

// Sentinel for "the affiliation was already ended": the API maps it to
// a 409 instead of pretending the new reason/date were applied. The old
// silent `return code` made the HTTP layer reply 204 and write an audit
// row for a change that never happened.
const ALREADY_ENDED = Symbol.for('organizations.affiliation.alreadyEnded');

function endAffiliation(db, code, { reason, reason_detail, ended_at, actor, actorKind, requestId } = {}) {
  if (!isValidCode(code, 'affiliation')) throw new Error('invalid affiliation code');
  const row = db.prepare(`SELECT * FROM affiliations WHERE code = ?`).get(code);
  if (!row) return null;
  if (row.ended_at) return ALREADY_ENDED;
  const reasonClass = _validateReason(reason);
  const endedAt = _normalizeEndedAt(ended_at);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE affiliations SET ended_at = COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
         reason = ?, reason_detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE code = ?`
    ).run(endedAt, reasonClass, reason_detail ? String(reason_detail) : null, code);
    const after = db.prepare(`SELECT * FROM affiliations WHERE code = ?`).get(code);
    history.record(db, {
      // 'archive' is the closest fit in the entity_changes operation
      // vocabulary: the row survives, dated and inactive.
      entityKind: 'affiliation', entityCode: code, operation: 'archive',
      before: row, after,
      actor: actor || 'system', actorKind, requestId,
      reason: reasonClass,
    });
    return code;
  });
  return tx();
}

// Transition an active affiliation into a successor role in one
// transaction — the canonical case being student → alumni at
// graduation or unenrollment. Leaving the student role doesn't mean
// leaving the community: the old row survives (dated, classified), and
// a new ongoing affiliation begins where it ended.
function transition(db, secrets, code, input = {}, audit = {}) {
  if (!isValidCode(code, 'affiliation')) throw new Error('invalid affiliation code');
  const row = db.prepare(`SELECT * FROM affiliations WHERE code = ?`).get(code);
  if (!row) return null;
  if (row.ended_at) throw new Error('affiliation already ended; affiliate anew instead');
  // Same guard affiliate() applies: an archived organization takes no
  // new affiliations, and the transition's successor row is a new
  // affiliation. Without this, graduating a student under an archived
  // school would mint exactly the row the affiliate() guard forbids.
  const org = db.prepare(`SELECT status FROM organizations WHERE code = ?`).get(row.org_code);
  if (!org || org.status !== 'active') {
    throw new Error('organization is archived; un-archive before transitioning affiliations');
  }
  const toRole = input.to_role ? String(input.to_role).toLowerCase() : 'alumni';
  if (!ROLES.has(toRole)) throw new Error(`invalid role: ${toRole}`);
  if (toRole === row.role) throw new Error('to_role matches the current role');
  if (PERSON_ONLY_ROLES.has(toRole) && !row.person_code) {
    throw new Error(`role '${toRole}' requires a person affiliation`);
  }
  const reasonClass = _validateReason(input.reason) || (toRole === 'alumni' ? 'graduated' : 'other');
  const endedAt = _normalizeEndedAt(input.ended_at);
  const newCodeValue = newCode('affiliation');
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE affiliations SET ended_at = COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
         reason = ?, reason_detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE code = ?`
    ).run(endedAt, reasonClass, input.reason_detail ? String(input.reason_detail) : null, code);
    const endedRow = db.prepare(`SELECT * FROM affiliations WHERE code = ?`).get(code);
    history.record(db, {
      entityKind: 'affiliation', entityCode: code, operation: 'archive',
      before: row, after: endedRow,
      actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
      reason: reasonClass, relatedCodes: [newCodeValue],
    });
    db.prepare(
      `INSERT INTO affiliations (code, org_code, person_code, family_code, role, started_at, notes_ct)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newCodeValue, row.org_code, row.person_code, row.family_code, toRole,
      endedRow.ended_at, enc.encrypt(secrets, input.notes),
    );
    const created = db.prepare(`SELECT * FROM affiliations WHERE code = ?`).get(newCodeValue);
    history.record(db, {
      entityKind: 'affiliation', entityCode: newCodeValue, operation: 'create',
      before: null, after: created,
      actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
      relatedCodes: [code],
    });
    return newCodeValue;
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
  // verified_at feeds the lexicographic high-water MAX on
  // last_verified_at, so a non-ISO string ('next week', 'TBD') would
  // sort above every real timestamp and permanently pin the marker —
  // the affiliation would never surface on the stale report again.
  // Same accepted shapes as ended_at: YYYY, YYYY-MM, YYYY-MM-DD, or a
  // full ISO stamp.
  let verifiedAt = null;
  if (input.verified_at != null) {
    verifiedAt = String(input.verified_at).trim();
    if (!/^\d{4}(-\d{2}){0,2}(T[\d:.]+Z?)?$/.test(verifiedAt)) {
      throw new Error('verified_at must be an ISO date (YYYY, YYYY-MM, YYYY-MM-DD, or a full timestamp)');
    }
  }
  // Participation-year label: '2025-2026' for a school year, '2026'
  // for a parish year. Free-form but short — it's a roster column.
  let period = null;
  if (input.period != null) {
    period = String(input.period).trim();
    if (!period || period.length > 20) throw new Error('period must be a short label like 2025-2026');
  }
  const code = newCode('affiliation_verification');
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO affiliation_verifications (code, affiliation_code, method, source, period, verified_at, notes_ct)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')), ?)`
    ).run(code, affiliationCode, method, input.source ? String(input.source) : null, period, verifiedAt, enc.encrypt(secrets, input.notes));
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

// The "years in the community" answer for one affiliation: distinct
// participation-year labels from the verification trail.
function listPeriods(db, affiliationCode) {
  if (!isValidCode(affiliationCode, 'affiliation')) return [];
  return db.prepare(
    `SELECT DISTINCT period FROM affiliation_verifications
      WHERE affiliation_code = ? AND period IS NOT NULL ORDER BY period`
  ).all(affiliationCode).map(r => r.period);
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
  // Joined org name/kind ride on every row so consumers (the dashboard
  // Communities panels especially) don't have to fetch the whole
  // organization catalog just to label a handful of affiliations.
  const sql = `SELECT a.*, o.name AS org_name, o.kind AS org_kind
    FROM affiliations a JOIN organizations o ON o.code = a.org_code${where.length ? ' WHERE ' + where.join(' AND ') : ''}
    ORDER BY COALESCE(a.last_verified_at, a.started_at) ASC`;
  return db.prepare(sql).all(...params).map(r => row2affiliation(r, secrets, { includePii }));
}

// ---------------------------------------------------------------------------
// Merge support — same contract as ministries.repoint*Assignments. The
// active-row unique indexes force ending duplicates on the loser instead
// of re-pointing into a collision.
// ---------------------------------------------------------------------------

function _repoint(db, column, loserCode, winnerCode, audit = {}) {
  const selectStmt = db.prepare(`SELECT * FROM affiliations WHERE ${column} = ?`);
  const dupeStmt = db.prepare(
    `SELECT 1 FROM affiliations WHERE org_code = ? AND ${column} = ? AND ended_at IS NULL`
  );
  const endStmt = db.prepare(
    `UPDATE affiliations SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       reason = 'merge', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE code = ?`
  );
  const moveStmt = db.prepare(
    `UPDATE affiliations SET ${column} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE code = ?`
  );
  const reloadStmt = db.prepare(`SELECT * FROM affiliations WHERE code = ?`);
  // Each ended or re-pointed row gets its own entity_changes snapshot:
  // merges mutate affiliations like any other write, and "any change
  // must have an audit trail" includes the merge path.
  const snap = (a, operation) => {
    history.record(db, {
      entityKind: 'affiliation', entityCode: a.code, operation,
      before: a, after: reloadStmt.get(a.code),
      actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
      reason: 'merge', relatedCodes: [loserCode, winnerCode],
    });
  };
  for (const a of selectStmt.all(loserCode)) {
    if (a.ended_at == null && dupeStmt.get(a.org_code, winnerCode)) {
      endStmt.run(a.code);
      snap(a, 'archive');
      continue;
    }
    moveStmt.run(winnerCode, a.code);
    snap(a, 'merge');
  }
}

function repointPersonAffiliations(db, loserCode, winnerCode, audit = {}) {
  _repoint(db, 'person_code', loserCode, winnerCode, audit);
}

function repointFamilyAffiliations(db, loserCode, winnerCode, audit = {}) {
  _repoint(db, 'family_code', loserCode, winnerCode, audit);
}

module.exports = {
  createOrganization,
  listOrganizations,
  getOrganization,
  updateOrganization,
  archiveOrganization,
  affiliate,
  endAffiliation,
  ALREADY_ENDED,
  transition,
  verify,
  listVerifications,
  listPeriods,
  listAffiliations,
  repointPersonAffiliations,
  repointFamilyAffiliations,
  KINDS,
  ROLES,
  END_REASONS,
  VERIFICATION_METHODS,
};
