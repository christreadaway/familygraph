'use strict';

// Diocese catalog — the system of record for Catholic safe-environment
// (EIM) certifications. FamilyGraph caches what it knows about each
// person's cert; this table records WHO issued it. A cached cert row
// in `eim_certifications` points back at `dioceses.code` via
// `diocese_code` (soft FK so an archived diocese doesn't orphan the
// cert).
//
// Per-diocese renewal interval supersedes the global `eim.renewal_years`
// setting when set: a parish that's part of the Archdiocese of Austin
// (3 years) and one that's part of the Diocese of Sacramento (5 years)
// can co-exist in the same FG without the operator having to flip the
// global setting for every cert insertion.

const enc = require('../crypto/encryption');
const { newCode, isValidCode } = require('../crypto/identifiers');
const history = require('../identity/history');

function _row2diocese(row, secrets, { includeNotes = false } = {}) {
  if (!row) return null;
  return {
    code: row.code,
    name: row.name,
    region: row.region,
    contact_url: row.contact_url,
    eim_program_name: row.eim_program_name,
    eim_renewal_years: row.eim_renewal_years,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    notes: includeNotes ? enc.decrypt(secrets, row.notes_ct) : null,
  };
}

function create(db, secrets, input = {}, audit = {}) {
  if (!input.name || !String(input.name).trim()) throw new Error('name required');
  const code = newCode('diocese');
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO dioceses (code, name, region, contact_url, eim_program_name, eim_renewal_years, notes_ct)
          VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      code,
      String(input.name).trim(),
      input.region || null,
      input.contact_url || input.contactUrl || null,
      input.eim_program_name || input.eimProgramName || null,
      input.eim_renewal_years != null ? Number(input.eim_renewal_years)
        : (input.eimRenewalYears != null ? Number(input.eimRenewalYears) : null),
      enc.encrypt(secrets, input.notes),
    );
    const row = db.prepare(`SELECT * FROM dioceses WHERE code = ?`).get(code);
    history.record(db, {
      entityKind: 'diocese', entityCode: code, operation: 'create',
      before: null, after: row,
      actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
    });
    return code;
  });
  return tx();
}

function get(db, secrets, code, opts = {}) {
  if (!isValidCode(code, 'diocese')) return null;
  const row = db.prepare(`SELECT * FROM dioceses WHERE code = ?`).get(code);
  return _row2diocese(row, secrets, opts);
}

function list(db, secrets, { status = 'active', limit = 100, includeNotes = false } = {}) {
  const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
  // 'all' surfaces every row regardless of status — useful for the
  // operator UI that wants to render the full catalog including
  // archived rows. Any other value is treated as an exact match.
  let rows;
  if (status === 'all') {
    rows = db.prepare(`SELECT * FROM dioceses ORDER BY name ASC LIMIT ?`).all(lim);
  } else {
    rows = db.prepare(
      `SELECT * FROM dioceses WHERE status = ? ORDER BY name ASC LIMIT ?`
    ).all(status, lim);
  }
  return rows.map(r => _row2diocese(r, secrets, { includeNotes }));
}

// Normalize a patch object so callers can use either camelCase or
// snake_case; the snake_case key wins when both are present (a deliberate
// choice — the dashboard sends camelCase, internal code uses snake_case,
// and the conflict tie-break should favour what FG itself emits).
function _normalisePatch(patch) {
  const map = {
    contactUrl: 'contact_url',
    eimProgramName: 'eim_program_name',
    eimRenewalYears: 'eim_renewal_years',
  };
  const out = { ...patch };
  for (const [camel, snake] of Object.entries(map)) {
    if (camel in out && !(snake in out)) out[snake] = out[camel];
  }
  return out;
}

// Sentinel surfaced through the audit object so the HTTP layer can map
// it onto a 412 Precondition Failed without leaking implementation
// detail into the helper return type.
const ETAG_MISMATCH = Symbol.for('integration.dioceses.etagMismatch');

