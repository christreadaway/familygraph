'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// On-disk secret format (JSON):
//   {
//     version: 1,
//     master:  <64 hex chars: 256-bit shared secret used as Bearer token>,
//     dataKey: <64 hex chars: 256-bit AES-GCM key for PII encryption>,
//     hmacKey: <64 hex chars: 256-bit HMAC-SHA256 key for searchable hashes>,
//     createdAt: ISO timestamp
//   }
// The whole file is stored mode 0600 in $CUSTOS_HOME and never logged.
// In v2, this file is replaced by the OS keychain. The shape of the keys is
// stable, so the migration is a copy-out without any ciphertext changes.

function generate() {
  return {
    version: 1,
    master: crypto.randomBytes(32).toString('hex'),
    dataKey: crypto.randomBytes(32).toString('hex'),
    hmacKey: crypto.randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  };
}

function load(secretPath) {
  if (!fs.existsSync(secretPath)) {
    const dir = path.dirname(secretPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fresh = generate();
    fs.writeFileSync(secretPath, JSON.stringify(fresh, null, 2), { mode: 0o600 });
    return fresh;
  }
  const raw = fs.readFileSync(secretPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.master || !parsed.dataKey || !parsed.hmacKey) {
    throw new Error('Custos secret file is malformed; refusing to start.');
  }
  return parsed;
}

function rotate(secretPath) {
  const dir = path.dirname(secretPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Rotate the master Bearer token only; data-encryption key cannot be rotated
  // without re-encrypting the database, which is a v2 concern.
  let existing = {};
  if (fs.existsSync(secretPath)) {
    existing = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  } else {
    existing = generate();
  }
  const next = {
    ...existing,
    version: 1,
    master: require('crypto').randomBytes(32).toString('hex'),
    rotatedAt: new Date().toISOString(),
  };
  // dataKey + hmacKey unchanged so existing ciphertext keeps decrypting.
  if (!next.dataKey) next.dataKey = require('crypto').randomBytes(32).toString('hex');
  if (!next.hmacKey) next.hmacKey = require('crypto').randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

module.exports = { generate, load, rotate };
