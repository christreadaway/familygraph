'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
const apiKeys = require('../server/auth/api-keys');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function req(port, opts) {
  return new Promise((resolve, reject) => {
    const data = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const h = { 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}), ...(opts.headers || {}) };
    const r = http.request({ method: opts.method || 'GET', hostname: '127.0.0.1', port, path: opts.path, headers: h }, res => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => {
        let p = buf; try { p = JSON.parse(buf); } catch { /* ok */ }
        resolve({ status: res.statusCode, body: p });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

function makeServer(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  return listen(app).then(({ server, port }) => {
    t.after(async () => { await new Promise(r => server.close(r)); db.close(); cleanup(dir); });
    return { server, port, db, secrets };
  });
}

test('api-keys > provision returns a hashed-only record + plaintext token once', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  const r = apiKeys.provision(db, { name: 'missioniq', scopes: ['pii.read', 'sanitize'] });
  assert.match(r.token, /^sk_/);
  assert.deepEqual(r.scopes, ['pii.read', 'sanitize']);
  // The hash column never contains the token.
  const row = db.prepare('SELECT hash FROM api_keys WHERE code = ?').get(r.code);
  assert.notEqual(row.hash, r.token);
  assert.equal(row.hash.length, 64); // sha256 hex
});

test('api-keys > revoked tokens are rejected', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  const r = apiKeys.provision(db, { name: 'x', scopes: ['pii.read'] });
  apiKeys.revoke(db, r.code);
  assert.equal(apiKeys.lookupByToken(db, r.token), null);
});

test('api-keys > unknown scope is rejected', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  assert.throws(() => apiKeys.provision(db, { name: 'x', scopes: ['nope'] }));
});

test('api-keys > master token also satisfies all scopes via the API', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const get = await req(port, { path: '/api/families', headers: auth });
  assert.equal(get.status, 200);
});

test('api-keys > scoped read-only token cannot write', async t => {
  const { port, secrets, db } = await makeServer(t);
  const provision = await req(port, {
    method: 'POST', path: '/api/keys',
    headers: { authorization: `Bearer ${secrets.master}` },
    body: { name: 'parentpoint', scopes: ['pii.read'] },
  });
  assert.equal(provision.status, 201);
  const tok = provision.body.token;
  const read = await req(port, { path: '/api/families', headers: { authorization: `Bearer ${tok}` } });
  assert.equal(read.status, 200);
  const write = await req(port, {
    method: 'POST', path: '/api/families', headers: { authorization: `Bearer ${tok}` }, body: { display_name: 'x' },
  });
  assert.equal(write.status, 403);
});

test('api-keys > revoked key is rejected via the API', async t => {
  const { port, secrets } = await makeServer(t);
  const p = await req(port, {
    method: 'POST', path: '/api/keys', headers: { authorization: `Bearer ${secrets.master}` },
    body: { name: 'bad', scopes: ['pii.read'] },
  });
  const tok = p.body.token;
  await req(port, { method: 'DELETE', path: `/api/keys/${p.body.code}`, headers: { authorization: `Bearer ${secrets.master}` } });
  const r = await req(port, { path: '/api/families', headers: { authorization: `Bearer ${tok}` } });
  assert.equal(r.status, 401);
});

test('api-keys > X-Sanctus-Actor reflects key.name not header for scoped tokens', async t => {
  const { port, secrets, db } = await makeServer(t);
  const p = await req(port, {
    method: 'POST', path: '/api/keys', headers: { authorization: `Bearer ${secrets.master}` },
    body: { name: 'audit_writer', scopes: ['audit.write'] },
  });
  const tok = p.body.token;
  await req(port, {
    method: 'POST', path: '/api/audit/external-export',
    headers: { authorization: `Bearer ${tok}`, 'x-sanctus-actor': 'IGNORED' },
    body: { destination: 'x.csv', entity_codes: [] },
  });
  const events = db.prepare('SELECT * FROM audit_events WHERE action = ? ORDER BY created_at DESC').all('export_consent');
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, 'audit_writer');
});
