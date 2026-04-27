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
const buildAudit = require('./api/audit');
const buildConflicts = require('./api/conflicts');
const buildImport = require('./api/import');

function buildApp({ db, secrets, thresholds }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.json({ limit: '20mb' }));

  // Inject auth context onto every request: PII routes require Bearer; safe
  // routes require loopback.
  const bearer = auth.bearerAuth(secrets);
  const loopback = auth.loopbackOnly();

  // Health (open).
  app.use('/api/health', buildHealth({ db }));

  // Safe surface (loopback only, no PII).
  app.use('/api/safe', loopback, buildSafe({ db, secrets }));

  // PII surface (Bearer required).
  app.use('/api/families', bearer, buildFamilies({ db, secrets, includePii: true }));
  app.use('/api/people', bearer, buildPeople({ db, secrets, includePii: true }));
  app.use('/api/conflicts', bearer, buildConflicts({ db, secrets }));
  app.use('/api/audit', bearer, buildAudit({ db }));
  app.use('/api/import', bearer, buildImport({ db, secrets, thresholds }));
  app.use('/api/sanitize', bearer, buildSanitize({ db, secrets }));
  app.use('/api/desanitize', bearer, buildDesanitize({ db, secrets }));

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

  const app = buildApp({ db, secrets, thresholds });
  const server = app.listen(config.port, config.bind, () => {
    // eslint-disable-next-line no-console
    console.log(`[sanctus] listening on http://${config.bind}:${config.port}`);
  });

  let watcher = null;
  if (process.env.SANCTUS_DISABLE_WATCH !== '1') {
    try {
      const wd = folderWatch.start(db, secrets, thresholds, {
        watchDir: config.watchDir,
        outDir: config.outDir,
      });
      watcher = wd.watcher;
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
