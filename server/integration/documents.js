'use strict';

// Document Vault — FamilyGraph's encrypted store for sensitive child documents
// (sacramental records, learning-accommodation plans, health/allergy records)
// and the mirrored health safety-flag summary.
//
// AT-REST vs ON-THE-WIRE (important distinction):
//   - At rest, the file BYTES and the TITLE are encrypted with the LOCAL
//     dataKey via crypto/encryption.js (the versioned BLOB layout). If the
//     SQLite file is exfiltrated, the bytes are unreadable.
//   - On the wire, an AUTHORIZED fetch RE-SEALS the bytes with the pairing
//     ENVELOPE key (server/integration/envelope.js) for transport to PP.
//     That sealing happens in the outbound agent, not here. This module only
//     ever touches the at-rest layer.
//
// Nothing in this module returns plaintext bytes to a caller without the
// caller having passed the access decision first — but the access DECISION
// lives in documentPolicy.js and is applied by the outbound agent. This module
// is the storage + retrieval primitive; it logs every read/write but does not
// itself enforce the matrix. The operator API and the agent are the two
// gated entry points.

const log = require('../log');
const enc = require('../crypto/encryption');
const aliases = require('../identity/aliases');
const { newCode } = require('../crypto/identifiers');
const policy = require('./documentPolicy');

// Hard size cap for any single document — 10 MB of raw bytes. Enforced on
// store and re-checked on fetch (a document stored before the cap, or via a
// future bulk path, still cannot be SENT over the wire if oversized).
const MAX_BYTES = 10 * 1024 * 1024;

const VALID_KINDS = new Set(['sacramental', 'accommodation', 'health', 'other']);
const VALID_SUBTYPES = new Set([
  'baptism', 'first_communion', 'confirmation', 'marriage',
  'iep', '504', 'mtss',
  'allergy_action_plan', 'health_care_plan',
  'immunization',
  'other',
]);

function _docCode() {
  // Opaque ref `doc_<hex>` — safe to show PP. Reuse the 64-bit hex minting.
  return newCode('audit').replace(/^au_/, 'doc_');
}

function _requirePerson(db, personCode) {
  const target = aliases.resolveAlias(db, personCode);
  if (!db.prepare('SELECT 1 FROM persons WHERE code = ?').get(target)) {
    const e = new Error('person not found');
    e.reason = 'not_found';
    throw e;
  }
  return target;
}

// ── Document storage ────────────────────────────────────────────────────────

