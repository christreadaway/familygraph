'use strict';

const crypto = require('crypto');
const audit = require('../audit');
const { newCode } = require('../crypto/identifiers');

// Scope vocabulary. Apps are issued the smallest scope that meets their need.
//   'pii.read'         — may read PII surface (GET /api/families/:c, etc.)
//   'pii.write'        — may write to PII surface (POST/PATCH)
//   'sanitize'         — may call /api/sanitize and /api/desanitize
//   'audit.read'       — may read /api/audit
//   'audit.write'      — may post /api/audit/external-export
//   'import'           — may run bulk imports
//   'rules.write'      — may CRUD resolution rules
//   'parentpoint'      — may call the /v1 ParentPoint contract surface.
//                        Distinct from pii.read/pii.write because the
//                        contract gates a different schema (PP-shaped
//                        objects) and warrants its own attribution in
//                        the audit log.
//   '*'                — full access (equivalent to the master token)
const VALID_SCOPES = new Set([
  'pii.read', 'pii.write', 'sanitize', 'audit.read', 'audit.write',
  'import', 'rules.write', 'parentpoint', '*',
]);

function hash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function newApiKey() {
  // 32 bytes random, base64url-encoded with a "sk_" prefix.
  const raw = crypto.randomBytes(32).toString('base64url');
  return `sk_${raw}`;
}

function provision(db, { name, scopes }) {
  if (!name) throw new Error('name required');
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error('scopes required');
  for (const s of scopes) {
    if (!VALID_SCOPES.has(s)) throw new Error(`unknown scope: ${s}`);
  }
  const code = newCode('audit').replace(/^au_/, 'sk_');
  const token = newApiKey();
  const h = hash(token);
  db.prepare(
    `INSERT INTO api_keys (code, name, hash, scopes) VALUES (?, ?, ?, ?)`
  ).run(code, name, h, JSON.stringify(scopes));
  audit.record(db, {
    action: 'api_key_provision',
    actor: 'operator',
    metadata: { code, name, scopes },
  });
  return { code, token, scopes };
}

function revoke(db, code) {
  const r = db.prepare(
    `UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ? AND revoked_at IS NULL`
  ).run(code);
  if (r.changes) {
    audit.record(db, { action: 'api_key_revoke', actor: 'operator', metadata: { code } });
  }
  return r.changes > 0;
}

function list(db) {
  return db
    .prepare(`SELECT code, name, scopes, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC`)
    .all()
    .map(r => ({ ...r, scopes: JSON.parse(r.scopes), revoked: !!r.revoked_at }));
}

function lookupByToken(db, token) {
  if (!token) return null;
  const row = db.prepare(`SELECT * FROM api_keys WHERE hash = ?`).get(hash(token));
  if (!row || row.revoked_at) return null;
  return { ...row, scopes: JSON.parse(row.scopes) };
}

function recordUse(db, code) {
  db.prepare(
    `UPDATE api_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`
  ).run(code);
}

function authorizes(scopes, required) {
  if (!Array.isArray(scopes)) return false;
  if (scopes.includes('*')) return true;
  if (Array.isArray(required)) {
    return required.every(r => scopes.includes(r));
  }
  return scopes.includes(required);
}

module.exports = { provision, revoke, list, lookupByToken, recordUse, authorizes, hash, VALID_SCOPES };
