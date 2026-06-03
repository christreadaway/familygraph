'use strict';

// Regression tests for the v0.2 bug-fix sweep. Each test maps to a
// concrete issue found during the comprehensive audit.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');
const people = require('../server/identity/people');
const families = require('../server/identity/families');
const consents = require('../server/integration/consents');
const dioceses = require('../server/integration/dioceses');
const schoolContext = require('../server/integration/schoolContext');
const history = require('../server/identity/history');

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
  'x-family-graph-actor': 'integration-bugfix-test',
  'x-fg-contract-version': 'v0.1',
  'x-source-app': 'integration',
  ...extra,
});

// -----------------------------------------------------------------------------
// 204 No Content idempotency capture
// -----------------------------------------------------------------------------

test('bugfix > DELETE /v1/persons/:id/photoConsent with X-Request-Id replays the 204 on retry', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  consents.setOverride(db, p, 'st-theresa', { photoConsent: 'deny' });

  const headers = auth(secrets, { 'x-request-id': 'integration_delete_idem_1' });
  const first = await request(port, {
    method: 'DELETE', path: `/v1/persons/${p}/photoConsent?schoolId=st-theresa`, headers,
  });
  assert.equal(first.status, 204);

  // Re-set the override so a second non-idempotent call would do real work.
  consents.setOverride(db, p, 'st-theresa', { photoConsent: 'group_only' });

  // Same request_id: the idempotency layer must replay the cached 204
  // instead of clearing the freshly-set override.
  const replay = await request(port, {
    method: 'DELETE', path: `/v1/persons/${p}/photoConsent?schoolId=st-theresa`, headers,
  });
  assert.equal(replay.status, 204);
  assert.equal(replay.headers['x-fg-idempotent-replay'], 'true');
  // Override should still be there because the second DELETE was a replay.
  const remaining = consents.getOverride(db, p, 'st-theresa');
  assert.ok(remaining, 'override survives because the second DELETE was a replay, not a re-execute');
});

test('bugfix > DELETE /v1/webhooks/:code with X-Request-Id replays on retry', async t => {
  const { port, secrets } = await makeServer(t);
  const sub = await request(port, {
    method: 'POST', path: '/v1/webhooks', headers: auth(secrets),
    body: { url: 'https://x.example/cb' },
  });
  const code = sub.body.subscription.code;
  const headers = auth(secrets, { 'x-request-id': 'integration_wh_delete_1' });
  const first = await request(port, { method: 'DELETE', path: `/v1/webhooks/${code}`, headers });
  assert.equal(first.status, 204);
  const replay = await request(port, { method: 'DELETE', path: `/v1/webhooks/${code}`, headers });
  assert.equal(replay.status, 204);
  assert.equal(replay.headers['x-fg-idempotent-replay'], 'true');
});

// -----------------------------------------------------------------------------
// /v1/dioceses?status=all
// -----------------------------------------------------------------------------

test('bugfix > GET /v1/dioceses?status=all surfaces archived rows alongside active', async t => {
  const { port, secrets } = await makeServer(t);
  const a = await request(port, {
    method: 'POST', path: '/v1/dioceses', headers: auth(secrets),
    body: { name: 'Active Diocese' },
  });
  const z = await request(port, {
    method: 'POST', path: '/v1/dioceses', headers: auth(secrets),
    body: { name: 'Zombie Diocese' },
  });
  await request(port, {
    method: 'POST', path: `/v1/dioceses/${z.body.diocese.code}/archive`, headers: auth(secrets),
  });
  const active = await request(port, { path: '/v1/dioceses', headers: auth(secrets) });
  const archived = await request(port, { path: '/v1/dioceses?status=archived', headers: auth(secrets) });
  const all = await request(port, { path: '/v1/dioceses?status=all', headers: auth(secrets) });
  assert.equal(active.body.items.length, 1);
  assert.equal(archived.body.items.length, 1);
  assert.equal(all.body.items.length, 2);
});

// -----------------------------------------------------------------------------
// schoolId validation
// -----------------------------------------------------------------------------

