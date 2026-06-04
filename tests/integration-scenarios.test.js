'use strict';

// End-to-end scenarios from §10 of FAMILYGRAPH_INTEGRATION.md. These exercise
// the contract from "Integration admin clicks a button" through to the
// FamilyGraph side effects (mirrored writes, queued webhooks).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');
const people = require('../server/identity/people');
const families = require('../server/identity/families');
const contacts = require('../server/identity/contacts');
const webhooks = require('../server/integration/webhooks');

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
  'x-family-graph-actor': 'integration-scenario-test',
  'x-fg-contract-version': 'v0.1',
  'x-source-app': 'integration',
  ...extra,
});

test('scenario §10.1 → admin adds a family in standalone-like mode (the app suggests identities to FG)', async t => {
  const { port, db, secrets } = await makeServer(t);
  // Admin adds a parent.
  const mom = await request(port, {
    method: 'POST', path: '/v1/persons', headers: auth(secrets),
    body: {
      firstName: 'Amanda', lastName: 'Lee', kind: 'adult',
      primaryEmail: 'amanda@example.com',
      phones: [{ value: '+15125550101', type: 'mobile', smsConsent: true }],
      mailingAddress: { line1: '12 Oak St', city: 'Austin', state: 'TX', postal: '78701' },
    },
  });
  assert.equal(mom.status, 201);
  // Admin adds the child.
  const kid = await request(port, {
    method: 'POST', path: '/v1/persons', headers: auth(secrets),
    body: { firstName: 'Annie', lastName: 'Lee', kind: 'child', dateOfBirth: '2017-09-04' },
  });
  assert.equal(kid.status, 201);
  // Admin creates the household.
  const hh = await request(port, {
    method: 'POST', path: '/v1/households', headers: auth(secrets),
    body: {
      displayName: 'The Lee Family',
      primaryContactPersonId: mom.body.person.personId,
      members: [
        { personId: mom.body.person.personId, role: 'mother', custodial: true },
        { personId: kid.body.person.personId, role: 'child' },
      ],
    },
  });
  assert.equal(hh.status, 201);
  assert.equal(hh.body.household.members.length, 2);
  assert.equal(hh.body.household.primaryContactPersonId, mom.body.person.personId);
});

test('scenario §10.3 → parent updates phone in FG, webhook queues for the app', async t => {
  const { port, db, secrets } = await makeServer(t);
  // Subscribe the app's webhook.
  const sub = webhooks.subscribe(db, secrets, {
    url: 'https://us-central1-demo.cloudfunctions.net/familyGraphWebhook',
    secret: 'shhhh',
    events: '*',
    schoolHint: 'st-marys',
  });
  // Create the parent + initial phone via the contract.
  const created = await request(port, {
    method: 'POST', path: '/v1/persons', headers: auth(secrets, { 'x-source-tenant': 'st-marys' }),
    body: { firstName: 'Amanda', lastName: 'Lee', kind: 'adult' },
  });
  const personId = created.body.person.personId;

  // Drain the one delivery from the create so we can measure just the phone update.
  const drainSender = async () => ({ ok: true, status: 200 });
  await webhooks.dispatchPending(db, secrets, { sender: drainSender });

  // Now PATCH a new phone in.
  const get = await request(port, { path: `/v1/persons/${personId}`, headers: auth(secrets) });
  const tag = get.headers.etag;
  const patch = await request(port, {
    method: 'PATCH', path: `/v1/persons/${personId}`,
    headers: auth(secrets, { 'if-match': tag, 'x-source-tenant': 'st-marys' }),
    body: { phones: [{ value: '+15125550199', type: 'mobile', smsConsent: true, is_primary: true }] },
  });
  assert.equal(patch.status, 200);
  assert.ok(patch.body.person.phones.some(p => p.e164 === '+15125550199'));

  // The webhook queue should have one fresh delivery.
  const pending = webhooks.listPendingDeliveries(db, {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].event, 'person.updated');
  assert.equal(pending[0].subscription_code, sub.code);
  // Payload carries personId + sourceTenant as a school hint.
  const payload = JSON.parse(pending[0].payload);
  assert.equal(payload.personId, personId);
  assert.ok(Array.isArray(payload.schoolHints));
  assert.ok(payload.schoolHints.includes('st-marys'));

  // Dispatch and confirm signature.
  const calls = [];
  const sender = async args => { calls.push(args); return { ok: true, status: 200 }; };
  await webhooks.dispatchPending(db, secrets, { sender });
  assert.equal(calls.length, 1);
  assert.match(calls[0].headers['x-fg-signature'], /^sha256=/);
});

