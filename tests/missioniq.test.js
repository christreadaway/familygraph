'use strict';

// Importing MissionIQ's people into Family Graph (owner decision 2026-09-28).
// MissionIQ already holds the parish/school community; every one of them must
// get exactly one lifelong id here before any roster is anonymized. The same
// bar as roster imports: two humans never share an id, one human never gets
// two, and anything uncertain waits for a person.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const ids = require('../server/crypto/identifiers');
const roster = require('../server/identity/roster');
const crosswalk = require('../server/identity/crosswalk');
const missioniq = require('../server/identity/missioniq');
const people = require('../server/identity/people');
const families = require('../server/identity/families');
const contacts = require('../server/identity/contacts');
const { buildApp } = require('../server');
const { newDb, newSecrets, defaultThresholds, cleanup, tmpDir } = require('./_helpers');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets, th: defaultThresholds(), dir };
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// A MissionIQ database with the columns the real one has (families,
// contacts, children, plus the fg_* stamps its sync writes).
function fakeMissionIQ(dir, { families: fams = [], contacts: cons = [], children: kids = [], links = [] }, { minimal = false } = {}) {
  const p = path.join(dir, `missioniq-${crypto.randomBytes(4).toString('hex')}.sqlite`);
  const m = new Database(p);
  if (minimal) {
    // An older MissionIQ: none of the later columns exist yet.
    m.exec(`
      CREATE TABLE families (id TEXT PRIMARY KEY, family_name TEXT, address_line1 TEXT, city TEXT, state TEXT, zip TEXT);
      CREATE TABLE contacts (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT, phone TEXT, family_id TEXT, role TEXT DEFAULT 'parent');
    `);
  } else {
    m.exec(`
      CREATE TABLE families (id TEXT PRIMARY KEY, family_name TEXT, address_line1 TEXT, address_line2 TEXT,
        city TEXT, state TEXT, zip TEXT, deceased INTEGER DEFAULT 0, fg_family_code TEXT,
        created_at TEXT DEFAULT '2026-01-01 00:00:00');
      CREATE TABLE contacts (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT, phone TEXT,
        secondary_email TEXT, secondary_phone TEXT, address_line1 TEXT, address_line2 TEXT, city TEXT, state TEXT,
        zip TEXT, family_id TEXT, role TEXT DEFAULT 'parent', relationship TEXT DEFAULT 'parent', birthday TEXT,
        gender TEXT, do_not_contact INTEGER DEFAULT 0, fg_person_code TEXT,
        created_at TEXT DEFAULT '2026-01-01 00:00:00');
      CREATE TABLE family_links (id INTEGER PRIMARY KEY AUTOINCREMENT, family_id_a TEXT NOT NULL,
        family_id_b TEXT NOT NULL, link_type TEXT NOT NULL DEFAULT 'shared_custody', notes TEXT);
      CREATE TABLE children (id INTEGER PRIMARY KEY AUTOINCREMENT, family_id TEXT NOT NULL, first_name TEXT,
        last_name TEXT, grade TEXT, birthday TEXT, enrolled INTEGER DEFAULT 1);
    `);
  }
  const ins = (table, row) => {
    const cols = Object.keys(row);
    m.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => row[c]));
  };
  if (!minimal && fams.some(f => 'donor_types' in f)) m.exec(`ALTER TABLE families ADD COLUMN donor_types TEXT DEFAULT '[]'`);
  fams.forEach(f => ins('families', f));
  links.forEach(l => ins('family_links', l));
  cons.forEach(c => ins('contacts', c));
  kids.forEach(k => ins('children', k));
  m.close();
  return p;
}

function editMissionIQ(p, sql, ...params) {
  const m = new Database(p);
  m.prepare(sql).run(...params);
  m.close();
}

const noReviews = item => { throw new Error(`unexpected review: ${item.key} ${(item.review_reasons || []).join(',')}`); };

async function importAll(ctx, dbPath, { decide = noReviews, confirm = () => true, ...rest } = {}) {
  return missioniq.runImport({ db: ctx.db, secrets: ctx.secrets, thresholds: ctx.th, dbPath, decide, confirm, actor: 'test', ...rest });
}

const planOnly = (ctx, dbPath, opts = {}) => missioniq.runImport({
  db: ctx.db, secrets: ctx.secrets, thresholds: ctx.th, dbPath, dryRun: true, actor: 'test', decide: noReviews, confirm: () => false, ...opts,
});

const SMITHS = {
  families: [
    { id: 'fam-a', family_name: 'Smith Family', address_line1: '12 Maple St', city: 'Austin', state: 'TX', zip: '78701' },
    { id: 'fam-b', family_name: 'Garcia Family', address_line1: '9 Oak Ave', city: 'Austin', state: 'TX', zip: '78702' },
  ],
  contacts: [
    { id: 'c-1', first_name: 'Jane', last_name: 'Smith', email: 'jane@example.org', family_id: 'fam-a' },
    { id: 'c-2', first_name: 'John', last_name: 'Smith', email: 'john@example.org', family_id: 'fam-a' },
    { id: 'c-3', first_name: 'Maria', last_name: 'Garcia', email: 'maria@example.org', phone: '512-555-0101', family_id: 'fam-b' },
  ],
  children: [
    { family_id: 'fam-a', first_name: 'Emma', last_name: 'Smith', grade: '3', birthday: '2016-04-02' },
    { family_id: 'fam-a', first_name: 'Liam', last_name: 'Smith', grade: '5' },
    { family_id: 'fam-b', first_name: 'Ava', last_name: 'Garcia', grade: 'K' },
  ],
};

// ---------------------------------------------------------------------------
// Crosswalk
// ---------------------------------------------------------------------------

