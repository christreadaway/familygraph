'use strict';

// End-to-end test of the /v1 Integration contract router.

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
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
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
  'x-family-graph-actor': 'integration-test',
  'x-fg-contract-version': 'v0.1',
  'x-source-app': 'integration',
  ...extra,
});

// -----------------------------------------------------------------------------
// PERSONS — read
// -----------------------------------------------------------------------------

test('Integration API > GET /v1/persons?email=<x> returns the matched person', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee', kind: 'adult' });
  const e = contacts.upsertEmail(db, secrets, 'amanda@example.com');
  contacts.attachEmailToPerson(db, p, e, { isPrimary: true });
  const r = await request(port, {
    path: '/v1/persons?email=amanda@example.com',
    headers: auth(secrets),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.person.personId, p);
  assert.equal(r.body.person.primaryEmail, 'amanda@example.com');
  assert.equal(r.body.person.firstName, 'Amanda');
  assert.equal(r.body.person.kind, 'adult');
  assert.ok(r.headers.etag, 'response should carry an ETag');
  assert.match(r.headers['x-fg-contract-version'], /v0\.1/);
});

test('Integration API > GET /v1/persons?email=<unknown> returns 404', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await request(port, {
    path: '/v1/persons?email=ghost@example.com',
    headers: auth(secrets),
  });
  assert.equal(r.status, 404);
});

test('Integration API > GET /v1/persons/:id returns the §6.1 shape', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, {
    given_name: 'Amanda', family_name: 'Lee', preferred_name: 'Mandy', kind: 'adult',
  });
  const ph = contacts.upsertPhone(db, secrets, '(512) 555-0101', { kind: 'mobile', smsConsent: true });
  contacts.attachPhoneToPerson(db, p, ph, { isPrimary: true });
  const r = await request(port, { path: `/v1/persons/${p}`, headers: auth(secrets) });
  assert.equal(r.status, 200);
  assert.equal(r.body.person.preferredName, 'Mandy');
  assert.equal(r.body.person.phones[0].e164, '+15125550101');
  assert.equal(r.body.person.phones[0].smsConsent, true);
});

test('Integration API > GET /v1/persons/:id 400s on a bad code', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await request(port, { path: '/v1/persons/not-a-code', headers: auth(secrets) });
  assert.equal(r.status, 400);
});

// -----------------------------------------------------------------------------
// PERSONS — write
// -----------------------------------------------------------------------------

test('Integration API > POST /v1/persons creates a new identity and attaches contacts', async t => {
  const { port, db, secrets } = await makeServer(t);
  const r = await request(port, {
    method: 'POST', path: '/v1/persons', headers: auth(secrets, { 'x-request-id': 'integration_create_1' }),
    body: {
      firstName: 'Amanda', lastName: 'Lee', preferredName: 'Mandy',
      kind: 'adult',
      primaryEmail: 'amanda@example.com',
      additionalEmails: ['amanda2@example.com'],
      phones: [
        { value: '(512) 555-0101', type: 'mobile', smsConsent: true, is_primary: true },
      ],
      mailingAddress: { line1: '123 Main St', city: 'Austin', state: 'TX', postal: '78701' },
    },
  });
  assert.equal(r.status, 201);
  assert.match(r.body.person.personId, /^p_/);
  assert.equal(r.body.person.primaryEmail, 'amanda@example.com');
  assert.equal(r.body.person.preferredName, 'Mandy');
  assert.equal(r.body.person.phones[0].e164, '+15125550101');
  assert.equal(r.body.person.mailingAddress.city, 'Austin');
  assert.ok(r.headers.etag);
});

test('Integration API > POST /v1/persons is idempotent on X-Request-Id', async t => {
  const { port, secrets } = await makeServer(t);
  const headers = auth(secrets, { 'x-request-id': 'integration_create_2' });
  const body = { firstName: 'Tim', lastName: 'Lee', kind: 'adult' };
  const a = await request(port, { method: 'POST', path: '/v1/persons', headers, body });
  const b = await request(port, { method: 'POST', path: '/v1/persons', headers, body });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.person.personId, b.body.person.personId);
  assert.equal(b.headers['x-fg-idempotent-replay'], 'true');
});

