'use strict';

// AES-256-GCM application-layer encryption for PII columns.
//
// Why application-layer and not SQLCipher: native compilation friction makes
// SQLCipher hostile to multi-platform packaging. Encrypting at the column
// level achieves the goal that "PII never lives in plaintext in the file"
// without forcing every consumer to install a custom SQLite build. If the
// SQLite file is exfiltrated, every PII column is unreadable without the
// data key, which lives in $FAMILY_GRAPH_HOME/secret.key (mode 0600) — or, in v2,
// the OS keychain. The shape of the ciphertext is stable across both stores.
//
// Ciphertext layout per BLOB column:
//   [version:1][iv:12][tag:16][cipher: variable]
// Version is 0x01.

const crypto = require('crypto');

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + IV_LEN + TAG_LEN;
const ALGO = 'aes-256-gcm';

function _key(secrets) {
  return Buffer.from(secrets.dataKey, 'hex');
}

function encrypt(secrets, plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const buf = Buffer.from(String(plaintext), 'utf8');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, _key(secrets), iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]);
}

function decrypt(secrets, blob) {
  if (blob === null || blob === undefined) return null;
  if (!Buffer.isBuffer(blob)) blob = Buffer.from(blob);
  if (blob.length < HEADER_LEN) {
    throw new Error('ciphertext too short');
  }
  const version = blob[0];
  if (version !== VERSION) {
    throw new Error(`unsupported ciphertext version: ${version}`);
  }
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, HEADER_LEN);
  const ct = blob.subarray(HEADER_LEN);
  const decipher = crypto.createDecipheriv(ALGO, _key(secrets), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

// Searchable HMAC: stable, deterministic hash of normalized input. Must NEVER
// be derived from raw plaintext that could be guessed (which is why we only
// hash normalized name/email/phone tokens, not free-form notes).
function hmac(secrets, normalizedString) {
  if (normalizedString === null || normalizedString === undefined) return null;
  const v = String(normalizedString);
  if (v.length === 0) return null;
  const h = crypto.createHmac('sha256', Buffer.from(secrets.hmacKey, 'hex'));
  h.update(v, 'utf8');
  return h.digest('hex');
}

function normalizeName(name) {
  if (!name) return null;
  return String(name)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')   // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEmail(email) {
  if (!email) return null;
  return String(email).trim().toLowerCase();
}

function normalizePhone(phone) {
  if (!phone) return null;
  // Strip everything but digits; leading country-code 1 dropped for North-American
  // canonicalization (matches MissionIQ's resolver convention).
  let digits = String(phone).replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits || null;
}

function normalizeAddress(parts) {
  const arr = [parts.line1, parts.line2, parts.city, parts.region, parts.postal, parts.country]
    .map(p => normalizeName(p) || '')
    .filter(Boolean);
  return arr.length ? arr.join('|') : null;
}

module.exports = {
  encrypt,
  decrypt,
  hmac,
  normalizeName,
  normalizeEmail,
  normalizePhone,
  normalizeAddress,
};