// store(db, secrets, { personCode, kind, subtype, title, contentType,
//   contentBase64 | contentBuffer, source }) → { docRef, policyKey, byteSize }
// Encrypts bytes + title at rest with the dataKey. Enforces the size cap.
function store(db, secrets, input, { actor = 'operator' } = {}) {
  if (!input || typeof input !== 'object') {
    const e = new Error('document input required'); e.reason = 'bad_request'; throw e;
  }
  const kind = String(input.kind || '').toLowerCase();
  const subtype = String(input.subtype || 'other').toLowerCase();
  if (!VALID_KINDS.has(kind)) {
    const e = new Error('invalid kind'); e.reason = 'bad_request'; throw e;
  }
  if (!VALID_SUBTYPES.has(subtype)) {
    const e = new Error('invalid subtype'); e.reason = 'bad_request'; throw e;
  }
  const personCode = _requirePerson(db, input.personCode || input.person_code);

  // Accept bytes either as base64 (the wire shape PP sends) or a Buffer
  // (operator API multipart). Normalize to a Buffer.
  let buf;
  if (Buffer.isBuffer(input.contentBuffer)) {
    buf = input.contentBuffer;
  } else if (typeof input.contentBase64 === 'string') {
    buf = Buffer.from(input.contentBase64, 'base64');
  } else {
    const e = new Error('document content required'); e.reason = 'bad_request'; throw e;
  }
  const byteSize = buf.length;
  if (byteSize === 0) {
    const e = new Error('empty document'); e.reason = 'bad_request'; throw e;
  }
  if (byteSize > MAX_BYTES) {
    const e = new Error('document exceeds size cap'); e.reason = 'too_large'; throw e;
  }

  const contentType = String(input.contentType || input.content_type || 'application/octet-stream');
  const title = input.title != null ? String(input.title) : null;
  const source = input.source != null ? String(input.source) : null;
  const policyKey = policy.derivePolicyKey(kind, subtype);

  const code = _docCode();
  // Encrypt bytes at rest. encryption.encrypt() takes a string; the bytes are
  // base64-wrapped first so binary survives the utf8 round-trip cleanly.
  const contentCt = enc.encrypt(secrets, buf.toString('base64'));
  const titleCt = title != null ? enc.encrypt(secrets, title) : null;

  db.prepare(
    `INSERT INTO documents
       (code, person_code, kind, subtype, title_ct, content_ct, content_type,
        byte_size, source, status, policy_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
  ).run(code, personCode, kind, subtype, titleCt, contentCt, contentType, byteSize, source, policyKey);

  log.info('documents.store', {
    docRef: code, person_code: personCode, kind, subtype,
    policy_key: policyKey, byte_size: byteSize, actor,
  });
  return { docRef: code, policyKey, byteSize, personCode };
}

function _row2meta(r) {
  if (!r) return null;
  return {
    docRef: r.code,
    personCode: r.person_code,
    kind: r.kind,
    subtype: r.subtype,
    contentType: r.content_type,
    byteSize: r.byte_size,
    source: r.source || null,
    status: r.status,
    policyKey: r.policy_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Metadata-only lookup (no bytes, no title). Used by the changed-feed and the
// operator list. Title is intentionally NOT decrypted here — see getWithBytes.
function getMeta(db, docRef) {
  const r = db.prepare(`SELECT * FROM documents WHERE code = ?`).get(docRef);
  return _row2meta(r);
}

// Full retrieval INCLUDING decrypted title + bytes. This is the privileged
// path; callers MUST have passed the access decision. Returns null if missing.
// `{ title, contentBase64, contentType, byteSize, ...meta }`.
function getWithBytes(db, secrets, docRef) {
  const r = db.prepare(`SELECT * FROM documents WHERE code = ?`).get(docRef);
  if (!r) return null;
  const meta = _row2meta(r);
  const title = r.title_ct ? enc.decrypt(secrets, r.title_ct) : null;
  // content_ct decrypts to the base64 string we stored; hand it back as-is so
  // the agent can put it straight into the wire envelope.
  const contentBase64 = enc.decrypt(secrets, r.content_ct);
  return { ...meta, title, contentBase64 };
}

// Decrypt only the title for metadata display (operator list / sync event).
function getTitle(db, secrets, docRef) {
  const r = db.prepare(`SELECT title_ct FROM documents WHERE code = ?`).get(docRef);
  if (!r) return null;
  return r.title_ct ? enc.decrypt(secrets, r.title_ct) : null;
}

// List a person's documents (metadata only). status filter defaults to active.
function listForPerson(db, secrets, personCode, { status = 'active', withTitles = false } = {}) {
  const target = aliases.resolveAlias(db, personCode);
  const where = status === 'all' ? '' : 'AND status = ?';
  const params = status === 'all' ? [target] : [target, status];
  const rows = db.prepare(
    `SELECT * FROM documents WHERE person_code = ? ${where} ORDER BY updated_at DESC`
  ).all(...params);
  return rows.map(r => {
    const m = _row2meta(r);
    if (withTitles) m.title = r.title_ct ? enc.decrypt(secrets, r.title_ct) : null;
    return m;
  });
}

// Archive a document (soft). Returns updated meta or null.
function archive(db, docRef, { actor = 'operator' } = {}) {
  const r = db.prepare(`SELECT * FROM documents WHERE code = ?`).get(docRef);
  if (!r) return null;
  if (r.status === 'archived') return _row2meta(r);
  db.prepare(
    `UPDATE documents SET status = 'archived',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
  ).run(docRef);
  log.info('documents.archive', { docRef, actor });
  return getMeta(db, docRef);
}

