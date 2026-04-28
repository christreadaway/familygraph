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

test('auth reasons > no bearer returns 401 with reason=no_bearer', async t => {
  const { port } = await makeServer(t);
  const r = await req(port, { path: '/api/families' });
  assert.equal(r.status, 401);
  assert.equal(r.body.reason, 'no_bearer');
});

test('auth reasons > bad bearer returns 401 with reason=token_mismatch', async t => {
  const { port } = await makeServer(t);
  const r = await req(port, { path: '/api/families', headers: { authorization: 'Bearer not-a-real-token' } });
  assert.equal(r.status, 401);
  assert.equal(r.body.reason, 'token_mismatch');
});

test('auth reasons > revoked scoped key returns 401 with reason=unknown_or_revoked_scoped_token', async t => {
  const { port, db } = await makeServer(t);
  const issued = apiKeys.provision(db, { name: 'rev', scopes: ['pii.read'] });
  apiKeys.revoke(db, issued.code);
  const r = await req(port, { path: '/api/families', headers: { authorization: `Bearer ${issued.token}` } });
  assert.equal(r.status, 401);
  assert.equal(r.body.reason, 'unknown_or_revoked_scoped_token');
});

test('auth reasons > scoped key with insufficient scope returns 403 with reason=missing_scope', async t => {
  const { port, db } = await makeServer(t);
  const issued = apiKeys.provision(db, { name: 'ro', scopes: ['pii.read'] });
  // Try to write — pii.write is required for POST /api/families.
  const r = await req(port, {
    method: 'POST', path: '/api/families',
    headers: { authorization: `Bearer ${issued.token}` },
    body: { display_name: 'x' },
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'missing_scope');
});

test('auth reasons > master token still works (no reason on success)', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await req(port, { path: '/api/families', headers: { authorization: `Bearer ${secrets.master}` } });
  assert.equal(r.status, 200);
  assert.equal(r.body.reason, undefined);
});

test('auth reasons > tokenFingerprint is stable + non-reversing', () => {
  const { tokenFingerprint } = require('../server/auth/middleware');
  const a = tokenFingerprint('hello');
  const b = tokenFingerprint('hello');
  const c = tokenFingerprint('helloo');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 8);
  assert.match(a, /^[0-9a-f]{8}$/);
});
