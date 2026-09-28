'use strict';

// Regression tests for the roster review findings (2026-09-28): fused
// same-name children, linked records renamed to someone else, a roster key
// reaching another app's crosswalk, non-idempotent commits, stale decisions
// minting second ids, and the input/limit/rate hardening around them.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const roster = require('../server/identity/roster');
const people = require('../server/identity/people');
const crosswalk = require('../server/identity/crosswalk');
const apiKeys = require('../server/auth/api-keys');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets, th: defaultThresholds() };
}

const run = (ctx, body, mode = 'plan', opts = {}) => roster.run(ctx.db, ctx.secrets, ctx.th, body, { mode, actor: 'test', ...opts });
const hh = (ctx, households, mode = 'plan', extra = {}) => run(ctx, { households, ...extra }, mode);
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const persons = r => r.sheets.flatMap(s => s.rows.flatMap(row => row.persons || []));
const byName = (r, given) => persons(r).filter(p => p.given_name === given);

// ---------------------------------------------------------------------------
// [2] Same-name children in different grades at one address
// ---------------------------------------------------------------------------

test('fix 2 > same-name children in different grades at one address are never fused in one upload', t => {
  const ctx = setup(t);
  const address = { line1: '5 Elm St', city: 'Austin', postal: '78701' };
  const households = [
    { address, persons: [
      { given_name: 'Ana', family_name: 'Cruz', role: 'parent', email: 'ana@example.org' },
      { given_name: 'Maria', family_name: 'Cruz', role: 'child', grade: '2' },
    ] },
    { address, persons: [
      { given_name: 'Rosa', family_name: 'Cruz', role: 'parent', email: 'rosa@example.org' },
      { given_name: 'Maria', family_name: 'Cruz', role: 'child', grade: '7' },
    ] },
  ];
  for (const mode of ['plan', 'commit']) {
    const r = hh(ctx, households, mode);
    const marias = byName(r, 'Maria');
    assert.notEqual(marias[1].action, 'matched', `${mode}: grade 7 is not the grade-2 Maria`);
    assert.equal(marias[1].same_as, undefined);
    assert.equal(marias[1].action, 'review', `${mode}: same name and address but a different grade - a person decides`);
    assert.ok(marias[1].review_reasons.includes('different_grade_same_upload'));
    assert.ok(r.pending.includes('0:1:1'));
    assert.equal(r.committed, false);
  }
  assert.equal(count(ctx.db, 'persons'), 0, 'nothing written while the question is open');

  // "Different child" commits two ids.
  const done = hh(ctx, households, 'commit', { decisions: { '0:1:1': { action: 'create' } } });
  assert.equal(done.committed, true);
  const m = byName(done, 'Maria');
  assert.notEqual(m[0].community_id, m[1].community_id);
});

test('fix 2 > the same child listed twice in the same grade at one address still matches on its own', t => {
  const ctx = setup(t);
  const address = { line1: '5 Elm St', city: 'Austin', postal: '78701' };
  const r = hh(ctx, [
    { address, persons: [{ given_name: 'Ana', family_name: 'Cruz', role: 'parent', email: 'ana@example.org' },
      { given_name: 'Maria', family_name: 'Cruz', role: 'child', grade: '2' }] },
    { address, persons: [{ given_name: 'Ana', family_name: 'Cruz', role: 'parent', email: 'ana@example.org' },
      { given_name: 'Maria', family_name: 'Cruz', role: 'child', grade: '2nd' }] },
  ]);
  assert.deepEqual(r.pending, []);
  assert.equal(byName(r, 'Maria')[1].action, 'matched');
  assert.equal(byName(r, 'Maria')[1].same_as, '0:0:1');
});

// ---------------------------------------------------------------------------
// [3] A linked record renamed into someone else
// ---------------------------------------------------------------------------

function linkedRename(t, from, to, { dobFrom = null, dobTo = null } = {}) {
  const ctx = setup(t);
  const first = hh(ctx, [{ ref: 'family:1', persons: [
    { ref: 'contact:1', given_name: from, family_name: 'Lee', role: 'parent', email: `${from.toLowerCase()}@example.org`, date_of_birth: dobFrom },
  ] }], 'commit', { source: 'missioniq' });
  assert.equal(first.committed, true);
  const code = crosswalk.lookup(ctx.db, 'missioniq', 'contact:1').code;
  const r = hh(ctx, [{ ref: 'family:1', persons: [
    { ref: 'contact:1', given_name: to, family_name: 'Lee', role: 'parent', email: `${to.toLowerCase()}@example.org`, date_of_birth: dobTo },
  ] }], 'plan', { source: 'missioniq' });
  return { r, out: persons(r)[0], firstId: persons(first)[0].community_id, code };
}