// ── Health safety flags ─────────────────────────────────────────────────────

// setSafetyFlags(db, secrets, personCode, { allergens, severity, medication,
//   emergencyContact }) → the stored summary (decrypted, for echo).
// Every field is encrypted at rest. Arrays (allergens) are JSON-then-encrypted.
function setSafetyFlags(db, secrets, personCode, input, { actor = 'operator' } = {}) {
  const target = _requirePerson(db, personCode);
  const i = input && typeof input === 'object' ? input : {};

  const allergens = Array.isArray(i.allergens)
    ? i.allergens
    : (i.allergens != null ? [String(i.allergens)] : []);
  const severity = i.severity != null ? String(i.severity) : null;
  const medication = i.medication != null ? String(i.medication) : null;
  const emergencyContact = i.emergencyContact != null ? String(i.emergencyContact)
    : (i.emergency_contact != null ? String(i.emergency_contact) : null);

  const allergensCt = enc.encrypt(secrets, JSON.stringify(allergens));
  const severityCt = severity != null ? enc.encrypt(secrets, severity) : null;
  const medicationCt = medication != null ? enc.encrypt(secrets, medication) : null;
  const ecCt = emergencyContact != null ? enc.encrypt(secrets, emergencyContact) : null;

  db.prepare(
    `INSERT INTO health_safety
        (person_code, allergens_ct, severity_ct, medication_ct, emergency_contact_ct, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      ON CONFLICT(person_code) DO UPDATE SET
        allergens_ct = excluded.allergens_ct,
        severity_ct = excluded.severity_ct,
        medication_ct = excluded.medication_ct,
        emergency_contact_ct = excluded.emergency_contact_ct,
        status = 'active',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(target, allergensCt, severityCt, medicationCt, ecCt);

  log.info('documents.safety_flags.set', { person_code: target, allergen_count: allergens.length, actor });
  return getSafetyFlags(db, secrets, target);
}

function _row2safety(secrets, r) {
  if (!r) return null;
  let allergens = [];
  if (r.allergens_ct) {
    try { allergens = JSON.parse(enc.decrypt(secrets, r.allergens_ct)) || []; }
    catch (_) { allergens = []; }
  }
  return {
    personCode: r.person_code,
    allergens,
    severity: r.severity_ct ? enc.decrypt(secrets, r.severity_ct) : null,
    medication: r.medication_ct ? enc.decrypt(secrets, r.medication_ct) : null,
    emergencyContact: r.emergency_contact_ct ? enc.decrypt(secrets, r.emergency_contact_ct) : null,
    status: r.status,
    updatedAt: r.updated_at,
  };
}

function getSafetyFlags(db, secrets, personCode) {
  const target = aliases.resolveAlias(db, personCode);
  const r = db.prepare(`SELECT * FROM health_safety WHERE person_code = ?`).get(target);
  return _row2safety(secrets, r);
}

// Clear (soft) — flips status to 'cleared'. The changed-feed turns this into a
// health.safetyFlags.cleared tombstone. We blank the encrypted fields too so a
// cleared row carries no residual PII.
function clearSafetyFlags(db, personCode, { actor = 'operator' } = {}) {
  const target = aliases.resolveAlias(db, personCode);
  const r = db.prepare(`SELECT person_code, status FROM health_safety WHERE person_code = ?`).get(target);
  if (!r) return false;
  if (r.status === 'cleared') return true;
  db.prepare(
    `UPDATE health_safety SET status = 'cleared',
        allergens_ct = NULL, severity_ct = NULL, medication_ct = NULL, emergency_contact_ct = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE person_code = ?`
  ).run(target);
  log.info('documents.safety_flags.clear', { person_code: target, actor });
  return true;
}

module.exports = {
  MAX_BYTES,
  store,
  getMeta,
  getWithBytes,
  getTitle,
  listForPerson,
  archive,
  setSafetyFlags,
  getSafetyFlags,
  clearSafetyFlags,
};
