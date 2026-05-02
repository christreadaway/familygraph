'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
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

test('GET /api/connectors lists both connectors with status untested initially', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const { server, port } = await listen(app);
  try {
    const r = await request(port, {
      path: '/api/connectors',
      headers: { authorization: `Bearer ${secrets.master}` },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 2);
    const names = r.body.items.map(i => i.name).sort();
    assert.deepEqual(names, ['facts', 'ministry_platform']);
    for (const item of r.body.items) {
      assert.equal(item.status, 'untested');
      assert.equal(item.enabled, false);
      assert.equal(item.fields.client_secret.set, false);
    }
  } finally {
    await close(server);
    db.close();
    cleanup(dir);
  }
});

test('POST /api/connectors/:name/credentials stores secrets without leaking plaintext', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const { server, port } = await listen(app);
  try {
    const r = await request(port, {
      method: 'POST',
      path: '/api/connectors/facts/credentials',
      headers: { authorization: `Bearer ${secrets.master}` },
      body: {
        api_base_url: 'https://example.test/api/v3',
        access_token_url: 'https://example.test/oauth2/token',
        client_id: 'cid-public-1',
        client_secret: 'super-secret-payload',
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.connector.fields.client_secret.set, true);
    assert.equal('value' in r.body.connector.fields.client_secret, false);
    // No plaintext leaks
    const json = JSON.stringify(r.body);
    assert.equal(json.includes('super-secret-payload'), false);
    assert.equal(json.includes('cid-public-1'), false);
  } finally {
    await close(server);
    db.close();
    cleanup(dir);
  }
});

test('PATCH /api/connectors/:name updates schedule and enabled flag', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const { server, port } = await listen(app);
  try {
    const r1 = await request(port, {
      method: 'PATCH', path: '/api/connectors/facts',
      headers: { authorization: `Bearer ${secrets.master}` },
      body: { enabled: true, schedule: 'hourly' },
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.connector.enabled, true);
    assert.equal(r1.body.connector.schedule, 'hourly');

    const r2 = await request(port, {
      method: 'PATCH', path: '/api/connectors/facts',
      headers: { authorization: `Bearer ${secrets.master}` },
      body: { schedule: 'every_minute' },
    });
    assert.equal(r2.status, 400);
  } finally {
    await close(server);
    db.close();
    cleanup(dir);
  }
});

test('DELETE /api/connectors/:name/credentials clears state', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const { server, port } = await listen(app);
  try {
    await request(port, {
      method: 'POST', path: '/api/connectors/facts/credentials',
      headers: { authorization: `Bearer ${secrets.master}` },
      body: {
        api_base_url: 'https://example.test/api/v3',
        access_token_url: 'https://example.test/oauth2/token',
        client_id: 'c', client_secret: 's',
      },
    });
    const del = await request(port, {
      method: 'DELETE', path: '/api/connectors/facts/credentials',
      headers: { authorization: `Bearer ${secrets.master}` },
    });
    assert.equal(del.status, 204);
    const r = await request(port, {
      path: '/api/connectors/facts',
      headers: { authorization: `Bearer ${secrets.master}` },
    });
    assert.equal(r.body.connector.fields.client_secret.set, false);
  } finally {
    await close(server);
    db.close();
    cleanup(dir);
  }
});

test('POST /api/connectors/:name/test against unconfigured connector yields config_error', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const { server, port } = await listen(app);
  try {
    const r = await request(port, {
      method: 'POST', path: '/api/connectors/facts/test',
      headers: { authorization: `Bearer ${secrets.master}` },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, 'config_error');
  } finally {
    await close(server);
    db.close();
    cleanup(dir);
  }
});

test('GET /api/connectors/bogus returns 404', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const { server, port } = await listen(app);
  try {
    const r = await request(port, {
      path: '/api/connectors/bogus',
      headers: { authorization: `Bearer ${secrets.master}` },
    });
    assert.equal(r.status, 404);
  } finally {
    await close(server);
    db.close();
    cleanup(dir);
  }
});

test('GET /api/connector-runs returns empty initially', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const { server, port } = await listen(app);
  try {
    const r = await request(port, {
      path: '/api/connector-runs',
      headers: { authorization: `Bearer ${secrets.master}` },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, []);
  } finally {
    await close(server);
    db.close();
    cleanup(dir);
  }
});

test('endpoints reject missing bearer with 401', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const { server, port } = await listen(app);
  try {
    const r = await request(port, { path: '/api/connectors' });
    assert.equal(r.status, 401);
  } finally {
    await close(server);
    db.close();
    cleanup(dir);
  }
});

test('GET /api/conflicts?cross_source=true filter works against the JSON column', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const { server, port } = await listen(app);
  try {
    // Inject a couple of conflict rows directly: one cross-source, one not.
    db.prepare(`INSERT INTO conflicts (code, kind, left_code, right_code, score, reasons, metadata) VALUES (?,?,?,?,?,?,?)`)
      .run('conf_aaaa1111', 'person', 'p_left1111', 'p_right111', 0.5, '[]', JSON.stringify({ cross_source: true, sources: ['facts_api', 'ministry_platform_api'] }));
    db.prepare(`INSERT INTO conflicts (code, kind, left_code, right_code, score, reasons, metadata) VALUES (?,?,?,?,?,?,?)`)
      .run('conf_bbbb2222', 'person', 'p_left2222', 'p_right222', 0.5, '[]', null);

    const r = await request(port, {
      path: '/api/conflicts?cross_source=true',
      headers: { authorization: `Bearer ${secrets.master}` },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1);
    assert.equal(r.body.items[0].code, 'conf_aaaa1111');
  } finally {
    await close(server);
    db.close();
    cleanup(dir);
  }
});
