'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');
const people = require('../server/identity/people');
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
        resolve({ status: res.statusCode, body: payload });
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

const auth = secrets => ({
  authorization: `Bearer ${secrets.master}`,
  'x-family-graph-actor': 'unit-test',
});

test('identity api > /match returns no candidate when registry is empty', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await request(port, {
    method: 'POST', path: '/api/identity/match', headers: auth(secrets),
    body: { record: { first_name: 'Mary', last_name: 'Smith', email: 'mary@example.org' } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.action, 'create');
  assert.equal(r.body.candidate, null);
});

test('identity api > /match peeks an existing person via email (definitive)', async t => {
  const { port, db, secrets } = await makeServer(t);
  const code = people.create(db, secrets, { given_name: 'Mary', family_name: 'Smith' });
  const ec = contacts.upsertEmail(db, secrets, 'mary@example.org');
  contacts.attachEmailToPerson(db, code, ec);

  const r = await request(port, {
    method: 'POST', path: '/api/identity/match', headers: auth(secrets),
    body: { record: { first_name: 'Mary', last_name: 'Smith', email: 'mary@example.org' } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.action, 'auto_merge');
  assert.equal(r.body.definitive, true);
  assert.equal(r.body.candidate.code, code);
  assert.ok(r.body.reasons.includes('exact_email_match'));
});

test('identity api > /resolve commits the match and returns the code', async t => {
  const { port, db, secrets } = await makeServer(t);
  const code = people.create(db, secrets, { given_name: 'Mary', family_name: 'Smith' });
  const ec = contacts.upsertEmail(db, secrets, 'mary@example.org');
  contacts.attachEmailToPerson(db, code, ec);

  const r = await request(port, {
    method: 'POST', path: '/api/identity/resolve', headers: auth(secrets),
    body: { record: { first_name: 'Mary', last_name: 'Smith', email: 'mary@example.org' }, source: 'missioniq' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.action, 'attached');
  assert.equal(r.body.code, code);
});

test('identity api > /resolve creates a new person when no candidate hits', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await request(port, {
    method: 'POST', path: '/api/identity/resolve', headers: auth(secrets),
    body: { record: { first_name: 'Karol', last_name: 'Wojtyła' }, source: 'missioniq' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.action, 'created');
  assert.match(r.body.code, /^p_/);
});

test('identity api > /feedback "different" makes a sticky non-match', async t => {
  const { port, db, secrets } = await makeServer(t);
  const a = people.create(db, secrets, { given_name: 'Pio', family_name: 'Pietrelcina' });
  const b = people.create(db, secrets, { given_name: 'Pio', family_name: 'Pietrelcina' });

  // External app says: these are NOT the same.
  const r1 = await request(port, {
    method: 'POST', path: '/api/identity/feedback', headers: auth(secrets),
    body: { left_code: a, right_code: b, decision: 'different', notes: 'father and son — confirmed via parish records' },
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.decision, 'rejected_sticky');

  // Now run the resolver — the same Pio Pietrelcina record should NOT
  // re-flag a conflict between a and b.
  const resolver = require('../server/identity/resolver');
  resolver.rescorePerson(db, secrets, defaultThresholds(), b);
  const conflictsMod = require('../server/identity/conflicts');
  const open = conflictsMod.list(db, { status: 'open' });
  assert.equal(open.length, 0, 'sticky non-match should suppress re-flagging');
});

test('identity api > /feedback "same" merges the pair', async t => {
  const { port, db, secrets } = await makeServer(t);
  const a = people.create(db, secrets, { given_name: 'Pio', family_name: 'Pietrelcina' });
  const b = people.create(db, secrets, { given_name: 'Pio', family_name: 'Pietrelcina' });
  const r = await request(port, {
    method: 'POST', path: '/api/identity/feedback', headers: auth(secrets),
    body: { left_code: a, right_code: b, decision: 'same', winner_code: a, notes: 'verified duplicate' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.decision, 'merged');
  assert.equal(r.body.winner, a);
});

test('identity api > /resolve persists profile fields on creation', async t => {
  const { port, db, secrets } = await makeServer(t);
  const r = await request(port, {
    method: 'POST', path: '/api/identity/resolve', headers: auth(secrets),
    body: { record: { first_name: 'Pio', last_name: 'Pietrelcina' }, source: 'missioniq' },
  });
  assert.equal(r.status, 201);
  // Now PATCH richer profile fields and read them back via the people API
  const code = r.body.code;
  await request(port, {
    method: 'PATCH', path: `/api/people/${code}`, headers: auth(secrets),
    body: {
      employer: 'St Joseph Hospital',
      title: 'Director of Development',
      do_not_contact: true,
      do_not_contact_reason: 'unsubscribed Q1 2026',
      not_living_together: true,
    },
  });
  const got = await request(port, { method: 'GET', path: `/api/people/${code}`, headers: auth(secrets) });
  assert.equal(got.status, 200);
  assert.equal(got.body.person.employer, 'St Joseph Hospital');
  assert.equal(got.body.person.title, 'Director of Development');
  assert.equal(got.body.person.do_not_contact, true);
  assert.equal(got.body.person.do_not_contact_reason, 'unsubscribed Q1 2026');
  assert.equal(got.body.person.not_living_together, true);
});

test('conflicts api > resolve with notes persists resolution_notes', async t => {
  const { port, db, secrets } = await makeServer(t);
  const a = people.create(db, secrets, { given_name: 'Pio', family_name: 'Pietrelcina' });
  const b = people.create(db, secrets, { given_name: 'Pio', family_name: 'Pietrelcina' });

  // Run a duplicate scan to open the conflict.
  const resolver = require('../server/identity/resolver');
  resolver.rescorePerson(db, secrets, defaultThresholds(), b);
  const conflictsMod = require('../server/identity/conflicts');
  const open = conflictsMod.list(db, { status: 'open' });
  assert.equal(open.length, 1);

  const r = await request(port, {
    method: 'POST', path: `/api/conflicts/${open[0].code}/resolve`, headers: auth(secrets),
    body: { decision: 'reject', notes: 'father and son, confirmed via parish records' },
  });
  assert.equal(r.status, 200);

  const closed = conflictsMod.list(db, { status: 'rejected' });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].resolution_notes, 'father and son, confirmed via parish records');
  assert.equal(closed[0].resolved_by, 'unit-test');
});