test('crosswalk > link, relink, and lookup through a merge', t => {
  const ctx = setup(t);
  const a = people.create(ctx.db, ctx.secrets, { given_name: 'Ann', family_name: 'Lee' }, { actor: 'test' });
  const b = people.create(ctx.db, ctx.secrets, { given_name: 'Ann', family_name: 'Lee' }, { actor: 'test' });
  assert.equal(crosswalk.link(ctx.db, { source: 'missioniq', ref: 'contact:1', kind: 'person', code: a }), 'created');
  assert.equal(crosswalk.link(ctx.db, { source: 'missioniq', ref: 'contact:1', kind: 'person', code: a }), 'unchanged');
  assert.deepEqual(crosswalk.lookup(ctx.db, 'missioniq', 'contact:1'), { code: a, kind: 'person', status: 'active' });
  assert.equal(crosswalk.lookup(ctx.db, 'other-app', 'contact:1'), null, 'refs are per source');
  assert.equal(crosswalk.lookup(ctx.db, 'missioniq', 'contact:2'), null);

  people.merge(ctx.db, ctx.secrets, a, b, { actor: 'test' });
  assert.equal(crosswalk.lookup(ctx.db, 'missioniq', 'contact:1').code, b, 'a ref follows the merge to the survivor');
  assert.deepEqual(crosswalk.refsFor(ctx.db, 'missioniq', 'person', b), ['contact:1'], 'refs of a merged-away code count for the survivor');
  assert.equal(crosswalk.link(ctx.db, { source: 'missioniq', ref: 'contact:1', kind: 'person', code: b }), 'unchanged');

  const c = people.create(ctx.db, ctx.secrets, { given_name: 'Cy', family_name: 'Lee' }, { actor: 'test' });
  assert.equal(crosswalk.link(ctx.db, { source: 'missioniq', ref: 'contact:1', kind: 'person', code: c }), 'relinked');
  assert.equal(crosswalk.lookup(ctx.db, 'missioniq', 'contact:1').code, c);

  assert.throws(() => crosswalk.link(ctx.db, { source: 'MissionIQ', ref: 'x', kind: 'person', code: c }), /invalid/);
  assert.throws(() => crosswalk.link(ctx.db, { source: 'missioniq', ref: 'has space', kind: 'person', code: c }), /invalid/);
  assert.throws(() => crosswalk.link(ctx.db, { source: 'missioniq', ref: 'x', kind: 'family', code: c }), /not a family code/);
});

// ---------------------------------------------------------------------------
// Reading MissionIQ
// ---------------------------------------------------------------------------

test('missioniq > reads households read-only and leaves out what is not a household member', t => {
  const ctx = setup(t);
  const p = fakeMissionIQ(ctx.dir, {
    families: [
      { id: 'fam-a', family_name: 'Smith Family', address_line1: '12 Maple St', city: 'Austin', state: 'TX', zip: '78701',
        fg_family_code: 'f_0123456789abcdef' },
      { id: 'fam-u', family_name: 'Unmatched Donations' },
      { id: 'fam-d', family_name: 'Old Family', deceased: 1 },
      { id: 'fam-e', family_name: 'Empty Family' },
    ],
    contacts: [
      { id: 'c-1', first_name: 'Jane', last_name: 'Smith', email: 'jane@example.org', secondary_email: 'js@example.org',
        family_id: 'fam-a', relationship: 'stepparent', fg_person_code: 'p_0123456789abcdef', do_not_contact: 1 },
      { id: 'c-2', first_name: 'Rose', last_name: 'Smith', family_id: 'fam-a', role: 'parent', relationship: 'grandparent' },
      { id: 'c-8', first_name: 'Gus', last_name: 'Smith', family_id: 'fam-a', role: 'aunt_uncle', relationship: 'parent' },
      { id: 'c-3', first_name: 'Bob', last_name: 'Neighbor', family_id: 'fam-a', relationship: 'emergency_contact' },
      { id: 'c-4', first_name: 'Dee', last_name: 'Donor', family_id: 'fam-u' },
      { id: 'c-5', first_name: 'Old', last_name: 'Timer', family_id: 'fam-d' },
      { id: 'c-6', first_name: 'Lone', last_name: 'Wolf', family_id: 'fam-gone' },
      { id: 'c-7', first_name: 'Bad', last_name: 'Stamp', family_id: 'fam-a', fg_person_code: 'f_0123456789abcdef' },
    ],
    children: [
      { family_id: 'fam-a', first_name: 'Emma', last_name: 'Smith', grade: '3', birthday: '2016-04-02' },
      { family_id: 'fam-a', first_name: 'Liam', last_name: 'Smith', grade: '12', enrolled: 0 },
    ],
  });
  const before = sha(p);
  const { households, stats } = missioniq.readMissionIQ(p);
  assert.equal(sha(p), before, 'the MissionIQ file is never written');

  assert.equal(households.length, 2, 'Smith household + the contact whose household is missing');
  const smith = households[0];
  assert.equal(smith.ref, 'family:fam-a');
  assert.equal(smith.code_hint, 'f_0123456789abcdef');
  assert.equal(smith.display_name, 'Smith Family');
  assert.equal(smith.address.line1, '12 Maple St');
  assert.deepEqual(smith.persons.map(x => [x.ref, x.role]), [
    ['contact:c-1', 'parent'], ['contact:c-2', 'grandparent'], ['contact:c-7', 'parent'],
    ['contact:c-8', 'other_adult'],
    ['child:1', 'child'], ['child:2', 'child'],
  ]);
  const jane = smith.persons[0];
  assert.deepEqual(jane.emails, ['jane@example.org', 'js@example.org']);
  assert.equal(jane.code_hint, 'p_0123456789abcdef');
  assert.equal(jane.do_not_contact, true);
  assert.equal(smith.persons[2].code_hint, null, 'a family code stored on a contact is not a person hint');
  assert.equal(smith.persons.find(x => x.ref === 'child:1').date_of_birth, '2016-04-02');
  assert.equal(households[1].ref, undefined);
  assert.equal(households[1].persons[0].ref, 'contact:c-6');

  assert.equal(stats.families, 1);
  assert.equal(stats.contacts, 5);
  assert.equal(stats.children, 2);
  assert.equal(stats.children_not_enrolled, 1);
  assert.equal(stats.do_not_contact, 1);
  assert.equal(stats.skipped_pseudo_families, 1);
  assert.equal(stats.skipped_pseudo_family_contacts, 1);
  assert.equal(stats.skipped_deceased_families, 1);
  assert.equal(stats.skipped_empty_families, 1);
  assert.equal(stats.skipped_emergency_contacts, 1);
  assert.equal(stats.contacts_without_family, 1);
  assert.equal(stats.prior_person_codes, 1);
  assert.equal(stats.prior_family_codes, 1);

  const withDeceased = missioniq.readMissionIQ(p, { includeDeceased: true });
  assert.equal(withDeceased.households.length, 3);
  assert.equal(withDeceased.stats.skipped_deceased_families, 0);
});

