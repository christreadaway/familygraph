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
const buildPpPairings = require('./api/pp-pairings');
const buildDocuments = require('./api/documents');
const buildMinistries = require('./api/ministries');
const buildOrganizations = require('./api/organizations');
const buildAuthApi = require('./api/auth');
const buildAdminAccounts = require('./api/admin-accounts');
const connectorScheduler = require('./connectors/scheduler');
const eim = require('./identity/eim');
const entityHistory = require('./identity/history');
const buildIntegrationApi = require('./api/integration');
const integrationWebhooks = require('./integration/webhooks');
const integrationFederation = require('./integration/federation');
const integrationIdempotency = require('./integration/idempotency');
const ppOutboundScheduler = require('./integration/outbound-scheduler');
const rateLimit = require('./auth/rate-limit');

// method2scope: chooses one of two scoped middlewares depending on the HTTP
// method. GET/HEAD use the read middleware; everything else uses the write
// middleware. Returned function is mounted with app.use(...).
function method2scope(readMw, writeMw) {
  return function pickByMethod(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return readMw(req, res, next);
    return writeMw(req, res, next);
  };
}

// Defense-in-depth response headers. We're loopback-by-default so most of
// these are belt-and-suspenders for the operator who flips bind to 0.0.0.0,
// but the cost is one extra middleware call per request.
//
//   X-Content-Type-Options: nosniff
//     Browsers respect the declared Content-Type. JSON responses won't be
//     re-interpreted as HTML.
//   X-Frame-Options: DENY
//     Dashboard can't be iframed → clickjacking surface goes to zero.
//   Referrer-Policy: no-referrer
//     Outbound links from the dashboard never leak the FG URL.
//   Cross-Origin-Resource-Policy: same-origin
//     A different origin can't fetch our JSON via <link>/<img>.
//   Permissions-Policy
//     Tell browsers we don't need camera/mic/geolocation. Defense for any
//     future page that gets bundled into the SPA.
//
// We do NOT set Strict-Transport-Security because the default bind is
// loopback (no TLS layer). Operators who terminate TLS in front of FG can
// add HSTS at the proxy.
function securityHeadersMw(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  // CSP only for HTML responses — JSON shouldn't trigger CSP processing.
  // The SPA is built by Vite into static JS + CSS under client/dist with
  // no inline scripts; strict CSP doesn't break it. We allow inline styles
  // because the design tokens use them and a `style-src 'self' 'unsafe-inline'`
  // posture is the standard SPA compromise.
  if (req.accepts(['html', 'json']) === 'html') {
    res.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; ')
    );
  }
  next();
}

