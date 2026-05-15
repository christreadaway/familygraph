'use strict';

// Per-person photo + directory consent. Lazy-created on first set; a missing
// row is treated as the contract default ('allow' for both fields).
// Surfaced as the consent object in §6.3 of the integration doc.

const aliases = require('../identity/aliases');
const people = require('../identity/people');

const PHOTO_VALUES = new Set(['allow', 'group_only', 'deny']);
const DIR_VALUES = new Set(['allow', 'deny']);

function _coerce(value, valid, name) {
  if (value === null || value === undefined) return null;
  const v = String(value).toLowerCase();
  if (!valid.has(v)) throw new Error(`invalid ${name}: ${value}`);
  return v;
}

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

// Upsert the consent row. Only fields the caller passes get overwritten;
// missing fields keep their previous value (or the default 'allow').
function set(db, personCode, { photoConsent, directoryListing } = {}) {
  const target = aliases.resolveAlias(db, personCode);
  if (!db.prepare('SELECT 1 FROM persons WHERE code = ?').get(target)) {
    throw new Error('person not found');
  }
  const photo = _coerce(photoConsent, PHOTO_VALUES, 'photoConsent');
  const dir = _coerce(directoryListing, DIR_VALUES, 'directoryListing');

  const existing = db.prepare(
    `SELECT photo_consent, directory_listing FROM person_consents WHERE person_code = ?`
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
  // Bump persons.updated_at so the changed-since feed surfaces this person.
  people.touchUpdatedAt(db, target);

  return get(db, target);
}

// Used by the changed-since endpoint. Returns person_codes whose consent row
// was updated after the supplied ISO timestamp.
function listChangedPersonCodes(db, sinceIso, { limit = 500 } = {}) {
  return db.prepare(
    `SELECT person_code FROM person_consents
       WHERE updated_at > ?
       ORDER BY updated_at ASC
       LIMIT ?`
  ).all(sinceIso, Math.max(1, Math.min(5000, Number(limit) || 500)))
   .map(r => r.person_code);
}

module.exports = { get, set, listChangedPersonCodes, PHOTO_VALUES, DIR_VALUES };
