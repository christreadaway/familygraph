'use strict';

// /api/identity/resolve and /resolve-batch read the crosswalk. These pin the
// guards on that read:
//   - a linked record that has since turned into someone else is not
//     returned as the linked person, and its email and phone never land on
//     them (via: 'crosswalk_mismatch', normal resolver instead);
//   - only the master token or the key named after the source may read a
//     source's crosswalk;
//   - with_family never guesses between two active households.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const people = require('../server/identity/people');
const families = require('../server/identity/families');
const crosswalk = require('../server/identity/crosswalk');
const apiKeys = require('../server/auth/api-keys');
const { buildApp } = require('../server');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method, hostname: '127.0.0.1', port, path: p,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}), ...headers },
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let payload = buf;
        try { payload = JSON.parse(buf); } catch { /* text */ }
        resolve({ status: res.statusCode, body: payload });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  t.after(() => new Promise(res => server.close(() => { db.close(); cleanup(dir); res(); })));
  const master = { authorization: `Bearer ${secrets.master}` };
  const post = (p, body, headers = master) => request(server.address().port, { method: 'POST', path: p, headers, body });
  return { db, secrets, post, master };
}

const contactCounts = (db, code) => ({
  emails: db.prepare('SELECT COUNT(*) AS n FROM person_emails WHERE person_code = ?').get(code).n,
  phones: db.prepare('SELECT COUNT(*) AS n FROM person_phones WHERE person_code = ?').get(code).n,
});

// John Smith, born 1970, linked to MissionIQ contact:5, in one household
// that is itself linked as family:fam-a.
function seedJohn(ctx) {
  const john = people.create(ctx.db, ctx.secrets, { given_name: 'John', family_name: 'Smith', date_of_birth: '1970-01-01' });
  const fam = families.create(ctx.db, ctx.secrets, { display_name: 'Smith Family' });
  families.addMember(ctx.db, ctx.secrets, fam, john, { role: 'parent' });
  crosswalk.link(ctx.db, { source: 'missioniq', ref: 'contact:5', kind: 'person', code: john });
  crosswalk.link(ctx.db, { source: 'missioniq', ref: 'family:fam-a', kind: 'family', code: fam });
  return { john, fam };
}

const MARY = { first_name: 'Mary', last_name: 'Smith', dob: '1985-05-05', email: 'mary@example.org', phone: '512-555-0199' };

// ---------------------------------------------------------------------------
// Findings 4 / 9: a changed linked record is not the linked person
// ---------------------------------------------------------------------------

test('resolve > a linked record edited into someone else does not return or grow the linked person', async t => {
  const ctx = await setup(t);
  const { john } = seedJohn(ctx);

  const r = await ctx.post('/api/identity/resolve', { record: MARY, source: 'missioniq', source_ref: 'contact:5', with_family: true });
  assert.equal(r.status, 201);
  assert.notEqual(r.body.code, john, 'Mary must not get John\'s id');
  assert.equal(r.body.via, 'crosswalk_mismatch');
  assert.ok(['created', 'enqueued', 'attached'].includes(r.body.action));
  assert.deepEqual(contactCounts(ctx.db, john), { emails: 0, phones: 0 }, 'Mary\'s email and phone stay off John');

  // Later strict email matching for Mary does not land on John either.
  const later = await ctx.post('/api/identity/resolve', { record: { first_name: 'Mary', last_name: 'Smith', email: 'mary@example.org' } });
  assert.notEqual(later.body.code, john);
});

test('resolve-batch > a changed linked record falls back to the resolver, per record', async t => {
  const ctx = await setup(t);
  const { john } = seedJohn(ctx);

  const r = await ctx.post('/api/identity/resolve-batch', {
    source: 'missioniq',
    records: [
      { ...MARY, source_ref: 'contact:5' },
      { first_name: 'John', last_name: 'Smith', email: 'john@example.org', source_ref: 'contact:5' },
    ],
  });
  assert.equal(r.status, 201);
  const [mary, same] = r.body.results;
  assert.equal(mary.index, 0);
  assert.notEqual(mary.code, john);
  assert.equal(mary.via, 'crosswalk_mismatch');
  // The unchanged record still rides the link, and its new email attaches.
  assert.equal(same.index, 1);
  assert.equal(same.code, john);
  assert.equal(same.via, 'crosswalk');
  assert.equal(same.action, 'attached');
  assert.deepEqual(contactCounts(ctx.db, john), { emails: 1, phones: 0 });
});

