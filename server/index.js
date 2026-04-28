'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const config = require('./config');
const dbModule = require('./db');
const secretModule = require('./crypto/secret');
const auth = require('./auth/middleware');
const folderWatch = require('./folder-watch');

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
const buildRules = require('./api/rules');
const buildApiKeys = require('./api/api-keys');
const buildSearch = require('./api/search');
const buildMembershipHistory = require('./api/membership-history');
const buildProfiles = require('./api/profiles');
const buildSettings = require('./api/settings');
const buildExport = require('./api/export');
const buildRelationships = require('./api/relationships');
const buildNotifications = require('./api/notifications');

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
        'Sanctus is running. Build the React client with `npm run client:build` to enable the dashboard.'
      );
    });
  }

  // 404 + error handlers (always JSON for /api).
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err, req, res, _next) => {
    // eslint-disable-next-line no-console
    console.error('[sanctus] unhandled', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

function start() {
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
    console.log(`[sanctus] listening on http://${config.bind}:${config.port}`);
  });

  // Daily audit sweep. Tier-2 events are never deleted; tier-1 events expire
  // when `audit_retention_days` is set in settings.
  const audit = require('./audit');
  const sweepInterval = setInterval(() => {
    const days = audit.effectiveRetentionDays(db, null);
    if (days) audit.sweep(db, days);
  }, 24 * 60 * 60 * 1000);
  sweepInterval.unref();

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
      console.error('[sanctus] notification dispatch failed:', e.message);
    });
  };
  if (process.env.SANCTUS_DISABLE_NOTIFY !== '1') {
    dispatchOnce();
    const notifyInterval = setInterval(dispatchOnce, 60 * 1000);
    notifyInterval.unref();
  }

  let watcher = null;
  if (process.env.SANCTUS_DISABLE_WATCH !== '1') {
    try {
      const wd = folderWatch.start(db, secrets, thresholds, {
        watchDir: config.watchDir,
        outDir: config.outDir,
        processExisting: process.env.SANCTUS_WATCH_PROCESS_EXISTING === '1',
        onProcessed: () => { watcherRef.processedSinceBoot += 1; },
      });
      watcher = wd.watcher;
      watcherRef.value = watcher;
      // eslint-disable-next-line no-console
      console.log(`[sanctus] folder-watch on ${config.watchDir} -> ${config.outDir}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[sanctus] folder-watch failed to start:', e.message);
    }
  }

  function shutdown() {
    if (watcher) watcher.close();
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
