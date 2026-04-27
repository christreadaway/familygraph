'use strict';

const { newCode } = require('../crypto/identifiers');

// Two-tier audit log:
//   Tier 1: internal Sanctus events (read_pii, write, merge, sanitize, etc.)
//   Tier 2: external-export consent events posted by consuming apps.
// Metadata is JSON. Sanctus PII redactor strips obvious value strings before
// write so the audit log itself is safe to share.

const PII_KEYS = new Set([
  'name',
  'first_name',
  'last_name',
  'given_name',
  'family_name',
  'email',
  'phone',
  'address',
  'line1',
  'line2',
  'dob',
  'date_of_birth',
  'value',
  'plaintext',
]);

function redact(meta) {
  if (!meta) return null;
  if (Array.isArray(meta)) return meta.map(redact);
  if (typeof meta !== 'object') return meta;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (PII_KEYS.has(k.toLowerCase())) {
      out[k] = '[redacted]';
    } else if (v && typeof v === 'object') {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function record(db, event) {
  const code = newCode('audit');
  const tier = event.tier || 1;
  const action = event.action;
  if (!action) throw new Error('audit event requires action');
  const actor = event.actor || 'system';
  const entityCode = event.entityCode || null;
  const entityKind = event.entityKind || null;
  const destination = event.destination || null;
  const metadata = event.metadata == null ? null : JSON.stringify(redact(event.metadata));
  db.prepare(
    `INSERT INTO audit_events (code, tier, action, actor, entity_code, entity_kind, destination, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(code, tier, action, actor, entityCode, entityKind, destination, metadata);
  return code;
}

function list(db, { limit = 100, action, actor, entityCode } = {}) {
  const filters = [];
  const params = [];
  if (action) {
    filters.push('action = ?');
    params.push(action);
  }
  if (actor) {
    filters.push('actor = ?');
    params.push(actor);
  }
  if (entityCode) {
    filters.push('entity_code = ?');
    params.push(entityCode);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  params.push(Math.max(1, Math.min(1000, Number(limit) || 100)));
  return db
    .prepare(`SELECT * FROM audit_events ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params)
    .map(row => ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null }));
}

module.exports = { record, list, redact };
