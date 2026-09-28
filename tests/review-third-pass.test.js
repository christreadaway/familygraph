'use strict';

// Regression tests for the third review of the 2026-09-28 fix pass:
//   1. John/Jack, John/Sean, Joseph/Jose are review, never proof
//   2. a MissionIQ re-sync can create a new namesake (per-run source_ref)
//   4. a misnamed MissionIQ key is refused on /resolve, not resolved by name
//   5. a roster key not named exactly after its source can still plan
//   6. a birthdate that may be misread goes to review, not auto-merge
// (3, stale decisions in Doc Anonymizer, is covered in Doc Anonymizer's
// tests/test_community_stale_decisions.py.)

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const roster = require('../server/identity/roster');
const matching = require('../server/identity/matching');
const crosswalk = require('../server/identity/crosswalk');
const missioniq = require('../server/identity/missioniq');
const people = require('../server/identity/people');
const apiKeys = require('../server/auth/api-keys');
const { buildApp } = require('../server');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets, th: defaultThresholds(), dir };
}
const strict = (a, b) => matching.scoreMatch(a, b, { strict: true });
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const persons = r => r.sheets.flatMap(s => s.rows.flatMap(row => row.persons || []));

// ---------------------------------------------------------------------------
// 1. Different given names that share an origin never prove identity
// ---------------------------------------------------------------------------

const INDEPENDENT = [['John', 'Jack'], ['John', 'Sean'], ['John', 'Juan'], ['Joseph', 'Jose'], ['Juan', 'Sean'], ['Joseph', 'Pepe']];

test('names > John/Jack, John/Sean, Joseph/Jose at one address or with one birthdate stay review', () => {
  for (const [a, b] of INDEPENDENT) {
    const addr = strict(
      { given_name: a, family_name: 'Murphy', address_line1: '5 Elm St' },
      { given_name: b, family_name: 'Murphy', address_line1: '5 Elm St' });
    assert.equal(addr.definitive, false, `${a}/${b} at one address`);
    const twins = strict(
      { given_name: a, family_name: 'Murphy', date_of_birth: '2015-03-04' },
      { given_name: b, family_name: 'Murphy', date_of_birth: '2015-03-04' });
    assert.equal(twins.definitive, false, `${a}/${b} twins`);
    assert.ok(twins.reasons.includes('nickname_or_short_form'), `${a}/${b} still reaches review`);
    const inbox = strict(
      { given_name: a, family_name: 'Garcia', email: 'garcia@example.org' },
      { given_name: b, family_name: 'Garcia', email: 'garcia@example.org' });
    assert.equal(inbox.definitive, false, `${a}/${b} on the family inbox`);
  }
});

test('names > real short forms of one name still prove identity', () => {
  for (const [a, b] of [['Joseph', 'Joe'], ['John', 'Johnny'], ['Jose', 'Pepe'], ['Elizabeth', 'Libby'], ['Nicholas', 'Nico']]) {
    const s = strict(
      { given_name: a, family_name: 'Smith', date_of_birth: '2015-03-04' },
      { given_name: b, family_name: 'Smith', date_of_birth: '2015-03-04' });
    assert.equal(s.definitive, true, `${a}/${b}`);
  }
  // Non-strict scoring still sees John/Jack as a nickname pair.
  assert.equal(matching.areNicknames('John', 'Jack'), true);
});

test('roster > brothers John and Jack Murphy at one address get two ids', t => {
  const ctx = setup(t);
  const sheet = {
    headers: ['First Name', 'Last Name', 'Address', 'City', 'Zip'],
    rows: [['John', 'Murphy', '5 Elm St', 'Austin', '78701'], ['Jack', 'Murphy', '5 Elm St', 'Austin', '78701']],
  };
  const r = roster.run(ctx.db, ctx.secrets, ctx.th, { sheets: [sheet] }, { mode: 'plan', actor: 'test' });
  const jack = persons(r).find(p => p.given_name === 'Jack');
  assert.notEqual(jack.action, 'matched');
  assert.notEqual(jack.same_as, '0:0:0');
});

test('roster > Joseph and Jose Garcia with different emails at one address are not fused', t => {
  const ctx = setup(t);
  const sheet = {
    headers: ['First Name', 'Last Name', 'Email', 'Address', 'City', 'Zip'],
    rows: [['Joseph', 'Garcia', 'joseph@example.org', '9 Oak St', 'Austin', '78701'],
      ['Jose', 'Garcia', 'jose@example.org', '9 Oak St', 'Austin', '78701']],
  };
  const r = roster.run(ctx.db, ctx.secrets, ctx.th, { sheets: [sheet] }, { mode: 'plan', actor: 'test' });
  const jose = persons(r).find(p => p.given_name === 'Jose');
  assert.notEqual(jose.action, 'matched');
});

// ---------------------------------------------------------------------------
// 2. A MissionIQ re-sync can create a genuinely new namesake
// ---------------------------------------------------------------------------