test('Integration API > PATCH /v1/persons/:id with stale If-Match returns 412', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  const r = await request(port, {
    method: 'PATCH', path: `/v1/persons/${p}`, headers: auth(secrets, { 'if-match': 'W/"deadbeefdeadbeef"' }),
    body: { firstName: 'Mandy' },
  });
  assert.equal(r.status, 412);
});

test('Integration API > PATCH /v1/persons/:id with valid If-Match succeeds', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  const get = await request(port, { path: `/v1/persons/${p}`, headers: auth(secrets) });
  const tag = get.headers.etag;
  assert.ok(tag);
  const r = await request(port, {
    method: 'PATCH', path: `/v1/persons/${p}`, headers: auth(secrets, { 'if-match': tag }),
    body: { preferredName: 'Mandy' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.person.preferredName, 'Mandy');
});

test('Integration API > PATCH /v1/persons/:id without If-Match accepts the write', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  const r = await request(port, {
    method: 'PATCH', path: `/v1/persons/${p}`, headers: auth(secrets),
    body: { preferredName: 'Mandy' },
  });
  assert.equal(r.status, 200);
});

// -----------------------------------------------------------------------------
// PHOTO CONSENT
// -----------------------------------------------------------------------------

test('Integration API > POST /v1/persons/:id/photoConsent updates consent', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  const r = await request(port, {
    method: 'POST', path: `/v1/persons/${p}/photoConsent`,
    headers: auth(secrets), body: { photoConsent: 'group_only', directoryListing: 'deny' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.consent.photoConsent, 'group_only');
  assert.equal(r.body.consent.directoryListing, 'deny');
  // Verify GET also returns the new consent.
  const g = await request(port, { path: `/v1/persons/${p}/consent`, headers: auth(secrets) });
  assert.equal(g.status, 200);
  assert.equal(g.body.consent.photoConsent, 'group_only');
});

// -----------------------------------------------------------------------------
// EIM CERTIFICATIONS
// -----------------------------------------------------------------------------

test('Integration API > POST /v1/persons/:id/eimCertifications adds a cert', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Mary', family_name: 'Smith' });
  const r = await request(port, {
    method: 'POST', path: `/v1/persons/${p}/eimCertifications`, headers: auth(secrets),
    body: { status: 'certified', completed_on: '2026-05-01', expires_on: '2029-05-01', source: 'diocese' },
  });
  assert.equal(r.status, 201);
  assert.match(r.body.code, /^eim_/);
  assert.equal(r.body.certifications.length, 1);
  assert.equal(r.body.certifications[0].expires_on, '2029-05-01');
});

// -----------------------------------------------------------------------------
// SCHOOL CONTEXT
// -----------------------------------------------------------------------------

test('Integration API > POST /v1/persons/:id/schoolContext stores the §7.3 snapshot', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  const r = await request(port, {
    method: 'POST', path: `/v1/persons/${p}/schoolContext`,
    headers: auth(secrets, { 'x-source-tenant': 'st-marys' }),
    body: {
      schoolId: 'st-marys', schoolYear: '2026-2027', grade: '3',
      classroomId: '3A', classroomName: 'Room 204 — Ms. Lee',
      activities: [{ kind: 'sport', label: 'Basketball — Girls 4A', season: '2026-2027 Winter' }],
      allergies: ['peanuts'],
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.schoolContext.schoolYear, '2026-2027');
  assert.equal(r.body.schoolContext.classroomId, '3A');
  // GET /schoolContext returns the same snapshot.
  const g = await request(port, {
    path: `/v1/persons/${p}/schoolContext?schoolId=st-marys`, headers: auth(secrets),
  });
  assert.equal(g.status, 200);
  assert.equal(g.body.schoolContext.grade, '3');
});

test('Integration API > GET /v1/persons/:id/schoolContext without schoolId lists all snapshots', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  const sc = require('../server/integration/schoolContext');
  sc.upsert(db, p, { schoolId: 'st-marys', grade: '3' });
  sc.upsert(db, p, { schoolId: 'st-johns', grade: '4' });
  const r = await request(port, { path: `/v1/persons/${p}/schoolContext`, headers: auth(secrets) });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 2);
});

