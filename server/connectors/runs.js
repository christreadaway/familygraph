'use strict';

// State machine for the `connector_runs` table. Mirrors `import_runs` but
// scoped to scheduled / manual / cli connector activity. A single sync
// flows through:
//
//   start()  → INSERT row in status='running'
//   finish() → UPDATE row to status='ok' (links the import_run code)
//   fail()   → UPDATE row to status='error' (with reason + metadata)
//
// Concurrent syncs of the same connector are blocked by isRunning() at the
// caller's gate (the scheduler and the manual-trigger handler both check
// it before calling start()).

const { newCode } = require('../crypto/identifiers');
const log = require('../log');

function _runCode() {
  return newCode('audit').replace(/^au_/, 'crun_');
}

function start(db, { connector, trigger }) {
  const code = _runCode();
  const now = Date.now();
  db.prepare(
    `INSERT INTO connector_runs (code, connector, trigger, status, started_at, metadata)
     VALUES (?, ?, ?, 'running', ?, ?)`
  ).run(code, connector, trigger, now, JSON.stringify({ phase: 'starting' }));
  log.info('connector.run.started', { connector, trigger, run_code: code });
  return code;
}

// Merge a partial state into the run's metadata JSON. Used to publish
// progress (current phase, page counts, etc.) so the dashboard can
// render a live "students pulled: 100/—" indicator while the request is
// in flight. Concurrency note: each call is a single UPDATE on a row
// the caller already owns (only one running row per connector at a
// time is enforced upstream), so a lock-free merge is safe.
function updateProgress(db, code, patch) {
  const row = db.prepare(`SELECT metadata FROM connector_runs WHERE code = ?`).get(code);
  if (!row) return;
  let cur = {};
  try { cur = row.metadata ? JSON.parse(row.metadata) : {}; } catch (_) { cur = {}; }
  const next = { ...cur, ...patch, updated_at: Date.now() };
  db.prepare(`UPDATE connector_runs SET metadata = ? WHERE code = ?`).run(JSON.stringify(next), code);
}

function finish(db, code, { importRun = null, metadata = null } = {}) {
  const now = Date.now();
  const meta = metadata ? JSON.stringify(metadata) : null;
  db.prepare(
    `UPDATE connector_runs SET status = 'ok', ended_at = ?, import_run = ?, metadata = COALESCE(?, metadata) WHERE code = ?`
  ).run(now, importRun, meta, code);
  const row = get(db, code);
  log.info('connector.run.finished', {
    connector: row && row.connector,
    run_code: code,
    status: 'ok',
    duration_ms: row ? (row.ended_at - row.started_at) : null,
    ...(metadata || {}),
  });
  return row;
}

function fail(db, code, { reason, status = 'error', metadata = null } = {}) {
  const now = Date.now();
  const meta = metadata ? JSON.stringify(metadata) : null;
  db.prepare(
    `UPDATE connector_runs SET status = ?, ended_at = ?, reason = ?, metadata = COALESCE(?, metadata) WHERE code = ?`
  ).run(status, now, reason || null, meta, code);
  const row = get(db, code);
  log.error('connector.run.failed', {
    connector: row && row.connector,
    run_code: code,
    reason: reason || null,
    status,
  });
  return row;
}

function get(db, code) {
  const row = db.prepare(`SELECT * FROM connector_runs WHERE code = ?`).get(code);
  if (!row) return null;
  return _hydrate(row);
}

function isRunning(db, connector) {
  const row = db.prepare(
    `SELECT code FROM connector_runs WHERE connector = ? AND status = 'running' LIMIT 1`
  ).get(connector);
  return !!row;
}

function lastRun(db, connector) {
  const row = db.prepare(
    `SELECT * FROM connector_runs WHERE connector = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`
  ).get(connector);
  return row ? _hydrate(row) : null;
}

function lastSuccessful(db, connector) {
  const row = db.prepare(
    `SELECT * FROM connector_runs WHERE connector = ? AND status = 'ok' ORDER BY started_at DESC, rowid DESC LIMIT 1`
  ).get(connector);
  return row ? _hydrate(row) : null;
}

function consecutiveFailures(db, connector) {
  // Count rows from most-recent backwards until we hit a non-error status.
  // We sort by started_at first and rowid as the tiebreaker — ms-resolution
  // timestamps can collide for fast back-to-back fail/finish in tests.
  const rows = db.prepare(
    `SELECT status FROM connector_runs WHERE connector = ? AND status IN ('ok','error','timeout') ORDER BY started_at DESC, rowid DESC LIMIT 50`
  ).all(connector);
  let n = 0;
  for (const r of rows) {
    if (r.status === 'ok') break;
    n += 1;
  }
  return n;
}

function list(db, { connector = null, status = null, limit = 50 } = {}) {
  const filters = [];
  const params = [];
  if (connector) { filters.push('connector = ?'); params.push(connector); }
  if (status) { filters.push('status = ?'); params.push(status); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  params.push(Math.max(1, Math.min(500, Number(limit) || 50)));
  return db
    .prepare(`SELECT * FROM connector_runs ${where} ORDER BY started_at DESC LIMIT ?`)
    .all(...params)
    .map(_hydrate);
}

// Mark stalled `running` rows as failed. Defensive: if the process crashed
// mid-sync the row would be left in 'running' forever and isRunning() would
// permanently block new triggers. The scheduler calls this on boot.
function reapStalled(db, { olderThanMs = 60 * 60 * 1000 } = {}) {
  const cutoff = Date.now() - olderThanMs;
  const r = db.prepare(
    `UPDATE connector_runs SET status = 'error', ended_at = ?, reason = COALESCE(reason, 'stalled') WHERE status = 'running' AND started_at < ?`
  ).run(Date.now(), cutoff);
  return r.changes;
}

function _hydrate(row) {
  return {
    ...row,
    metadata: row.metadata ? _safeParse(row.metadata) : null,
  };
}

function _safeParse(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

module.exports = {
  start,
  finish,
  fail,
  get,
  list,
  isRunning,
  lastRun,
  lastSuccessful,
  consecutiveFailures,
  reapStalled,
  updateProgress,
};
