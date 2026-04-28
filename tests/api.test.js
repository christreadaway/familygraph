'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(port, { method = 'GET', path = '/', headers = {}, body, ip = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const opts = {
      method,
      hostname: ip,
      port,
      path,
      headers: {
        'content-type': 'application/json',
        ...(data ? { 'content-length': data.length } : {}),
        ...headers,
      },
    };
    const req = http.request(opts, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => (buf += c));
      res.on('end', () => {
        let payload = buf;
        try { payload = JSON.parse(buf); } catch { /* keep string */ }
        resolve({ status: res.statusCode, body: payload, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function makeServer(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  return listen(app).then(({ server, port }) => {
    t.after(async () => { await close(server); db.close(); cleanup(dir); });
    return { server, port, db, secrets };
  });
}

test('api > health is open', async t => {
  const { port } = await makeServer(t);
  const res = await request(port, { path: '/api/health' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('api > PII surface refuses without bearer token', async t => {
  const { port } = await makeServer(t);
  const res = await request(port, { path: '/api/families' });
  assert.equal(res.status, 401);
  const ok = await request(port, { path: '/api/families', headers: { authorization: 'Bearer wrong' } });
  assert.equal(ok.status, 401);
});

test('api > PII surface with bearer returns data', async t => {
  const { port, secrets } = await makeServer(t);
  const res = await request(port, {
    path: '/api/families',
    headers: { authorization: `Bearer ${secrets.master}`, 'x-custos-actor': 'unit-test' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { items: [] });
});

test('api > create + read family includes PII', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}`, 'x-custos-actor': 'unit-test' };
  const create = await request(port, { method: 'POST', path: '/api/families', headers: auth, body: { display_name: 'Smith' } });
  assert.equal(create.status, 201);
  const code = create.body.code;
  const get = await request(port, { path: `/api/families/${code}`, headers: auth });
  assert.equal(get.status, 200);
  assert.equal(get.body.family.display_name, 'Smith');
});

test('api > safe surface returns no PII', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}`, 'x-custos-actor': 'unit-test' };
  await request(port, { method: 'POST', path: '/api/families', headers: auth, body: { display_name: 'Smith Privacy Test' } });
  const safe = await request(port, { path: '/api/safe/families' });
  assert.equal(safe.status, 200);
  for (const item of safe.body.items) {
    assert.equal(item.display_name, undefined);
    assert.equal(item.notes, undefined);
  }
});

test('api > sanitize/desanitize round trip', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}`, 'x-custos-actor': 'unit-test' };
  const text = 'Mary Smith can be reached at mary@example.org.';
  const r = await request(port, { method: 'POST', path: '/api/sanitize', headers: auth, body: { text } });
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.body.sanitized, /mary@example\.org/);
  const d = await request(port, {
    method: 'POST',
    path: '/api/desanitize',
    headers: auth,
    body: { text: r.body.sanitized, token_set: r.body.token_set },
  });
  assert.equal(d.status, 200);
  assert.equal(d.body.text, text);
});

test('api > import preview + run', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}`, 'x-custos-actor': 'unit-test' };
  const csvBody = 'first_name,last_name,email,city,state,zip\nMary,Smith,mary@example.org,Lima,OH,45801\n';
  const preview = await request(port, { method: 'POST', path: '/api/import/preview', headers: auth, body: { content: csvBody } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.row_count, 1);
  const run = await request(port, { method: 'POST', path: '/api/import/run', headers: auth, body: { content: csvBody } });
  assert.equal(run.status, 201);
  assert.equal(run.body.rows, 1);
  assert.ok(run.body.results[0].family.code.startsWith('f_'));
});

test('api > external-export consent records tier-2 audit event', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}`, 'x-custos-actor': 'missioniq' };
  const r = await request(port, {
    method: 'POST',
    path: '/api/audit/external-export',
    headers: auth,
    body: { destination: 'board.csv', entity_codes: ['f_deadbeef'], reason: 'board report' },
  });
  assert.equal(r.status, 201);
  const list = await request(port, { path: '/api/audit?action=export_consent', headers: auth });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].tier, 2);
});

test('api > 404 on unknown api path returns JSON', async t => {
  const { port } = await makeServer(t);
  const res = await request(port, { path: '/api/nope' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not found');
});

test('api > invalid family code is 400', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}`, 'x-custos-actor': 'unit-test' };
  const res = await request(port, { path: '/api/families/not_a_code', headers: auth });
  assert.equal(res.status, 400);
});

test('api > merge + split families', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}`, 'x-custos-actor': 'unit-test' };
  const a = (await request(port, { method: 'POST', path: '/api/families', headers: auth, body: { display_name: 'A' } })).body.code;
  const b = (await request(port, { method: 'POST', path: '/api/families', headers: auth, body: { display_name: 'B' } })).body.code;
  const merge = await request(port, { method: 'POST', path: `/api/families/${a}/merge`, headers: auth, body: { winner_code: b } });
  assert.equal(merge.status, 200);
  // Reading the loser should now return the winner.
  const get = await request(port, { path: `/api/families/${a}`, headers: auth });
  assert.equal(get.status, 200);
  assert.equal(get.body.family.code, b);
});

test('api > conflict resolve via merge', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}`, 'x-custos-actor': 'unit-test' };
  const p1 = (await request(port, { method: 'POST', path: '/api/people', headers: auth, body: { given_name: 'Pio', family_name: 'Pietrelcina' } })).body.code;
  const p2 = (await request(port, { method: 'POST', path: '/api/people', headers: auth, body: { given_name: 'Pio', family_name: 'Pietrelcina' } })).body.code;
  // Trigger a rescore to create a conflict.
  const resolver = require('../server/identity/resolver');
  const conflictsMod = require('../server/identity/conflicts');
  resolver.rescorePerson(db, secrets, defaultThresholds(), p2);
  const open = conflictsMod.list(db);
  assert.ok(open.length >= 1);
  const cfl = open[0];
  const resolve = await request(port, {
    method: 'POST',
    path: `/api/conflicts/${cfl.code}/resolve`,
    headers: auth,
    body: { decision: 'merge', winner_code: p1 },
  });
  assert.equal(resolve.status, 200);
});