test('missioniq > an older MissionIQ without the later columns still reads', t => {
  const ctx = setup(t);
  const p = fakeMissionIQ(ctx.dir, {
    families: [{ id: 'fam-a', family_name: 'Smith Family' }],
    contacts: [{ id: 'c-1', first_name: 'Jane', last_name: 'Smith', family_id: 'fam-a' }],
  }, { minimal: true });
  const { households, stats } = missioniq.readMissionIQ(p);
  assert.equal(households.length, 1);
  assert.equal(stats.children, 0);
  assert.equal(households[0].persons[0].role, 'parent');
});

test('missioniq > refuses a file that is not MissionIQ, or is missing', t => {
  const ctx = setup(t);
  const other = path.join(ctx.dir, 'other.sqlite');
  const m = new Database(other);
  m.exec('CREATE TABLE things (id INTEGER)');
  m.close();
  assert.throws(() => missioniq.readMissionIQ(other), /not a MissionIQ database/);
  assert.throws(() => missioniq.readMissionIQ(path.join(ctx.dir, 'nope.sqlite')), /cannot open MissionIQ database/);
  assert.ok(!fs.existsSync(path.join(ctx.dir, 'nope.sqlite')), 'a missing file is not created');
});

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

test('missioniq > fresh import gives every person and household one id; a re-run changes nothing', async t => {
  const ctx = setup(t);
  const p = fakeMissionIQ(ctx.dir, SMITHS);
  const r = await importAll(ctx, p, { category: 'school' });
  assert.equal(r.status, 'committed');
  assert.equal(r.result.summary.persons.new, 6);
  assert.equal(r.result.summary.families.new, 2);
  assert.deepEqual(r.crosswalk, { person: 6, family: 2 });
  assert.equal(count(ctx.db, 'persons'), 6);
  assert.equal(count(ctx.db, 'families'), 2);
  assert.deepEqual(r.stale, []);

  const rows = r.result.sheets[0].rows;
  const all = rows.flatMap(row => row.persons);
  for (const person of all) {
    assert.match(person.community_id, /^I[0-9A-F]{16}$/, `${person.given_name} has an id`);
    assert.equal(crosswalk.lookup(ctx.db, 'missioniq', person.ref).code, ids.fromCommunityId(person.community_id));
  }
  assert.equal(new Set(all.map(x => x.community_id)).size, 6, 'six people, six ids');
  for (const row of rows) assert.match(row.family.community_id, /^F[0-9A-F]{16}$/);
  const emma = all.find(x => x.given_name === 'Emma');
  const emmaRec = people.get(ctx.db, ctx.secrets, ids.fromCommunityId(emma.community_id), { includePii: true });
  assert.equal(emmaRec.grade, '3');
  assert.equal(emmaRec.date_of_birth, '2016-04-02');

  // Second run: everything is recognized by its MissionIQ id.
  const again = await importAll(ctx, p);
  assert.equal(again.status, 'committed');
  const s = again.result.summary;
  assert.deepEqual(s.persons, { matched: 6, new: 0, review: 0, skipped: 0 });
  assert.deepEqual(s.families, { matched: 2, new: 0, review: 0 });
  assert.deepEqual(s.crosswalk, { created: 0, unchanged: 8, relinked: 0 });
  assert.equal(count(ctx.db, 'persons'), 6);
  assert.equal(count(ctx.db, 'families'), 2);
  const again2 = again.result.sheets[0].rows.flatMap(row => row.persons);
  assert.deepEqual(again2.map(x => x.community_id), all.map(x => x.community_id), 'identical ids');
  assert.ok(again2.every(x => x.matched && x.matched.via === 'linked'));
});

test('missioniq > people already in Family Graph keep their id, found by strict matching', async t => {
  const ctx = setup(t);
  const jane = people.create(ctx.db, ctx.secrets, { given_name: 'Jane', family_name: 'Smith' }, { actor: 'test' });
  contacts.attachEmailToPerson(ctx.db, jane, contacts.upsertEmail(ctx.db, ctx.secrets, 'jane@example.org'), { isPrimary: true });
  const fam = families.create(ctx.db, ctx.secrets, { display_name: 'Smith Family' }, { actor: 'test' });
  families.addMember(ctx.db, ctx.secrets, fam, jane, { role: 'parent' });

  const p = fakeMissionIQ(ctx.dir, SMITHS);
  const r = await importAll(ctx, p);
  const rows = r.result.sheets[0].rows;
  const janeOut = rows[0].persons.find(x => x.given_name === 'Jane');
  assert.equal(janeOut.action, 'matched');
  assert.equal(janeOut.community_id, ids.toCommunityId(jane));
  assert.equal(rows[0].family.community_id, ids.toCommunityId(fam), 'the Smiths join their existing household');
  assert.equal(r.result.summary.persons.new, 5);
});