function fakeMissionIQ(dir, { families = [], contacts = [] }) {
  const p = path.join(dir, `missioniq-${crypto.randomBytes(4).toString('hex')}.sqlite`);
  const m = new Database(p);
  m.exec(`
    CREATE TABLE families (id TEXT PRIMARY KEY, family_name TEXT, address_line1 TEXT, address_line2 TEXT,
      city TEXT, state TEXT, zip TEXT, deceased INTEGER DEFAULT 0, fg_family_code TEXT,
      created_at TEXT DEFAULT '2026-01-01 00:00:00');
    CREATE TABLE contacts (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT, phone TEXT,
      secondary_email TEXT, secondary_phone TEXT, address_line1 TEXT, address_line2 TEXT, city TEXT, state TEXT,
      zip TEXT, family_id TEXT, role TEXT DEFAULT 'parent', relationship TEXT DEFAULT 'parent', birthday TEXT,
      gender TEXT, do_not_contact INTEGER DEFAULT 0, fg_person_code TEXT,
      created_at TEXT DEFAULT '2026-01-01 00:00:00');
    CREATE TABLE children (id INTEGER PRIMARY KEY AUTOINCREMENT, family_id TEXT NOT NULL, first_name TEXT,
      last_name TEXT, grade TEXT, birthday TEXT, enrolled INTEGER DEFAULT 1);
  `);
  const ins = (table, row) => {
    const cols = Object.keys(row);
    m.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => row[c]));
  };
  families.forEach(f => ins('families', f));
  contacts.forEach(c => ins('contacts', c));
  m.close();
  return p;
}

test('missioniq > a later sync can create a new namesake the operator says is someone else', async t => {
  const ctx = setup(t);
  const first = fakeMissionIQ(ctx.dir, {
    families: [{ id: 'fam-a', family_name: 'Garcia Family', address_line1: '5 Elm St', city: 'Austin', state: 'TX', zip: '78701' }],
    contacts: [{ id: 'c-1', first_name: 'Maria', last_name: 'Garcia', email: 'maria@example.org', family_id: 'fam-a' }],
  });
  const noReviews = item => { throw new Error(`unexpected review: ${item.key}`); };
  const base = { db: ctx.db, secrets: ctx.secrets, thresholds: ctx.th, confirm: () => true, actor: 'test' };
  const r1 = await missioniq.runImport({ ...base, dbPath: first, decide: noReviews });
  assert.equal(r1.status, 'committed');

  // A second Maria Garcia, her own household at the same address.
  const second = fakeMissionIQ(ctx.dir, {
    families: [
      { id: 'fam-a', family_name: 'Garcia Family', address_line1: '5 Elm St', city: 'Austin', state: 'TX', zip: '78701' },
      { id: 'fam-z', family_name: 'Garcia Family', address_line1: '5 Elm St', city: 'Austin', state: 'TX', zip: '78701' },
    ],
    contacts: [
      { id: 'c-1', first_name: 'Maria', last_name: 'Garcia', email: 'maria@example.org', family_id: 'fam-a' },
      { id: 'c-2', first_name: 'Maria', last_name: 'Garcia', email: 'maria.two@example.org', family_id: 'fam-z' },
    ],
  });
  const seen = [];
  const r2 = await missioniq.runImport({ ...base, dbPath: second, decide: item => { seen.push(item.key); return { action: 'create' }; } });
  assert.ok(seen.length > 0, 'the namesake went to a person');
  assert.equal(r2.status, 'committed', 'the operator\'s "someone else" is honored, not refused as a repeat');
  const one = crosswalk.lookup(ctx.db, 'missioniq', 'contact:c-1').code;
  const two = crosswalk.lookup(ctx.db, 'missioniq', 'contact:c-2').code;
  assert.notEqual(one, two);
  assert.equal(count(ctx.db, 'persons'), 2);
  // Two runs, two source_refs.
  const refs = ctx.db.prepare(`SELECT DISTINCT source_ref FROM import_runs WHERE source = 'missioniq'`).all();
  assert.equal(refs.length, 2);
});

// ---------------------------------------------------------------------------
// 5. Roster source rights
// ---------------------------------------------------------------------------

test('roster > a key not named exactly "docanonymizer" may still send source docanonymizer', t => {
  const ctx = setup(t);
  const body = {
    source: 'docanonymizer', source_ref: 'docanonymizer:s1',
    sheets: [{ headers: ['First Name', 'Last Name'], rows: [['Ann', 'Lee']] }],
  };
  for (const caller of [{ id: 'k1', name: 'DocAnonymizer', master: false }, { id: 'staff:a1', name: null, master: false }]) {
    const r = roster.run(ctx.db, ctx.secrets, ctx.th, body, { mode: 'plan', actor: 'test', caller });
    assert.equal(r.committed, false);
  }
});

