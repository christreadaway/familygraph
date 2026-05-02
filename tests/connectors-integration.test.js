'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
const credentials = require('../server/connectors/credentials');
const importPipeline = require('../server/identity/import');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function close(server) { return new Promise(resolve => server.close(resolve)); }
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const opts = { method, hostname: '127.0.0.1', port, path, headers: {
      'content-type': 'application/json',
      ...(data ? { 'content-length': data.length } : {}),
      ...headers,
    } };
    const req = http.request(opts, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => buf += c);
      res.on('end', () => {
        let payload = buf;
        try { payload = JSON.parse(buf); } catch (_) { /* keep */ }
        resolve({ status: res.statusCode, body: payload });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('GET /api/settings reduces connector ciphertext to _set flags only', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://example.test/api/v3',
      access_token_url: 'https://example.test/oauth2/token',
      client_id: 'cid-PUBLIC-12345',
      client_secret: 'super-secret-XYZ',
      enabled: true,
      schedule: 'daily_2am',
    });
    const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
    const { server, port } = await listen(app);
    try {
      const r = await request(port, {
        path: '/api/settings',
        headers: { authorization: `Bearer ${secrets.master}` },
      });
      assert.equal(r.status, 200);
      const json = JSON.stringify(r.body);
      assert.equal(json.includes('super-secret-XYZ'), false, 'plaintext leaked into /api/settings');
      assert.equal(json.includes('cid-PUBLIC-12345'), false, 'client id leaked into /api/settings');
      // The base64 ciphertext also must not appear; PRD §5.1 says the
      // _ct keys should be reduced to set flags entirely.
      const hasCtKey = (r.body.items || []).some(it => /_ct$/.test(it.key));
      assert.equal(hasCtKey, false, 'ciphertext key surfaced in /api/settings');
      const hasSetFlag = (r.body.items || []).some(it => it.key === 'connector_facts_client_secret_set');
      assert.equal(hasSetFlag, true, 'expected `_set` flag in place of ciphertext');
    } finally { await close(server); }
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('PUT /api/settings rejects connector keys as direct writes', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
    const { server, port } = await listen(app);
    try {
      const r = await request(port, {
        method: 'PUT',
        path: '/api/settings/connector.facts.client_secret_ct',
        headers: { authorization: `Bearer ${secrets.master}` },
        body: { value: 'attempted plaintext' },
      });
      assert.equal(r.status, 400);
      assert.match(r.body.error || '', /managed via \/api\/connectors/);
    } finally { await close(server); }
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('GET /api/health surfaces connector posture once configured', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
    const { server, port } = await listen(app);
    try {
      // Initially: no connectors in posture array.
      const r1 = await request(port, { path: '/api/health' });
      assert.equal(r1.status, 200);
      assert.deepEqual(r1.body.connectors, []);

      // Configure FACTS — even with no run yet, it surfaces (enabled flag).
      credentials.set(db, secrets, 'facts', {
        api_base_url: 'https://example.test/api/v3',
        access_token_url: 'https://example.test/oauth2/token',
        client_id: 'c', client_secret: 's',
        enabled: true, schedule: 'hourly',
      });
      const r2 = await request(port, { path: '/api/health' });
      assert.equal(r2.status, 200);
      assert.equal(r2.body.connectors.length, 1);
      assert.equal(r2.body.connectors[0].name, 'facts');
      assert.equal(r2.body.connectors[0].enabled, true);
      assert.equal(r2.body.connectors[0].last_status, 'untested');
    } finally { await close(server); }
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('import_runs.trigger defaults to file for plain importBatch calls', () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    const result = importPipeline.importBatch(db, secrets, defaultThresholds(), [
      { family: { display_name: 'Test family' }, persons: [{ given_name: 'A', family_name: 'B', emails: [], phones: [] }], address: null },
    ], { source: 'csv', sourceRef: 'test' });
    const row = db.prepare(`SELECT "trigger" AS trig FROM import_runs WHERE code = ?`).get(result.importRunCode);
    assert.equal(row.trig, 'file');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('connector sync writes import_runs with trigger=manual/scheduled', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://x.test/api', access_token_url: 'https://x.test/token',
      client_id: 'c', client_secret: 's', enabled: true, schedule: 'hourly',
    });
    const fetchImpl = async (url) => {
      if (url.includes('/token')) {
        return { ok: true, status: 200, statusText: 'OK',
          async json() { return { access_token: 't', token_type: 'Bearer', expires_in: 3600 }; },
          async text() { return ''; },
        };
      }
      if (url.includes('role=student')) {
        return { ok: true, status: 200, statusText: 'OK',
          async json() { return { users: [{
            sourcedId: 'stu1', givenName: 'A', familyName: 'B',
            metadata: { address: '1 Main St', city: 'X', state: 'MO', zip: '63101' },
            agents: [],
          }] }; },
          async text() { return ''; },
        };
      }
      return { ok: true, status: 200, statusText: 'OK',
        async json() { return { users: [] }; },
        async text() { return ''; },
      };
    };
    const connectors = require('../server/connectors');
    const out = await connectors.runSync(db, secrets, defaultThresholds(), 'facts', {
      trigger: 'manual', actor: 'tester', fetchImpl,
    });
    assert.equal(out.ok, true);
    const row = db.prepare(`SELECT "trigger" AS trig FROM import_runs WHERE code = ?`).get(out.import_run);
    assert.equal(row.trig, 'manual');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('credentials.set/clear emit structured log events with no plaintext', () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const log = require('../server/log');
  const captured = [];
  // Monkey-patch stderr.write for the duration of this test.
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (line) => {
    captured.push(String(line));
    return true;
  };
  try {
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://example.test/api',
      access_token_url: 'https://example.test/token',
      client_id: 'c-DEADBEEF',
      client_secret: 's-DEADBEEF',
    });
    credentials.clear(db, secrets, 'facts');
    const text = captured.join('');
    // Both events should appear by name.
    assert.match(text, /connector\.credential\.set/);
    assert.match(text, /connector\.credential\.deleted/);
    // Plaintext credentials must never appear in any log line.
    assert.equal(text.includes('s-DEADBEEF'), false, 'secret leaked into log');
    assert.equal(text.includes('c-DEADBEEF'), false, 'client id leaked into log');
  } finally {
    process.stderr.write = orig;
    db.close();
    cleanup(dir);
  }
});