function buildApp({ db, secrets, thresholds, watchState = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // Defense-in-depth response headers (see securityHeadersMw above).
  app.use(securityHeadersMw);

  // Body size limits, scoped by route:
  //  - /api/import + /api/sanitize accept large payloads (bulk CSV import,
  //    multi-MB sanitization batches). Cap at 20 MB to stop a hostile
  //    caller from exhausting memory.
  //  - /v1 + the rest of /api carry small JSON objects. Cap at 256 KB
  //    so a runaway client can't post a 50 MB person-update body.
  //  - The webhook subscription path doesn't need much; the same 256 KB cap
  //    covers it.
  app.use('/api/import', express.json({ limit: '20mb' }));
  app.use('/api/sanitize', express.json({ limit: '20mb' }));
  app.use('/api/desanitize', express.json({ limit: '20mb' }));
  app.use('/api/scan', express.json({ limit: '20mb' }));
  // Document vault store accepts a base64 file body; the 10 MB raw cap is ~13.4
  // MB base64, so a 16 MB JSON limit gives headroom (the byte cap is enforced
  // in documents.store, not here).
  app.use('/api/documents', express.json({ limit: '16mb' }));
  app.use(express.json({ limit: '256kb' }));

  // Structured request log: every response writes one JSON line to stderr (or
  // FAMILY_GRAPH_LOG_FILE) with method, path, status, latency, actor, IP.
  // Auth failures and unhandled errors get their own log lines.
  app.use(requestLogger());

  // Rate limits. The integration surface needs to flow freely; defaults
  // are deliberately generous (10 req/sec for /v1 = 600/min per token).
  // Sanitize gets a stricter bucket because it's CPU-heavy. Disable
  // entirely with FAMILY_GRAPH_DISABLE_RATE_LIMIT=1 (tests use this).
  const piiRateLimit = rateLimit.build({ capacity: 200, refillPerSec: 10, name: 'pii' });
  const v1RateLimit = rateLimit.build({ capacity: 300, refillPerSec: 20, name: 'v1' });
  const sanitizeRateLimit = rateLimit.build({ capacity: 30, refillPerSec: 1, name: 'sanitize' });
  const importRateLimit = rateLimit.build({ capacity: 20, refillPerSec: 0.5, name: 'import' });

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
  const bearerIntegration = auth.bearerAuth(secrets, { db, scope: 'integration' });
  const loopback = auth.loopbackOnly();

  // Health (open).
  app.use('/api/health', buildHealth({ db, watchState }));

  // Safe surface (loopback only, no PII).
  app.use('/api/safe', loopback, buildSafe({ db, secrets }));

  // PII surface (Bearer required). Different scopes per surface so an app
  // issued only `pii.read` cannot also write or run imports. The rate
  // limiter runs after the auth middleware so the per-token bucket gets
  // a stable key.
  app.use('/api/families', method2scope(bearerRead, bearerWrite), piiRateLimit, buildFamilies({ db, secrets, includePii: true }));
  app.use('/api/people', method2scope(bearerRead, bearerWrite), piiRateLimit, buildPeople({ db, secrets, includePii: true }));
  app.use('/api/relationships', bearerWrite, piiRateLimit, buildRelationships({ db }));
  app.use('/api/conflicts', method2scope(bearerRead, bearerWrite), piiRateLimit, buildConflicts({ db, secrets }));
  app.use('/api/audit/external-export', bearerAuditWrite, piiRateLimit, buildAuditExport({ db }));
  app.use('/api/audit', bearerAuditRead, piiRateLimit, buildAuditList({ db }));
  app.use('/api/import', bearerImport, importRateLimit, buildImport({ db, secrets, thresholds }));
  app.use('/api/imports', bearerRead, piiRateLimit, buildImports({ db }));
  app.use('/api/sanitize', bearerSanitize, sanitizeRateLimit, buildSanitize({ db, secrets }));
  app.use('/api/desanitize', bearerSanitize, sanitizeRateLimit, buildDesanitize({ db, secrets }));
  app.use('/api/rules', bearerRulesWrite, piiRateLimit, buildRules({ db }));
  app.use('/api/keys', bearerMaster, piiRateLimit, buildApiKeys({ db }));
  app.use('/api/search', bearerRead, piiRateLimit, buildSearch({ db, secrets }));
  app.use('/api/membership-history', bearerRead, piiRateLimit, buildMembershipHistory({ db, secrets }));
  app.use('/api/profiles', bearerRulesWrite, piiRateLimit, buildProfiles({ db }));
  app.use('/api/settings', bearerMaster, piiRateLimit, buildSettings({ db }));
  app.use('/api/export', bearerRead, piiRateLimit, buildExport({ db, secrets }));
  app.use('/api/notifications', bearerMaster, piiRateLimit, buildNotifications({ db }));
  app.use('/api/scan', bearerWrite, piiRateLimit, buildScan({ db, secrets, thresholds }));
  // External-app identity API. Consuming apps call these endpoints to
  // delegate match/resolve to Family Graph.
  app.use('/api/identity', method2scope(bearerRead, bearerWrite), piiRateLimit, buildIdentityApi({ db, secrets, thresholds }));
  app.use('/api/connectors', bearerImport, piiRateLimit, buildConnectors({ db, secrets, thresholds }));
  // ParentPoint outbound pairing config (operator-only — holds shared
  // secrets for the FG→PP dialer). Configures the dialer; opens no inbound
  // surface.
  app.use('/api/pp-pairings', bearerMaster, piiRateLimit, buildPpPairings({ db, secrets }));
  // Document Vault (operator-only — children's sacramental/accommodation/health
  // records, the most sensitive data in the system). Bytes are encrypted at
  // rest with the dataKey; PP reaches documents ONLY via the outbound agent's
  // document.store/fetch transport, never this route. Opens no inbound surface.
  app.use('/api/documents', bearerMaster, piiRateLimit, buildDocuments({ db, secrets }));
  app.use('/api/connector-runs', bearerRead, piiRateLimit, buildConnectors.buildRunsRouter({ db }));
  // Volunteer ministries + EIM. Reads are gated on pii.read because per-
  // assignment notes can contain operator commentary; writes need pii.write.
  app.use('/api/ministries', method2scope(bearerRead, bearerWrite), piiRateLimit, buildMinistries({ db, secrets, includePii: true }));
  // Organizations (parish / school) + dated affiliations with the rolling
  // verification trail. Same scope posture as ministries: reads gated on
  // pii.read because affiliation notes carry operator commentary.
  app.use('/api/organizations', method2scope(bearerRead, bearerWrite), piiRateLimit, buildOrganizations({ db, secrets, includePii: true }));
  // Staff login surface. request-link/redeem are unauthenticated by
  // design (they're how a session comes to exist) and sit behind a
  // tight rate limit; account management is master-only like /api/keys.
  const authRateLimit = rateLimit.build({ capacity: 10, refillPerSec: 0.2, name: 'auth' });
  app.use('/api/auth', authRateLimit, buildAuthApi({ db, secrets }));
  app.use('/api/accounts', bearerMaster, piiRateLimit, buildAdminAccounts({ db, secrets }));

  // FamilyGraph Integration API surface (FAMILYGRAPH_INTEGRATION.md
  // v0.1). All routes live under /v1/... so the URL shape matches the
  // contract verbatim and integrating apps don't have to remember a
  // distinct "FG-side" prefix. Single dedicated scope so an operator can
  // issue a scoped key to an integrating app without granting it the full
  // PII surface. Rate limit is generous: consuming apps can be chatty
  // during a reconcile sweep.
  app.use('/v1', bearerIntegration, v1RateLimit, buildIntegrationApi({ db, secrets }));

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

  // 404 + error handlers (always JSON for /api and /v1).
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  app.use('/v1', (req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(errorLogger());
  app.use((err, req, res, _next) => {
    // The structured logger has already recorded the stack via errorLogger().
    // The wire response is a fixed shape — never leak err.message because
    // it could contain user-supplied content or internal detail.
    if (res.headersSent) return;
    // Body-parser surfaces oversize / malformed JSON as 4xx errors with
    // a `status` field on the error. Reflect that status so the caller
    // sees the right code; the body stays generic.
    const status = (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500)
      ? err.status : 500;
    let code = 'internal_error';
    if (status === 413) code = 'request_too_large';
    else if (status === 400) code = 'bad_request';
    else if (status === 415) code = 'unsupported_media_type';
    else if (status >= 400 && status < 500) code = 'bad_request';
    res.status(status).json({ error: code });
  });

  return app;
}

async function start() {
  // Restrict the umask so any file we create — SQLite WAL/SHM files,
  // log files, backup blobs — is owner-read/write only (mode 0600 for
  // files, 0700 for directories). Without this, a default-umask system
  // (0o022) leaves WAL files world-readable, and the WAL file contains
  // unencrypted in-flight transaction pages.
  process.umask(0o077);

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

  // Daily entity_changes sweep. Default: keep forever (the contract
  // explicitly supports restoring soft-archived records). Operators
  // who want a hard cap set `entity_changes_retention_days` in settings.
  const entityChangesSweep = setInterval(() => {
    const days = entityHistory.effectiveRetentionDays(db, null);
    if (days) entityHistory.sweep(db, days);
  }, 24 * 60 * 60 * 1000);
  entityChangesSweep.unref();

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

  // Integration webhook dispatcher. Picks up pending webhook_deliveries
  // rows and fires HTTP POSTs with signed payloads. Disable via
  // FAMILY_GRAPH_DISABLE_INTEGRATION_WEBHOOKS=1 — useful for tests and for
  // operators who want to debug the queue manually.
  let integrationWebhookDispatcher = null;
  if (process.env.FAMILY_GRAPH_DISABLE_INTEGRATION_WEBHOOKS !== '1') {
    try {
      integrationWebhookDispatcher = integrationWebhooks.start(db, secrets, { intervalMs: 60_000 });
    } catch (e) {
      log.error('integration_webhook.dispatcher.start_failed', { message: e.message, stack: e.stack });
    }
  }

  // Federation pusher. Wakes every 60s and ships fat, hex-keyed person /
  // household batches to subscriptions that opted into federation_push — the
  // hydration + reconciliation channel for consumers that can't pull (e.g. a
  // cloud app while FamilyGraph sits on-prem). Disable via
  // FAMILY_GRAPH_DISABLE_FEDERATION_PUSH=1.
  let integrationFederationPusher = null;
  try {
    integrationFederationPusher = integrationFederation.start(db, secrets, { intervalMs: 60_000 });
  } catch (e) {
    log.error('federation.pusher.start_failed', { message: e.message, stack: e.stack });
  }

  // ParentPoint outbound check-in scheduler (Option A — "no open doors").
  // FG is the sole initiator: this loop dials PP over outbound HTTPS for any
  // ENABLED pairing. It opens NO inbound port and listens for nothing. With
  // zero enabled pairings every tick is a no-op, so this stays fully dormant
  // until the operator pairs and enables a tenant. Disable entirely via
  // FAMILY_GRAPH_DISABLE_PP_OUTBOUND=1.
  let ppOutboundSched = null;
  try {
    ppOutboundSched = ppOutboundScheduler.start(db, secrets);
  } catch (e) {
    log.error('integration_pp.scheduler.start_failed', { message: e.message, stack: e.stack });
  }

  // Idempotency-key sweeper. Runs every 6h. The lookup path lazily expires
  // its own row on read so steady-state pressure stays bounded; this sweep
  // is the belt-and-suspenders cleanup for the long tail of rows that
  // never get queried again.
  const idemSweep = setInterval(() => {
    try { integrationIdempotency.sweep(db); } catch (_) { /* ignore */ }
  }, 6 * 60 * 60 * 1000);
  idemSweep.unref();

  // Token-set TTL sweeper. token_sets rows hold the sanitize → desanitize
  // mapping; they're encrypted, but every expired row is one more chance
  // for a stale mapping to be reversed. The expires_at column on a
  // sanitize call defaults to `config.tokenSetTtlMinutes` from boot time;
  // this sweep enforces the TTL by deleting rows whose `expires_at` has
  // passed. Runs every 6h to mirror the idempotency sweep cadence.
  const tokenSetSweep = setInterval(() => {
    try {
      db.prepare(`DELETE FROM token_sets WHERE expires_at IS NOT NULL AND expires_at <= ?`)
        .run(new Date().toISOString());
    } catch (_) { /* ignore */ }
  }, 6 * 60 * 60 * 1000);
  tokenSetSweep.unref();

  let watcher = null;
  if (process.env.FAMILY_GRAPH_DISABLE_WATCH !== '1') {
    try {
      const wd = await folderWatch.start(db, secrets, thresholds, {
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

  async function shutdown() {
    if (watcher) watcher.close();
    if (connectorSched && connectorSched.stop) connectorSched.stop();
    // Stop the app webhook dispatcher; await any in-flight POST so we
    // don't orphan a delivery mid-fetch.
    if (integrationWebhookDispatcher && integrationWebhookDispatcher.stop) {
      try { await integrationWebhookDispatcher.stop(); } catch (_) { /* swallow */ }
    }
    if (integrationFederationPusher && integrationFederationPusher.stop) {
      try { await integrationFederationPusher.stop(); } catch (_) { /* swallow */ }
    }
    // Stop the PP outbound scheduler; await any in-flight check-in.
    if (ppOutboundSched && ppOutboundSched.stop) {
      try { await ppOutboundSched.stop(); } catch (_) { /* swallow */ }
    }
    clearInterval(idemSweep);
    clearInterval(tokenSetSweep);
    clearInterval(entityChangesSweep);
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