test('missioniq > a stored id from an old sync that fused two spouses is caught', async t => {
  const ctx = setup(t);
  // MissionIQ's loose sync put John and Mary on one Family Graph person.
  const john = people.create(ctx.db, ctx.secrets, { given_name: 'John', family_name: 'Smith' }, { actor: 'test' });
  const fam = families.create(ctx.db, ctx.secrets, { display_name: 'Smith Family' }, { actor: 'test' });
  families.addMember(ctx.db, ctx.secrets, fam, john, { role: 'parent' });
  const p = fakeMissionIQ(ctx.dir, {
    families: [{ id: 'fam-a', family_name: 'Smith Family', fg_family_code: fam }],
    contacts: [
      { id: 'c-john', first_name: 'John', last_name: 'Smith', email: 'smiths@example.org', family_id: 'fam-a', fg_person_code: john },
      { id: 'c-mary', first_name: 'Mary', last_name: 'Smith', email: 'smiths@example.org', family_id: 'fam-a', fg_person_code: john },
    ],
  });

  const plan = await planOnly(ctx, p);
  const [johnOut, maryOut] = plan.plan.sheets[0].rows[0].persons;
  assert.equal(johnOut.action, 'matched');
  assert.equal(johnOut.matched.via, 'prior_link');
  assert.equal(maryOut.action, 'review');
  assert.ok(maryOut.review_reasons.includes('prior_link_used_twice'));
  assert.equal(maryOut.candidates[0].community_id, ids.toCommunityId(john), 'the operator sees who the stored id belongs to');

  const seen = [];
  const r = await importAll(ctx, p, { decide: item => { seen.push(item); return { action: 'create' }; } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].given_name, 'Mary');
  assert.equal(r.status, 'committed');
  const out = r.result.sheets[0].rows[0];
  assert.equal(out.persons[0].community_id, ids.toCommunityId(john));
  assert.notEqual(out.persons[1].community_id, ids.toCommunityId(john), 'Mary gets her own id');
  assert.equal(out.family.community_id, ids.toCommunityId(fam));
  assert.deepEqual(r.stale.map(x => [x.kind, x.missioniq_ref, x.stored, x.correct]), [
    ['person', 'contact:c-mary', ids.toCommunityId(john), out.persons[1].community_id],
  ]);
  const members = families.members(ctx.db, ctx.secrets, fam).map(m => m.person_code).sort();
  assert.deepEqual(members, [john, ids.fromCommunityId(out.persons[1].community_id)].sort());
  // Recorded as two different people, so no later import re-asks.
  const rejected = ctx.db.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE status = 'rejected' AND kind = 'person'").get().n;
  assert.equal(rejected, 1);
});

test('missioniq > a stored id that belongs to someone else goes to a person', async t => {
  const ctx = setup(t);
  const karen = people.create(ctx.db, ctx.secrets, { given_name: 'Karen', family_name: 'Jones' }, { actor: 'test' });
  const p = fakeMissionIQ(ctx.dir, {
    families: [{ id: 'fam-b', family_name: 'Brown Family' }],
    contacts: [{ id: 'c-9', first_name: 'Mary', last_name: 'Brown', family_id: 'fam-b', fg_person_code: karen }],
  });
  const seen = [];
  const r = await importAll(ctx, p, { decide: item => { seen.push(item); return { action: 'create' }; } });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].review_reasons.includes('prior_link_disagrees'));
  assert.equal(seen[0].candidates[0].community_id, ids.toCommunityId(karen));
  const mary = r.result.sheets[0].rows[0].persons[0];
  assert.notEqual(mary.community_id, ids.toCommunityId(karen));
  assert.equal(r.stale.length, 1);
  assert.equal(people.get(ctx.db, ctx.secrets, karen, { includePii: true }).given_name, 'Karen', 'Karen is untouched');
});