for (const [a, b] of [['Mark', 'Mary'], ['John', 'Joan'], ['Maria', 'Mario'], ['Jean', 'Joan'], ['Daniel', 'Danielle'], ['Jane', 'Janie']]) {
  test(`fix 3 > a linked record renamed ${a} -> ${b} goes to a person, never keeps the old id silently`, t => {
    const { r, out } = linkedRename(t, a, b);
    assert.equal(out.action, 'review');
    assert.ok(out.review_reasons.includes('linked_record_changed'));
    assert.deepEqual(r.pending, ['0:0:0']);
  });
}

test('fix 3 > a nickname, the same name, or a typo fix with the same birthdate keeps the link automatically', t => {
  for (const [a, b, opts] of [
    ['Robert', 'Bob', {}],
    ['John', 'Johnny', {}],
    ['Mary', 'Marie', {}],
    ['Jane', 'Jane', {}],
    ['Jhon', 'John', { dobFrom: '1980-02-03', dobTo: '1980-02-03' }],
  ]) {
    const { r, out } = linkedRename(t, a, b, opts);
    assert.deepEqual(r.pending, [], `${a} -> ${b}`);
    assert.equal(out.action, 'matched', `${a} -> ${b}`);
    assert.equal(out.matched.via, 'linked');
  }
});