// -----------------------------------------------------------------------------
// HOUSEHOLDS
// -----------------------------------------------------------------------------

test('Integration API > POST /v1/households creates a household with members', async t => {
  const { port, db, secrets } = await makeServer(t);
  const mom = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee', kind: 'adult' });
  const dad = people.create(db, secrets, { given_name: 'Tim', family_name: 'Lee', kind: 'adult' });
  const kid = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  const r = await request(port, {
    method: 'POST', path: '/v1/households', headers: auth(secrets),
    body: {
      displayName: 'The Lee Family',
      communicationLanguage: 'en',
      primaryContactPersonId: mom,
      members: [
        { personId: mom, role: 'mother', custodial: true },
        { personId: dad, role: 'father', custodial: true },
        { personId: kid, role: 'child' },
      ],
    },
  });
  assert.equal(r.status, 201);
  assert.match(r.body.household.householdId, /^f_/);
  assert.equal(r.body.household.members.length, 3);
  assert.equal(r.body.household.primaryContactPersonId, mom);
});

test('Integration API > GET /v1/households?personId=<id> returns the active household', async t => {
  const { port, db, secrets } = await makeServer(t);
  const f = families.create(db, secrets, { display_name: 'Lee' });
  const p = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  families.addMember(db, secrets, f, p, { role: 'parent', relationLabel: 'mother', custody: 'joint' });
  const r = await request(port, { path: `/v1/households?personId=${p}`, headers: auth(secrets) });
  assert.equal(r.status, 200);
  assert.equal(r.body.household.householdId, f);
});

test('Integration API > POST /v1/households/:id/members adds a member and triggers a webhook', async t => {
  const { port, db, secrets } = await makeServer(t);
  const f = families.create(db, secrets, { display_name: 'Lee' });
  const mom = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  families.addMember(db, secrets, f, mom, { role: 'parent', relationLabel: 'mother', custody: 'joint' });
  const kid = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  // Subscribe a webhook so we can verify the queue grows.
  const webhooks = require('../server/integration/webhooks');
  webhooks.subscribe(db, secrets, { url: 'https://x.example/cb', events: '*' });
  const r = await request(port, {
    method: 'POST', path: `/v1/households/${f}/members`,
    headers: auth(secrets, { 'x-source-tenant': 'st-marys' }),
    body: { personId: kid, role: 'child' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.household.members.length, 2);
  const deliveries = webhooks.listDeliveries(db, { status: 'pending' });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].event, 'household.updated');
});

// -----------------------------------------------------------------------------
// CHANGED-SINCE FEEDS
// -----------------------------------------------------------------------------

test('Integration API > GET /v1/persons/changed returns persons updated after the cursor', async t => {
  const { port, db, secrets } = await makeServer(t);
  const a = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  // Capture the cursor between the two writes by reading A's updated_at.
  const cursor = db.prepare('SELECT updated_at FROM persons WHERE code = ?').get(a).updated_at;
  // Sleep until we're strictly past the cursor.
  await new Promise(r => setTimeout(r, 2));
  const b = people.create(db, secrets, { given_name: 'B', family_name: 'X' });
  const r = await request(port, {
    path: `/v1/persons/changed?since=${encodeURIComponent(cursor)}`,
    headers: auth(secrets),
  });
  assert.equal(r.status, 200);
  const codes = r.body.items.map(p => p.personId);
  assert.ok(codes.includes(b));
  assert.equal(codes.includes(a), false, 'A should not appear: its updated_at equals the cursor');
});

