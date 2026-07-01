'use strict';

// Per-tenant the partner app pairing configuration.
//
// FamilyGraph is the only initiator in the "no open doors" (Option A)
// topology. For every the partner app tenant the operator pairs, FG stores the
// outbound target and the shared secrets here, encrypted at rest with the
// existing dataKey, reusing the connector-credential storage pattern
// (server/connectors/credentials.js). Plaintext secrets are NEVER returned
// over HTTP and NEVER logged.
//
// Storage lives under the existing `settings` table — no schema change.
// Keys are namespaced `partner_pairing.<schoolId>.<field>`. Plain fields
// (partner_base_url, school_id, enabled, check_in_interval_s, last_acked_cursor,
// last_check_in_at) are stored as raw JSON; the three secret fields
// (partner_bearer_credential, shared_webhook_secret, envelope_key) are stored
// as a `_ct` base64-of-ciphertext blob alongside, exactly like connector
// secrets, so they round-trip through settings without new columns.
//
// `envelope_key` is the shared symmetric key for the envelope-encryption
// layer (see server/integration/envelope.js). It is a 64-hex-char string
// (32 bytes) — the same shape as the AES-256-GCM dataKey.

const enc = require('../crypto/encryption');
const audit = require('../audit');
const log = require('../log');

// Fields per pairing. `secret: true` means encrypt-at-rest and never echo.
const FIELDS = [
  { name: 'partner_base_url',           secret: false, required: true  },
  { name: 'school_id',             secret: false, required: true  },
  { name: 'partner_bearer_credential',  secret: true,  required: true  },
  { name: 'shared_webhook_secret', secret: true,  required: true  },
  { name: 'envelope_key',          secret: true,  required: true  },
];

const DEFAULT_INTERVAL_S = 20;
const MIN_INTERVAL_S = 5;
const MAX_INTERVAL_S = 3600;

// schoolId is the tenant key. Same shape constraint as schoolContext /
// consents so it's safe in a settings key, a query string, and a log line.
const _SCHOOL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function _validateSchoolId(v) {
  if (v === null || v === undefined || v === '') throw new Error('schoolId required');
  if (typeof v !== 'string' || !_SCHOOL_ID_RE.test(v)) {
    throw new Error('invalid schoolId: use [A-Za-z0-9._-], max 128 chars, starting with alphanumeric');
  }
  return v;
}

function _put(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value));
}

function _get(db, key) {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value_json); } catch (_) { return undefined; }
}

function _del(db, key) { db.prepare('DELETE FROM settings WHERE key = ?').run(key); }

function _key(schoolId, field) { return `partner_pairing.${schoolId}.${field}`; }

// The registry of paired tenants. We keep an index list so list()/scheduler
// can enumerate pairings without scanning the whole settings table.
function _indexKey() { return 'partner_pairing.__index'; }
function _index(db) {
  const idx = _get(db, _indexKey());
  return Array.isArray(idx) ? idx : [];
}
function _addToIndex(db, schoolId) {
  const idx = _index(db);
  if (!idx.includes(schoolId)) { idx.push(schoolId); _put(db, _indexKey(), idx); }
}
function _removeFromIndex(db, schoolId) {
  const idx = _index(db).filter(s => s !== schoolId);
  _put(db, _indexKey(), idx);
}

function ids(db) { return _index(db); }

function exists(db, schoolId) { return _index(db).includes(schoolId); }

// Returns the plaintext pairing bundle. INTERNAL USE ONLY — never serve over
// HTTP. Any unset field returns null.
function load(db, secrets, schoolId) {
  if (!exists(db, schoolId)) return null;
  const out = {
    schoolId,
    enabled: _get(db, _key(schoolId, 'enabled')) === true,
    checkInIntervalS: _get(db, _key(schoolId, 'check_in_interval_s')) || DEFAULT_INTERVAL_S,
    lastAckedCursor: _get(db, _key(schoolId, 'last_acked_cursor')) || null,
    lastCheckInAt: _get(db, _key(schoolId, 'last_check_in_at')) || null,
  };
  for (const f of FIELDS) {
    if (f.secret) {
      const b64 = _get(db, _key(schoolId, `${f.name}_ct`));
      if (b64) {
        try { out[f.name] = enc.decrypt(secrets, Buffer.from(String(b64), 'base64')); }
        catch (_) { out[f.name] = null; }
      } else out[f.name] = null;
    } else {
      const v = _get(db, _key(schoolId, f.name));
      out[f.name] = (v === undefined ? null : v);
    }
  }
  return out;
}

// Public-safe view: never includes plaintext secrets. The settings UI
// renders `••••••••` for any field marked `set: true`.
function describe(db, secrets, schoolId) {
  if (!exists(db, schoolId)) return null;
  const fields = {};
  for (const f of FIELDS) {
    if (f.secret) {
      const b64 = _get(db, _key(schoolId, `${f.name}_ct`));
      fields[f.name] = { set: !!b64 };
    } else {
      const v = _get(db, _key(schoolId, f.name));
      fields[f.name] = { set: v !== undefined && v !== null && v !== '', value: (v === undefined ? null : v) };
    }
  }
  return {
    schoolId,
    enabled: _get(db, _key(schoolId, 'enabled')) === true,
    check_in_interval_s: _get(db, _key(schoolId, 'check_in_interval_s')) || DEFAULT_INTERVAL_S,
    last_acked_cursor: _get(db, _key(schoolId, 'last_acked_cursor')) || null,
    last_check_in_at: _get(db, _key(schoolId, 'last_check_in_at')) || null,
    fields,
  };
}

