'use strict';

// Migration 0019 must rename any EXISTING pp_* partner-pairing settings keys to
// the generic partner_* naming WITHOUT losing data — so a pairing configured
// before the open-source rename keeps working.

const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb, cleanup } = require('./_helpers');
const migration = require('../server/db/migrations/0019_rename_pp_pairing_settings');

test('0019 > renames stored pp_pairing keys to partner_pairing, preserving values', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });

  // Simulate a pairing stored under the OLD naming (as pairing.js wrote it
  // before the rename).
  const put = (k, v) => db.prepare(
    "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
    "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
  ).run(k, JSON.stringify(v));

  put('pp_pairing.__index', ['st-marys']);
  put('pp_pairing.st-marys.school_id', 'st-marys');
  put('pp_pairing.st-marys.enabled', true);
  put('pp_pairing.st-marys.pp_base_url', 'https://partner.example.org');
  put('pp_pairing.st-marys.pp_bearer_credential_ct', 'BASE64CTHERE');
  put('pp_pairing.st-marys.envelope_key_ct', 'ENVELOPECT');

  migration.up(db);

  const keys = db.prepare("SELECT key FROM settings ORDER BY key").all().map(r => r.key);
  // No old keys remain.
  assert.ok(!keys.some(k => k.startsWith('pp_pairing.')), 'no pp_pairing.* keys remain');
  // New keys present with values intact.
  const get = k => { const r = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(k); return r ? JSON.parse(r.value_json) : undefined; };
  assert.deepEqual(get('partner_pairing.__index'), ['st-marys']);
  assert.equal(get('partner_pairing.st-marys.enabled'), true);
  assert.equal(get('partner_pairing.st-marys.partner_base_url'), 'https://partner.example.org');
  assert.equal(get('partner_pairing.st-marys.partner_bearer_credential_ct'), 'BASE64CTHERE');
  // Non-pp field names are untouched.
  assert.equal(get('partner_pairing.st-marys.envelope_key_ct'), 'ENVELOPECT');

  // Idempotent: a second run changes nothing.
  migration.up(db);
  const keys2 = db.prepare("SELECT key FROM settings ORDER BY key").all().map(r => r.key);
  assert.deepEqual(keys2, keys.map(k => k
    .replace('pp_bearer_credential', 'partner_bearer_credential')
    .replace('pp_base_url', 'partner_base_url')
    .replace('pp_pairing.', 'partner_pairing.')).sort());
});

test('0019 > round-trips through the pairing module after rename', t => {
  const { db, dir } = newDb();
  const secrets = require('./_helpers').newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const pairing = require('../server/integration/pairing');

  // Configure a pairing through the (now generic) module API, then read it back.
  pairing.set(db, secrets, 'st-marys', {
    partner_base_url: 'https://partner.example.org',
    partner_bearer_credential: 'tok_abc',
    shared_webhook_secret: 'whs_abc',
    envelope_key: 'a'.repeat(64),
    enabled: true,
  }, { actor: 'test' });

  const d = pairing.describe(db, secrets, 'st-marys');
  assert.equal(d.schoolId, 'st-marys');
  assert.equal(d.fields.partner_base_url.value, 'https://partner.example.org');
  assert.equal(d.fields.partner_bearer_credential.set, true);
  assert.ok(pairing.isComplete(db, secrets, 'st-marys'));
});
