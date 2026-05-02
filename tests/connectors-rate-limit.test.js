'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const httpMod = require('../server/connectors/http');
const connectors = require('../server/connectors');
const credentials = require('../server/connectors/credentials');
const runs = require('../server/connectors/runs');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

function makeResponse({ status = 200, json = null, text = null, headers = {} }) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: {
      get(name) { return headerMap.get(String(name).toLowerCase()) || null; },
    },
    async json() { if (json == null) throw new Error('no json'); return json; },
    async text() { return text || (json ? JSON.stringify(json) : ''); },
  };
}

test('http.authedFetch > 429 with Retry-After waits then retries once', async () => {
  httpMod.clearTokenCache();
  const sleeps = [];
  const _sleep = ms => { sleeps.push(ms); return Promise.resolve(); };
  const responses = [
    makeResponse({ status: 200, json: { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 } }),
    makeResponse({ status: 429, headers: { 'Retry-After': '3' } }),
    makeResponse({ status: 200, json: { ok: true, payload: 'after-retry' } }),
  ];
  let i = 0;
  const fetchImpl = async () => responses[i++] || responses[responses.length - 1];

  const out = await httpMod.authedFetch({
    connector: 'unit', url: 'https://api.test/x',
    tokenUrl: 'https://t.test/token', clientId: 'c', clientSecret: 's',
    fetchImpl, _sleep,
  });
  assert.equal(out.payload, 'after-retry');
  assert.equal(sleeps.length, 1, 'expected exactly one sleep');
  assert.equal(sleeps[0], 3000, 'expected 3-second wait per Retry-After');
});

test('http.authedFetch > 429 without Retry-After defaults to 60s', async () => {
  httpMod.clearTokenCache();
  const sleeps = [];
  const _sleep = ms => { sleeps.push(ms); return Promise.resolve(); };
  const responses = [
    makeResponse({ status: 200, json: { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 } }),
    makeResponse({ status: 429 }),
    makeResponse({ status: 200, json: {} }),
  ];
  let i = 0;
  const fetchImpl = async () => responses[i++] || responses[responses.length - 1];
  await httpMod.authedFetch({
    connector: 'unit', url: 'https://api.test/x',
    tokenUrl: 'https://t.test/token', clientId: 'c', clientSecret: 's',
    fetchImpl, _sleep,
  });
  assert.equal(sleeps[0], 60_000, 'expected default 60s wait');
});

test('http.authedFetch > second 429 in a row throws rate_limited', async () => {
  httpMod.clearTokenCache();
  const _sleep = () => Promise.resolve();
  const responses = [
    makeResponse({ status: 200, json: { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 } }),
    makeResponse({ status: 429, headers: { 'Retry-After': '1' } }),
    makeResponse({ status: 429, headers: { 'Retry-After': '1' } }),
  ];
  let i = 0;
  const fetchImpl = async () => responses[i++] || responses[responses.length - 1];
  await assert.rejects(
    () => httpMod.authedFetch({
      connector: 'unit', url: 'https://api.test/x',
      tokenUrl: 'https://t.test/token', clientId: 'c', clientSecret: 's',
      fetchImpl, _sleep,
    }),
    e => { assert.equal(e.reason, 'rate_limited'); return true; }
  );
});

test('http.authedFetch > 401 then 429 is handled (auth refresh + rate-limit retry)', async () => {
  httpMod.clearTokenCache();
  const _sleep = () => Promise.resolve();
  const responses = [
    makeResponse({ status: 200, json: { access_token: 'tok-A', token_type: 'Bearer', expires_in: 3600 } }),
    makeResponse({ status: 401 }),
    makeResponse({ status: 200, json: { access_token: 'tok-B', token_type: 'Bearer', expires_in: 3600 } }),
    makeResponse({ status: 429, headers: { 'Retry-After': '2' } }),
    makeResponse({ status: 200, json: { final: true } }),
  ];
  let i = 0;
  const fetchImpl = async () => responses[i++] || responses[responses.length - 1];
  const out = await httpMod.authedFetch({
    connector: 'unit', url: 'https://api.test/x',
    tokenUrl: 'https://t.test/token', clientId: 'c', clientSecret: 's',
    fetchImpl, _sleep,
  });
  assert.equal(out.final, true);
});

