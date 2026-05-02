'use strict';

// Connector registry + sync orchestrator. Two responsibilities:
//
//  1. Map the operator-visible name (`facts`, `ministry_platform`) to a
//     connector module that knows how to talk to the vendor.
//  2. Run a sync end-to-end: pull canonical rows from the vendor, run
//     them through the existing import pipeline (so the resolver, audit
//     trail, and conflicts queue all work the same as for file ingest),
//     and record the outcome on `connector_runs`.

const credentials = require('./credentials');
const runs = require('./runs');
const factsMod = require('./facts');
const mpMod = require('./ministry-platform');
const importPipeline = require('../identity/import');
const audit = require('../audit');
const log = require('../log');
const notify = require('../notify');

// 60 minutes wall-clock budget per PRD §5.9.
const SYNC_DEADLINE_MS = 60 * 60 * 1000;

// Notify after 3 consecutive failures, but only re-notify after recovery.
const FAILURE_NOTIFY_THRESHOLD = 3;

const REGISTRY = {
  facts: {
    name: 'facts',
    sourceTag: 'facts_api',
    category: 'school',
    module: factsMod,
  },
  ministry_platform: {
    name: 'ministry_platform',
    sourceTag: 'ministry_platform_api',
    category: 'church',
    module: mpMod,
  },
};

function names() { return Object.keys(REGISTRY); }
function get(name) { return REGISTRY[name] || null; }

async function testConnection(db, secrets, name, opts = {}) {
  const reg = get(name);
  if (!reg) throw _err('unknown_connector', `unknown connector: ${name}`);
  const creds = credentials.load(db, secrets, name);
  if (!credentials.isComplete(db, secrets, name)) {
    throw _err('config_error', 'connector credentials are incomplete');
  }
  const out = await reg.module.testConnection({ creds, fetchImpl: opts.fetchImpl || null });
  audit.record(db, {
    action: 'connector_test_ok',
    actor: opts.actor || 'operator',
    metadata: { connector: name, sample_count: out.sample_count || 0 },
  });
  return out;
}

// startRun: synchronous gate that creates the connector_runs row and
// returns its code. Returns null if the run can't start (unknown
// connector, missing credentials, already running). Errors that block
// the caller (config_error, unknown_connector) throw; transient gates
// (already_running) return a sentinel object for the caller to inspect.
function startRun(db, secrets, name, { trigger = 'manual' } = {}) {
  const reg = get(name);
  if (!reg) throw _err('unknown_connector', `unknown connector: ${name}`);
  if (!credentials.isComplete(db, secrets, name)) {
    throw _err('config_error', 'connector credentials are incomplete');
  }
  if (runs.isRunning(db, name)) {
    const e = new Error('a sync is already in progress for this connector');
    e.reason = 'already_running';
    throw e;
  }
  return runs.start(db, { connector: name, trigger });
}

// executeRun: the async body of a sync. Caller has already created the
// connector_runs row via startRun() and holds the runCode. This is
// split out so the HTTP endpoint can return immediately with the
// runCode while the work continues in the background — the dashboard
// polls /api/connector-runs/:code for progress + final state.
async function executeRun(db, secrets, thresholds, name, runCode, { trigger = 'manual', actor = 'operator', fetchImpl = null } = {}) {
  const reg = get(name);
  const startedAt = Date.now();
  const deadlineMs = startedAt + SYNC_DEADLINE_MS;

  // onProgress: writes the current phase + counters into
  // connector_runs.metadata so the dashboard's poll sees live progress.
  const onProgress = (phase, details = {}) => {
    try { runs.updateProgress(db, runCode, { phase, ...(details || {}) }); }
    catch (_) { /* progress is best-effort; never fail the sync */ }
  };

  try {
    onProgress('authenticating');
    const creds = credentials.load(db, secrets, name);
    const cursor = creds.last_modified_cursor || null;
    const { canonical, metadata } = await reg.module.pullCanonical({
      creds, cursor, deadlineMs, fetchImpl, onProgress,
    });

    let importRunCode = null;
    let totals = null;
    if (canonical.length > 0) {
      onProgress('importing', { rows_pulled: canonical.length });
      const cursorIso = new Date().toISOString();
      const result = importPipeline.importBatch(db, secrets, thresholds, canonical, {
        source: reg.sourceTag,
        sourceRef: `connector:${name}:${runCode}`,
        actor: actor || `connector:${name}`,
        category: reg.category,
        tags: ['connector', trigger],
        trigger,
      });
      importRunCode = result.importRunCode;
      totals = result.totals;
      credentials.setLastModifiedCursor(db, name, cursorIso);
    } else {
      onProgress('importing', { rows_pulled: 0 });
    }
    credentials.setLastSyncAt(db, name, Date.now());

    runs.finish(db, runCode, {
      importRun: importRunCode,
      metadata: {
        phase: 'done',
        ...metadata,
        rows_pulled: canonical.length,
        ...(totals || {}),
      },
    });
    audit.record(db, {
      action: 'connector_sync_ok',
      actor: actor || `connector:${name}`,
      metadata: { connector: name, run_code: runCode, import_run: importRunCode, rows_pulled: canonical.length },
    });
    return {
      ok: true,
      run_code: runCode,
      import_run: importRunCode,
      rows_pulled: canonical.length,
      totals,
      duration_ms: Date.now() - startedAt,
    };
  } catch (e) {
    const reason = e.reason || 'http_error';
    runs.fail(db, runCode, {
      reason,
      status: reason === 'timeout' ? 'timeout' : 'error',
      metadata: { phase: 'failed', error_message: String(e.message || e) },
    });
    audit.record(db, {
      action: 'connector_sync_error',
      actor: actor || `connector:${name}`,
      metadata: { connector: name, run_code: runCode, reason, message: String(e.message || e) },
    });
    _maybeNotifyFailures(db, name, reason);
    return {
      ok: false,
      run_code: runCode,
      reason,
      message: String(e.message || e),
      duration_ms: Date.now() - startedAt,
    };
  }
}

