'use strict';

// Per-person photo + directory consent. Identity-level base lives in
// `person_consents`; per-school overrides live in
// `person_consent_overrides`. Effective consent for a (person, school)
// pair is `override-or-base` per field — each override column is
// nullable so a school can override only one of the two flags.
//
// Migration 0013 introduced the override table at the operator's
// request: §11 Q5 of FAMILYGRAPH_INTEGRATION.md proposed identity-level
// in FG with PP holding per-school overrides; we picked identity-level
// PLUS per-school in FG so a sibling app (the parish faith-formation
// surface, for instance) can also benefit from a school-scoped
// override without each consumer rebuilding its own override table.

const aliases = require('../identity/aliases');
const people = require('../identity/people');
const history = require('../identity/history');

const PHOTO_VALUES = new Set(['allow', 'group_only', 'deny']);
const DIR_VALUES = new Set(['allow', 'deny']);

function _coerce(value, valid, name) {
  if (value === null || value === undefined) return null;
  const v = String(value).toLowerCase();
  if (!valid.has(v)) throw new Error(`invalid ${name}: ${value}`);
  return v;
}

function _assertPersonExists(db, code) {
  if (!db.prepare('SELECT 1 FROM persons WHERE code = ?').get(code)) {
    throw new Error('person not found');
  }
}

// Read the identity-level base. Missing row reads as the contract
// default ('allow' for both).
function get(db, personCode) {
  const target = aliases.resolveAlias(db, personCode);
  const row = db.prepare(
    `SELECT person_code, photo_consent, directory_listing, updated_at
       FROM person_consents WHERE person_code = ?`
  ).get(target);
  if (!row) {
    return {
      person_code: target,
      photo_consent: 'allow',
      directory_listing: 'allow',
      updated_at: null,
      defaulted: true,
    };
  }
  return { ...row, defaulted: false };
}

function set(db, personCode, { photoConsent, directoryListing } = {}, {
  actor = 'system', actorKind = null, requestId = null,
} = {}) {
  const target = aliases.resolveAlias(db, personCode);
  _assertPersonExists(db, target);
  const photo = _coerce(photoConsent, PHOTO_VALUES, 'photoConsent');
  const dir = _coerce(directoryListing, DIR_VALUES, 'directoryListing');

  const existing = db.prepare(
    `SELECT * FROM person_consents WHERE person_code = ?`
  ).get(target);

  const nextPhoto = photo != null ? photo : (existing ? existing.photo_consent : 'allow');
  const nextDir   = dir   != null ? dir   : (existing ? existing.directory_listing : 'allow');

  if (existing) {
    db.prepare(
      `UPDATE person_consents
          SET photo_consent = ?, directory_listing = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE person_code = ?`
    ).run(nextPhoto, nextDir, target);
  } else {
    db.prepare(
      `INSERT INTO person_consents (person_code, photo_consent, directory_listing)
         VALUES (?, ?, ?)`
    ).run(target, nextPhoto, nextDir);
  }
  const after = db.prepare(`SELECT * FROM person_consents WHERE person_code = ?`).get(target);
  history.record(db, {
    entityKind: 'consent', entityCode: target,
    operation: existing ? 'update' : 'create',
    before: existing || null, after,
    actor, actorKind, requestId,
  });
  // Bump persons.updated_at so the changed-since feed surfaces this person.
  people.touchUpdatedAt(db, target);
  return get(db, target);
}

// Override read for one (person, school). Returns the override row or
// null. Each column is independently nullable.
function getOverride(db, personCode, schoolId) {
  const target = aliases.resolveAlias(db, personCode);
  const row = db.prepare(
    `SELECT * FROM person_consent_overrides WHERE person_code = ? AND school_id = ?`
  ).get(target, schoolId);
  return row || null;
}