test('Integration API > GET /v1/households/changed returns households updated after the cursor', async t => {
  const { port, db, secrets } = await makeServer(t);
  const f = families.create(db, secrets, { display_name: 'Lee' });
  const cursor = db.prepare('SELECT updated_at FROM families WHERE code = ?').get(f).updated_at;
  await new Promise(r => setTimeout(r, 2));
  const g = families.create(db, secrets, { display_name: 'Patel' });
  const r = await request(port, {
    path: `/v1/households/changed?since=${encodeURIComponent(cursor)}`,
    headers: auth(secrets),
  });
  assert.equal(r.status, 200);
  const codes = r.body.items.map(h => h.householdId);
  assert.ok(codes.includes(g));
});

test('Integration API > GET /v1/persons/changed rejects an unparseable since', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await request(port, {
    path: '/v1/persons/changed?since=not-a-date', headers: auth(secrets),
  });
  assert.equal(r.status, 400);
});

// -----------------------------------------------------------------------------
// CONTRACT VERSION
// -----------------------------------------------------------------------------

test('Integration API > unsupported X-FG-Contract-Version returns 426', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await request(port, {
    path: '/v1/persons?email=x@y.com',
    headers: { ...auth(secrets), 'x-fg-contract-version': 'v9.99' },
  });
  assert.equal(r.status, 426);
});

test('Integration API > missing X-FG-Contract-Version is accepted (logged-only)', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  const e = contacts.upsertEmail(db, secrets, 'amanda@example.com');
  contacts.attachEmailToPerson(db, p, e, { isPrimary: true });
  const headers = { ...auth(secrets) };
  delete headers['x-fg-contract-version'];
  const r = await request(port, { path: '/v1/persons?email=amanda@example.com', headers });
  assert.equal(r.status, 200);
});

// -----------------------------------------------------------------------------
// WEBHOOK SUBSCRIPTION MANAGEMENT
// -----------------------------------------------------------------------------

test('Integration API > webhook subscribe + list + unsubscribe lifecycle', async t => {
  const { port, secrets } = await makeServer(t);
  const sub = await request(port, {
    method: 'POST', path: '/v1/webhooks', headers: auth(secrets),
    body: { url: 'https://x.example/cb', secret: 's', events: '*' },
  });
  assert.equal(sub.status, 201);
  assert.match(sub.body.subscription.code, /^wh_/);
  const list = await request(port, { path: '/v1/webhooks', headers: auth(secrets) });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  const del = await request(port, {
    method: 'DELETE', path: `/v1/webhooks/${sub.body.subscription.code}`, headers: auth(secrets),
  });
  assert.equal(del.status, 204);
  const list2 = await request(port, { path: '/v1/webhooks', headers: auth(secrets) });
  assert.equal(list2.body.items.length, 0);
});

// -----------------------------------------------------------------------------
// AUTH
// -----------------------------------------------------------------------------

test('Integration API > a scoped key with only `integration` scope can call /v1', async t => {
  const { port, db, secrets } = await makeServer(t);
  const apiKeys = require('../server/auth/api-keys');
  const { token } = apiKeys.provision(db, { name: 'integration-test', scopes: ['integration'] });
  const p = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  const e = contacts.upsertEmail(db, secrets, 'amanda@example.com');
  contacts.attachEmailToPerson(db, p, e, { isPrimary: true });
  const r = await request(port, {
    path: '/v1/persons?email=amanda@example.com',
    headers: {
      authorization: `Bearer ${token}`,
      'x-fg-contract-version': 'v0.1',
    },
  });
  assert.equal(r.status, 200);
});

test('Integration API > a scoped key without integration scope is rejected', async t => {
  const { port, db } = await makeServer(t);
  const apiKeys = require('../server/auth/api-keys');
  const { token } = apiKeys.provision(db, { name: 'pii-only', scopes: ['pii.read'] });
  const r = await request(port, {
    path: '/v1/persons?email=x@y.com',
    headers: { authorization: `Bearer ${token}`, 'x-fg-contract-version': 'v0.1' },
  });
  assert.equal(r.status, 403);
});

test('Integration API > unauthenticated /v1 requests are rejected', async t => {
  const { port } = await makeServer(t);
  const r = await request(port, { path: '/v1/persons?email=x@y.com' });
  assert.equal(r.status, 401);
});