test('fix 3 > a different first name with the same birthdate (a twin) is still asked', t => {
  const { out } = linkedRename(t, 'Ella', 'Grace', { dobFrom: '2015-01-01', dobTo: '2015-01-01' });
  assert.equal(out.action, 'review');
  assert.ok(out.review_reasons.includes('linked_record_changed'));
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function request(port, { method = 'GET', path = '/', headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw != null ? Buffer.from(raw) : (body == null ? null : Buffer.from(JSON.stringify(body)));
    const req = http.request({
      method, hostname: '127.0.0.1', port, path,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}), ...headers },
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let payload = buf;
        try { payload = JSON.parse(buf); } catch { /* keep text */ }
        resolve({ status: res.statusCode, body: payload, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function httpSetup(t, { rateLimited = false } = {}) {
  const prev = process.env.FAMILY_GRAPH_DISABLE_RATE_LIMIT;
  if (rateLimited) delete process.env.FAMILY_GRAPH_DISABLE_RATE_LIMIT;
  else process.env.FAMILY_GRAPH_DISABLE_RATE_LIMIT = '1';
  const { buildApp } = require('../server');
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  if (prev === undefined) delete process.env.FAMILY_GRAPH_DISABLE_RATE_LIMIT;
  else process.env.FAMILY_GRAPH_DISABLE_RATE_LIMIT = prev;
  const { server, port } = await listen(app);
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); cleanup(dir); });
  const anon = apiKeys.provision(db, { name: 'docanonymizer', scopes: ['roster'] });
  const H = tok => ({ authorization: `Bearer ${tok}` });
  return { db, secrets, port, anon, H, master: H(secrets.master) };
}

// ---------------------------------------------------------------------------
// [6] A roster key cannot reach another app's crosswalk
// ---------------------------------------------------------------------------

test('fix 6 > a roster key cannot claim another app\'s source, send refs or code hints; master and the CLI can', async t => {
  const ctx = await httpSetup(t);
  const P = '/api/identity/roster/plan';
  const C = '/api/identity/roster/commit';
  // MissionIQ (in-process, as the CLI does) links child:7 to Ann Lee.
  const seed = roster.run(ctx.db, ctx.secrets, defaultThresholds(), {
    source: 'missioniq',
    households: [{ ref: 'family:7', persons: [{ ref: 'child:7', given_name: 'Ann', family_name: 'Lee', role: 'child', date_of_birth: '2015-01-01' }] }],
  }, { mode: 'commit', actor: 'cli' });
  assert.equal(seed.committed, true);
  const annCode = crosswalk.lookup(ctx.db, 'missioniq', 'child:7').code;

  const probe = { source: 'missioniq', households: [{ persons: [{ given_name: 'Zed', family_name: 'Other', ref: 'child:7' }] }] };
  const p = await request(ctx.port, { method: 'POST', path: P, headers: ctx.H(ctx.anon.token), body: probe });
  assert.equal(p.status, 403);
  assert.equal(p.body.error, 'roster_forbidden');
  assert.ok(!JSON.stringify(p.body).includes('Ann'), 'nothing about the linked person comes back');
  const c = await request(ctx.port, { method: 'POST', path: C, headers: ctx.H(ctx.anon.token),
    body: { ...probe, decisions: { '0:0:0': { action: 'create' } } } });
  assert.equal(c.status, 403);
  assert.equal(crosswalk.lookup(ctx.db, 'missioniq', 'child:7').code, annCode, 'the link is untouched');

  // Refs and code hints under the key's own source name are refused too.
  for (const body of [
    { source: 'docanonymizer', households: [{ persons: [{ given_name: 'Zed', family_name: 'Other', ref: 'child:7' }] }] },
    { households: [{ ref: 'family:7', persons: [{ given_name: 'Zed', family_name: 'Other' }] }] },
    { households: [{ persons: [{ given_name: 'Ann', family_name: 'Lee', code_hint: annCode }] }] },
  ]) {
    const r = await request(ctx.port, { method: 'POST', path: P, headers: ctx.H(ctx.anon.token), body });
    assert.equal(r.status, 403, JSON.stringify(body));
  }
  // Its own name, the default, and plain sheets still work.
  const sheets = [{ headers: ['First Name', 'Last Name'], rows: [['Zed', 'Other']] }];
  assert.equal((await request(ctx.port, { method: 'POST', path: P, headers: ctx.H(ctx.anon.token), body: { source: 'docanonymizer', sheets } })).status, 200);
  assert.equal((await request(ctx.port, { method: 'POST', path: P, headers: ctx.H(ctx.anon.token), body: { sheets } })).status, 200);
  // A source with no crosswalk links is only a label (changed 2026-09-28,
  // third pass: a key not named exactly after its source must still plan).
  assert.equal((await request(ctx.port, { method: 'POST', path: P, headers: ctx.H(ctx.anon.token), body: { source: 'someotherapp', sheets } })).status, 200);
  // The master token keeps full use.
  const m = await request(ctx.port, { method: 'POST', path: P, headers: ctx.master,
    body: { source: 'missioniq', households: [{ persons: [{ given_name: 'Ann', family_name: 'Lee', ref: 'child:7', role: 'child' }] }] } });
  assert.equal(m.status, 200);
  assert.equal(m.body.sheets[0].rows[0].persons[0].matched.via, 'linked');
});

// ---------------------------------------------------------------------------
// [7] Idempotent commit
// ---------------------------------------------------------------------------

const SHEET = {
  headers: ['First Name', 'Last Name', 'Email'],
  rows: [['Marie', 'Smith', 'marie@example.org'], ['Mary', 'Smith', ''], ['Bob', 'Jones', 'bob@example.org']],
};

test('fix 7 > a commit retried with the same idempotency key replays the first result and writes nothing', async t => {
  const ctx = await httpSetup(t);
  const C = '/api/identity/roster/commit';
  people.create(ctx.db, ctx.secrets, { given_name: 'Mary', family_name: 'Smith' });
  const key = 'docanon:sess1:0123456789abcdef0123456789abcdef';

  // Refused for open reviews: not stored, so the same key works once decided.
  const refused = await request(ctx.port, { method: 'POST', path: C, headers: ctx.H(ctx.anon.token),
    body: { sheets: [SHEET], source: 'docanonymizer', idempotency_key: key } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'review_incomplete');
  assert.equal(count(ctx.db, 'idempotency_keys'), 0);

  const body = { sheets: [SHEET], source: 'docanonymizer', source_ref: 'docanonymizer:sess1',
    decisions: { '0:0:0': { action: 'create' }, '0:1:0': { action: 'create' } }, idempotency_key: key };
  const first = await request(ctx.port, { method: 'POST', path: C, headers: ctx.H(ctx.anon.token), body });
  assert.equal(first.status, 201);
  assert.equal(first.body.committed, true);
  assert.equal(first.body.replayed, undefined);
  const nPersons = count(ctx.db, 'persons');
  const nConflicts = count(ctx.db, 'conflicts');
  const nAudit = count(ctx.db, 'audit_events');

  const again = await request(ctx.port, { method: 'POST', path: C, headers: ctx.H(ctx.anon.token), body });
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.committed, true);
  assert.deepEqual(again.body.sheets, first.body.sheets, 'the same ids come back');
  assert.equal(count(ctx.db, 'persons'), nPersons, 'no second ids');
  assert.equal(count(ctx.db, 'conflicts'), nConflicts, 'no re-recorded conflicts');
  assert.equal(count(ctx.db, 'audit_events'), nAudit, 'a replay writes nothing');

  // Same key, different request.
  const changed = await request(ctx.port, { method: 'POST', path: C, headers: ctx.H(ctx.anon.token),
    body: { ...body, decisions: { '0:0:0': { action: 'create' }, '0:1:0': { action: 'skip' } } } });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, 'idempotency_conflict');
  assert.equal(count(ctx.db, 'persons'), nPersons);

  // The stored response is encrypted: no names in the table.
  const stored = ctx.db.prepare('SELECT response_body, expires_at FROM idempotency_keys').all();
  assert.equal(stored.length, 1);
  assert.ok(!/Marie|Smith|marie@/.test(stored[0].response_body));
  const days = (Date.parse(stored[0].expires_at) - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days <= 7.01, 'kept for 7 days');

  // Keys are per caller: the master token's same key is a different request.
  const other = await request(ctx.port, { method: 'POST', path: C, headers: ctx.master,
    body: { sheets: [{ headers: ['First Name', 'Last Name', 'Email'], rows: [['Cy', 'Lee', 'cy@example.org']] }], idempotency_key: key } });
  assert.equal(other.status, 201);

  // Bad keys are refused.
  for (const bad of ['short', 'has space in it', 'x'.repeat(201), 12345678]) {
    const r = await request(ctx.port, { method: 'POST', path: C, headers: ctx.H(ctx.anon.token), body: { ...body, idempotency_key: bad } });
    assert.equal(r.status, 400, String(bad));
  }
});

test('fix 7 > an expired key is forgotten', t => {
  const ctx = setup(t);
  const body = { sheets: [{ headers: ['First Name', 'Last Name', 'Email'], rows: [['Cy', 'Lee', 'cy@example.org']] }], idempotency_key: 'k-12345678' };
  const caller = { id: 'key_1', name: 'docanonymizer', master: false };
  const a = run(ctx, body, 'commit', { caller });
  assert.equal(a.committed, true);
  assert.equal(run(ctx, body, 'commit', { caller }).replayed, true);
  ctx.db.prepare(`UPDATE idempotency_keys SET expires_at = '2000-01-01T00:00:00.000Z'`).run();
  const c = run(ctx, body, 'commit', { caller });
  assert.equal(c.replayed, undefined);
  assert.equal(c.committed, true);
  assert.equal(count(ctx.db, 'persons'), 1, 'the person matched on the re-run, no second id');
});

test('fix 7 > without a key, a retried commit of the same upload refuses instead of minting second ids', t => {
  const ctx = setup(t);
  people.create(ctx.db, ctx.secrets, { given_name: 'Mary', family_name: 'Smith' });
  const body = { sheets: [SHEET], source: 'docanonymizer', source_ref: 'docanonymizer:sess2',
    decisions: { '0:0:0': { action: 'create' }, '0:1:0': { action: 'create' } } };
  const first = run(ctx, body, 'commit');
  assert.equal(first.committed, true);
  const n = count(ctx.db, 'persons');
  const nc = count(ctx.db, 'conflicts');
  const again = run(ctx, body, 'commit');
  assert.equal(again.committed, false);
  assert.deepEqual([...again.stale_decisions].sort(), ['0:0:0', '0:1:0']);
  assert.equal(count(ctx.db, 'persons'), n, 'no second Marie, no third Mary');
  assert.equal(count(ctx.db, 'conflicts'), nc);
});

// ---------------------------------------------------------------------------
// [10] A stale 'create' never overrides a definitive match
// ---------------------------------------------------------------------------

test('fix 10 > a create decision on an item that is now a definitive match is refused and reported', t => {
  const ctx = setup(t);
  const sheet = { headers: ['First Name', 'Last Name', 'Email'], rows: [['Marie', 'Garcia', 'marie@example.org']] };
  const first = run(ctx, { sheets: [sheet] }, 'commit');
  assert.equal(first.committed, true);
  const id = persons(first)[0].community_id;

  const p = run(ctx, { sheets: [sheet], decisions: { '0:0:0': { action: 'create' } } }, 'plan');
  assert.deepEqual(p.stale_decisions, ['0:0:0']);
  assert.equal(persons(p)[0].action, 'matched', 'the plan shows what the data says now');
  assert.equal(persons(p)[0].stale_decision, 'decision_no_longer_applies');

  const c = run(ctx, { sheets: [sheet], decisions: { '0:0:0': { action: 'create' } } }, 'commit');
  assert.equal(c.committed, false);
  assert.deepEqual(c.stale_decisions, ['0:0:0']);
  assert.equal(count(ctx.db, 'persons'), 1, 'no second id for Marie');

  // An attach to someone else is just as stale; an attach to her is fine.
  const other = people.create(ctx.db, ctx.secrets, { given_name: 'Zoe', family_name: 'Garcia' });
  const ids = require('../server/crypto/identifiers');
  const wrong = run(ctx, { sheets: [sheet], decisions: { '0:0:0': { action: 'attach', target: ids.toCommunityId(other) } } }, 'commit');
  assert.equal(wrong.committed, false);
  assert.deepEqual(wrong.stale_decisions, ['0:0:0']);
  const right = run(ctx, { sheets: [sheet], decisions: { '0:0:0': { action: 'attach', target: id } } }, 'commit');
  assert.equal(right.committed, true);
  assert.equal(persons(right)[0].community_id, id);
});

test('fix 10 > over HTTP a stale decision is a 409 with the fresh plan, nothing written', async t => {
  const ctx = await httpSetup(t);
  const sheet = { headers: ['First Name', 'Last Name', 'Email'], rows: [['Marie', 'Garcia', 'marie@example.org']] };
  const C = '/api/identity/roster/commit';
  assert.equal((await request(ctx.port, { method: 'POST', path: C, headers: ctx.H(ctx.anon.token), body: { sheets: [sheet] } })).status, 201);
  const r = await request(ctx.port, { method: 'POST', path: C, headers: ctx.H(ctx.anon.token),
    body: { sheets: [sheet], decisions: { '0:0:0': { action: 'create' } }, idempotency_key: 'docanon:s:abcdef12' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'review_incomplete');
  assert.deepEqual(r.body.plan.stale_decisions, ['0:0:0']);
  assert.equal(count(ctx.db, 'persons'), 1);
  assert.equal(count(ctx.db, 'idempotency_keys'), 0, 'a refused commit is not stored');
});

// ---------------------------------------------------------------------------
// [33] Disclosed candidates are on the audit trail (codes only)
// ---------------------------------------------------------------------------

test('fix 33 > a plan records which people it disclosed, as codes, never values', t => {
  const ctx = setup(t);
  const ann = people.create(ctx.db, ctx.secrets, { given_name: 'Ann', family_name: 'Lee', date_of_birth: '2015-01-01' });
  run(ctx, { sheets: [{ headers: ['First Name', 'Last Name'], rows: [['Anne', 'Lee']] }] }, 'plan');
  const row = ctx.db.prepare(`SELECT metadata FROM audit_events WHERE action = 'roster_plan' ORDER BY rowid DESC LIMIT 1`).get();
  const meta = JSON.parse(row.metadata);
  assert.deepEqual(meta.disclosed_persons, [ann]);
  assert.equal(meta.disclosed_count, 1);
  assert.ok(!/Ann|Lee|2015/.test(row.metadata.replace(ann, '')));
});

// ---------------------------------------------------------------------------
// [34] Plan sits behind the roster (import-class) rate limit
// ---------------------------------------------------------------------------

test('fix 34 > plan and commit share a tight roster bucket; lookup stays on the pii bucket', async t => {
  const ctx = await httpSetup(t, { rateLimited: true });
  const sheets = [{ headers: ['First Name', 'Last Name'], rows: [['Zed', 'Other']] }];
  const p = await request(ctx.port, { method: 'POST', path: '/api/identity/roster/plan', headers: ctx.H(ctx.anon.token), body: { sheets } });
  assert.equal(p.status, 200);
  assert.equal(p.headers['x-ratelimit-bucket'], 'roster');
  let limited = null;
  for (let i = 0; i < 25 && !limited; i++) {
    const r = await request(ctx.port, { method: 'POST', path: '/api/identity/roster/plan', headers: ctx.H(ctx.anon.token), body: { sheets } });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, 'a burst of plans is throttled');
  // An unauthenticated caller is turned away before its body is parsed.
  const unauth = await request(ctx.port, { method: 'POST', path: '/api/identity/roster/plan', raw: '{not json' });
  assert.equal(unauth.status, 401);
});

// ---------------------------------------------------------------------------
// [35] [36] [39] Input shape
// ---------------------------------------------------------------------------

test('fix 35 > a malformed mapping is a 400, not a crash', t => {
  const ctx = setup(t);
  const headers = ['First Name', 'Last Name'];
  for (const mapping of [{ persons: 5 }, { persons: 'x' }, { persons: [null] }, { persons: [{ given_name: 7 }] },
    { persons: [{ given_name: 'First Name' }], address: 3 }, { persons: [{ given_name: ['First Name', 4] }] }, { family: 'x' }]) {
    assert.throws(() => run(ctx, { sheets: [{ headers, rows: [['Ann', 'Lee']], mapping }] }),
      e => e instanceof roster.RosterError && e.status === 400, JSON.stringify(mapping));
  }
  // A good caller mapping still works.
  const ok = run(ctx, { sheets: [{ headers, rows: [['Ann', 'Lee']], mapping: { persons: [{ role: 'member', given_name: 'First Name', family_name: 'Last Name' }] } }] });
  assert.equal(ok.summary.persons.new, 1);
});

test('fix 36 > persons per household and per request are capped', t => {
  const ctx = setup(t);
  const many = n => Array.from({ length: n }, (_, i) => ({ given_name: `P${i}`, family_name: 'Lee' }));
  assert.throws(() => hh(ctx, [{ persons: many(roster.LIMITS.personsPerHousehold + 1) }]),
    e => e instanceof roster.RosterError && e.status === 400);
  // A list cell that splits into too many people counts the same way.
  const list = Array.from({ length: roster.LIMITS.personsPerHousehold + 1 }, (_, i) => `Kid${i}`).join(', ');
  assert.throws(() => run(ctx, { sheets: [{ headers: ['Last Name', 'Children'], rows: [['Lee', list]] }] }),
    e => e instanceof roster.RosterError && e.status === 400);
  // The request total.
  const saved = roster.LIMITS.persons;
  roster.LIMITS.persons = 10;
  t.after(() => { roster.LIMITS.persons = saved; });
  assert.throws(() => hh(ctx, Array.from({ length: 6 }, () => ({ persons: many(2) }))),
    e => e instanceof roster.RosterError && /too many people/.test(e.message));
  roster.LIMITS.persons = saved;
  assert.equal(hh(ctx, [{ persons: many(roster.LIMITS.personsPerHousehold) }]).summary.rows, 1);
});

test('fix 39 > object and array cells are refused, never minted as names', t => {
  const ctx = setup(t);
  const headers = ['First Name', 'Last Name'];
  for (const rows of [[[{}, 'Lee']], [[['Ann'], 'Lee']], [['Ann', { x: 1 }]]]) {
    for (const mode of ['plan', 'commit']) {
      assert.throws(() => run(ctx, { sheets: [{ headers, rows }] }, mode),
        e => e instanceof roster.RosterError && e.status === 400 && /text or numbers/.test(e.message));
    }
  }
  assert.throws(() => run(ctx, { sheets: [{ headers: [{}, 'Last Name'], rows: [['Ann', 'Lee']] }] }), roster.RosterError);
  assert.throws(() => hh(ctx, [{ persons: [{ given_name: { a: 1 }, family_name: 'Lee' }] }]), roster.RosterError);
  assert.equal(count(ctx.db, 'persons'), 0);
  // Numbers and booleans are still text.
  assert.equal(run(ctx, { sheets: [{ headers: ['First Name', 'Last Name', 'Grade'], rows: [['Ann', 'Lee', 3]] }] }).summary.persons.new, 1);
});
