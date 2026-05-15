'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const config = require('./config');
const dbModule = require('./db');
const secretModule = require('./crypto/secret');
const auth = require('./auth/middleware');
const folderWatch = require('./folder-watch');
const log = require('./log');
const { requestLogger, errorLogger } = require('./log/middleware');

const buildHealth = require('./api/health');
const buildFamilies = require('./api/families');
const buildPeople = require('./api/people');
const buildSafe = require('./api/safe');
const { buildSanitize, buildDesanitize } = require('./api/sanitize');
const auditMod = require('./api/audit');
const buildAuditList = auditMod.buildList;
const buildAuditExport = auditMod.buildExternalExport;
const buildConflicts = require('./api/conflicts');
const buildImport = require('./api/import');
const buildImports = require('./api/imports');
const buildRules = require('./api/rules');
const buildApiKeys = require('./api/api-keys');
const buildSearch = require('./api/search');
const buildMembershipHistory = require('./api/membership-history');
const buildProfiles = require('./api/profiles');
const buildSettings = require('./api/settings');
const buildExport = require('./api/export');
const buildRelationships = require('./api/relationships');
const buildNotifications = require('./api/notifications');
const buildScan = require('./api/scan');
const buildIdentityApi = require('./api/identity');
const buildConnectors = require('./api/connectors');
const buildMinistries = require('./api/ministries');
const connectorScheduler = require('./connectors/scheduler');
const eim = require('./identity/eim');
const buildParentPointApi = require('./api/parentpoint');
const ppWebhooks = require('./parentpoint/webhooks');
const ppIdempotency = require('./parentpoint/idempotency');

// method2scope: chooses one of two scoped middlewares depending on the HTTP
// method. GET/HEAD use the read middleware; everything else uses the write
// middleware. Returned function is mounted with app.use(...).
function method2scope(readMw, writeMw) {
  return function pickByMethod(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return readMw(req, res, next);
    return writeMw(req, res, next);
  };
}