test('runSync > rate_limited fires an immediate operator notification', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  httpMod.clearTokenCache();
  try {
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://example.test/api', access_token_url: 'https://example.test/oauth2/token',
      client_id: 'c', client_secret: 's', enabled: true, schedule: 'hourly',
    });
    db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run('operator_email', JSON.stringify('admin@example.test'));
    db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run('notifications.enabled', JSON.stringify(true));

    // Mock fetch: token OK → /users 429 twice → rate_limited.
    let userHits = 0;
    const fetchImpl = async (url) => {
      if (url.includes('/token')) {
        return makeResponse({ status: 200, json: { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 } });
      }
      if (url.includes('/users')) {
        userHits += 1;
        return makeResponse({ status: 429, headers: { 'Retry-After': '0' } });
      }
      return makeResponse({ status: 404 });
    };

    // Patch the http helper's _sleep through fetchImpl wrapping isn't direct;
    // instead we fast-forward by monkey-patching globalThis.setTimeout? Easier:
    // the test connector path uses authedFetch internally. We pass fetchImpl
    // through, but _sleep is internal. Use a very short Retry-After (0).
    const out = await connectors.runSync(db, secrets, defaultThresholds(), 'facts', {
      trigger: 'manual', actor: 'tester', fetchImpl,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'rate_limited');
    assert.ok(userHits >= 2, `expected at least 2 user-endpoint hits, got ${userHits}`);

    // A notification should be queued for the operator.
    const notes = db.prepare(`SELECT subject, to_email, status FROM notifications`).all();
    assert.ok(notes.length >= 1, 'expected an operator notification');
    const rateNote = notes.find(n => /rate limit/i.test(n.subject || '') || /429/.test(n.subject || ''));
    assert.ok(rateNote, `expected a 429-specific notification, got: ${JSON.stringify(notes.map(n => n.subject))}`);
    assert.equal(rateNote.to_email, 'admin@example.test');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('startSyncBackground > returns runCode immediately and writes status as it runs', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  httpMod.clearTokenCache();
  try {
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://example.test/api', access_token_url: 'https://example.test/oauth2/token',
      client_id: 'c', client_secret: 's', enabled: true, schedule: 'hourly',
    });
    let resolveStudents;
    const gate = new Promise(r => { resolveStudents = r; });
    const fetchImpl = async (url) => {
      if (url.includes('/token')) {
        return makeResponse({ status: 200, json: { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 } });
      }
      if (url.includes('role=student')) {
        await gate;
        return makeResponse({ status: 200, json: { users: [] } });
      }
      return makeResponse({ status: 200, json: { users: [] } });
    };
    const { run_code } = connectors.startSyncBackground(db, secrets, defaultThresholds(), 'facts', {
      trigger: 'manual', actor: 'tester', fetchImpl,
    });
    assert.ok(run_code, 'expected run_code immediately');
    // While the sync is gated, the row should be 'running'.
    const r1 = runs.get(db, run_code);
    assert.equal(r1.status, 'running');
    // Release.
    resolveStudents();
    // Wait for the run to settle.
    let r2;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 20));
      r2 = runs.get(db, run_code);
      if (r2 && r2.status !== 'running') break;
    }
    assert.equal(r2.status, 'ok');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('runSync > onProgress writes phase + counters into connector_runs.metadata', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  httpMod.clearTokenCache();
  try {
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://example.test/api', access_token_url: 'https://example.test/oauth2/token',
      client_id: 'c', client_secret: 's', enabled: true, schedule: 'hourly',
    });
    const fetchImpl = async (url) => {
      if (url.includes('/token')) {
        return makeResponse({ status: 200, json: { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 } });
      }
      if (url.includes('role=student')) {
        return makeResponse({ status: 200, json: { users: [{ sourcedId: 's1', familyName: 'X', givenName: 'Y' }] } });
      }
      return makeResponse({ status: 200, json: { users: [] } });
    };
    const out = await connectors.runSync(db, secrets, defaultThresholds(), 'facts', {
      trigger: 'manual', fetchImpl,
    });
    const r = runs.get(db, out.run_code);
    assert.equal(r.metadata.phase, 'done');
    assert.equal(r.metadata.students_pulled, 1);
    assert.equal(r.metadata.parents_pulled, 0);
    assert.equal(r.metadata.rows_pulled, 1);
  } finally {
    db.close();
    cleanup(dir);
  }
});
