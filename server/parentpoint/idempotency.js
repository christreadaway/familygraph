'use strict';

// Idempotency cache for inbound PP writes. §7.2: ParentPoint sends
// `X-Request-Id: pp_{uuid}` and FamilyGraph dedupes within 24h so retries
// on flaky networks don't double-create.
//
// Key shape: (request_id, method, path). Different methods or paths with
// the same request_id are independent — PP could legitimately retry a
// patch then issue an unrelated POST with the same UUID because the
// caller generates it per attempt, not per logical call. The doc commits
// to 24h, so we set expires_at = now + 24h on each insert.

const TTL_HOURS = 24;

function _expiry() {
  return new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000).toISOString();
}

function _nowIso() {
  return new Date().toISOString();
}

// Look up a cached response. Returns null when missing or expired.
// Lazily deletes expired rows for the looked-up key so the table stays
// bounded under steady-state pressure.
function lookup(db, { requestId, method, path }) {
  if (!requestId || !method || !path) return null;
  const row = db.prepare(
    `SELECT response_code, response_body, expires_at FROM pp_idempotency_keys
       WHERE request_id = ? AND method = ? AND path = ?`
  ).get(requestId, method, path);
  if (!row) return null;
  if (row.expires_at <= _nowIso()) {
    db.prepare(
      `DELETE FROM pp_idempotency_keys WHERE request_id = ? AND method = ? AND path = ?`
    ).run(requestId, method, path);
    return null;
  }
  let body = null;
  if (row.response_body) {
    try { body = JSON.parse(row.response_body); } catch (_) { body = row.response_body; }
  }
  return { status: row.response_code, body };
}

function record(db, { requestId, method, path, status, body }) {
  if (!requestId || !method || !path) return;
  const serialized = body == null ? null : JSON.stringify(body);
  db.prepare(
    `INSERT OR REPLACE INTO pp_idempotency_keys
        (request_id, method, path, response_code, response_body, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).run(requestId, method, path, status, serialized, _expiry());
}

// Periodic sweep. Returns the number of rows removed; cheap when the
// table is small.
function sweep(db) {
  const r = db.prepare(`DELETE FROM pp_idempotency_keys WHERE expires_at <= ?`).run(_nowIso());
  return r.changes;
}

module.exports = { lookup, record, sweep, TTL_HOURS };