test('missioniq > a stored household id nobody in the household confirms goes to a person', async t => {
  const ctx = setup(t);
  const doe = people.create(ctx.db, ctx.secrets, { given_name: 'Dana', family_name: 'Doe' }, { actor: 'test' });
  const doeFam = families.create(ctx.db, ctx.secrets, { display_name: 'Doe Family' }, { actor: 'test' });
  families.addMember(ctx.db, ctx.secrets, doeFam, doe, { role: 'parent' });
  const p = fakeMissionIQ(ctx.dir, {
    families: [{ id: 'fam-c', family_name: 'Clark Family', fg_family_code: doeFam }],
    contacts: [{ id: 'c-1', first_name: 'Chris', last_name: 'Clark', family_id: 'fam-c' }],
  });
  const seen = [];
  const r = await importAll(ctx, p, { decide: item => { seen.push(item); return { action: 'create' }; } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'family');
  assert.ok(seen[0].review_reasons.includes('prior_link_unconfirmed'));
  assert.equal(seen[0].candidates[0].community_id, ids.toCommunityId(doeFam));
  assert.deepEqual(seen[0].candidates[0].members.map(m => m.name), ['Dana Doe'], 'the operator sees who lives there');
  assert.notEqual(r.result.sheets[0].rows[0].family.community_id, ids.toCommunityId(doeFam));
  assert.equal(families.members(ctx.db, ctx.secrets, doeFam).length, 1, 'the Clarks were not put into the Doe household');
  assert.equal(r.stale.filter(x => x.kind === 'family').length, 1);
});

test('missioniq > one child in two households (divorced parents) is confirmed once, then remembered', async t => {
  const ctx = setup(t);
  const p = fakeMissionIQ(ctx.dir, {
    families: [{ id: 'fam-a', family_name: 'Lee Family' }, { id: 'fam-b', family_name: 'Lee Family' }],
    contacts: [
      { id: 'c-ann', first_name: 'Ann', last_name: 'Lee', family_id: 'fam-a' },
      { id: 'c-tom', first_name: 'Tom', last_name: 'Lee', family_id: 'fam-b' },
    ],
    children: [
      { family_id: 'fam-a', first_name: 'Emma', last_name: 'Lee', birthday: '2015-01-02' },
      { family_id: 'fam-b', first_name: 'Emma', last_name: 'Lee', birthday: '2015-01-02' },
    ],
  });
  const seen = [];
  const r = await importAll(ctx, p, {
    decide: item => {
      seen.push(item);
      if (item.kind === 'person') return missioniq.parseAnswer(item, '1');
      return missioniq.parseAnswer(item, 'n');
    },
  });
  assert.deepEqual(seen.map(x => [x.kind, x.review_reasons[0]]), [
    ['person', 'same_person_as_another_record'],
    ['family', 'new_adult_with_known_children'],
  ]);
  assert.equal(seen[0].candidates[0].community_id, null, 'Emma was new in this same import');
  assert.equal(seen[0].candidates[0].sheet_ref, '0:0:1');
  assert.equal(r.status, 'committed');
  const [a, b] = r.result.sheets[0].rows;
  assert.equal(a.persons[1].community_id, b.persons[1].community_id, 'one Emma, one id');
  assert.notEqual(a.family.community_id, b.family.community_id, 'two households');
  assert.equal(crosswalk.lookup(ctx.db, 'missioniq', 'child:1').code, crosswalk.lookup(ctx.db, 'missioniq', 'child:2').code);
  assert.equal(count(ctx.db, 'persons'), 3);

  const again = await importAll(ctx, p);
  assert.equal(again.status, 'committed');
  assert.deepEqual(again.result.summary.persons, { matched: 4, new: 0, review: 0, skipped: 0 });
  assert.deepEqual(again.result.summary.families, { matched: 2, new: 0, review: 0 });
});

test('missioniq > a duplicate contact matching someone already imported is confirmed by a person', async t => {
  const ctx = setup(t);
  const p = fakeMissionIQ(ctx.dir, {
    families: [{ id: 'fam-a', family_name: 'Smith Family' }],
    contacts: [{ id: 'c-1', first_name: 'Jane', last_name: 'Smith', email: 'jane@example.org', family_id: 'fam-a' }],
  });
  await importAll(ctx, p);
  // Someone enters Jane again, under a new household, in MissionIQ.
  editMissionIQ(p, "INSERT INTO families (id, family_name) VALUES ('fam-z', 'Smith Family')");
  editMissionIQ(p, "INSERT INTO contacts (id, first_name, last_name, email, family_id) VALUES ('c-2', 'Jane', 'Smith', 'jane@example.org', 'fam-z')");
  const seen = [];
  const r = await importAll(ctx, p, { decide: item => { seen.push(item); return missioniq.parseAnswer(item, '1'); } });
  assert.deepEqual(seen.map(x => x.review_reasons[0]), ['same_person_as_another_record', 'same_household_as_another_record']);
  assert.equal(r.status, 'committed');
  assert.equal(crosswalk.lookup(ctx.db, 'missioniq', 'contact:2'), null);
  assert.equal(crosswalk.lookup(ctx.db, 'missioniq', 'contact:c-2').code, crosswalk.lookup(ctx.db, 'missioniq', 'contact:c-1').code);
  assert.equal(count(ctx.db, 'persons'), 1);
});

test('missioniq > an imported record that turns into someone else is not silently kept', async t => {
  const ctx = setup(t);
  const p = fakeMissionIQ(ctx.dir, SMITHS);
  await importAll(ctx, p);
  const janeCode = crosswalk.lookup(ctx.db, 'missioniq', 'contact:c-1').code;

  // A harmless edit (new email, a nickname-table entry) keeps the link.
  // (Changed 2026-09-28: this edit was Jane -> Janie, which the matcher
  // scores only as a phonetic match - the same band as Mark -> Mary - so a
  // renamed linked record like that now goes to a person.)
  const johnCode = crosswalk.lookup(ctx.db, 'missioniq', 'contact:c-2').code;
  editMissionIQ(p, "UPDATE contacts SET email = 'jane.new@example.org' WHERE id = 'c-1'");
  editMissionIQ(p, "UPDATE contacts SET first_name = 'Johnny' WHERE id = 'c-2'");
  const ok = await planOnly(ctx, p);
  assert.equal(ok.plan.pending.length, 0);
  assert.equal(ok.plan.sheets[0].rows[0].persons[0].community_id, ids.toCommunityId(janeCode));
  assert.equal(ok.plan.sheets[0].rows[0].persons[1].community_id, ids.toCommunityId(johnCode));

  // The record was reused for a different human.
  editMissionIQ(p, "UPDATE contacts SET first_name = 'Robert', birthday = '1970-05-05' WHERE id = 'c-1'");
  const changed = await planOnly(ctx, p);
  assert.deepEqual(changed.plan.pending, ['0:0:0']);
  const out = changed.plan.sheets[0].rows[0].persons[0];
  assert.ok(out.review_reasons.includes('linked_record_changed'));
  assert.equal(out.candidates[0].community_id, ids.toCommunityId(janeCode));
});

test('missioniq > deceased households stay out unless asked; do-not-contact carries over', async t => {
  const ctx = setup(t);
  const p = fakeMissionIQ(ctx.dir, {
    families: [{ id: 'fam-a', family_name: 'Smith Family' }, { id: 'fam-d', family_name: 'Old Family', deceased: 1 }],
    contacts: [
      { id: 'c-1', first_name: 'Jane', last_name: 'Smith', family_id: 'fam-a', do_not_contact: 1 },
      { id: 'c-2', first_name: 'Olive', last_name: 'Old', family_id: 'fam-d' },
    ],
  });
  const r = await importAll(ctx, p);
  assert.equal(r.stats.skipped_deceased_families, 1);
  assert.equal(count(ctx.db, 'persons'), 1);
  const jane = people.get(ctx.db, ctx.secrets, crosswalk.lookup(ctx.db, 'missioniq', 'contact:c-1').code);
  assert.equal(jane.do_not_contact, true);

  const withDeceased = await importAll(ctx, p, { includeDeceased: true });
  assert.equal(withDeceased.result.summary.persons.new, 1);
  assert.equal(count(ctx.db, 'persons'), 2);
});

test('missioniq > quitting, or not confirming, writes nothing', async t => {
  const ctx = setup(t);
  const karen = people.create(ctx.db, ctx.secrets, { given_name: 'Karen', family_name: 'Jones' }, { actor: 'test' });
  const p = fakeMissionIQ(ctx.dir, {
    families: [{ id: 'fam-b', family_name: 'Brown Family' }],
    contacts: [{ id: 'c-9', first_name: 'Mary', last_name: 'Brown', family_id: 'fam-b', fg_person_code: karen }],
  });
  const quit = await importAll(ctx, p, { decide: () => 'quit' });
  assert.equal(quit.status, 'aborted');
  const declined = await importAll(ctx, p, { decide: () => ({ action: 'create' }), confirm: () => false });
  assert.equal(declined.status, 'aborted');
  assert.equal(count(ctx.db, 'persons'), 1);
  assert.equal(count(ctx.db, 'external_refs'), 0);
  assert.equal(count(ctx.db, 'import_runs'), 0);
});

test('missioniq > review items read plainly and answers parse strictly', () => {
  const person = {
    kind: 'person', key: '0:3:1', given_name: 'Mary', family_name: 'Smith', role: 'parent', household: 'Smith Family',
    prior_community_id: 'I0123456789ABCDEF', review_reasons: ['prior_link_used_twice'],
    candidates: [{ community_id: 'I0123456789ABCDEF', given_name: 'John', family_name: 'Smith', role: 'adult', family: { display_name: 'Smith Family' } },
      { community_id: null, sheet_ref: '0:1:0', given_name: 'Mary', family_name: 'Smith' }],
  };
  const text = missioniq.describeItem(person, { index: 0, total: 2 }).join('\n');
  assert.match(text, /\[1\/2\] PERSON  Mary Smith/);
  assert.match(text, /two people in this household carry the same stored id/);
  assert.match(text, /1\) same person as I0123456789ABCDEF  John Smith/);
  assert.match(text, /2\) same person as \(new in this import\)  Mary Smith/);
  assert.deepEqual(missioniq.parseAnswer(person, '1'), { action: 'attach', target: 'I0123456789ABCDEF' });
  assert.deepEqual(missioniq.parseAnswer(person, ' 2 '), { action: 'attach', target: '0:1:0' });
  assert.deepEqual(missioniq.parseAnswer(person, 'N'), { action: 'create' });
  assert.deepEqual(missioniq.parseAnswer(person, 's'), { action: 'skip' });
  assert.equal(missioniq.parseAnswer(person, 'q'), 'quit');
  for (const bad of ['3', '0', '', 'yes', '1x', null]) assert.equal(missioniq.parseAnswer(person, bad), null, String(bad));
  const fam = { kind: 'family', key: '0:3:family', display_name: 'Smith Family', members: ['Mary Smith'], review_reasons: [], candidates: [] };
  assert.equal(missioniq.parseAnswer(fam, 's'), null, 'a household cannot be skipped');
  assert.match(missioniq.describeItem(fam).join('\n'), /HOUSEHOLD  Smith Family  members: Mary Smith/);
});

