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
function req(port, opts) {
  return new Promise((resolve, reject) => {
    const data = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const h = { 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}), ...(opts.headers || {}) };
    const r = http.request({ method: opts.method || 'GET', hostname: '127.0.0.1', port, path: opts.path, headers: h }, res => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => {
        const ct = res.headers['content-type'] || '';
        let p = buf;
        if (ct.includes('application/json')) { try { p = JSON.parse(buf); } catch { /* ok */ } }
        resolve({ status: res.statusCode, body: p, headers: res.headers });
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

test('api ext > search by name returns matched persons + their families', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const csv = 'first_name,last_name,email\nMary,Smith,mary@example.org\nJohn,Smith,john@example.org\n';
  await req(port, { method: 'POST', path: '/api/import/run', headers: auth, body: { content: csv } });
  const r = await req(port, { path: '/api/search?q=Smith', headers: auth });
  assert.equal(r.status, 200);
  assert.equal(r.body.persons.length, 2);
  assert.ok(r.body.families.length >= 1);
});

test('api ext > export safe produces no PII in JSON', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  await req(port, { method: 'POST', path: '/api/families', headers: auth, body: { display_name: 'Smith Test' } });
  const r = await req(port, { method: 'POST', path: '/api/export', headers: auth, body: { entity: 'families', mode: 'safe', format: 'json' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'safe');
  for (const item of r.body.items) {
    assert.equal(item.display_name, undefined);
  }
});

test('api ext > export PII without consent flag is rejected', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const r = await req(port, {
    method: 'POST', path: '/api/export', headers: auth,
    body: { entity: 'families', mode: 'pii', format: 'json' },
  });
  assert.equal(r.status, 400);
});

test('api ext > export PII with consent records tier-2 audit event', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}`, 'x-custos-actor': 'dashboard' };
  await req(port, { method: 'POST', path: '/api/families', headers: auth, body: { display_name: 'Smith' } });
  const r = await req(port, {
    method: 'POST', path: '/api/export', headers: auth,
    body: { entity: 'families', mode: 'pii', format: 'csv', consent: true, destination: 'board.csv', reason: 'q2' },
  });
  assert.equal(r.status, 200);
  // CSV body
  assert.match(r.body, /code,status,created_at,display_name,notes/);
  const t2 = db.prepare("SELECT * FROM audit_events WHERE tier = 2 AND action = 'export_consent'").all();
  assert.equal(t2.length, 1);
  assert.equal(t2[0].destination, 'board.csv');
});

test('api ext > membership history returns rows for a person across families', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const f1 = (await req(port, { method: 'POST', path: '/api/families', headers: auth, body: {} })).body.code;
  const f2 = (await req(port, { method: 'POST', path: '/api/families', headers: auth, body: {} })).body.code;
  const p = (await req(port, { method: 'POST', path: '/api/people', headers: auth, body: { given_name: 'Lucy', family_name: 'X' } })).body.code;
  const m1 = (await req(port, { method: 'POST', path: `/api/families/${f1}/members`, headers: auth, body: { person_code: p, role: 'child' } })).body.membership_code;
  await req(port, { method: 'DELETE', path: `/api/families/${f1}/members/${m1}`, headers: auth, body: { reason: 'emancipation' } });
  await req(port, { method: 'POST', path: `/api/families/${f2}/members`, headers: auth, body: { person_code: p, role: 'parent' } });
  const r = await req(port, { path: `/api/membership-history/person/${p}`, headers: auth });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 2);
  assert.equal(r.body.items[0].family_code, f1);
  assert.equal(r.body.items[0].reason, 'emancipation');
  assert.equal(r.body.items[1].family_code, f2);
});

test('api ext > rules round trip via the API', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const c = (await req(port, {
    method: 'POST', path: '/api/rules', headers: auth,
    body: { kind: 'person', rule: { match: { given_name: 'Karol' }, action: 'never_merge' } },
  })).body.code;
  const list = await req(port, { path: '/api/rules', headers: auth });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  await req(port, { method: 'PATCH', path: `/api/rules/${c}`, headers: auth, body: { enabled: false } });
  const list2 = await req(port, { path: '/api/rules?enabled=1', headers: auth });
  assert.equal(list2.body.items.length, 0);
  await req(port, { method: 'DELETE', path: `/api/rules/${c}`, headers: auth });
  const list3 = await req(port, { path: '/api/rules', headers: auth });
  assert.equal(list3.body.items.length, 0);
});

test('api ext > settings put + get + delete', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const put = await req(port, {
    method: 'PUT', path: '/api/settings/audit_retention_days', headers: auth, body: { value: 365 },
  });
  assert.equal(put.status, 200);
  const got = await req(port, { path: '/api/settings', headers: auth });
  assert.ok(got.body.items.find(it => it.key === 'audit_retention_days' && it.value === 365));
  const del = await req(port, { method: 'DELETE', path: '/api/settings/audit_retention_days', headers: auth });
  assert.equal(del.status, 204);
});

test('api ext > settings rejects unknown keys', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await req(port, {
    method: 'PUT', path: '/api/settings/foobar', headers: { authorization: `Bearer ${secrets.master}` }, body: { value: 1 },
  });
  assert.equal(r.status, 400);
});

test('api ext > profile activation surfaces in /api/profiles', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  await req(port, { method: 'POST', path: '/api/profiles/activate', headers: auth, body: { name: 'parish_donor' } });
  const r = await req(port, { path: '/api/profiles', headers: auth });
  assert.equal(r.body.active.name, 'parish_donor');
});

test('api ext > relationships add then remove', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const a = (await req(port, { method: 'POST', path: '/api/families', headers: auth, body: {} })).body.code;
  const b = (await req(port, { method: 'POST', path: '/api/families', headers: auth, body: {} })).body.code;
  const c = await req(port, { method: 'POST', path: '/api/relationships', headers: auth, body: { from: a, to: b, kind: 'related_household' } });
  assert.equal(c.status, 201);
  const list = await req(port, { path: `/api/relationships/${a}`, headers: auth });
  assert.ok(list.body.items.find(r => r.code === c.body.code));
  await req(port, { method: 'DELETE', path: `/api/relationships/${c.body.code}`, headers: auth });
  const list2 = await req(port, { path: `/api/relationships/${a}`, headers: auth });
  assert.equal(list2.body.items.find(r => r.code === c.body.code), undefined);
});

test('api ext > unauthenticated /api/safe still works as before', async t => {
  const { port } = await makeServer(t);
  const r = await req(port, { path: '/api/safe/families' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { items: [] });
});
