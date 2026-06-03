'use strict';

// End-to-end test of the v0.2 contract additions:
//   - per-school photoConsent override (POST/DELETE/GET)
//   - diocese CRUD
//   - EIM cert that references a diocese
//   - archive / reinstate / history endpoints

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');
const people = require('../server/identity/people');
const families = require('../server/identity/families');
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
  'x-family-graph-actor': 'integration-v0_2-test',
  'x-fg-contract-version': 'v0.1',
  'x-source-app': 'integration',
  ...extra,
});

// -----------------------------------------------------------------------------
// PER-SCHOOL CONSENT OVERRIDE
// -----------------------------------------------------------------------------

test('Integration API v0.2 > POST /v1/persons/:id/photoConsent with schoolId writes a per-school override', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  // Set the base first.
  await request(port, {
    method: 'POST', path: `/v1/persons/${p}/photoConsent`, headers: auth(secrets),
    body: { photoConsent: 'allow' },
  });
  // Now set a per-school override.
  const r = await request(port, {
    method: 'POST', path: `/v1/persons/${p}/photoConsent`,
    headers: auth(secrets, { 'x-source-tenant': 'st-theresa' }),
    body: { schoolId: 'st-theresa', photoConsent: 'deny' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.consent.photoConsent, 'deny');
  assert.equal(r.body.consent.overrideApplied, true);
  assert.equal(r.body.consent.basePhotoConsent, 'allow');
});

test('Integration API v0.2 > GET /v1/persons/:id/consent?schoolId=... returns the effective view', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  await request(port, {
    method: 'POST', path: `/v1/persons/${p}/photoConsent`,
    headers: auth(secrets), body: { photoConsent: 'allow' },
  });
  await request(port, {
    method: 'POST', path: `/v1/persons/${p}/photoConsent`,
    headers: auth(secrets),
    body: { schoolId: 'st-theresa', photoConsent: 'group_only' },
  });
  const g = await request(port, {
    path: `/v1/persons/${p}/consent?schoolId=st-theresa`, headers: auth(secrets),
  });
  assert.equal(g.status, 200);
  assert.equal(g.body.consent.photoConsent, 'group_only');
  assert.equal(g.body.consent.overrideApplied, true);
  // And without schoolId we get the base verbatim.
  const baseGet = await request(port, { path: `/v1/persons/${p}/consent`, headers: auth(secrets) });
  assert.equal(baseGet.body.consent.photoConsent, 'allow');
  assert.equal(baseGet.body.consent.overrideApplied, false);
});

test('Integration API v0.2 > DELETE /v1/persons/:id/photoConsent?schoolId=... clears the override', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  await request(port, {
    method: 'POST', path: `/v1/persons/${p}/photoConsent`,
    headers: auth(secrets),
    body: { schoolId: 'st-theresa', photoConsent: 'deny' },
  });
  const del = await request(port, {
    method: 'DELETE', path: `/v1/persons/${p}/photoConsent?schoolId=st-theresa`, headers: auth(secrets),
  });
  assert.equal(del.status, 204);
  const g = await request(port, {
    path: `/v1/persons/${p}/consent?schoolId=st-theresa`, headers: auth(secrets),
  });
  assert.equal(g.body.consent.overrideApplied, false);
});

test('Integration API v0.2 > consent overrides are visible at /v1/persons/:id/consent/overrides', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  await request(port, {
    method: 'POST', path: `/v1/persons/${p}/photoConsent`, headers: auth(secrets),
    body: { schoolId: 'st-theresa', photoConsent: 'deny' },
  });
  await request(port, {
    method: 'POST', path: `/v1/persons/${p}/photoConsent`, headers: auth(secrets),
    body: { schoolId: 'st-johns', photoConsent: 'group_only' },
  });
  const r = await request(port, {
    path: `/v1/persons/${p}/consent/overrides`, headers: auth(secrets),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 2);
  const schools = r.body.items.map(o => o.school_id).sort();
  assert.deepEqual(schools, ['st-johns', 'st-theresa']);
});