test('bugfix > setOverride rejects schoolId containing / so composite history keys stay parseable', async t => {
  const { db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  assert.throws(
    () => consents.setOverride(db, p, 'st-theresa/extra', { photoConsent: 'deny' }),
    /invalid schoolId/
  );
});

test('bugfix > setOverride rejects empty / non-string schoolId', async t => {
  const { db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  assert.throws(() => consents.setOverride(db, p, '', { photoConsent: 'deny' }), /schoolId/);
  assert.throws(() => consents.setOverride(db, p, 123, { photoConsent: 'deny' }), /invalid schoolId/);
  assert.throws(() => consents.setOverride(db, p, '  st theresa  ', { photoConsent: 'deny' }), /invalid schoolId/);
});

test('bugfix > school_context.upsert validates schoolId the same way', async t => {
  const { db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  assert.throws(
    () => schoolContext.upsert(db, p, { schoolId: 'bad/id', grade: '3' }),
    /invalid schoolId/
  );
});

// -----------------------------------------------------------------------------
// Diocese update with mixed camelCase / snake_case
// -----------------------------------------------------------------------------

test('bugfix > dioceses.update handles both camelCase and snake_case keys', async t => {
  const { db, secrets } = await makeServer(t);
  const code = dioceses.create(db, secrets, { name: 'Diocese A', eim_renewal_years: 3 });
  dioceses.update(db, secrets, code, { eimRenewalYears: 7 });
  assert.equal(dioceses.get(db, secrets, code).eim_renewal_years, 7);
  dioceses.update(db, secrets, code, { contactUrl: 'https://camelcase.example/x' });
  assert.equal(dioceses.get(db, secrets, code).contact_url, 'https://camelcase.example/x');
});

// -----------------------------------------------------------------------------
// PATCH /v1/dioceses honors If-Match transactionally
// -----------------------------------------------------------------------------

test('bugfix > PATCH /v1/dioceses returns 412 on stale If-Match', async t => {
  const { port, secrets } = await makeServer(t);
  const c = await request(port, {
    method: 'POST', path: '/v1/dioceses', headers: auth(secrets),
    body: { name: 'Diocese A', eim_renewal_years: 3 },
  });
  const code = c.body.diocese.code;
  const r = await request(port, {
    method: 'PATCH', path: `/v1/dioceses/${code}`,
    headers: auth(secrets, { 'if-match': 'W/"deadbeefdeadbeef"' }),
    body: { eim_renewal_years: 5 },
  });
  assert.equal(r.status, 412);
});

test('bugfix > PATCH /v1/dioceses succeeds with a correct If-Match', async t => {
  const { port, secrets } = await makeServer(t);
  const c = await request(port, {
    method: 'POST', path: '/v1/dioceses', headers: auth(secrets),
    body: { name: 'Diocese A', eim_renewal_years: 3 },
  });
  const code = c.body.diocese.code;
  const g = await request(port, { path: `/v1/dioceses/${code}`, headers: auth(secrets) });
  const r = await request(port, {
    method: 'PATCH', path: `/v1/dioceses/${code}`,
    headers: auth(secrets, { 'if-match': g.headers.etag }),
    body: { eim_renewal_years: 5 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.diocese.eim_renewal_years, 5);
});

// -----------------------------------------------------------------------------
// Snapshot serializer recursion
// -----------------------------------------------------------------------------

test('bugfix > history.snapshot recurses into nested objects with Buffers', () => {
  const buf = Buffer.from([0x41, 0x42, 0x43]);
  const out = history.snapshot({ outer: { inner: { value_ct: buf } }, list: [buf, 'plain'] });
  const parsed = JSON.parse(out);
  assert.equal(parsed.outer.inner.value_ct._ct, Buffer.from('ABC').toString('base64'));
  assert.equal(parsed.list[0]._ct, Buffer.from('ABC').toString('base64'));
  assert.equal(parsed.list[1], 'plain');
});

test('bugfix > history.snapshot drops NaN/Infinity rather than emitting null silently', () => {
  const out = JSON.parse(history.snapshot({ a: NaN, b: Infinity, c: -Infinity, d: 7 }));
  assert.equal(out.a, null);
  assert.equal(out.b, null);
  assert.equal(out.c, null);
  assert.equal(out.d, 7);
});

test('bugfix > history.snapshot tolerates circular references', () => {
  const obj = { name: 'cycle' };
  obj.self = obj;
  const out = history.snapshot(obj);
  const parsed = JSON.parse(out);
  assert.equal(parsed.name, 'cycle');
  assert.equal(parsed.self, '[circular]');
});

test('bugfix > history.snapshot serialises shared references as-is, not as [circular]', () => {
  // Two siblings sharing one object reference is NOT a cycle —
  // ancestors-only checks are the right model.
  const shared = { kind: 'addr', city: 'Austin' };
  const out = JSON.parse(history.snapshot({ children: [{ addr: shared }, { addr: shared }] }));
  assert.deepEqual(out.children[0].addr, { kind: 'addr', city: 'Austin' });
  assert.deepEqual(out.children[1].addr, { kind: 'addr', city: 'Austin' });
});

test('bugfix > history.snapshot strips __proto__ / constructor / prototype keys defensively', () => {
  // JSON.parse creates an own property named "__proto__" rather than
  // walking up the prototype chain; the snapshot serialiser must skip
  // those (and constructor/prototype) so an attacker-shaped payload
  // can't smuggle pollution keys through to a careless consumer.
  const malicious = JSON.parse('{"__proto__":{"isAdmin":true},"constructor":"x","prototype":"y","name":"clean"}');
  const out = JSON.parse(history.snapshot(malicious));
  assert.equal(out.name, 'clean');
  assert.equal(Object.hasOwn(out, '__proto__'), false, 'forbidden key is dropped (own-prop check)');
  assert.equal(Object.hasOwn(out, 'constructor'), false);
  assert.equal(Object.hasOwn(out, 'prototype'), false);
});

// -----------------------------------------------------------------------------
// Atomicity of write + history.record
// -----------------------------------------------------------------------------

test('bugfix > archive is atomic — a history failure rolls back the status flip', async t => {
  const { db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Demo', family_name: 'User' });
  // Force history.record to throw on the next call by stubbing the
  // history module's record function.
  const original = history.record;
  history.record = () => { throw new Error('forced failure'); };
  try {
    assert.throws(() => people.archive(db, p, { actor: 'unit' }), /forced failure/);
  } finally {
    history.record = original;
  }
  const row = db.prepare('SELECT status FROM persons WHERE code = ?').get(p);
  assert.equal(row.status, 'active', 'archive transaction rolled back');
});

test('bugfix > consent set is atomic — a history failure rolls back the upsert', async t => {
  const { db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Demo', family_name: 'User' });
  const original = history.record;
  history.record = () => { throw new Error('forced failure'); };
  try {
    assert.throws(() => consents.set(db, p, { photoConsent: 'deny' }, { actor: 'unit' }), /forced failure/);
  } finally {
    history.record = original;
  }
  // No consent row should exist because the transaction rolled back.
  const row = db.prepare('SELECT 1 FROM person_consents WHERE person_code = ?').get(p);
  assert.equal(row, undefined, 'consent insert rolled back');
});

// -----------------------------------------------------------------------------
// Archived persons tombstoned in changed feed (no PII rebroadcast)
// -----------------------------------------------------------------------------

test('bugfix > /v1/persons/changed tombstones archived persons (no PII leak)', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  const cursor = db.prepare('SELECT updated_at FROM persons WHERE code = ?').get(p).updated_at;
  await new Promise(r => setTimeout(r, 2));
  people.archive(db, p, { actor: 'unit' });
  const r = await request(port, {
    path: `/v1/persons/changed?since=${encodeURIComponent(cursor)}`,
    headers: auth(secrets),
  });
  const item = r.body.items.find(p => p.personId === p.personId);
  // Tombstone shape: only personId + active=false + status + updatedAt.
  // No firstName / lastName / phones / emails / mailingAddress.
  assert.equal(item.active, false);
  assert.equal(item.firstName, undefined, 'tombstone does not include firstName');
  assert.equal(item.lastName, undefined, 'tombstone does not include lastName');
  assert.equal(item.phones, undefined);
  assert.equal(item.mailingAddress, undefined);
});

test('bugfix > direct GET /v1/persons/:id of an archived person still returns full PII for operator UI', async t => {
  const { port, db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  people.archive(db, p, { actor: 'unit' });
  const r = await request(port, { path: `/v1/persons/${p}`, headers: auth(secrets) });
  assert.equal(r.body.person.firstName, 'Annie', 'direct GET retains PII for historical view');
  assert.equal(r.body.person.active, false);
});

test('bugfix > /v1/households/changed tombstones archived households', async t => {
  const { port, db, secrets } = await makeServer(t);
  const f = families.create(db, secrets, { display_name: 'TestFam' });
  const cursor = db.prepare('SELECT updated_at FROM families WHERE code = ?').get(f).updated_at;
  await new Promise(r => setTimeout(r, 2));
  families.archive(db, f, { actor: 'unit' });
  const r = await request(port, {
    path: `/v1/households/changed?since=${encodeURIComponent(cursor)}`,
    headers: auth(secrets),
  });
  const item = r.body.items.find(h => h.householdId === f);
  assert.ok(item, 'archived family surfaces in the feed');
  assert.equal(item.active, false);
  assert.equal(item.members, undefined, 'tombstone has no members list');
});

// -----------------------------------------------------------------------------
// Webhook URL SSRF guard
// -----------------------------------------------------------------------------

test('bugfix > webhook subscribe rejects loopback URLs', async t => {
  const { db, secrets } = await makeServer(t);
  const webhooks = require('../server/integration/webhooks');
  assert.throws(() => webhooks.subscribe(db, secrets, { url: 'http://localhost:5432/x' }), /loopback/);
  assert.throws(() => webhooks.subscribe(db, secrets, { url: 'http://127.0.0.1/cb' }), /loopback/);
  assert.throws(() => webhooks.subscribe(db, secrets, { url: 'http://169.254.169.254/latest/meta-data/' }), /loopback/);
  assert.throws(() => webhooks.subscribe(db, secrets, { url: 'http://10.0.0.5/cb' }), /loopback/);
  assert.throws(() => webhooks.subscribe(db, secrets, { url: 'http://192.168.1.1/cb' }), /loopback/);
});

test('bugfix > webhook subscribe rejects file://, ws://, etc.', async t => {
  const { db, secrets } = await makeServer(t);
  const webhooks = require('../server/integration/webhooks');
  assert.throws(() => webhooks.subscribe(db, secrets, { url: 'file:///etc/passwd' }), /unsupported url scheme/);
  assert.throws(() => webhooks.subscribe(db, secrets, { url: 'ws://example.com/cb' }), /unsupported url scheme/);
});

test('bugfix > webhook subscribe accepts a normal https URL', async t => {
  const { db, secrets } = await makeServer(t);
  const webhooks = require('../server/integration/webhooks');
  const sub = webhooks.subscribe(db, secrets, {
    url: 'https://us-central1-demo.cloudfunctions.net/familyGraphWebhook',
  });
  assert.match(sub.code, /^wh_/);
});

// -----------------------------------------------------------------------------
// Retention floor (verifies the new sweep semantics)
// -----------------------------------------------------------------------------

test('bugfix > sweep preserves the latest archive event so reinstate audit stays readable', async t => {
  const { db, secrets } = await makeServer(t);
  const p = people.create(db, secrets, { given_name: 'Demo', family_name: 'User' });
  people.archive(db, p, { actor: 'unit', reason: 'graduated' });
  // Backdate every history row to 2000 so a 30-day sweep would normally
  // delete them.
  db.prepare(`UPDATE entity_changes SET created_at = '2000-01-01T00:00:00.000Z' WHERE entity_kind = 'person' AND entity_code = ?`).run(p);
  history.sweep(db, 30);
  const hist = history.listFor(db, 'person', p);
  assert.ok(hist.length >= 1, 'at least the latest event survives');
  assert.equal(hist[0].operation, 'archive');
});

// -----------------------------------------------------------------------------
// Merge / split history logging
// -----------------------------------------------------------------------------

test('bugfix > families.merge writes an entity_changes row', async t => {
  const { db, secrets } = await makeServer(t);
  const a = families.create(db, secrets, { display_name: 'Loser' });
  const b = families.create(db, secrets, { display_name: 'Winner' });
  families.merge(db, secrets, a, b, { actor: 'unit', reason: 'dedupe' });
  const hist = history.listFor(db, 'family', b);
  const m = hist.find(h => h.operation === 'merge');
  assert.ok(m, 'merge logged');
  assert.deepEqual(m.related_codes, [a]);
});

test('bugfix > families.split writes split + create rows in entity_changes', async t => {
  const { db, secrets } = await makeServer(t);
  const f = families.create(db, secrets, { display_name: 'Original' });
  const kid = people.create(db, secrets, { given_name: 'Kid', family_name: 'X' });
  families.addMember(db, secrets, f, kid, { role: 'child', relationLabel: 'child' });
  const newF = families.split(db, secrets, f, [kid], { displayName: 'New' }, { actor: 'unit' });
  const sourceHist = history.listFor(db, 'family', f);
  assert.ok(sourceHist.find(h => h.operation === 'split'));
  const newHist = history.listFor(db, 'family', newF);
  assert.ok(newHist.find(h => h.operation === 'create'));
});