test('resolve > the same first name with a contradicting birthdate is not the linked person', async t => {
  const ctx = await setup(t);
  const { john } = seedJohn(ctx);
  const r = await ctx.post('/api/identity/resolve', {
    record: { first_name: 'John', last_name: 'Smith', dob: '1999-09-09', email: 'john2@example.org' },
    source: 'missioniq', source_ref: 'contact:5',
  });
  assert.notEqual(r.body.code, john);
  assert.equal(r.body.via, 'crosswalk_mismatch');
  assert.deepEqual(contactCounts(ctx.db, john), { emails: 0, phones: 0 });
});

test('resolve > Jr against a linked Sr is not the linked person', async t => {
  const ctx = await setup(t);
  const sr = people.create(ctx.db, ctx.secrets, { given_name: 'John', family_name: 'Smith', suffix: 'Sr' });
  crosswalk.link(ctx.db, { source: 'missioniq', ref: 'contact:9', kind: 'person', code: sr });
  const r = await ctx.post('/api/identity/resolve', {
    record: { first_name: 'John', last_name: 'Smith', suffix: 'Jr', email: 'jr@example.org' },
    source: 'missioniq', source_ref: 'contact:9',
  });
  assert.notEqual(r.body.code, sr);
  assert.equal(r.body.via, 'crosswalk_mismatch');
  assert.deepEqual(contactCounts(ctx.db, sr), { emails: 0, phones: 0 });
});

test('resolve > a nickname or a fixed typo with the same birthdate still rides the link', async t => {
  const ctx = await setup(t);
  const { john } = seedJohn(ctx);
  const nick = await ctx.post('/api/identity/resolve', {
    record: { first_name: 'Johnny', last_name: 'Smith' }, source: 'missioniq', source_ref: 'contact:5',
  });
  assert.equal(nick.body.code, john);
  assert.equal(nick.body.via, 'crosswalk');
  const typo = await ctx.post('/api/identity/resolve', {
    record: { first_name: 'Jonh', last_name: 'Smith', dob: '1970-01-01' }, source: 'missioniq', source_ref: 'contact:5',
  });
  assert.equal(typo.body.code, john);
  assert.equal(typo.body.via, 'crosswalk');
});

// ---------------------------------------------------------------------------
// Finding 23: only the source's own key reads its crosswalk
// ---------------------------------------------------------------------------

test('resolve > another app\'s key cannot read the missioniq crosswalk or plant contacts through it', async t => {
  const ctx = await setup(t);
  const { john } = seedJohn(ctx);
  const pp = apiKeys.provision(ctx.db, { name: 'parentpoint', scopes: ['pii.read', 'pii.write'] });
  const ppHeaders = { authorization: `Bearer ${pp.token}` };

  const probe = await ctx.post('/api/identity/resolve', {
    record: { first_name: 'x', last_name: 'y', email: 'attacker@example.org' },
    source: 'missioniq', source_ref: 'contact:5', with_family: true,
  }, ppHeaders);
  // Refused outright (third pass): resolving by name instead could stamp a
  // second id on a linked record.
  assert.equal(probe.status, 403);
  assert.equal(probe.body.error, 'crosswalk_forbidden');
  assert.equal(probe.body.code, undefined, 'the ref must not map to John for another app');
  assert.deepEqual(contactCounts(ctx.db, john), { emails: 0, phones: 0 });

  const batch = await ctx.post('/api/identity/resolve-batch', {
    source: 'missioniq', records: [{ first_name: 'John', last_name: 'Smith', source_ref: 'contact:5' }],
  }, ppHeaders);
  assert.equal(batch.status, 403);
  assert.equal(batch.body.results, undefined);

  // The key issued as `family-graph issue-key missioniq` does read it.
  const mq = apiKeys.provision(ctx.db, { name: 'missioniq', scopes: ['pii.read', 'pii.write'] });
  const own = await ctx.post('/api/identity/resolve', {
    record: { first_name: 'John', last_name: 'Smith' }, source: 'missioniq', source_ref: 'contact:5',
  }, { authorization: `Bearer ${mq.token}` });
  assert.equal(own.body.code, john);
  assert.equal(own.body.via, 'crosswalk');
});

