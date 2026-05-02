'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('../server/connectors/scheduler');
const credentials = require('../server/connectors/credentials');
const runs = require('../server/connectors/runs');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

test('scheduler.isDue > off is never due', () => {
  assert.equal(scheduler.isDue('off', 0), false);
  assert.equal(scheduler.isDue('off', Date.now()), false);
});

test('scheduler.isDue > hourly fires after 1h', () => {
  const now = Date.now();
  assert.equal(scheduler.isDue('hourly', 0), true, 'never run before');
  assert.equal(scheduler.isDue('hourly', now - 30 * 60 * 1000), false);
  assert.equal(scheduler.isDue('hourly', now - 70 * 60 * 1000), true);
});

test('scheduler.isDue > daily_2am respects last sync', () => {
  // Never run → due
  assert.equal(scheduler.isDue('daily_2am', 0), true);
  // Run very recently (last hour) → not due (today's slot already done OR
  // tomorrow's slot is in the future)
  assert.equal(scheduler.isDue('daily_2am', Date.now() - 60 * 1000), false);
});

test('scheduler.dueConnectors filters by enabled + complete + not running', () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    // Not configured at all → not due.
    assert.deepEqual(scheduler.dueConnectors(db, secrets), []);

    // Configure but disabled → not due.
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://x', access_token_url: 'https://x/t',
      client_id: 'c', client_secret: 's',
      schedule: 'hourly',
      enabled: false,
    });
    assert.deepEqual(scheduler.dueConnectors(db, secrets), []);

    // Enabled and never run → due.
    credentials.set(db, secrets, 'facts', { enabled: true });
    assert.deepEqual(scheduler.dueConnectors(db, secrets), ['facts']);

    // Currently running → not due (concurrent-sync prevention).
    runs.start(db, { connector: 'facts', trigger: 'manual' });
    assert.deepEqual(scheduler.dueConnectors(db, secrets), []);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('scheduler.tick triggers due connectors via runSync (mocked fetch)', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://example.test/api/v3',
      access_token_url: 'https://example.test/oauth2/token',
      client_id: 'c', client_secret: 's',
      enabled: true, schedule: 'hourly',
    });
    const fetchImpl = async (url) => {
      if (url.includes('/oauth2/token') || url.includes('/token')) {
        return { ok: true, status: 200, statusText: 'OK',
          async json() { return { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }; },
          async text() { return ''; },
        };
      }
      // Empty user lists → zero canonical rows → import skipped → ok
      return { ok: true, status: 200, statusText: 'OK',
        async json() { return { users: [] }; },
        async text() { return ''; },
      };
    };
    const results = await scheduler.tick(db, secrets, defaultThresholds(), { fetchImpl });
    assert.equal(results.length, 1);
    assert.equal(results[0].connector, 'facts');
    assert.equal(results[0].ok, true);
  } finally {
    db.close();
    cleanup(dir);
  }
});
