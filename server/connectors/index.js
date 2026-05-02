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

// Run a sync end-to-end. The optional `fetchImpl` lets tests inject a
// mocked fetch without touching the network.
async function runSync(db, secrets, thresholds, name, { trigger = 'manual', actor = 'operator', fetchImpl = null } = {}) {
  const reg = get(name);
  if (!reg) throw _err('unknown_connector', `unknown connector: ${name}`);
  if (runs.isRunning(db, name)) {
    return { skipped: true, reason: 'already_running' };
  }
  if (!credentials.isComplete(db, secrets, name)) {
    throw _err('config_error', 'connector credentials are incomplete');
  }

  const runCode = runs.start(db, { connector: name, trigger });
  const deadlineMs = Date.now() + SYNC_DEADLINE_MS;
  const startedAt = Date.now();

  try {
    const creds = credentials.load(db, secrets, name);
    const cursor = creds.last_modified_cursor || null;
    const { canonical, metadata } = await reg.module.pullCanonical({ creds, cursor, deadlineMs, fetchImpl });

    let importRunCode = null;
    let totals = null;
    if (canonical.length > 0) {
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
      // Move the cursor only on a successful import.
      credentials.setLastModifiedCursor(db, name, cursorIso);
    }
    credentials.setLastSyncAt(db, name, Date.now());

    runs.finish(db, runCode, {
      importRun: importRunCode,
      metadata: {
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
      metadata: { error_message: String(e.message || e) },
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

function _maybeNotifyFailures(db, name, reason) {
  try {
    const failures = runs.consecutiveFailures(db, name);
    if (failures !== FAILURE_NOTIFY_THRESHOLD) return;
    const cfg = notify.effectiveConfig(db);
    if (!cfg.enabled) return;
    const opSetting = db.prepare(`SELECT value_json FROM settings WHERE key = 'operator_email'`).get();
    const to = opSetting ? _parseJson(opSetting.value_json) : null;
    if (!to || typeof to !== 'string') return;
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
  SYNC_DEADLINE_MS,
  FAILURE_NOTIFY_THRESHOLD,
};