// ---------------------------------------------------------------------------
// Finding 25: with_family never picks between two active households
// ---------------------------------------------------------------------------

test('resolve > two crosswalk-linked households: no family is guessed, both are listed', async t => {
  const ctx = await setup(t);
  const { john, fam } = seedJohn(ctx);
  const famZ = families.create(ctx.db, ctx.secrets, { display_name: 'Smith Family' });
  families.addMember(ctx.db, ctx.secrets, famZ, john, { role: 'parent' });
  crosswalk.link(ctx.db, { source: 'missioniq', ref: 'family:fam-z', kind: 'family', code: famZ });
  const famsBefore = ctx.db.prepare('SELECT COUNT(*) AS n FROM families').get().n;

  const r = await ctx.post('/api/identity/resolve', {
    record: { first_name: 'John', last_name: 'Smith' }, source: 'missioniq', source_ref: 'contact:5', with_family: true,
  });
  assert.equal(r.body.code, john);
  assert.equal(r.body.family, undefined, 'no household is stamped on a guess');
  assert.deepEqual([...r.body.families].sort(), [fam, famZ].sort());
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM families').get().n, famsBefore, 'with_family does not create a third');

  const b = await ctx.post('/api/identity/resolve-batch', {
    source: 'missioniq', with_family: true, records: [{ first_name: 'John', last_name: 'Smith', source_ref: 'contact:5' }],
  });
  assert.equal(b.body.results[0].family, undefined);
  assert.deepEqual([...b.body.results[0].families].sort(), [fam, famZ].sort());
});

test('resolve > two households, exactly one linked from the same source: that one is returned', async t => {
  const ctx = await setup(t);
  const { john, fam } = seedJohn(ctx);
  // A second, newer household that MissionIQ never linked (another app's).
  const other = families.create(ctx.db, ctx.secrets, { display_name: 'Other Family' });
  families.addMember(ctx.db, ctx.secrets, other, john, { role: 'parent' });
  crosswalk.link(ctx.db, { source: 'parentpoint', ref: 'household:1', kind: 'family', code: other });

  const r = await ctx.post('/api/identity/resolve', {
    record: { first_name: 'John', last_name: 'Smith' }, source: 'missioniq', source_ref: 'contact:5', with_family: true,
  });
  assert.equal(r.body.code, john);
  assert.deepEqual(r.body.family, { code: fam, action: 'existing' });
  assert.equal(r.body.families, undefined);

  // A caller that may not read the missioniq crosswalk gets no pick. (With
  // a record ref it is refused outright; without one it resolves by name.)
  const pp = apiKeys.provision(ctx.db, { name: 'parentpoint', scopes: ['pii.read', 'pii.write'] });
  const ppr = await ctx.post('/api/identity/resolve', {
    record: { first_name: 'John', last_name: 'Smith', dob: '1970-01-01' }, source: 'missioniq', with_family: true,
  }, { authorization: `Bearer ${pp.token}` });
  assert.equal(ppr.body.code, john, 'exact name and birthdate: the resolver finds John on its own');
  assert.equal(ppr.body.via, undefined);
  assert.equal(ppr.body.family, undefined);
  assert.deepEqual([...ppr.body.families].sort(), [fam, other].sort());
});

test('resolve > one active household is returned exactly as before', async t => {
  const ctx = await setup(t);
  const { john, fam } = seedJohn(ctx);
  const r = await ctx.post('/api/identity/resolve', {
    record: { first_name: 'John', last_name: 'Smith' }, source: 'missioniq', source_ref: 'contact:5',
  });
  assert.equal(r.body.code, john);
  assert.deepEqual(r.body.family, { code: fam, action: 'existing' });
  assert.equal(r.body.families, undefined);
});
