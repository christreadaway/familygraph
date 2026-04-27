'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const HOME = os.homedir();
const SANCTUS_HOME = process.env.SANCTUS_HOME || path.join(HOME, '.sanctus');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

const config = {
  env: process.env.SANCTUS_ENV || 'production',
  home: SANCTUS_HOME,
  dataDir: ensureDir(path.join(SANCTUS_HOME, 'data')),
  watchDir: process.env.SANCTUS_WATCH_DIR || path.join(SANCTUS_HOME, 'watch'),
  outDir: process.env.SANCTUS_OUT_DIR || path.join(SANCTUS_HOME, 'out'),
  backupsDir: ensureDir(path.join(SANCTUS_HOME, 'backups')),
  dbPath: process.env.SANCTUS_DB || path.join(SANCTUS_HOME, 'data', 'sanctus.sqlite'),
  secretPath: process.env.SANCTUS_SECRET || path.join(SANCTUS_HOME, 'secret.key'),
  port: Number(process.env.SANCTUS_PORT || 3500),
  bind: process.env.SANCTUS_BIND || '127.0.0.1',
  resolverThresholds: {
    autoMerge: Number(process.env.SANCTUS_AUTO_MERGE || 0.92),
    review: Number(process.env.SANCTUS_REVIEW || 0.7),
  },
  // When true, the safe API surface is reachable only from loopback.
  enforceLoopbackOnSafe: true,
  // Token sets (sanitize round-trip) expire after this many minutes by default.
  tokenSetTtlMinutes: 60 * 24,
};

ensureDir(config.watchDir);
ensureDir(config.outDir);

module.exports = config;