function buildApp({ db, secrets, thresholds, watchState = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.json({ limit: '20mb' }));

  // Structured request log: every response writes one JSON line to stderr (or
  // FAMILY_GRAPH_LOG_FILE) with method, path, status, latency, actor, IP.
  // Auth failures and unhandled errors get their own log lines.
  app.use(requestLogger());

  // Inject auth context onto every request: PII routes require Bearer; safe
  // routes require loopback. Scoped Bearer middlewares enforce per-app scopes
  // when consumers use `sk_…` tokens; the master token always satisfies them.
  const bearerRead = auth.bearerAuth(secrets, { db, scope: 'pii.read' });
  const bearerWrite = auth.bearerAuth(secrets, { db, scope: 'pii.write' });
  const bearerSanitize = auth.bearerAuth(secrets, { db, scope: 'sanitize' });
  const bearerAuditRead = auth.bearerAuth(secrets, { db, scope: 'audit.read' });
  const bearerAuditWrite = auth.bearerAuth(secrets, { db, scope: 'audit.write' });
  const bearerImport = auth.bearerAuth(secrets, { db, scope: 'import' });
  const bearerRulesWrite = auth.bearerAuth(secrets, { db, scope: 'rules.write' });
  const bearerMaster = auth.bearerAuth(secrets, { db, scope: '*' });
  const bearerParentPoint = auth.bearerAuth(secrets, { db, scope: 'parentpoint' });
  const loopback = auth.loopbackOnly();

  // Health (open).
  app.use('/api/health', buildHealth({ db, watchState }));

  // Safe surface (loopback only, no PII).
  app.use('/api/safe', loopback, buildSafe({ db, secrets }));

  // PII surface (Bearer required). Different scopes per surface so an app
  // issued only `pii.read` cannot also write or run imports.
  app.use('/api/families', method2scope(bearerRead, bearerWrite), buildFamilies({ db, secrets, includePii: true }));
  app.use('/api/people', method2scope(bearerRead, bearerWrite), buildPeople({ db, secrets, includePii: true }));
  app.use('/api/relationships', bearerWrite, buildRelationships({ db }));
  app.use('/api/conflicts', method2scope(bearerRead, bearerWrite), buildConflicts({ db, secrets }));
  app.use('/api/audit/external-export', bearerAuditWrite, buildAuditExport({ db }));
  app.use('/api/audit', bearerAuditRead, buildAuditList({ db }));
  app.use('/api/import', bearerImport, buildImport({ db, secrets, thresholds }));
  app.use('/api/imports', bearerRead, buildImports({ db }));
  app.use('/api/sanitize', bearerSanitize, buildSanitize({ db, secrets }));
  app.use('/api/desanitize', bearerSanitize, buildDesanitize({ db, secrets }));
  app.use('/api/rules', bearerRulesWrite, buildRules({ db }));
  app.use('/api/keys', bearerMaster, buildApiKeys({ db }));
  app.use('/api/search', bearerRead, buildSearch({ db, secrets }));
  app.use('/api/membership-history', bearerRead, buildMembershipHistory({ db, secrets }));
  app.use('/api/profiles', bearerRulesWrite, buildProfiles({ db }));
  app.use('/api/settings', bearerMaster, buildSettings({ db }));
  app.use('/api/export', bearerRead, buildExport({ db, secrets }));
  app.use('/api/notifications', bearerMaster, buildNotifications({ db }));
  app.use('/api/scan', bearerWrite, buildScan({ db, secrets, thresholds }));
  // External-app identity API. Sibling apps (missionIQ, ParentPoint) call
  // these endpoints to delegate match/resolve to Family Graph.
  app.use('/api/identity', method2scope(bearerRead, bearerWrite), buildIdentityApi({ db, secrets, thresholds }));
  app.use('/api/connectors', bearerImport, buildConnectors({ db, secrets, thresholds }));
  app.use('/api/connector-runs', bearerRead, buildConnectors.buildRunsRouter({ db }));
  // Volunteer ministries + EIM. Reads are gated on pii.read because per-
  // assignment notes can contain operator commentary; writes need pii.write.
  app.use('/api/ministries', method2scope(bearerRead, bearerWrite), buildMinistries({ db, secrets, includePii: true }));

  // ParentPoint × FamilyGraph contract surface (FAMILYGRAPH_INTEGRATION.md
  // v0.1). All routes live under /v1/... so the URL shape matches the
  // contract verbatim and PP integrations don't have to remember a
  // distinct "FG-side" prefix. Single dedicated scope so an operator can
  // issue a scoped key to ParentPoint without granting it the full PII
  // surface.
  app.use('/v1', bearerParentPoint, buildParentPointApi({ db, secrets }));

  // Static client (built React UI).
  const clientDir = path.join(__dirname, '..', 'client', 'dist');
  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get(/^\/(?!api).*/, (req, res) => {
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => {
      res.type('text/plain').send(
        'Family Graph is running. Build the React client with `npm run client:build` to enable the dashboard.'
      );
    });
  }

  // 404 + error handlers (always JSON for /api).
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  app.use(errorLogger());
  app.use((err, req, res, _next) => {
    // The structured logger has already recorded the stack via errorLogger().
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

function start() {
  // Initialise the logger from env first so any pre-boot diagnostics land
  // in the configured destination.
  log.autoConfigureFromEnv();
  // Default log file under $FAMILY_GRAPH_HOME/logs/server.log when no
  // explicit FAMILY_GRAPH_LOG_FILE was set. Stderr remains a copy.
  if (!process.env.FAMILY_GRAPH_LOG_FILE) {
    log.configure({ file: path.join(config.home, 'logs', 'server.log') });
  }
  log.info('boot', { home: config.home, port: config.port, bind: config.bind });

  const secrets = secretModule.load(config.secretPath);
  const db = dbModule.init(config.dbPath);
  const thresholds = config.resolverThresholds;

  const watcherRef = {
    value: null,
    watchDir: config.watchDir,
    outDir: config.outDir,
    processedSinceBoot: 0,
  };
  const watchState = () => ({
    enabled: !!watcherRef.value,
    watch_dir: watcherRef.watchDir,
    out_dir: watcherRef.outDir,
    processed_since_boot: watcherRef.processedSinceBoot,
  });

  const app = buildApp({ db, secrets, thresholds, watchState });
  const server = app.listen(config.port, config.bind, () => {
    // eslint-disable-next-line no-console
    log.info('listening', { url: `http://${config.bind}:${config.port}` });
  });

  // Daily audit sweep. Tier-2 events are never deleted; tier-1 events expire
  // when `audit_retention_days` is set in settings.
  const audit = require('./audit');
  const sweepInterval = setInterval(() => {
    const days = audit.effectiveRetentionDays(db, null);
    if (days) audit.sweep(db, days);
  }, 24 * 60 * 60 * 1000);
  sweepInterval.unref();

  // Daily EIM expiration sweep. Flips certified rows whose eim_expires_on
  // has passed into 'expired' so the dashboard surfaces lapses without
  // waiting for an operator action. Runs once at boot, then every 24h.
  try { eim.recomputeStatus(db); } catch (_) { /* boot-safe */ }
  const eimSweep = setInterval(() => {
    try { eim.recomputeStatus(db); } catch (e) {
      log.error('eim.recompute_failed', { message: e.message, stack: e.stack });
    }
  }, 24 * 60 * 60 * 1000);
  eimSweep.unref();

  // Conflict-assignment expiry sweep. Runs every 15 minutes; on first start we
  // also run it once so a process restart doesn't leave expired assignments
  // visible until the first interval fires.
  const conflictsMod = require('./identity/conflicts');
  try { conflictsMod.sweepExpiredAssignments(db); } catch (_) { /* ok at boot */ }
  try { conflictsMod.sendDueReminders(db); } catch (_) { /* ok at boot */ }
  const assignSweep = setInterval(() => {
    try { conflictsMod.sweepExpiredAssignments(db); } catch (_) { /* ignore */ }
    try { conflictsMod.sendDueReminders(db); } catch (_) { /* ignore */ }
  }, 15 * 60 * 1000);
  assignSweep.unref();

  // Notification dispatcher. Picks up `pending` rows whose `next_attempt_at`
  // has elapsed and sends them via the configured transport. A 60s cadence is
  // tight enough for "near-real-time" delivery and loose enough that a
  // misconfigured Postmark token doesn't hammer the API.
  const notify = require('./notify');
  const dispatchOnce = () => {
    notify.dispatchPending(db).catch(e => {
      // eslint-disable-next-line no-console
      log.error('notify.dispatch_failed', { message: String(e.message || e), stack: e && e.stack });
    });
  };
  if (process.env.FAMILY_GRAPH_DISABLE_NOTIFY !== '1') {
    dispatchOnce();
    const notifyInterval = setInterval(dispatchOnce, 60 * 1000);
    notifyInterval.unref();
  }

  // Connector scheduler. Wakes every 60s, fires due syncs. Disable via
  // FAMILY_GRAPH_DISABLE_CONNECTORS=1 (mirrors the notify dispatcher).
  let connectorSched = null;
  try {
    connectorSched = connectorScheduler.start(db, secrets, thresholds);
  } catch (e) {
    log.error('connector.scheduler.start_failed', { message: e.message, stack: e.stack });
  }

  // ParentPoint webhook dispatcher. Picks up pending pp_webhook_deliveries
  // rows and fires HTTP POSTs with signed payloads. Disable via
  // FAMILY_GRAPH_DISABLE_PP_WEBHOOKS=1 — useful for tests and for
  // operators who want to debug the queue manually.
  let ppWebhookDispatcher = null;
  if (process.env.FAMILY_GRAPH_DISABLE_PP_WEBHOOKS !== '1') {
    try {
      ppWebhookDispatcher = ppWebhooks.start(db, secrets, { intervalMs: 60_000 });
    } catch (e) {
      log.error('pp_webhook.dispatcher.start_failed', { message: e.message, stack: e.stack });
    }
  }

  // Idempotency-key sweeper. Runs every 6h. The lookup path lazily expires
  // its own row on read so steady-state pressure stays bounded; this sweep
  // is the belt-and-suspenders cleanup for the long tail of rows that
  // never get queried again.
  const idemSweep = setInterval(() => {
    try { ppIdempotency.sweep(db); } catch (_) { /* ignore */ }
  }, 6 * 60 * 60 * 1000);
  idemSweep.unref();

  let watcher = null;
  if (process.env.FAMILY_GRAPH_DISABLE_WATCH !== '1') {
    try {
      const wd = folderWatch.start(db, secrets, thresholds, {
        watchDir: config.watchDir,
        outDir: config.outDir,
        processExisting: process.env.FAMILY_GRAPH_WATCH_PROCESS_EXISTING === '1',
        onProcessed: () => { watcherRef.processedSinceBoot += 1; },
      });
      watcher = wd.watcher;
      watcherRef.value = watcher;
      // eslint-disable-next-line no-console
      log.info('folder_watch.started', { watch_dir: config.watchDir, out_dir: config.outDir });
    } catch (e) {
      // eslint-disable-next-line no-console
      log.error('folder_watch.start_failed', { message: e.message, stack: e.stack });
    }
  }

  function shutdown() {
    if (watcher) watcher.close();
    if (connectorSched && connectorSched.stop) connectorSched.stop();
    if (ppWebhookDispatcher && ppWebhookDispatcher.stop) ppWebhookDispatcher.stop();
    clearInterval(idemSweep);
    server.close(() => process.exit(0));
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, server, db, secrets, watcher };
}

module.exports = { buildApp, start };

if (require.main === module) {
  start();
}
