'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const HOME = os.homedir();
const FAMILY_GRAPH_HOME = process.env.FAMILY_GRAPH_HOME || path.join(HOME, '.family-graph');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

const config = {
  env: process.env.FAMILY_GRAPH_ENV || 'production',
  home: FAMILY_GRAPH_HOME,
  dataDir: ensureDir(path.join(FAMILY_GRAPH_HOME, 'data')),
  watchDir: process.env.FAMILY_GRAPH_WATCH_DIR || path.join(FAMILY_GRAPH_HOME, 'watch'),
  outDir: process.env.FAMILY_GRAPH_OUT_DIR || path.join(FAMILY_GRAPH_HOME, 'out'),
  backupsDir: ensureDir(path.join(FAMILY_GRAPH_HOME, 'backups')),
  dbPath: process.env.FAMILY_GRAPH_DB || path.join(FAMILY_GRAPH_HOME, 'data', 'family-graph.sqlite'),
  secretPath: process.env.FAMILY_GRAPH_SECRET || path.join(FAMILY_GRAPH_HOME, 'secret.key'),
  port: Number(process.env.FAMILY_GRAPH_PORT || 3500),
  bind: process.env.FAMILY_GRAPH_BIND || '127.0.0.1',
  // Recalibrated for the upstream additive scoring vendored in
  // server/identity/matching.js (v9). autoMerge=0.85 holds the
  // "definitive signal OR very strong soft signals" bar; review=0.30
  // surfaces even surname-only or phonetic-variant matches for operator
  // decision rather than silently dropping them. Override per
  // institution via env var or via the profiles table.
  resolverThresholds: {
    autoMerge: Number(process.env.FAMILY_GRAPH_AUTO_MERGE || 0.85),
    review: Number(process.env.FAMILY_GRAPH_REVIEW || 0.30),
  },
  // When true, the safe API surface is reachable only from loopback.
  enforceLoopbackOnSafe: true,
  // Token sets (sanitize round-trip) expire after this many minutes by default.
  tokenSetTtlMinutes: 60 * 24,
};

ensureDir(config.watchDir);
ensureDir(config.outDir);

module.exports = config;
