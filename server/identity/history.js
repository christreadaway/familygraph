'use strict';

// Entity-change log writer + reader. Captures full row snapshots
// alongside the operation that produced them so soft-archived rows can
// be reinstated, and so the operator can answer "what did this person
// look like before May 1?".
//
// Snapshot serialisation: rows are JSON-stringified with BLOB columns
// converted to base64. The dataKey is still required to decrypt the
// resulting string back to plaintext, so the change log itself doesn't
// leak PII at rest. We also cap the per-row snapshot at 64 KB — far
// larger than any sane person/family row but small enough that a
// runaway caller can't fill the table with one giant blob.

const { newCode } = require('../crypto/identifiers');

const MAX_SNAPSHOT_BYTES = 64 * 1024;

const KNOWN_KINDS = new Set([
  'person',
  'family',
  'membership',
  'consent',
  'consent_override',
  'school_context',
  'eim_certification',
  'diocese',
  'webhook_subscription',
]);

const KNOWN_OPERATIONS = new Set([
  'create', 'update', 'archive', 'reinstate', 'merge', 'split', 'delete',
]);

function _normaliseValue(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return { _ct: v.toString('base64') };
  if (v instanceof Uint8Array) return { _ct: Buffer.from(v).toString('base64') };
  return v;
}

function snapshot(row) {
  if (!row || typeof row !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = _normaliseValue(v);
  }
  let serialised;
  try {
    serialised = JSON.stringify(out);
  } catch (_) {
    return JSON.stringify({ _truncated: true });
  }
  if (serialised.length > MAX_SNAPSHOT_BYTES) {
    return JSON.stringify({
      _truncated: true,
      _bytes: serialised.length,
      _prefix: serialised.slice(0, MAX_SNAPSHOT_BYTES - 64),
    });
  }
  return serialised;
}

// record(db, event) writes a single change row.
//   { entityKind, entityCode, operation, before, after, actor, actorKind?,
//     requestId?, relatedCodes?, reason? }
function record(db, event) {
  if (!event || !event.entityKind || !event.entityCode || !event.operation) {
    throw new Error('entity_changes.record: entityKind/entityCode/operation required');
  }
  if (!KNOWN_KINDS.has(event.entityKind)) {
    throw new Error(`entity_changes.record: unknown kind ${event.entityKind}`);
  }
  if (!KNOWN_OPERATIONS.has(event.operation)) {
    throw new Error(`entity_changes.record: unknown operation ${event.operation}`);
  }
  const code = newCode('entity_change');
  db.prepare(
    `INSERT INTO entity_changes
        (code, entity_kind, entity_code, operation,
         before_json, after_json,
         actor, actor_kind, request_id, related_codes, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    code,
    event.entityKind,
    event.entityCode,
    event.operation,
    event.before === undefined ? null : snapshot(event.before),
    event.after === undefined ? null : snapshot(event.after),
    event.actor || 'system',
    event.actorKind || null,
    event.requestId || null,
    Array.isArray(event.relatedCodes) && event.relatedCodes.length
      ? JSON.stringify(event.relatedCodes)
      : null,
    event.reason || null,
  );
  return code;
}

// Read the change history for one entity. Returns rows in reverse
// chronological order with before/after parsed back into objects.
function listFor(db, entityKind, entityCode, { limit = 100 } = {}) {
  // Secondary sort by rowid because two writes can land on the same
  // millisecond (sqlite's strftime resolution). rowid is monotonic, so
  // the newest insert always wins the tie.
  const rows = db.prepare(
    `SELECT * FROM entity_changes
       WHERE entity_kind = ? AND entity_code = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
  ).all(entityKind, entityCode, Math.max(1, Math.min(1000, Number(limit) || 100)));
  return rows.map(_row2event);
}

function _row2event(r) {
  const parseJson = s => {
    if (!s) return null;
    try { return JSON.parse(s); } catch (_) { return null; }
  };
  return {
    code: r.code,
    entity_kind: r.entity_kind,
    entity_code: r.entity_code,
    operation: r.operation,
    before: parseJson(r.before_json),
    after: parseJson(r.after_json),
    actor: r.actor,
    actor_kind: r.actor_kind,
    request_id: r.request_id,
    related_codes: r.related_codes ? parseJson(r.related_codes) : [],
    reason: r.reason,
    created_at: r.created_at,
  };
}

// Most recent change matching a kind+code+operation, or null.
function latestFor(db, entityKind, entityCode, operation) {
  const row = db.prepare(
    `SELECT * FROM entity_changes
       WHERE entity_kind = ? AND entity_code = ? AND operation = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get(entityKind, entityCode, operation);
  return row ? _row2event(row) : null;
}

// Retention sweep. Removes rows older than `days` days. Returns the
// number deleted. Run nightly from the same boot cron that handles the
// audit sweep.
function sweep(db, days) {
  if (typeof days !== 'number' || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const r = db.prepare(`DELETE FROM entity_changes WHERE created_at < ?`).run(cutoff);
  return r.changes;
}

function effectiveRetentionDays(db, fallback = null) {
  const row = db.prepare(`SELECT value_json FROM settings WHERE key = 'entity_changes_retention_days'`).get();
  if (!row) return fallback;
  try { return Number(JSON.parse(row.value_json)); } catch (_) { return fallback; }
}

module.exports = {
  record,
  listFor,
  latestFor,
  sweep,
  snapshot,
  effectiveRetentionDays,
  KNOWN_KINDS,
  KNOWN_OPERATIONS,
  MAX_SNAPSHOT_BYTES,
};