function update(db, secrets, code, patch, audit = {}) {
  if (!isValidCode(code, 'diocese')) return null;
  const tx = db.transaction(() => {
    const existing = db.prepare(`SELECT * FROM dioceses WHERE code = ?`).get(code);
    if (!existing) return null;
    // If the caller supplied an If-Match validator, run the comparison
    // INSIDE the transaction so a concurrent update can't slip between
    // the read and the write.
    if (audit.ifMatch) {
      const etag = require('./etag');
      const currentTag = etag.compute({ diocese: _row2diocese(existing, secrets) });
      if (!etag.matches(audit.ifMatch, currentTag)) return ETAG_MISMATCH;
    }
    const p = _normalisePatch(patch);
    const name = 'name' in p ? String(p.name).trim() : existing.name;
    const region = 'region' in p ? p.region : existing.region;
    const contactUrl = 'contact_url' in p ? p.contact_url : existing.contact_url;
    const eimProgram = 'eim_program_name' in p ? p.eim_program_name : existing.eim_program_name;
    const renewal = 'eim_renewal_years' in p
      ? (p.eim_renewal_years != null ? Number(p.eim_renewal_years) : null)
      : existing.eim_renewal_years;
    const notesCt = 'notes' in p ? enc.encrypt(secrets, p.notes) : existing.notes_ct;
    db.prepare(
      `UPDATE dioceses
          SET name = ?, region = ?, contact_url = ?, eim_program_name = ?,
              eim_renewal_years = ?, notes_ct = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE code = ?`
    ).run(name, region, contactUrl, eimProgram, renewal, notesCt, code);
    const after = db.prepare(`SELECT * FROM dioceses WHERE code = ?`).get(code);
    history.record(db, {
      entityKind: 'diocese', entityCode: code, operation: 'update',
      before: existing, after,
      actor: audit.actor || 'system', actorKind: audit.actorKind, requestId: audit.requestId,
    });
    return code;
  });
  return tx();
}

function archive(db, code, { actor = 'system', actorKind = null, reason = null, requestId = null } = {}) {
  if (!isValidCode(code, 'diocese')) return null;
  const before = db.prepare(`SELECT * FROM dioceses WHERE code = ?`).get(code);
  if (!before) return null;
  const tx = db.transaction(() => {
    if (before.status === 'archived') {
      history.record(db, {
        entityKind: 'diocese', entityCode: code, operation: 'archive',
        before, after: before, actor, actorKind, requestId, reason,
      });
      return { code, before, after: before, noop: true };
    }
    db.prepare(
      `UPDATE dioceses SET status = 'archived', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
    ).run(code);
    const after = db.prepare(`SELECT * FROM dioceses WHERE code = ?`).get(code);
    history.record(db, {
      entityKind: 'diocese', entityCode: code, operation: 'archive',
      before, after, actor, actorKind, requestId, reason,
    });
    return { code, before, after };
  });
  return tx();
}

function reinstate(db, code, { actor = 'system', actorKind = null, reason = null, requestId = null } = {}) {
  if (!isValidCode(code, 'diocese')) return null;
  const before = db.prepare(`SELECT * FROM dioceses WHERE code = ?`).get(code);
  if (!before) return null;
  const tx = db.transaction(() => {
    if (before.status === 'active') {
      history.record(db, {
        entityKind: 'diocese', entityCode: code, operation: 'reinstate',
        before, after: before, actor, actorKind, requestId, reason,
      });
      return { code, before, after: before, noop: true };
    }
    db.prepare(
      `UPDATE dioceses SET status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
    ).run(code);
    const after = db.prepare(`SELECT * FROM dioceses WHERE code = ?`).get(code);
    history.record(db, {
      entityKind: 'diocese', entityCode: code, operation: 'reinstate',
      before, after, actor, actorKind, requestId, reason,
    });
    return { code, before, after };
  });
  return tx();
}

// Resolve the renewal interval for a diocese, falling back to the
// global setting and finally the eim module default (3 years).
function renewalYears(db, code) {
  if (code && isValidCode(code, 'diocese')) {
    const row = db.prepare(`SELECT eim_renewal_years FROM dioceses WHERE code = ?`).get(code);
    if (row && Number.isFinite(row.eim_renewal_years) && row.eim_renewal_years > 0) {
      return row.eim_renewal_years;
    }
  }
  return null;
}

module.exports = { create, get, list, update, archive, reinstate, renewalYears, ETAG_MISMATCH };