function setOverride(db, personCode, schoolId, { photoConsent, directoryListing } = {}, {
  actor = 'system', actorKind = null, requestId = null,
} = {}) {
  const target = aliases.resolveAlias(db, personCode);
  _assertPersonExists(db, target);
  if (!schoolId) throw new Error('schoolId required');
  const photo = _coerce(photoConsent, PHOTO_VALUES, 'photoConsent');
  const dir = _coerce(directoryListing, DIR_VALUES, 'directoryListing');

  const existing = getOverride(db, target, schoolId);

  // Override columns are independently nullable. A caller that omits
  // one field keeps whatever was there; an explicit `null` clears that
  // field's override (which falls back to the base).
  const nextPhoto = (photoConsent === null) ? null
    : (photo != null ? photo : (existing ? existing.photo_consent : null));
  const nextDir = (directoryListing === null) ? null
    : (dir != null ? dir : (existing ? existing.directory_listing : null));

  // If both columns end up null, the override row is meaningless — drop it.
  if (nextPhoto == null && nextDir == null) {
    if (existing) {
      db.prepare(
        `DELETE FROM person_consent_overrides WHERE person_code = ? AND school_id = ?`
      ).run(target, schoolId);
      history.record(db, {
        entityKind: 'consent_override',
        entityCode: `${target}/${schoolId}`,
        operation: 'delete',
        before: existing, after: null,
        actor, actorKind, requestId,
      });
      people.touchUpdatedAt(db, target);
    }
    return { person_code: target, school_id: schoolId, photo_consent: null, directory_listing: null, defaulted: true };
  }

  if (existing) {
    db.prepare(
      `UPDATE person_consent_overrides
          SET photo_consent = ?, directory_listing = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE person_code = ? AND school_id = ?`
    ).run(nextPhoto, nextDir, target, schoolId);
  } else {
    db.prepare(
      `INSERT INTO person_consent_overrides (person_code, school_id, photo_consent, directory_listing)
         VALUES (?, ?, ?, ?)`
    ).run(target, schoolId, nextPhoto, nextDir);
  }
  const after = getOverride(db, target, schoolId);
  history.record(db, {
    entityKind: 'consent_override',
    entityCode: `${target}/${schoolId}`,
    operation: existing ? 'update' : 'create',
    before: existing || null, after,
    actor, actorKind, requestId,
  });
  people.touchUpdatedAt(db, target);
  return after;
}

function clearOverride(db, personCode, schoolId, opts = {}) {
  return setOverride(db, personCode, schoolId, { photoConsent: null, directoryListing: null }, opts);
}

function listOverridesForPerson(db, personCode) {
  const target = aliases.resolveAlias(db, personCode);
  return db.prepare(
    `SELECT * FROM person_consent_overrides WHERE person_code = ? ORDER BY school_id ASC`
  ).all(target);
}

// Effective consent for (person, schoolId?). When schoolId is null,
// returns the identity-level base verbatim. When schoolId is set,
// returns the per-field override or falls back to the base.
function effective(db, personCode, schoolId = null) {
  const base = get(db, personCode);
  if (!schoolId) {
    return { ...base, school_id: null, override_applied: false };
  }
  const override = getOverride(db, personCode, schoolId);
  if (!override) {
    return { ...base, school_id: schoolId, override_applied: false };
  }
  const out = {
    person_code: base.person_code,
    school_id: schoolId,
    photo_consent: override.photo_consent != null ? override.photo_consent : base.photo_consent,
    directory_listing: override.directory_listing != null ? override.directory_listing : base.directory_listing,
    updated_at: override.updated_at,
    override_applied: true,
    base_photo_consent: base.photo_consent,
    base_directory_listing: base.directory_listing,
  };
  return out;
}

function listChangedPersonCodes(db, sinceIso, { limit = 500 } = {}) {
  return db.prepare(
    `SELECT person_code FROM person_consents
       WHERE updated_at > ?
       UNION
       SELECT person_code FROM person_consent_overrides
       WHERE updated_at > ?
       ORDER BY person_code ASC LIMIT ?`
  ).all(sinceIso, sinceIso, Math.max(1, Math.min(5000, Number(limit) || 500)))
   .map(r => r.person_code);
}

module.exports = {
  get,
  set,
  effective,
  getOverride,
  setOverride,
  clearOverride,
  listOverridesForPerson,
  listChangedPersonCodes,
  PHOTO_VALUES,
  DIR_VALUES,
};