test('Integration API v0.2 > consent override write fires a consent.updated webhook with schoolId payload', async t => {
  const { port, db, secrets } = await makeServer(t);
  webhooks.subscribe(db, secrets, { url: 'https://x.example/cb', events: ['consent.updated'] });
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  await request(port, {
    method: 'POST', path: `/v1/persons/${p}/photoConsent`, headers: auth(secrets),
    body: { schoolId: 'st-theresa', photoConsent: 'deny' },
  });
  const pending = webhooks.listPendingDeliveries(db, {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].event, 'consent.updated');
  const payload = JSON.parse(pending[0].payload);
  assert.equal(payload.personId, p);
  assert.equal(payload.schoolId, 'st-theresa');
});

// -----------------------------------------------------------------------------
// DIOCESE CRUD
// -----------------------------------------------------------------------------

test('Integration API v0.2 > POST + GET + PATCH a diocese', async t => {
  const { port, secrets } = await makeServer(t);
  const c = await request(port, {
    method: 'POST', path: '/v1/dioceses', headers: auth(secrets),
    body: { name: 'Diocese of Austin', region: 'Texas', eim_renewal_years: 3 },
  });
  assert.equal(c.status, 201);
  assert.match(c.body.diocese.code, /^dio_/);
  const g = await request(port, { path: `/v1/dioceses/${c.body.diocese.code}`, headers: auth(secrets) });
  assert.equal(g.body.diocese.region, 'Texas');
  const p = await request(port, {
    method: 'PATCH', path: `/v1/dioceses/${c.body.diocese.code}`, headers: auth(secrets),
    body: { eim_renewal_years: 5 },
  });
  assert.equal(p.status, 200);
  assert.equal(p.body.diocese.eim_renewal_years, 5);
});

test('Integration API v0.2 > POST /v1/persons/:id/eimCertifications with dioceseCode', async t => {
  const { port, secrets } = await makeServer(t);
  const d = await request(port, {
    method: 'POST', path: '/v1/dioceses', headers: auth(secrets),
    body: { name: 'Diocese of Austin', eim_renewal_years: 5 },
  });
  const dCode = d.body.diocese.code;
  const personR = await request(port, {
    method: 'POST', path: '/v1/persons', headers: auth(secrets),
    body: { firstName: 'Mary', lastName: 'Smith', kind: 'adult' },
  });
  const pCode = personR.body.person.personId;
  const cert = await request(port, {
    method: 'POST', path: `/v1/persons/${pCode}/eimCertifications`, headers: auth(secrets),
    body: {
      status: 'certified', completed_on: '2026-05-01',
      dioceseCode: dCode, dioceseRecordId: 'EIM-TX-12345',
    },
  });
  assert.equal(cert.status, 201);
  assert.equal(cert.body.certifications[0].expires_on, '2031-05-01');
  assert.equal(cert.body.certifications[0].diocese_code, dCode);
  assert.equal(cert.body.certifications[0].diocese_record_id, 'EIM-TX-12345');
});

test('Integration API v0.2 > archive + reinstate a diocese keeps it findable under status=archived', async t => {
  const { port, secrets } = await makeServer(t);
  const d = await request(port, {
    method: 'POST', path: '/v1/dioceses', headers: auth(secrets),
    body: { name: 'Defunct Diocese' },
  });
  const code = d.body.diocese.code;
  const arc = await request(port, {
    method: 'POST', path: `/v1/dioceses/${code}/archive`, headers: auth(secrets),
    body: { reason: 'consolidated' },
  });
  assert.equal(arc.status, 200);
  assert.equal(arc.body.diocese.status, 'archived');
  // /v1/dioceses defaults to active-only.
  const activeList = await request(port, { path: '/v1/dioceses', headers: auth(secrets) });
  assert.equal(activeList.body.items.find(d => d.code === code), undefined);
  // status=archived surfaces it.
  const archivedList = await request(port, { path: '/v1/dioceses?status=archived', headers: auth(secrets) });
  assert.ok(archivedList.body.items.find(d => d.code === code));
  // Reinstate.
  const rein = await request(port, {
    method: 'POST', path: `/v1/dioceses/${code}/reinstate`, headers: auth(secrets),
  });
  assert.equal(rein.body.diocese.status, 'active');
});

// -----------------------------------------------------------------------------
// ARCHIVE / REINSTATE / HISTORY for persons and households
// -----------------------------------------------------------------------------