// Run a sync end-to-end. The optional `fetchImpl` lets tests inject a
// mocked fetch without touching the network. This is the synchronous
// path used by the CLI and tests; the HTTP endpoint uses
// startSyncBackground for non-blocking behavior.
async function runSync(db, secrets, thresholds, name, opts = {}) {
  let runCode;
  try {
    runCode = startRun(db, secrets, name, { trigger: opts.trigger || 'manual' });
  } catch (e) {
    if (e.reason === 'already_running') return { skipped: true, reason: 'already_running' };
    throw e;
  }
  return executeRun(db, secrets, thresholds, name, runCode, opts);
}

// startSyncBackground: kick off a sync without awaiting it. Returns the
// runCode immediately so the HTTP caller can return 202 and let the
// dashboard poll. Any error during the run lands on the connector_runs
// row, the same way a synchronous run would record it.
function startSyncBackground(db, secrets, thresholds, name, opts = {}) {
  const runCode = startRun(db, secrets, name, { trigger: opts.trigger || 'manual' });
  // Fire-and-forget. .catch is defensive: executeRun already turns
  // every error into a connector_runs.status='error' row, but a bug in
  // the orchestrator itself shouldn't crash the process.
  Promise.resolve().then(() => executeRun(db, secrets, thresholds, name, runCode, opts)).catch(e => {
    log.error('connector.background.unhandled', { connector: name, run_code: runCode, message: String(e.message || e) });
  });
  return { run_code: runCode };
}

function _operatorEmail(db) {
  const opSetting = db.prepare(`SELECT value_json FROM settings WHERE key = 'operator_email'`).get();
  const to = opSetting ? _parseJson(opSetting.value_json) : null;
  return (to && typeof to === 'string') ? to : null;
}

function _maybeNotifyFailures(db, name, reason) {
  try {
    // PRD §5.9.1: a rate_limited failure is unusual enough that the
    // operator should be notified on the FIRST occurrence, not after
    // three. (Vendor enforcement of rate limits would imply we're
    // pulling more aggressively than expected, or the vendor changed
    // their published policy — either way, worth surfacing now.)
    if (reason === 'rate_limited') {
      _notifyRateLimited(db, name);
      // Fall through so the 3-in-a-row path still tracks it.
    }
    const failures = runs.consecutiveFailures(db, name);
    if (failures !== FAILURE_NOTIFY_THRESHOLD) return;
    const cfg = notify.effectiveConfig(db);
    if (!cfg.enabled) return;
    const to = _operatorEmail(db);
    if (!to) return;
    notify.enqueue(db, {
      kind: 'expired',
      to,
      subject: `[Family Graph] ${name} connector failed ${failures}× in a row`,
      text:
        `The Family Graph ${name} connector has failed ${failures} consecutive times.\n` +
        `Most recent reason: ${reason}\n\n` +
        `Open the dashboard at ${cfg.dashboardUrl}/settings/connectors to investigate.\n` +
        `Family Graph will keep trying on the configured schedule. No further notifications will be sent until it succeeds at least once.`,
    });
  } catch (e) {
    log.warn('connector.notify_skipped', { connector: name, error: String(e.message || e) });
  }
}

function _notifyRateLimited(db, name) {
  try {
    const cfg = notify.effectiveConfig(db);
    if (!cfg.enabled) return;
    const to = _operatorEmail(db);
    if (!to) return;
    notify.enqueue(db, {
      kind: 'expired',
      to,
      subject: `[Family Graph] ${name} connector hit a rate limit (HTTP 429)`,
      text:
        `The Family Graph ${name} connector received an HTTP 429 from the vendor twice in a row` +
        ` and aborted the sync to be a polite client.\n\n` +
        `No partial data was written. The next scheduled sync will run normally.\n\n` +
        `If 429s become routine, the operator may want to lengthen the schedule (e.g. switch from\n` +
        `Hourly to Daily) until the vendor confirms a higher rate budget.\n\n` +
        `Open the dashboard at ${cfg.dashboardUrl}/settings/connectors/${name} to investigate.`,
    });
  } catch (e) {
    log.warn('connector.rate_limit_notify_skipped', { connector: name, error: String(e.message || e) });
  }
}

function _parseJson(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

function _err(reason, message) {
  const e = new Error(message);
  e.reason = reason;
  return e;
}

module.exports = {
  REGISTRY,
  names,
  get,
  testConnection,
  runSync,
  startSyncBackground,
  startRun,
  executeRun,
  SYNC_DEADLINE_MS,
  FAILURE_NOTIFY_THRESHOLD,
};