test('scenario §10.4 → enrichment snapshot is persisted and readable', async t => {
  const { port, db, secrets } = await makeServer(t);
  const annie = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  const r = await request(port, {
    method: 'POST', path: `/v1/persons/${annie}/schoolContext`,
    headers: auth(secrets, { 'x-source-tenant': 'st-marys' }),
    body: {
      schoolId: 'st-marys', schoolYear: '2026-2027', grade: '3',
      classroomId: '3A', classroomName: 'Room 204 — Ms. Lee',
      activities: [
        { kind: 'sport', label: 'Basketball — Girls 4A', season: '2026-2027 Winter' },
        { kind: 'sport', label: 'Volleyball — Girls 4A', season: '2026-2027 Fall' },
        { kind: 'enrichment', label: 'Drama Camp (May 2026)', season: '2026-2027' },
        { kind: 'after_care', label: 'After-care: MWF', season: '2026-2027' },
      ],
      allergies: ['peanuts'],
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.schoolContext.activities.length, 4);
  // A second POST with the same schoolId overwrites the previous snapshot.
  const r2 = await request(port, {
    method: 'POST', path: `/v1/persons/${annie}/schoolContext`,
    headers: auth(secrets, { 'x-source-tenant': 'st-marys' }),
    body: { schoolId: 'st-marys', grade: '3', activities: [{ kind: 'sport', label: 'Basketball — Girls 4A' }] },
  });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.schoolContext.activities.length, 1);
});

test('scenario §10.5 → student moves classroom; the snapshot reflects the new classroom', async t => {
  const { port, db, secrets } = await makeServer(t);
  const annie = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  await request(port, {
    method: 'POST', path: `/v1/persons/${annie}/schoolContext`,
    headers: auth(secrets),
    body: {
      schoolId: 'st-marys', schoolYear: '2026-2027', grade: '3',
      classroomId: '3A', classroomName: 'Room 204 — Ms. Lee',
    },
  });
  const r = await request(port, {
    method: 'POST', path: `/v1/persons/${annie}/schoolContext`,
    headers: auth(secrets),
    body: {
      schoolId: 'st-marys', schoolYear: '2026-2027', grade: '3',
      classroomId: '3B', classroomName: 'Room 207 — Mr. Patel',
    },
  });
  assert.equal(r.status, 201);
  const g = await request(port, {
    path: `/v1/persons/${annie}/schoolContext?schoolId=st-marys`, headers: auth(secrets),
  });
  assert.equal(g.body.schoolContext.classroomId, '3B');
  assert.equal(g.body.schoolContext.classroomName, 'Room 207 — Mr. Patel');
});

test('scenario > consent change generates a consent.updated webhook event', async t => {
  const { port, db, secrets } = await makeServer(t);
  webhooks.subscribe(db, secrets, { url: 'https://x.example/cb', events: ['consent.updated'] });
  const annie = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  const r = await request(port, {
    method: 'POST', path: `/v1/persons/${annie}/photoConsent`,
    headers: auth(secrets),
    body: { photoConsent: 'group_only' },
  });
  assert.equal(r.status, 200);
  const pending = webhooks.listPendingDeliveries(db, {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].event, 'consent.updated');
  const payload = JSON.parse(pending[0].payload);
  assert.equal(payload.personId, annie);
});

test('scenario > app push that creates a person then references that personId in a household round-trips correctly', async t => {
  const { port, secrets } = await makeServer(t);
  // Create three people via the contract.
  const mom = await request(port, {
    method: 'POST', path: '/v1/persons', headers: auth(secrets, { 'x-request-id': 'integration_create_mom' }),
    body: { firstName: 'Amanda', lastName: 'Lee', kind: 'adult', primaryEmail: 'amanda@example.com' },
  });
  const dad = await request(port, {
    method: 'POST', path: '/v1/persons', headers: auth(secrets, { 'x-request-id': 'integration_create_dad' }),
    body: { firstName: 'Tim', lastName: 'Lee', kind: 'adult' },
  });
  const kid = await request(port, {
    method: 'POST', path: '/v1/persons', headers: auth(secrets, { 'x-request-id': 'integration_create_kid' }),
    body: { firstName: 'Annie', lastName: 'Lee', kind: 'child' },
  });
  // Compose them into a household.
  const hh = await request(port, {
    method: 'POST', path: '/v1/households', headers: auth(secrets),
    body: {
      members: [
        { personId: mom.body.person.personId, role: 'mother', custodial: true },
        { personId: dad.body.person.personId, role: 'father', custodial: true },
        { personId: kid.body.person.personId, role: 'child' },
      ],
    },
  });
  assert.equal(hh.status, 201);
  // Look up the household via the kid's personId.
  const lookup = await request(port, {
    path: `/v1/households?personId=${kid.body.person.personId}`, headers: auth(secrets),
  });
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.household.householdId, hh.body.household.householdId);
  assert.equal(lookup.body.household.members.length, 3);
});

test('scenario > resend of the same X-Request-Id returns the cached response (idempotency)', async t => {
  const { port, secrets } = await makeServer(t);
  const body = { firstName: 'Pio', lastName: 'Pietrelcina', kind: 'adult' };
  const headers = auth(secrets, { 'x-request-id': 'integration_idempotent' });
  const first = await request(port, { method: 'POST', path: '/v1/persons', headers, body });
  const second = await request(port, { method: 'POST', path: '/v1/persons', headers, body });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  // Same personId; the second call must not have created a duplicate row.
  assert.equal(first.body.person.personId, second.body.person.personId);
  assert.equal(second.headers['x-fg-idempotent-replay'], 'true');
});