// ---------------------------------------------------------------------------
// Households input and same-row twins (roster engine)
// ---------------------------------------------------------------------------

test('roster > households input is validated', t => {
  const ctx = setup(t);
  const run = body => roster.run(ctx.db, ctx.secrets, ctx.th, body, { mode: 'plan', actor: 'test' });
  const hh = [{ persons: [{ given_name: 'Ann', family_name: 'Lee', role: 'parent' }] }];
  assert.throws(() => run({ households: hh, sheets: [] }), /sheets or households, not both/);
  assert.throws(() => run({ households: 'x' }), /households must be an array/);
  assert.throws(() => run({ households: [{ persons: [{ given_name: 'A', ref: 'has space' }] }] }), /short id without spaces/);
  assert.throws(() => run({ households: [{}] }), /persons array required/);
  assert.throws(() => run({ households: hh, source: 'Mission IQ' }), /source must be/);
  const ok = run({ households: hh, source: 'missioniq' });
  assert.equal(ok.summary.persons.new, 1);
  assert.equal(count(ctx.db, 'persons'), 0, 'plan writes nothing');
});

test('roster > the same name twice on one row goes to a person; attaching to the twin is allowed', t => {
  const ctx = setup(t);
  const sheet = {
    headers: ['Parent 1 First Name', 'Parent 1 Last Name', 'Parent 2 First Name', 'Parent 2 Last Name', 'Student First Name'],
    rows: [['John', 'Smith', 'John', 'Smith', 'Max']],
  };
  const body = { sheets: [sheet] };
  const plan = roster.run(ctx.db, ctx.secrets, ctx.th, body, { mode: 'plan', actor: 'test' });
  assert.deepEqual(plan.pending, ['0:0:1']);
  const twin = plan.sheets[0].rows[0].persons[1];
  assert.ok(twin.review_reasons.includes('same_name_twice_in_household'));
  assert.equal(twin.candidates[0].sheet_ref, '0:0:0');

  const same = roster.run(ctx.db, ctx.secrets, ctx.th,
    { ...body, decisions: { '0:0:1': { action: 'attach', target: '0:0:0' } } }, { mode: 'commit', actor: 'test' });
  assert.equal(same.committed, true);
  const [p0, p1] = same.sheets[0].rows[0].persons;
  assert.equal(p0.community_id, p1.community_id, 'one person entered twice');
  assert.equal(count(ctx.db, 'persons'), 2);

  // A different pair (father and son) on a fresh registry.
  const ctx2 = setup(t);
  const diff = roster.run(ctx2.db, ctx2.secrets, ctx2.th,
    { ...body, decisions: { '0:0:1': { action: 'create' } } }, { mode: 'commit', actor: 'test' });
  const [q0, q1] = diff.sheets[0].rows[0].persons;
  assert.notEqual(q0.community_id, q1.community_id);
  assert.equal(count(ctx2.db, 'persons'), 3);

  // Different birthdates tell them apart: no question.
  const ctx3 = setup(t);
  const dated = roster.run(ctx3.db, ctx3.secrets, ctx3.th, { households: [{ persons: [
    { given_name: 'John', family_name: 'Smith', date_of_birth: '1950-01-01', role: 'parent' },
    { given_name: 'John', family_name: 'Smith', date_of_birth: '1980-01-01', role: 'parent' },
  ] }] }, { mode: 'plan', actor: 'test' });
  assert.deepEqual(dated.pending, []);
  const undated = roster.run(ctx3.db, ctx3.secrets, ctx3.th, { households: [{ persons: [
    { given_name: 'John', family_name: 'Smith', role: 'parent' },
    { given_name: 'John', family_name: 'Smith', role: 'parent' },
  ] }] }, { mode: 'plan', actor: 'test' });
  assert.deepEqual(undated.pending, ['0:0:1']);
});

