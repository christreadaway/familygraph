'use strict';

// Tests for the consuming-app identity enhancements:
//   - GET  /api/health           exposes a capabilities map
//   - POST /api/identity/resolve returns a family code (and creates one on opt-in)
//   - POST /api/identity/resolve-batch
//   - GET  /api/identity/changed forward-cursored change feed

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');
const people = require('../server/identity/people');
const families = require('../server/identity/families');
const contacts = require('../server/identity/contacts');

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function close(server) { return new Promise(resolve => server.close(resolve)); }

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method, hostname: '127.0.0.1', port, path,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}), ...headers },
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => buf += c);
      res.on('end', () => { let p = buf; try { p = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, body: p }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function makeServer(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const { server, port } = await listen(app);
  t.after(async () => { await close(server); db.close(); cleanup(dir); });
  return { server, port, db, secrets };
}

const auth = secrets => ({ authorization: `Bearer ${secrets.master}`, 'x-family-graph-actor': 'unit-test' });

test('health > exposes a capabilities map for feature discovery', async t => {
  const { port } = await makeServer(t);
  const r = await request(port, { path: '/api/health' });
  assert.equal(r.status, 200);
  assert.ok(r.body.capabilities, 'capabilities present');
  assert.equal(r.body.capabilities.identity_resolve_batch, true);
  assert.equal(r.body.capabilities.identity_resolve_family, true);
  assert.equal(r.body.capabilities.identity_changed_feed, true);
  assert.equal(r.body.capabilities.identity_conflict_source_ref, true);
  assert.equal(typeof r.body.capabilities_version, 'number');
});

test('resolve > stamps the caller source_ref onto an opened conflict', async t => {
  const { port, db, secrets } = await makeServer(t);
  // Seed a name-only person so a same-name resolve scores in the review band
  // (last+first name = 0.50) and opens a conflict rather than auto-merging.
  people.create(db, secrets, { given_name: 'Mary', family_name: 'Smith' });

  const r = await request(port, {
    method: 'POST', path: '/api/identity/resolve', headers: auth(secrets),
    body: { source: 'ext_app', source_ref: 'ext:record:123', record: { first_name: 'Mary', last_name: 'Smith', email: 'new-mary@example.org' } },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.action, 'enqueued');
  assert.ok(r.body.conflict, 'conflict opened');

  // The consuming app's opaque ref is now visible on the conflict for the operator.
  const c = await request(port, { method: 'GET', path: `/api/conflicts/${r.body.conflict}`, headers: auth(secrets) });
  assert.equal(c.status, 200);
  assert.equal(c.body.conflict.metadata.source_ref, 'ext:record:123');
  assert.equal(c.body.conflict.metadata.source, 'ext_app');
});

test('resolve > returns the existing family code for a matched person', async t => {
  const { port, db, secrets } = await makeServer(t);
  // Seed a person with an email, in a family.
  const pcode = people.create(db, secrets, { given_name: 'Mary', family_name: 'Smith' });
  const ec = contacts.upsertEmail(db, secrets, 'mary@example.org');
  contacts.attachEmailToPerson(db, pcode, ec);
  const fcode = families.create(db, secrets, { display_name: 'Smith Family' });
  families.addMember(db, secrets, fcode, pcode, { role: 'parent' });

  const r = await request(port, {
    method: 'POST', path: '/api/identity/resolve', headers: auth(secrets),
    body: { record: { first_name: 'Mary', last_name: 'Smith', email: 'mary@example.org' } },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.action, 'attached');
  assert.equal(r.body.code, pcode);
  assert.ok(r.body.family, 'family included');
  assert.equal(r.body.family.code, fcode);
  assert.equal(r.body.family.action, 'existing');
});

test('resolve > with_family creates and attaches a family for a new person', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await request(port, {
    method: 'POST', path: '/api/identity/resolve', headers: auth(secrets),
    body: {
      with_family: true,
      record: { first_name: 'John', last_name: 'Doe', email: 'john@example.org', address_line1: '1 Main St', city: 'Springfield', zip: '00001' },
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.action, 'created');
  assert.ok(r.body.family, 'family created');
  assert.equal(r.body.family.action, 'created');
  assert.match(r.body.family.code, /^f_/);
});

test('resolve > omits family for a new person when with_family is not set', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await request(port, {
    method: 'POST', path: '/api/identity/resolve', headers: auth(secrets),
    body: { record: { first_name: 'Lone', last_name: 'Wolf', email: 'lone@example.org' } },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.action, 'created');
  assert.equal(r.body.family, undefined);
});

test('resolve-batch > resolves many records and reports totals', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await request(port, {
    method: 'POST', path: '/api/identity/resolve-batch', headers: auth(secrets),
    body: {
      records: [
        { first_name: 'A', last_name: 'One', email: 'a@example.org' },
        { first_name: 'B', last_name: 'Two', email: 'b@example.org' },
        { first_name: 'A', last_name: 'One', email: 'a@example.org' }, // same as #1 → attaches
      ],
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.results.length, 3);
  assert.equal(r.body.results[0].index, 0);
  assert.match(r.body.results[0].code, /^p_/);
  // Third row is the same person as the first → attached, same code.
  assert.equal(r.body.results[2].code, r.body.results[0].code);
  assert.equal(r.body.totals.created, 2);
  assert.equal(r.body.totals.attached, 1);
});

test('resolve-batch > rejects a non-array and an over-limit batch', async t => {
  const { port, secrets } = await makeServer(t);
  const bad = await request(port, {
    method: 'POST', path: '/api/identity/resolve-batch', headers: auth(secrets), body: { records: 'nope' },
  });
  assert.equal(bad.status, 400);

  const tooMany = await request(port, {
    method: 'POST', path: '/api/identity/resolve-batch', headers: auth(secrets),
    body: { records: new Array(1001).fill({ first_name: 'X', last_name: 'Y' }) },
  });
  assert.equal(tooMany.status, 400);
});

test('changed > feeds identity changes and cursors forward', async t => {
  const { port, db, secrets } = await makeServer(t);
  // Two creates → two person changes.
  const p1 = people.create(db, secrets, { given_name: 'Ann', family_name: 'Alpha' });
  const p2 = people.create(db, secrets, { given_name: 'Bea', family_name: 'Beta' });

  const all = await request(port, { path: '/api/identity/changed', headers: auth(secrets) });
  assert.equal(all.status, 200);
  assert.ok(all.body.count >= 2);
  const codes = all.body.changes.map(c => c.code);
  assert.ok(codes.includes(p1) && codes.includes(p2));
  assert.ok(all.body.next_since, 'next_since cursor returned');

  // Cursoring past the last change yields nothing new.
  const after = await request(port, { path: `/api/identity/changed?since=${encodeURIComponent(all.body.next_since)}`, headers: auth(secrets) });
  assert.equal(after.status, 200);
  assert.equal(after.body.count, 0);
});

test('changed > captures a merge so a consumer can follow the surviving code', async t => {
  const { port, db, secrets } = await makeServer(t);
  const loser = people.create(db, secrets, { given_name: 'Dup', family_name: 'Licate' });
  const winner = people.create(db, secrets, { given_name: 'Dup', family_name: 'Licate' });

  // Snapshot the cursor after the two creates, then merge.
  const before = await request(port, { path: '/api/identity/changed', headers: auth(secrets) });
  const cursor = before.body.next_since;
  people.merge(db, secrets, loser, winner, { actor: 'unit-test' });

  const feed = await request(port, { path: `/api/identity/changed?since=${encodeURIComponent(cursor)}`, headers: auth(secrets) });
  assert.equal(feed.status, 200);
  const mergeRows = feed.body.changes.filter(c => c.operation === 'merge');
  assert.ok(mergeRows.length >= 1, 'merge appears in the changed feed');
});
