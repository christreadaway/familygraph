'use strict';

// Phase 2 contract-edge tests for the partner app consumer of the
// FamilyGraph /v1 surface. Covers the v0.2 additions:
//   - X-FG-Contract-Version: v0.2 accepted (v0.1 still accepted; unknown
//     major → 426)
//   - POST /v1/consents              (canonical, person-keyed consent write)
//   - POST /v1/schools/:id/context   (canonical, school-keyed context snapshot)
//   - the five canonical webhook event names emitted with a sha256= signature
//
// The query lookups (?email=, ?personId=) and the households/changed feed
// are already covered by integration-api.test.js / integration-bugfixes.test.js
// — this file only exercises the new contract edges.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const { buildApp } = require('../server');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');
const people = require('../server/identity/people');
const families = require('../server/identity/families');
const webhooks = require('../server/integration/webhooks');

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
      res.on('end', () => {
        let payload = buf;
        try { payload = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: payload, headers: res.headers });
      });
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

const auth = (secrets, extra = {}) => ({
  authorization: `Bearer ${secrets.master}`,
  'x-family-graph-actor': 'partner-contract-test',
  'x-fg-contract-version': 'v0.2',
  'x-source-app': 'partner',
  ...extra,
});

// -----------------------------------------------------------------------------
// CONTRACT VERSION
// -----------------------------------------------------------------------------

test('the partner app contract > X-FG-Contract-Version: v0.2 is accepted and echoed', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await request(port, { path: '/v1/webhooks', headers: auth(secrets) });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-fg-contract-version'], 'v0.2');
});

test('the partner app contract > X-FG-Contract-Version: v0.1 still accepted (back-compat)', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await request(port, {
    path: '/v1/webhooks', headers: auth(secrets, { 'x-fg-contract-version': 'v0.1' }),
  });
  assert.equal(r.status, 200);
});

test('the partner app contract > unknown major contract version is rejected with 426', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await request(port, {
    path: '/v1/webhooks', headers: auth(secrets, { 'x-fg-contract-version': 'v9.9' }),
  });
  assert.equal(r.status, 426);
  assert.equal(r.body.error, 'upgrade_required');
});

// -----------------------------------------------------------------------------
// POST /v1/consents — canonical person-keyed consent write
// -----------------------------------------------------------------------------

