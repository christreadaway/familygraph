'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dbModule = require('../server/db');

function tmpDir() {
  const d = path.join(os.tmpdir(), `family-graph-test-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function newDb() {
  const d = tmpDir();
  const dbPath = path.join(d, 'test.sqlite');
  const db = dbModule.init(dbPath);
  return { db, dir: d, dbPath };
}

function newSecrets() {
  return {
    version: 1,
    master: crypto.randomBytes(32).toString('hex'),
    dataKey: crypto.randomBytes(32).toString('hex'),
    hmacKey: crypto.randomBytes(32).toString('hex'),
  };
}

function defaultThresholds() {
  // Recalibrated for the upstream additive scoring vendored into
  // server/identity/matching.js. autoMerge holds the "definitive signal"
  // bar (exact email/phone, exact name+DOB, very-close address). review
  // is calibrated so even surname-only or phonetic-variant first-name
  // matches are surfaced for operator decision rather than silently
  // dropped on the floor.
  return { autoMerge: 0.85, review: 0.30 };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

module.exports = { tmpDir, newDb, newSecrets, defaultThresholds, cleanup };