// ---------------------------------------------------------------------------
// /api/identity/resolve reads the crosswalk
// ---------------------------------------------------------------------------

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

test('identity api > resolve returns the imported person for a MissionIQ record, and never writes the crosswalk', async t => {
  const ctx = setup(t);
  const app = buildApp({ db: ctx.db, secrets: ctx.secrets, thresholds: ctx.th });
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  t.after(() => new Promise(res => server.close(res)));
  const port = server.address().port;
  const headers = { authorization: `Bearer ${ctx.secrets.master}`, 'x-family-graph-actor': 'missioniq' };

  const p = fakeMissionIQ(ctx.dir, SMITHS);
  await importAll(ctx, p);
  const jane = crosswalk.lookup(ctx.db, 'missioniq', 'contact:c-1').code;
  const john = crosswalk.lookup(ctx.db, 'missioniq', 'contact:c-2').code;
  const refsBefore = count(ctx.db, 'external_refs');
  const personsBefore = count(ctx.db, 'persons');

  // MissionIQ's "Sync now" for John, even with a shared family email that
  // the loose resolver would pin on Jane.
  const one = await request(port, {
    method: 'POST', path: '/api/identity/resolve', headers,
    body: { record: { first_name: 'John', last_name: 'Smith', email: 'jane@example.org' }, source: 'missioniq', source_ref: 'contact:c-2', with_family: true },
  });
  assert.equal(one.status, 201);
  assert.equal(one.body.code, john);
  assert.equal(one.body.action, 'attached');
  assert.equal(one.body.via, 'crosswalk');
  assert.ok(one.body.family && one.body.family.code);

  const batch = await request(port, {
    method: 'POST', path: '/api/identity/resolve-batch', headers,
    body: {
      source: 'missioniq', source_ref: 'contact:c-1', with_family: true,
      records: [
        { first_name: 'Jane', last_name: 'Smith', source_ref: 'contact:c-1' },
        { first_name: 'Maria', last_name: 'Garcia', source_ref: 'contact:c-3' },
        { first_name: 'Newly', last_name: 'Added', source_ref: 'contact:c-99' },
      ],
    },
  });
  assert.equal(batch.status, 201);
  assert.equal(batch.body.results[0].code, jane);
  assert.equal(batch.body.results[0].via, 'crosswalk');
  assert.equal(batch.body.results[1].code, crosswalk.lookup(ctx.db, 'missioniq', 'contact:c-3').code);
  assert.equal(batch.body.results[2].via, undefined, 'an unlinked record goes through the resolver');
  assert.equal(batch.body.results[2].action, 'created');
  assert.equal(batch.body.totals.attached, 2);
  assert.equal(count(ctx.db, 'external_refs'), refsBefore, '/resolve never writes a link');
  assert.equal(count(ctx.db, 'persons'), personsBefore + 1);

  // Another app's ref with the same text is not MissionIQ's record.
  const other = await request(port, {
    method: 'POST', path: '/api/identity/resolve', headers,
    body: { record: { first_name: 'Zed', last_name: 'Zulu' }, source: 'other-app', source_ref: 'contact:c-2' },
  });
  assert.notEqual(other.body.code, john);

  const health = await request(port, { path: '/api/health' });
  assert.equal(health.body.capabilities.identity_crosswalk, true);
  assert.equal(health.body.capabilities.community_ids, true);
});

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

