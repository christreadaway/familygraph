'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const credentials = require('../server/connectors/credentials');
const { newDb, newSecrets, cleanup } = require('./_helpers');

test('credentials > round-trip secrets via encrypted settings', () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://example.test/api/v3',
      access_token_url: 'https://example.test/oauth2/token',
      client_id: 'cid-12345',
      client_secret: 'secret-deadbeef',
      enabled: true,
      schedule: 'daily_2am',
    });
    const loaded = credentials.load(db, secrets, 'facts');
    assert.equal(loaded.api_base_url, 'https://example.test/api/v3');
    assert.equal(loaded.access_token_url, 'https://example.test/oauth2/token');
    assert.equal(loaded.client_id, 'cid-12345');
    assert.equal(loaded.client_secret, 'secret-deadbeef');
    assert.equal(loaded.enabled, true);
    assert.equal(loaded.schedule, 'daily_2am');

    const desc = credentials.describe(db, secrets, 'facts');
    assert.equal(desc.fields.client_secret.set, true);
    assert.equal('value' in desc.fields.client_secret, false, 'public describe must not return plaintext');
    assert.equal(desc.fields.client_id.set, true);
    assert.equal('value' in desc.fields.client_id, false);
    assert.equal(desc.fields.api_base_url.value, 'https://example.test/api/v3');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('credentials > settings table contains no plaintext secret', () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://example.test/api/v3',
      access_token_url: 'https://example.test/oauth2/token',
      client_id: 'cid-X',
      client_secret: 'super-secret-XYZ-987',
    });
    const rows = db.prepare(`SELECT key, value_json FROM settings`).all();
    const all = rows.map(r => r.value_json).join('\n');
    assert.equal(all.includes('super-secret-XYZ-987'), false, 'plaintext secret leaked into settings');
    assert.equal(all.includes('cid-X'), false, 'plaintext client id leaked into settings');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('credentials > clear() removes everything', () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    credentials.set(db, secrets, 'ministry_platform', {
      api_base_url: 'https://parish.test/ministryplatformapi/',
      client_id: 'mp-client',
      client_secret: 'mp-secret',
      enabled: true,
      schedule: 'hourly',
    });
    credentials.clear(db, secrets, 'ministry_platform');
    const desc = credentials.describe(db, secrets, 'ministry_platform');
    assert.equal(desc.enabled, false);
    assert.equal(desc.schedule, 'off');
    assert.equal(desc.fields.client_id.set, false);
    assert.equal(desc.fields.client_secret.set, false);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('credentials > rejects unknown connector and bad schedule', () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    assert.throws(() => credentials.set(db, secrets, 'bogus', {}), /unknown connector/);
    assert.throws(() => credentials.set(db, secrets, 'facts', { schedule: 'every_minute' }), /schedule must be/);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('credentials > isComplete reflects required fields', () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    assert.equal(credentials.isComplete(db, secrets, 'facts'), false);
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://example.test/api',
      access_token_url: 'https://example.test/oauth2/token',
      client_id: 'cid',
    });
    assert.equal(credentials.isComplete(db, secrets, 'facts'), false, 'still missing client_secret');
    credentials.set(db, secrets, 'facts', { client_secret: 'sec' });
    assert.equal(credentials.isComplete(db, secrets, 'facts'), true);
  } finally {
    db.close();
    cleanup(dir);
  }
});
