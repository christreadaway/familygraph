'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const HOME = os.homedir();
const CUSTOS_HOME = process.env.CUSTOS_HOME || path.join(HOME, '.custos');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

const config = {
  env: process.env.CUSTOS_ENV || 'production',
  home: CUSTOS_HOME,
  dataDir: ensureDir(path.join(CUSTOS_HOME, 'data')),
  watchDir: process.env.CUSTOS_WATCH_DIR || path.join(CUSTOS_HOME, 'watch'),
  outDir: process.env.CUSTOS_OUT_DIR || path.join(CUSTOS_HOME, 'out'),
  backupsDir: ensureDir(path.join(CUSTOS_HOME, 'backups')),
  dbPath: process.env.CUSTOS_DB || path.join(CUSTOS_HOME, 'data', 'custos.sqlite'),
  secretPath: process.env.CUSTOS_SECRET || path.join(CUSTOS_HOME, 'secret.key'),
  port: Number(process.env.CUSTOS_PORT || 3500),
  bind: process.env.CUSTOS_BIND || '127.0.0.1',
  resolverThresholds: {
    autoMerge: Number(process.env.CUSTOS_AUTO_MERGE || 0.92),
    review: Number(process.env.CUSTOS_REVIEW || 0.7),
  },
  // When true, the safe API surface is reachable only from loopback.
  enforceLoopbackOnSafe: true,
  // Token sets (sanitize round-trip) expire after this many minutes by default.
  tokenSetTtlMinutes: 60 * 24,
};

ensureDir(config.watchDir);
ensureDir(config.outDir);

module.exports = config;