function runCli(home, args, input) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, FAMILY_GRAPH_HOME: home };
    delete env.FAMILY_GRAPH_DB;
    delete env.FAMILY_GRAPH_SECRET;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'family-graph.js'), ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('cli > import-missioniq asks, writes only on YES, and is safe to re-run', async t => {
  const home = tmpDir();
  t.after(() => cleanup(home));
  const mdir = tmpDir();
  t.after(() => cleanup(mdir));
  const p = fakeMissionIQ(mdir, {
    ...SMITHS,
    contacts: [...SMITHS.contacts,
      { id: 'c-4', first_name: 'John', last_name: 'Smith', family_id: 'fam-a' }],
  });

  const dry = await runCli(home, ['import-missioniq', p, '--dry-run'], '');
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /MissionIQ: 2 households, 4 adults, 3 students/);
  assert.match(dry.stdout, /Dry run: nothing written\. 1 items would need your decision\./);

  const quit = await runCli(home, ['import-missioniq', p], 'q\n');
  assert.equal(quit.code, 0, quit.stderr);
  assert.match(quit.stdout, /the same name appears twice in this household/);
  assert.match(quit.stdout, /Stopped\. Nothing was written\./);

  // Bad answers are asked again; "n" = a different John; then YES.
  const run = await runCli(home, ['import-missioniq', p, '--category', 'school'], 'maybe\n9\nn\nYES\n');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /type a number from the list, n, s, or q/);
  assert.match(run.stdout, /Done\. Written to Family Graph:/);
  assert.match(run.stdout, /MissionIQ records linked: 7 people, 2 households/);

  const again = await runCli(home, ['import-missioniq', p], 'YES\n');
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /people: {5}7 already in Family Graph, 0 new, 0 need you/);

  const eof = await runCli(home, ['import-missioniq', p], '');
  assert.match(eof.stdout, /Stopped\. Nothing was written\./, 'end of input is never a YES');

  const bad = await runCli(home, ['import-missioniq'], '');
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /usage: family-graph import-missioniq/);
  const badCat = await runCli(home, ['import-missioniq', p, '--category', 'parish'], '');
  assert.equal(badCat.code, 2);

  // Logs carry counts, never names or contact details.
  const logDir = path.join(home, 'logs');
  const logs = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).map(f => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n')
    : '';
  for (const secret of ['Jane', 'Garcia', 'jane@example.org', '512-555-0101', 'Maple']) {
    assert.ok(!logs.includes(secret), `logs must not contain ${secret}`);
  }
});

test('missioniq > donor_types become family tags and extended_family links become grandparent_of; re-run is idempotent', async t => {
  const ctx = setup(t);
  const data = {
    families: [
      { id: 'fam-g', family_name: 'Elder Family', address_line1: '1 Elm St', city: 'Austin', state: 'TX', zip: '78703', donor_types: '["grandparent","alumni"]' },
      { id: 'fam-k', family_name: 'Young Family', address_line1: '2 Pine St', city: 'Austin', state: 'TX', zip: '78704', donor_types: '[]' },
      { id: 'fam-x', family_name: 'Other Family', address_line1: '3 Ash St', city: 'Austin', state: 'TX', zip: '78705', donor_types: 'not json' },
    ],
    contacts: [
      { id: 'c-g', first_name: 'Ruth', last_name: 'Elder', email: 'ruth@example.org', family_id: 'fam-g' },
      { id: 'c-k', first_name: 'Paul', last_name: 'Young', email: 'paul@example.org', family_id: 'fam-k' },
      { id: 'c-x', first_name: 'Ann', last_name: 'Other', email: 'ann@example.org', family_id: 'fam-x' },
    ],
    links: [
      // The grandparent family is on the b side here: direction comes from donor_types.
      { family_id_a: 'fam-k', family_id_b: 'fam-g', link_type: 'extended_family' },
      // Neither side is a grandparent: direction unknown, skipped and counted.
      { family_id_a: 'fam-k', family_id_b: 'fam-x', link_type: 'extended_family' },
      // Other link types are not read.
      { family_id_a: 'fam-g', family_id_b: 'fam-x', link_type: 'shared_custody' },
    ],
  };
  const p = fakeMissionIQ(ctx.dir, data);
  const r = await importAll(ctx, p);
  assert.equal(r.status, 'committed');
  assert.equal(r.stats.grandparent_families, 1);
  assert.equal(r.stats.alumni_families, 1);
  assert.equal(r.stats.extended_family_links, 2);
  assert.equal(r.stats.extended_family_links_undirected, 1);
  assert.equal(r.extras.tags_grandparent, 1);
  assert.equal(r.extras.tags_school_alumni, 1);
  assert.equal(r.extras.grandparent_links_created, 1);
  const g = crosswalk.lookup(ctx.db, 'missioniq', 'family:fam-g').code;
  const k = crosswalk.lookup(ctx.db, 'missioniq', 'family:fam-k').code;
  const x = crosswalk.lookup(ctx.db, 'missioniq', 'family:fam-x').code;
  const tags = require('../server/identity/tags');
  assert.deepEqual(tags.getFamilyTags(ctx.db, g), ['grandparent', 'school-alumni']);
  assert.deepEqual(tags.getFamilyTags(ctx.db, k), []);
  assert.deepEqual(tags.getFamilyTags(ctx.db, x), []);
  const rels = () => ctx.db.prepare('SELECT from_code, to_code, kind FROM relationships ORDER BY kind').all();
  assert.deepEqual(rels(), [
    { from_code: k, to_code: g, kind: 'grandchild_of' },
    { from_code: g, to_code: k, kind: 'grandparent_of' },
  ]);

  const again = await importAll(ctx, p);
  assert.equal(again.status, 'committed');
  assert.equal(again.extras.grandparent_links_created, 0);
  assert.equal(again.extras.grandparent_links_existing, 1);
  assert.equal(rels().length, 2);
  assert.deepEqual(tags.getFamilyTags(ctx.db, g), ['grandparent', 'school-alumni']);
});

test('missioniq > a MissionIQ without donor_types or family_links still imports', async t => {
  const ctx = setup(t);
  const p = fakeMissionIQ(ctx.dir, SMITHS);
  const m = new Database(p); m.exec('DROP TABLE family_links'); m.close();
  const r = await importAll(ctx, p);
  assert.equal(r.status, 'committed');
  assert.equal(r.stats.extended_family_links, 0);
  assert.deepEqual(r.extras, {
    tags_grandparent: 0, tags_school_alumni: 0, tag_families_unlinked: 0,
    grandparent_links_created: 0, grandparent_links_existing: 0, grandparent_links_unlinked: 0,
  });
});