function list(db, secrets) {
  return ids(db).map(s => describe(db, secrets, s)).filter(Boolean);
}

function _validateInterval(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('check_in_interval_s must be a number');
  const i = Math.round(n);
  if (i < MIN_INTERVAL_S || i > MAX_INTERVAL_S) {
    throw new Error(`check_in_interval_s must be between ${MIN_INTERVAL_S} and ${MAX_INTERVAL_S} seconds`);
  }
  return i;
}

function _validateHexKey(v) {
  const s = String(v).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error('envelope_key must be 64 hex chars (32 bytes)');
  }
  return s.toLowerCase();
}

function _validateHttpsUrl(v) {
  let u;
  try { u = new URL(String(v)); } catch (_) { throw new Error('partner_base_url must be a valid URL'); }
  if (u.protocol !== 'https:') throw new Error('partner_base_url must be https://');
  return String(v).replace(/\/+$/, '');
}

// Persist a partial update. Plaintext only at the call boundary; the caller
// (route / CLI) has already authenticated. Empty / undefined values are
// ignored so a single field can be patched without resending the rest.
function set(db, secrets, schoolId, payload, opts = {}) {
  const sid = _validateSchoolId(schoolId);
  // school_id is the key; always store it so describe() reflects it.
  _addToIndex(db, sid);
  _put(db, _key(sid, 'school_id'), sid);
  const actor = opts.actor || 'operator';
  const updated = [];
  for (const f of FIELDS) {
    if (f.name === 'school_id') continue;
    if (!Object.prototype.hasOwnProperty.call(payload, f.name)) continue;
    let v = payload[f.name];
    if (v == null || v === '') continue;
    if (f.name === 'partner_base_url') v = _validateHttpsUrl(v);
    if (f.name === 'envelope_key') v = _validateHexKey(v);
    if (f.secret) {
      const ct = enc.encrypt(secrets, String(v));
      _put(db, _key(sid, `${f.name}_ct`), Buffer.from(ct).toString('base64'));
    } else {
      _put(db, _key(sid, f.name), String(v));
    }
    updated.push(f.name);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'check_in_interval_s')) {
    _put(db, _key(sid, 'check_in_interval_s'), _validateInterval(payload.check_in_interval_s));
    updated.push('check_in_interval_s');
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'enabled')) {
    _put(db, _key(sid, 'enabled'), !!payload.enabled);
    updated.push('enabled');
  }
  if (updated.length) {
    audit.record(db, {
      action: 'partner_pairing_set',
      actor,
      metadata: { school_id: sid, fields: updated },
    });
    // Never log secret VALUES — only field names.
    log.info('integration_partner.pairing.set', { school_id: sid, actor, fields: updated });
  }
  return describe(db, secrets, sid);
}

function clear(db, secrets, schoolId, opts = {}) {
  const sid = _validateSchoolId(schoolId);
  if (!exists(db, sid)) return false;
  for (const f of FIELDS) {
    _del(db, _key(sid, f.name));
    _del(db, _key(sid, `${f.name}_ct`));
  }
  _del(db, _key(sid, 'enabled'));
  _del(db, _key(sid, 'check_in_interval_s'));
  _del(db, _key(sid, 'last_acked_cursor'));
  _del(db, _key(sid, 'last_check_in_at'));
  _removeFromIndex(db, sid);
  audit.record(db, {
    action: 'partner_pairing_deleted',
    actor: opts.actor || 'operator',
    metadata: { school_id: sid },
  });
  log.info('integration_partner.pairing.deleted', { school_id: sid, actor: opts.actor || 'operator' });
  return true;
}

// All required secret + URL fields present. A pairing must be complete
// before the scheduler will check it in, even if `enabled` is true.
function isComplete(db, secrets, schoolId) {
  const c = load(db, secrets, schoolId);
  if (!c) return false;
  for (const f of FIELDS) {
    if (f.required && !c[f.name]) return false;
  }
  return true;
}

// Cursor + check-in bookkeeping. These travel cleartext (cursors are not
// PII) and are written by the outbound agent after each successful push.
function setLastAckedCursor(db, schoolId, cursor) {
  if (cursor === null || cursor === undefined) _del(db, _key(schoolId, 'last_acked_cursor'));
  else _put(db, _key(schoolId, 'last_acked_cursor'), String(cursor));
}

function setLastCheckInAt(db, schoolId, unixMs) {
  _put(db, _key(schoolId, 'last_check_in_at'), Number(unixMs));
}

module.exports = {
  FIELDS,
  DEFAULT_INTERVAL_S,
  MIN_INTERVAL_S,
  MAX_INTERVAL_S,
  ids,
  exists,
  load,
  describe,
  list,
  set,
  clear,
  isComplete,
  setLastAckedCursor,
  setLastCheckInAt,
};