test('roster > a key may not use another app\'s source once that source has crosswalk links', t => {
  const ctx = setup(t);
  const p = people.create(ctx.db, ctx.secrets, { given_name: 'Ann', family_name: 'Lee' });
  crosswalk.link(ctx.db, { source: 'missioniq', ref: 'contact:1', kind: 'person', code: p });
  const body = { source: 'missioniq', sheets: [{ headers: ['First Name', 'Last Name'], rows: [['Ann', 'Lee']] }] };
  assert.throws(
    () => roster.run(ctx.db, ctx.secrets, ctx.th, body, { mode: 'plan', actor: 'test', caller: { id: 'k1', name: 'DocAnonymizer', master: false } }),
    e => e instanceof roster.RosterError && e.status === 403 && e.extra.code === 'roster_forbidden');
  // Its own name still works, and the master token keeps full use.
  roster.run(ctx.db, ctx.secrets, ctx.th, body, { mode: 'plan', actor: 'test', caller: { id: 'k2', name: 'missioniq', master: false } });
  roster.run(ctx.db, ctx.secrets, ctx.th, body, { mode: 'plan', actor: 'test', caller: { id: 'master', name: null, master: true } });
});

// ---------------------------------------------------------------------------
// 4. /resolve refuses a misnamed key instead of resolving a linked record by name
// ---------------------------------------------------------------------------

function request(port, { method, path: p, headers, body }) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      method, hostname: '127.0.0.1', port, path: p,
      headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers },
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('resolve > a MissionIQ key issued under another name is refused, and nobody is created', async t => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  t.after(() => new Promise(res => server.close(() => { db.close(); cleanup(dir); res(); })));
  const post = (p, body, headers) => request(server.address().port, { method: 'POST', path: p, headers, body });

  const john = people.create(db, secrets, { given_name: 'John', family_name: 'Smith' });
  crosswalk.link(db, { source: 'missioniq', ref: 'contact:5', kind: 'person', code: john });
  const before = count(db, 'persons');
  const key = apiKeys.provision(db, { name: 'MissionIQ', scopes: ['pii.read', 'pii.write'] });
  const auth = { authorization: `Bearer ${key.token}` };

  // Drifted to a nickname: by name alone the resolver could mint a second id.
  const r = await post('/api/identity/resolve', { record: { first_name: 'Johnny', last_name: 'Smith' }, source: 'missioniq', source_ref: 'contact:5' }, auth);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'crosswalk_forbidden');
  assert.match(r.body.detail, /issue-key missioniq/);
  const b = await post('/api/identity/resolve-batch', { source: 'missioniq', records: [{ first_name: 'Johnny', last_name: 'Smith', source_ref: 'contact:5' }] }, auth);
  assert.equal(b.status, 403);
  assert.equal(count(db, 'persons'), before);

  // A source with no crosswalk links is just a label: allowed as before.
  const fresh = await post('/api/identity/resolve', { record: { first_name: 'Ann', last_name: 'Lee' }, source: 'newapp', source_ref: 'r-1' }, auth);
  assert.equal(fresh.status, 201);
});

// ---------------------------------------------------------------------------
// 6. A possibly misread birthdate is review, never proof and never "different"
// ---------------------------------------------------------------------------

test('names > a day/month swap or a century apart vetoes proof but does not tell the pair apart', () => {
  for (const [da, db] of [['1980-03-04', '1980-04-03'], ['1920-03-04', '2020-03-04']]) {
    const s = strict(
      { given_name: 'Ana', family_name: 'Ruiz', date_of_birth: da, email: 'ana@example.org' },
      { given_name: 'Ana', family_name: 'Ruiz', date_of_birth: db, email: 'ana@example.org' });
    assert.equal(s.definitive, false, `${da}/${db}`);
    assert.ok(s.confidence <= matching.VETO_CAP);
    assert.ok(s.reasons.includes('dob_possible_misreading'));
    assert.ok(!s.reasons.includes('dob_conflict'), 'not proof of two people either');
    const addr = strict(
      { given_name: 'Ana', family_name: 'Ruiz', date_of_birth: da, address_line1: '5 Elm St' },
      { given_name: 'Ana', family_name: 'Ruiz', date_of_birth: db, address_line1: '5 Elm St' });
    assert.equal(addr.definitive, false);
  }
});

test('roster > a namesake with a swapped birthdate on the same email goes to review', t => {
  const ctx = setup(t);
  const headers = ['First Name', 'Last Name', 'Birthdate', 'Email'];
  roster.run(ctx.db, ctx.secrets, ctx.th, { sheets: [{ headers, rows: [['Ana', 'Ruiz', '1980-03-04', 'ana@example.org']] }] }, { mode: 'commit', actor: 'test' });
  const r = roster.run(ctx.db, ctx.secrets, ctx.th, { sheets: [{ headers, rows: [['Ana', 'Ruiz', '1980-04-03', 'ana@example.org']] }] }, { mode: 'plan', actor: 'test' });
  assert.equal(persons(r)[0].action, 'review');
});
