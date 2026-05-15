'use strict';

// EIM certification history. The contract endpoint
// `POST /v1/persons/{personId}/eimCertifications` adds or extends a
// person's safe-environment training row. We keep the existing
// persons.eim_* columns as the "current" cert pointer (used by the
// expiring-soon dashboard) and record every renewal here.
//
// Migration 0013 added `diocese_code` and `diocese_record_id` — the
// diocese is the system of record (§11 Q6 of the integration doc), so
// every cert points back at the issuing diocese plus the diocese's
// own record id. When a diocese has its own renewal interval set, it
// supersedes the global `eim.renewal_years` setting for auto-derivation.

const enc = require('../crypto/encryption');
const { newCode, isValidCode } = require('../crypto/identifiers');
const aliases = require('../identity/aliases');
const eim = require('../identity/eim');
const people = require('../identity/people');
const history = require('../identity/history');
const dioceses = require('./dioceses');

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

function _addYearsIso(isoDate, years) {
  if (!isoDate || !Number.isFinite(years) || years <= 0) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const dt = new Date(Date.UTC(y + years, mo - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function add(db, secrets, personCode, input = {}, audit = {}) {
  const target = aliases.resolveAlias(db, personCode);
  if (!isValidCode(target, 'person')) throw new Error('invalid person code');
  if (!db.prepare('SELECT 1 FROM persons WHERE code = ?').get(target)) {
    throw new Error('person not found');
  }

  // Normalise key shapes (contract uses completed_on / expires_on; the
  // legacy eim helper looks for eim_completed_on / eim_expires_on).
  const aliased = { ...input };
  if (aliased.completed_on && !aliased.eim_completed_on) aliased.eim_completed_on = aliased.completed_on;
  if (aliased.expires_on && !aliased.eim_expires_on) aliased.eim_expires_on = aliased.expires_on;

  const dioceseCode = input.diocese_code || input.dioceseCode || null;
  if (dioceseCode && !isValidCode(dioceseCode, 'diocese')) {
    throw new Error(`invalid dioceseCode: ${dioceseCode}`);
  }
  if (dioceseCode) {
    const exists = db.prepare(`SELECT 1 FROM dioceses WHERE code = ?`).get(dioceseCode);
    if (!exists) throw new Error('diocese not found');
  }

  // Per-diocese renewal interval supersedes the global setting. We
  // bypass eim.deriveExpiration when the diocese has its own interval
  // and the caller didn't supply an explicit expires_on.
  let expiresFromDiocese = null;
  if (dioceseCode && !aliased.eim_expires_on && aliased.eim_completed_on) {
    const years = dioceses.renewalYears(db, dioceseCode);
    if (years) {
      expiresFromDiocese = _addYearsIso(aliased.eim_completed_on, years);
    }
  }
  if (expiresFromDiocese) aliased.eim_expires_on = expiresFromDiocese;

  const enriched = eim.deriveExpiration(db, aliased);
  const status = _normStatus(enriched.status || enriched.eim_status) || 'certified';
  const completed = _normIsoDate(enriched.completed_on || enriched.eim_completed_on);
  const expires = _normIsoDate(enriched.expires_on || enriched.eim_expires_on);
  const source = enriched.source ? String(enriched.source).slice(0, 120) : null;
  const dioceseRecordId = input.diocese_record_id || input.dioceseRecordId || null;

  const code = newCode('audit').replace(/^au_/, 'eim_');
  db.prepare(
    `INSERT INTO eim_certifications
       (code, person_code, status, completed_on, expires_on, source, notes_ct,
        diocese_code, diocese_record_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    code, target, status, completed, expires, source,
    enc.encrypt(secrets, enriched.notes),
    dioceseCode, dioceseRecordId,
  );

  const after = db.prepare(`SELECT * FROM eim_certifications WHERE code = ?`).get(code);
  history.record(db, {
    entityKind: 'eim_certification', entityCode: code, operation: 'create',
    before: null, after,
    actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
    relatedCodes: [target].concat(dioceseCode ? [dioceseCode] : []),
  });

  // Promote logic (unchanged from v0.1 contract): later expiration
  // promotes; pending promotes when current is null/expired; expired
  // historical backfill never demotes a live cert.
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
    diocese_code: r.diocese_code || null,
    diocese_record_id: r.diocese_record_id || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    notes: includePii ? enc.decrypt(secrets, r.notes_ct) : null,
  }));
}

module.exports = { add, listForPerson, STATUSES };