test('the partner app contract > POST /v1/consents writes the identity-level base', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  const r = await request(port, {
    method: 'POST', path: '/v1/consents', headers: auth(secrets),
    body: { personId: p, photo: 'group_only', directory: 'deny' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.consent.photoConsent, 'group_only');
  assert.equal(r.body.consent.directoryListing, 'deny');
  assert.equal(r.body.consent.overrideApplied, false);
});

test('the partner app contract > POST /v1/consents with schoolId writes a per-school override', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  // base
  await request(port, {
    method: 'POST', path: '/v1/consents', headers: auth(secrets),
    body: { personId: p, photo: 'allow' },
  });
  // override
  const r = await request(port, {
    method: 'POST', path: '/v1/consents', headers: auth(secrets),
    body: { personId: p, schoolId: 'st-marys', photo: 'deny' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.consent.photoConsent, 'deny');
  assert.equal(r.body.consent.overrideApplied, true);
  assert.equal(r.body.consent.basePhotoConsent, 'allow');
});

test('the partner app contract > POST /v1/consents accepts personCode as an alias for personId', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Bob', family_name: 'Jones' });
  const r = await request(port, {
    method: 'POST', path: '/v1/consents', headers: auth(secrets),
    body: { personCode: p, directory: 'deny' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.consent.directoryListing, 'deny');
});

test('the partner app contract > POST /v1/consents fires a consent.updated webhook (school-scoped carries schoolId)', async t => {
  const { port, db, secrets } = await makeServer(t);
  webhooks.subscribe(db, secrets, { url: 'https://partner.example/cb', events: ['consent.updated'] });
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  await request(port, {
    method: 'POST', path: '/v1/consents', headers: auth(secrets),
    body: { personId: p, schoolId: 'st-marys', photo: 'deny' },
  });
  const pending = webhooks.listPendingDeliveries(db, {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].event, 'consent.updated');
  const payload = JSON.parse(pending[0].payload);
  assert.equal(payload.personId, p);
  assert.equal(payload.schoolId, 'st-marys');
});

test('the partner app contract > POST /v1/consents with a bad person id is a 400', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await request(port, {
    method: 'POST', path: '/v1/consents', headers: auth(secrets),
    body: { personId: 'not-a-code', photo: 'allow' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_person_id');
});

test('the partner app contract > POST /v1/consents with neither photo nor directory is a 400', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  const r = await request(port, {
    method: 'POST', path: '/v1/consents', headers: auth(secrets), body: { personId: p },
  });
  assert.equal(r.status, 400);
});

// -----------------------------------------------------------------------------
// POST /v1/schools/:schoolId/context — canonical school-keyed snapshot
// -----------------------------------------------------------------------------

test('the partner app contract > POST /v1/schools/:id/context stores a snapshot keyed by the path schoolId', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  const r = await request(port, {
    method: 'POST', path: '/v1/schools/st-marys/context', headers: auth(secrets),
    body: {
      personId: p,
      schoolYear: '2026-2027',
      grade: '3',
      classroomId: '3A',
      classroomName: 'Room 204',
      activities: [{ kind: 'sport', label: 'Basketball', season: '2026-2027 Winter' }],
      allergies: ['peanuts'],
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.schoolContext.schoolId, 'st-marys');
  assert.equal(r.body.schoolContext.grade, '3');
  assert.deepEqual(r.body.schoolContext.allergies, ['peanuts']);
  // Round-trips on read.
  const g = await request(port, {
    path: `/v1/persons/${p}/schoolContext?schoolId=st-marys`, headers: auth(secrets),
  });
  assert.equal(g.body.schoolContext.classroomName, 'Room 204');
});

test('the partner app contract > POST /v1/schools/:id/context overwrites the previous snapshot (current state, not a log)', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  await request(port, {
    method: 'POST', path: '/v1/schools/st-marys/context', headers: auth(secrets),
    body: { personId: p, grade: '3', classroomId: '3A' },
  });
  await request(port, {
    method: 'POST', path: '/v1/schools/st-marys/context', headers: auth(secrets),
    body: { personId: p, grade: '3', classroomId: '3B' },
  });
  const g = await request(port, {
    path: `/v1/persons/${p}/schoolContext?schoolId=st-marys`, headers: auth(secrets),
  });
  assert.equal(g.body.schoolContext.classroomId, '3B');
  // Only one row for the (person, school) pair.
  const all = await request(port, { path: `/v1/persons/${p}/schoolContext`, headers: auth(secrets) });
  assert.equal(all.body.items.length, 1);
});

test('the partner app contract > POST /v1/schools/:id/context for an unknown person is a 404', async t => {
  const { port, secrets } = await makeServer(t);
  // A syntactically valid but non-existent person code.
  const ghost = 'p_' + crypto.randomBytes(4).toString('hex');
  const r = await request(port, {
    method: 'POST', path: '/v1/schools/st-marys/context', headers: auth(secrets),
    body: { personId: ghost, grade: '3' },
  });
  assert.equal(r.status, 404);
});

test('the partner app contract > POST /v1/schools/:id/context rejects a malformed schoolId', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  const r = await request(port, {
    method: 'POST', path: '/v1/schools/bad%2Fslug/context', headers: auth(secrets),
    body: { personId: p, grade: '3' },
  });
  assert.equal(r.status, 400);
});

// -----------------------------------------------------------------------------
// WEBHOOK SIGNATURE — sha256= over the raw body, keyed by the subscription secret
// -----------------------------------------------------------------------------

test('the partner app contract > webhook delivery signs the raw body as sha256=<HMAC-SHA256>', async t => {
  const { port, db, secrets } = await makeServer(t);
  const secret = 'partner-shared-secret';
  webhooks.subscribe(db, secrets, { url: 'https://partner.example/cb', secret, events: ['person.updated'] });
  const p = people.create(db, secrets, { given_name: 'Demo', family_name: 'User' });
  await request(port, {
    method: 'PATCH', path: `/v1/persons/${p}`, headers: auth(secrets), body: { preferredName: 'Dee' },
  });
  let capturedHeaders = null;
  let capturedBody = null;
  await webhooks.dispatchPending(db, secrets, {
    sender: async ({ headers, body }) => { capturedHeaders = headers; capturedBody = body; return { ok: true, status: 200 }; },
  });
  assert.ok(capturedHeaders['x-fg-signature']);
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(capturedBody, 'utf8')).digest('hex');
  assert.equal(capturedHeaders['x-fg-signature'], expected);
  assert.equal(capturedHeaders['x-fg-contract-version'], 'v0.2');
});

test('the partner app contract > all five canonical event names are the only ones the dispatcher knows', t => {
  assert.deepEqual(
    [...webhooks.KNOWN_EVENTS].sort(),
    ['consent.updated', 'household.deleted', 'household.updated', 'person.deleted', 'person.updated'],
  );
});
