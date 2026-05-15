'use strict';

// EIM certification history. The contract endpoint
// `POST /v1/persons/{personId}/eimCertifications` adds or extends a
// person's safe-environment training row. We keep the existing
// persons.eim_* columns as the "current" cert pointer (used by the
// expiring-soon dashboard) and record every renewal here.
//
// Status flow mirrors the existing eim module:
//   pending    — paperwork in flight
//   certified  — completed, current today
//   expired    — past expiration
//
// `add()` returns the new row's code and bumps persons.eim_* when the
// incoming row supplants the current one.

const enc = require('../crypto/encryption');
const { newCode, isValidCode } = require('../crypto/identifiers');
const aliases = require('../identity/aliases');
const eim = require('../identity/eim');
const people = require('../identity/people');

const STATUSES = new Set(['pending', 'certified', 'expired']);

function _normIsoDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`invalid date (want YYYY-MM-DD): ${v}`);
  return s;
}

function _normStatus(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).toLowerCase();
  if (!STATUSES.has(s)) throw new Error(`invalid status: ${v}`);
  return s;
}

function add(db, secrets, personCode, input = {}) {
  const target = aliases.resolveAlias(db, personCode);
  if (!isValidCode(target, 'person')) throw new Error('invalid person code');
  if (!db.prepare('SELECT 1 FROM persons WHERE code = ?').get(target)) {
    throw new Error('person not found');
  }
  // eim.deriveExpiration looks for `eim_completed_on` / `eim_expires_on`
  // keys (the column names on persons). The contract uses the shorter
  // `completed_on` / `expires_on`. Mirror both directions so the renewal-
  // years auto-fill kicks in regardless of which key shape the caller
  // sent.
  const aliased = { ...input };
  if (aliased.completed_on && !aliased.eim_completed_on) aliased.eim_completed_on = aliased.completed_on;
  if (aliased.expires_on && !aliased.eim_expires_on) aliased.eim_expires_on = aliased.expires_on;
  const enriched = eim.deriveExpiration(db, aliased);
  const status = _normStatus(enriched.status || enriched.eim_status) || 'certified';
  const completed = _normIsoDate(enriched.completed_on || enriched.eim_completed_on);
  const expires = _normIsoDate(enriched.expires_on || enriched.eim_expires_on);
  const source = enriched.source ? String(enriched.source).slice(0, 120) : null;

  const code = newCode('audit').replace(/^au_/, 'eim_');
  db.prepare(
    `INSERT INTO eim_certifications
       (code, person_code, status, completed_on, expires_on, source, notes_ct)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(code, target, status, completed, expires, source, enc.encrypt(secrets, enriched.notes));

  // Promote the new cert to "current" when it has a later expiration than
  // whatever persons.eim_* holds today, OR when status is 'certified'/'pending'
  // and we have no current cert. Expired-only inserts (historical backfill)
  // never demote a still-valid cert.
  const personRow = db.prepare(
    `SELECT eim_status, eim_completed_on, eim_expires_on FROM persons WHERE code = ?`
  ).get(target);
  const shouldPromote = (
    status !== 'expired'
    && (
      !personRow.eim_status
      || (expires && (!personRow.eim_expires_on || expires >= personRow.eim_expires_on))
      || (status === 'pending' && personRow.eim_status === 'expired')
    )
  );
  if (shouldPromote) {
    people.update(db, secrets, target, {
      eim_status: status,
      eim_completed_on: completed,
      eim_expires_on: expires,
      ...(enriched.notes !== undefined ? { eim_notes: enriched.notes } : {}),
    });
  } else {
    // Even if we don't promote, touch updated_at so the changed feed picks
    // up the new history row.
    people.touchUpdatedAt(db, target);
  }

  return code;
}

function listForPerson(db, secrets, personCode, { includePii = false } = {}) {
  const target = aliases.resolveAlias(db, personCode);
  return db.prepare(
    `SELECT * FROM eim_certifications WHERE person_code = ? ORDER BY created_at DESC`
  ).all(target).map(r => ({
    code: r.code,
    status: r.status,
    completed_on: r.completed_on,
    expires_on: r.expires_on,
    source: r.source,
    created_at: r.created_at,
    updated_at: r.updated_at,
    notes: includePii ? enc.decrypt(secrets, r.notes_ct) : null,
  }));
}

module.exports = { add, listForPerson, STATUSES };