test('Integration API v0.2 > person archive emits person.deleted webhook + writes a history row', async t => {
  const { port, db, secrets } = await makeServer(t);
  webhooks.subscribe(db, secrets, { url: 'https://x.example/cb', events: ['person.deleted'] });
  const p = people.create(db, secrets, { given_name: 'Demo', family_name: 'User' });
  const r = await request(port, {
    method: 'POST', path: `/v1/persons/${p}/archive`, headers: auth(secrets),
    body: { reason: 'graduated' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.person.active, false);
  const pending = webhooks.listPendingDeliveries(db, {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].event, 'person.deleted');
  const hist = await request(port, { path: `/v1/persons/${p}/history`, headers: auth(secrets) });
  assert.equal(hist.status, 200);
  assert.equal(hist.body.items[0].operation, 'archive');
  assert.equal(hist.body.items[0].reason, 'graduated');
});

test('Integration API v0.2 > person reinstate flips status back and emits person.updated', async t => {
  const { port, db, secrets } = await makeServer(t);
  webhooks.subscribe(db, secrets, { url: 'https://x.example/cb', events: ['person.updated'] });
  const p = people.create(db, secrets, { given_name: 'Demo', family_name: 'User' });
  // Drain the create event.
  await webhooks.dispatchPending(db, secrets, { sender: async () => ({ ok: true, status: 200 }) });
  await request(port, { method: 'POST', path: `/v1/persons/${p}/archive`, headers: auth(secrets) });
  const r = await request(port, { method: 'POST', path: `/v1/persons/${p}/reinstate`, headers: auth(secrets) });
  assert.equal(r.status, 200);
  assert.equal(r.body.person.active, true);
  // person.updated should be queued (the archive earlier fired person.deleted but that
  // subscription only listens for person.updated → 0 deliveries from archive, 1 from reinstate).
  const pending = webhooks.listPendingDeliveries(db, {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].event, 'person.updated');
});

test('Integration API v0.2 > household archive/reinstate parallels person endpoints', async t => {
  const { port, db, secrets } = await makeServer(t);
  const f = families.create(db, secrets, { display_name: 'Demo' });
  const arc = await request(port, {
    method: 'POST', path: `/v1/households/${f}/archive`, headers: auth(secrets),
    body: { reason: 'no longer enrolled' },
  });
  assert.equal(arc.status, 200);
  // The household read still works (it's a soft delete).
  const g = await request(port, { path: `/v1/households/${f}`, headers: auth(secrets) });
  assert.equal(g.status, 200);
  const hist = await request(port, { path: `/v1/households/${f}/history`, headers: auth(secrets) });
  assert.equal(hist.body.items[0].operation, 'archive');
  const rein = await request(port, { method: 'POST', path: `/v1/households/${f}/reinstate`, headers: auth(secrets) });
  assert.equal(rein.status, 200);
});

test('Integration API v0.2 > person archive is idempotent on a second call', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Demo', family_name: 'User' });
  await request(port, { method: 'POST', path: `/v1/persons/${p}/archive`, headers: auth(secrets) });
  const second = await request(port, { method: 'POST', path: `/v1/persons/${p}/archive`, headers: auth(secrets) });
  assert.equal(second.status, 200);
  assert.equal(second.body.noop, true);
});

test('Integration API v0.2 > archive refuses to touch a merged person', async t => {
  const { port, db, secrets } = await makeServer(t);
  const winner = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  const loser = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  people.merge(db, secrets, loser, winner);
  const r = await request(port, { method: 'POST', path: `/v1/persons/${loser}/archive`, headers: auth(secrets) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /merged/);
});

test('Integration API v0.2 > history endpoint surfaces creates, updates, and archives in order', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Demo', family_name: 'User' });
  // Generate a few events via the API.
  await request(port, {
    method: 'POST', path: `/v1/persons/${p}/photoConsent`, headers: auth(secrets),
    body: { photoConsent: 'group_only' },
  });
  await request(port, { method: 'POST', path: `/v1/persons/${p}/archive`, headers: auth(secrets), body: { reason: 'test' } });
  await request(port, { method: 'POST', path: `/v1/persons/${p}/reinstate`, headers: auth(secrets) });
  const hist = await request(port, { path: `/v1/persons/${p}/history`, headers: auth(secrets) });
  const ops = hist.body.items.map(i => i.operation);
  // History returns reverse-chronological (newest first).
  assert.equal(ops[0], 'reinstate');
  assert.equal(ops[1], 'archive');
});
