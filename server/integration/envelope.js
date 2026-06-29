'use strict';

// Envelope encryption for outbound FamilyGraph → ParentPoint payloads.
//
// "No open doors" topology means every FG→PP byte rides outbound HTTPS
// (TLS in transit) carrying an X-FG-Signature HMAC (integrity). On TOP of
// those, any payload containing PII — de-anonymized text, identity-resolved
// names, document bytes/safety-flags (later phase) — is sealed with a
// shared symmetric key established at pairing. PP holds the same key and
// decrypts server-side only. This is defence-in-depth: even if TLS is
// terminated at a proxy PP doesn't control, the PII never sits in plaintext
// anywhere but inside PP's own process memory after it decrypts.
//
// What is sealed vs cleartext (decided in the agent, enforced here by
// what we choose to wrap):
//   SEALED:    desanitize results (codes → names), identity.resolve results
//              that carry names, any reconciliation batch item carrying
//              person/household PII fields, schoolContext snapshots with
//              child PII, (later) document bytes / safety flags.
//   CLEARTEXT: pseudonymous codes, cursors, request ids, acks, sanitize
//              results that contain ONLY codes. These may travel cleartext
//              inside the TLS + HMAC envelope.
//
// Wire shape of a sealed value (CANONICAL — so PP can detect-and-decrypt):
//   { "enc": "aes-256-gcm", "iv": "<base64 12B>",
//     "tag": "<base64 16B>", "ct": "<base64>" }
// The plaintext is the UTF-8 JSON of the wrapped object. PP recognises the
// `enc` marker, pulls iv/tag/ct, and decrypts with the shared key. This is the
// single canonical wire shape shared by BOTH repos
// (see FG_PP_WIRE_CONTRACT). A value with NO `enc` field is cleartext.
//
// We reuse the SAME AES-256-GCM primitive family as crypto/encryption.js,
// but with the pairing's `envelope_key` rather than the local dataKey, and
// emit a self-describing JSON wire shape (rather than the packed BLOB that
// the at-rest column encryptor uses) because the receiver is a different
// process in a different language and needs explicit field names.

const crypto = require('crypto');

const WIRE_VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
// Canonical envelope marker: a sealed value carries `enc: "aes-256-gcm"`.
const MARKER = 'enc';

function _key(envelopeKeyHex) {
  if (!envelopeKeyHex || !/^[0-9a-fA-F]{64}$/.test(String(envelopeKeyHex))) {
    throw new Error('envelope_key must be 64 hex chars (32 bytes)');
  }
  return Buffer.from(String(envelopeKeyHex), 'hex');
}

// seal(envelopeKeyHex, value) → wire object. `value` is any JSON-serialisable
// thing (object, array, string). Returns the self-describing sealed wrapper.
function seal(envelopeKeyHex, value) {
  const key = _key(envelopeKeyHex);
  const plaintext = Buffer.from(JSON.stringify(value === undefined ? null : value), 'utf8');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: ALGO,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

// isSealed(x) → true if x looks like a canonical envelope (carries the `enc`
// marker set to the AES-256-GCM algorithm id). Matches PP's `isEnvelope`.
function isSealed(x) {
  return !!(x && typeof x === 'object' && x[MARKER] === ALGO
    && typeof x.iv === 'string' && typeof x.tag === 'string' && typeof x.ct === 'string');
}

// open(envelopeKeyHex, wire) → original value. Throws on tamper (GCM tag
// mismatch) or wrong key. Round-trips seal().
function open(envelopeKeyHex, wire) {
  if (!isSealed(wire)) throw new Error('not a sealed envelope');
  const key = _key(envelopeKeyHex);
  const iv = Buffer.from(wire.iv, 'base64');
  const tag = Buffer.from(wire.tag, 'base64');
  const ct = Buffer.from(wire.ct, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

module.exports = { seal, open, isSealed, WIRE_VERSION, MARKER };
