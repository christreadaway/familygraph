'use strict';

// Roster imports that issue community identifiers (I… individual, F… family).
// The bar is "no mistakes": two humans must never share an id, one human must
// never get two, and anything uncertain waits for a person to decide.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const ids = require('../server/crypto/identifiers');
const roster = require('../server/identity/roster');
const people = require('../server/identity/people');
const families = require('../server/identity/families');
const contacts = require('../server/identity/contacts');
const resolver = require('../server/identity/resolver');
const importPipeline = require('../server/identity/import');
const matching = require('../server/identity/matching');
const { applyMapping, splitNameList } = require('../server/sources/normalize');
const csv = require('../server/sources/csv');
const apiKeys = require('../server/auth/api-keys');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets, th: defaultThresholds() };
}

const plan = (ctx, body) => roster.run(ctx.db, ctx.secrets, ctx.th, body, { mode: 'plan', actor: 'test' });
const commit = (ctx, body) => roster.run(ctx.db, ctx.secrets, ctx.th, body, { mode: 'commit', actor: 'test' });
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const persons = r => r.sheets.flatMap(s => s.rows.flatMap(row => row.persons || []));
const byName = (r, given) => persons(r).filter(p => p.given_name === given);

const SCHOOL = {
  name: 'Roster',
  headers: ['Student First Name', 'Student Last Name', 'Grade', 'Parent 1 First Name', 'Parent 1 Last Name',
    'Parent Email', 'Parent 2 First Name', 'Address', 'City', 'State', 'Zip'],
  rows: [
    ['Emma', 'Smith', '3', 'Jane', 'Smith', 'jane@example.org', 'John', '12 Maple St', 'Austin', 'TX', '78701'],
    ['Liam', 'Smith', '5', 'Jane', 'Smith', 'jane@example.org', 'John', '12 Maple St', 'Austin', 'TX', '78701'],
    ['Ava', 'Garcia', 'K', 'Maria', 'Garcia', 'maria@example.org', '', '9 Oak Ave', 'Austin', 'TX', '78702'],
  ],
};

// ---------------------------------------------------------------------------
// Community id format
// ---------------------------------------------------------------------------

test('community id > round trips person and family codes, both lengths, any case', () => {
  const p = ids.newCode('person');
  const f = ids.newCode('family');
  const ip = ids.toCommunityId(p);
  const ff = ids.toCommunityId(f);
  assert.match(ip, /^I[0-9A-F]{16}$/);
  assert.match(ff, /^F[0-9A-F]{16}$/);
  assert.equal(ids.fromCommunityId(ip), p);
  assert.equal(ids.fromCommunityId(ff), f);
  assert.equal(ids.fromCommunityId(ip.toLowerCase()), p);
  assert.equal(ids.toCommunityId('p_0123abcd'), 'I0123ABCD');
  assert.equal(ids.fromCommunityId('I0123ABCD'), 'p_0123abcd');
  assert.equal(ids.toCode(ip), p);
  assert.equal(ids.toCode(p), p);
  assert.ok(ids.isCommunityId(ip, 'person'));
  assert.ok(!ids.isCommunityId(ip, 'family'));
});

test('community id > rejects anything that is not exactly an I/F id', () => {
  for (const bad of ['', 'I', 'I123', 'X0123ABCD', 'I0123ABCDE', 'I0123ABCG', 'F 0123ABCD', null, 42]) {
    assert.equal(ids.fromCommunityId(bad), null, String(bad));
  }
  assert.equal(ids.toCommunityId('e_0123456789abcdef'), null, 'emails have no community id');
  assert.equal(ids.toCommunityId('nonsense'), null);
});

// ---------------------------------------------------------------------------
// Plan / commit core
// ---------------------------------------------------------------------------

test('roster > plan writes nothing but its own audit row', t => {
  const ctx = setup(t);
  const before = { p: count(ctx.db, 'persons'), f: count(ctx.db, 'families'), s: count(ctx.db, 'source_records') };
  const r = plan(ctx, { sheets: [SCHOOL] });
  assert.equal(r.committed, false);
  assert.equal(count(ctx.db, 'persons'), before.p);
  assert.equal(count(ctx.db, 'families'), before.f);
  assert.equal(count(ctx.db, 'source_records'), before.s);
  assert.equal(count(ctx.db, 'import_runs'), 0);
  const auditRow = ctx.db.prepare(`SELECT * FROM audit_events WHERE action = 'roster_plan'`).get();
  assert.ok(auditRow, 'plan is audited');
  assert.ok(!/Smith|Garcia|jane@/.test(auditRow.metadata), 'audit holds counts, not names');
  for (const p of persons(r)) assert.equal(p.community_id, null, 'a plan never shows an id it has not minted');
});

test('roster > commit issues one id per person and household, re-import changes nothing', t => {
  const ctx = setup(t);
  const r1 = commit(ctx, { sheets: [SCHOOL] });
  assert.equal(r1.committed, true);
  // Jane and John appear on two rows (one per child) but are one person each.
  const jane = byName(r1, 'Jane');
  assert.equal(jane.length, 2);
  assert.equal(jane[0].community_id, jane[1].community_id);
  assert.match(jane[0].community_id, /^I[0-9A-F]{16}$/);
  assert.equal(byName(r1, 'John')[0].community_id, byName(r1, 'John')[1].community_id);
  assert.notEqual(byName(r1, 'Emma')[0].community_id, byName(r1, 'Liam')[0].community_id);
  const rows = r1.sheets[0].rows;
  assert.equal(rows[0].family.community_id, rows[1].family.community_id, 'siblings share the household id');
  assert.notEqual(rows[0].family.community_id, rows[2].family.community_id);
  assert.match(rows[0].family.community_id, /^F[0-9A-F]{16}$/);
  assert.equal(count(ctx.db, 'persons'), 6);
  assert.equal(count(ctx.db, 'families'), 2);
  // The blank Parent 2 on the Garcia row is not a person.
  assert.equal(rows[2].persons.length, 2);

  const r2 = commit(ctx, { sheets: [SCHOOL] });
  assert.equal(r2.committed, true);
  assert.equal(r2.summary.persons.new, 0);
  assert.equal(r2.summary.families.new, 0);
  assert.equal(count(ctx.db, 'persons'), 6);
  assert.equal(count(ctx.db, 'families'), 2);
  const before = new Map(persons(r1).map(p => [p.key, p.community_id]));
  for (const p of persons(r2)) assert.equal(p.community_id, before.get(p.key), `${p.key} keeps its id`);
  assert.equal(r2.sheets[0].rows[0].family.community_id, rows[0].family.community_id);
});

test('roster > a new sibling on next year\'s roster joins the existing household', t => {
  const ctx = setup(t);
  const r1 = commit(ctx, { sheets: [SCHOOL] });
  const next = { ...SCHOOL, rows: [['Noah', 'Smith', 'K', 'Jane', 'Smith', 'jane@example.org', 'John', '12 Maple St', 'Austin', 'TX', '78701']] };
  const r2 = commit(ctx, { sheets: [next] });
  assert.equal(r2.committed, true);
  const row = r2.sheets[0].rows[0];
  assert.equal(row.family.community_id, r1.sheets[0].rows[0].family.community_id);
  assert.equal(byName(r2, 'Noah')[0].action, 'new');
  assert.equal(byName(r2, 'Jane')[0].community_id, byName(r1, 'Jane')[0].community_id);
});

test('roster > siblings and unrelated same-surname families are not sent to review', t => {
  const ctx = setup(t);
  commit(ctx, { sheets: [SCHOOL] });
  const other = { ...SCHOOL, rows: [['Mia', 'Smith', '2', 'Karen', 'Smith', 'karen@example.org', '', '400 Elm St', 'Austin', 'TX', '78704']] };
  const r = plan(ctx, { sheets: [other] });
  assert.deepEqual(r.pending, []);
  assert.equal(r.summary.persons.new, 2);
  assert.equal(r.sheets[0].rows[0].family.action, 'new');
});

test('roster > commit refuses, writes nothing, and shows no ids while a review is open', t => {
  const ctx = setup(t);
  // Existing Mary Smith; the roster has a Marie Smith - nickname-equivalent,
  // no email or birthdate to settle it.
  people.create(ctx.db, ctx.secrets, { given_name: 'Mary', family_name: 'Smith' });
  const sheet = { headers: ['First Name', 'Last Name'], rows: [['Marie', 'Smith'], ['Karol', 'Nowak']] };
  const p = plan(ctx, { sheets: [sheet] });
  assert.deepEqual(p.pending, ['0:0:0']);
  const item = persons(p)[0];
  assert.equal(item.action, 'review');
  assert.equal(item.candidates.length, 1);
  assert.match(item.candidates[0].community_id, /^I/);

  const before = count(ctx.db, 'persons');
  const c = commit(ctx, { sheets: [sheet] });
  assert.equal(c.committed, false);
  assert.deepEqual(c.pending, ['0:0:0']);
  assert.equal(count(ctx.db, 'persons'), before, 'nothing written');
  assert.equal(count(ctx.db, 'import_runs'), 0);
  const karol = byName(c, 'Karol')[0];
  assert.equal(karol.community_id, null, 'ids minted by a refused commit are never shown');
  assert.ok(ctx.db.prepare(`SELECT 1 FROM audit_events WHERE action = 'roster_commit_refused'`).get());
});

test('roster > operator decisions: same person, different person, not a person', t => {
  const ctx = setup(t);
  const mary = people.create(ctx.db, ctx.secrets, { given_name: 'Mary', family_name: 'Smith' });
  const sheet = {
    headers: ['First Name', 'Last Name'],
    rows: [['Marie', 'Smith'], ['Mary', 'Smith'], ['TBD', 'Smith']],
  };
  const p = plan(ctx, { sheets: [sheet] });
  assert.deepEqual(p.pending.sort(), ['0:0:0', '0:1:0', '0:2:0'].sort());

  const r = commit(ctx, {
    sheets: [sheet],
    decisions: {
      '0:0:0': { action: 'create' },
      '0:1:0': { action: 'attach', target: ids.toCommunityId(mary) },
      '0:2:0': { action: 'skip' },
    },
  });
  assert.equal(r.committed, true);
  const rows = r.sheets[0].rows;
  assert.notEqual(rows[0].persons[0].community_id, ids.toCommunityId(mary));
  assert.equal(rows[1].persons[0].community_id, ids.toCommunityId(mary));
  assert.equal(rows[2].persons[0].action, 'skip');
  assert.equal(rows[2].persons[0].community_id, undefined);
  // "Different person" is remembered so a rescan does not ask again.
  const marie = ids.fromCommunityId(rows[0].persons[0].community_id);
  const sticky = ctx.db.prepare(
    `SELECT status FROM conflicts WHERE kind = 'person' AND left_code = ? AND right_code = ?`
  ).get(marie, mary);
  assert.equal(sticky.status, 'rejected');
  assert.ok(ctx.db.prepare(`SELECT 1 FROM audit_events WHERE action = 'resolver_attach_manual' AND entity_code = ?`).get(mary));
});

test('roster > a decision can point at an earlier row of the same upload', t => {
  const ctx = setup(t);
  // Two rows, no email/dob: "Bob Jones" then "Robert Jones" (nickname).
  const sheet = { headers: ['First Name', 'Last Name'], rows: [['Bob', 'Jones'], ['Robert', 'Jones']] };
  const p = plan(ctx, { sheets: [sheet] });
  assert.deepEqual(p.pending, ['0:1:0']);
  assert.equal(persons(p)[1].candidates[0].sheet_ref, '0:0:0');
  const r = commit(ctx, { sheets: [sheet], decisions: { '0:1:0': { action: 'attach', target: '0:0:0' } } });
  assert.equal(r.committed, true);
  assert.equal(persons(r)[0].community_id, persons(r)[1].community_id);
  assert.equal(count(ctx.db, 'persons'), 1);
});

test('roster > malformed or impossible decisions are refused, never guessed around', t => {
  const ctx = setup(t);
  const sheet = { headers: ['First Name', 'Last Name'], rows: [['Ann', 'Lee']] };
  assert.throws(() => commit(ctx, { sheets: [sheet], decisions: { 'x': { action: 'create' } } }), /bad decision key/);
  assert.throws(() => commit(ctx, { sheets: [sheet], decisions: { '0:0:0': { action: 'merge' } } }), /action must be/);
  assert.throws(() => commit(ctx, { sheets: [sheet], decisions: { '0:0:family': { action: 'skip' } } }), /action must be/);
  assert.throws(() => commit(ctx, { sheets: [sheet], decisions: { '0:0:0': { action: 'attach' } } }), /needs a target/);
  assert.throws(() => commit(ctx, { sheets: [sheet], decisions: { '0:0:0': { action: 'attach', target: 'I0123456789ABCDEF' } } }), /does not exist/);
  assert.throws(() => commit(ctx, { sheets: [sheet], decisions: { '0:0:0': { action: 'attach', target: 'F0123456789ABCDEF' } } }), /not an individual id/);
  assert.throws(() => commit(ctx, { sheets: [sheet], decisions: { '0:0:0': { action: 'attach', target: '0:5:0' } } }), /not an earlier person/);
  assert.equal(count(ctx.db, 'persons'), 0);
});

// ---------------------------------------------------------------------------
// The traps that would give two humans one id
// ---------------------------------------------------------------------------

test('trap > spouses sharing a family email are never fused', t => {
  const ctx = setup(t);
  const sheet = {
    headers: ['First Name', 'Last Name', 'Email', 'Spouse First Name', 'Spouse Email'],
    rows: [['Jane', 'Smith', 'smiths@example.org', 'John', 'smiths@example.org']],
  };
  const r1 = commit(ctx, { sheets: [sheet] });
  const jane = byName(r1, 'Jane')[0].community_id;
  const john = byName(r1, 'John')[0].community_id;
  assert.notEqual(jane, john);
  // John alone on another list, with the shared email: must be John.
  const r2 = commit(ctx, { sheets: [{ headers: ['First Name', 'Last Name', 'Email'], rows: [['John', 'Smith', 'smiths@example.org']] }] });
  assert.equal(r2.committed, true);
  assert.equal(byName(r2, 'John')[0].community_id, john);
});

test('trap > a shared email alone never matches a different first name', t => {
  const ctx = setup(t);
  const jane = people.create(ctx.db, ctx.secrets, { given_name: 'Jane', family_name: 'Smith' });
  contacts.attachEmailToPerson(ctx.db, jane, contacts.upsertEmail(ctx.db, ctx.secrets, 'smiths@example.org'));
  const r = plan(ctx, { sheets: [{ headers: ['First Name', 'Last Name', 'Email'], rows: [['Emma', 'Smith', 'smiths@example.org']] }] });
  const emma = byName(r, 'Emma')[0];
  assert.equal(emma.action, 'review', 'a child under a parent\'s email goes to a human');
  assert.ok(emma.candidates[0].reasons.includes('contact_match_name_unaligned'));
});

test('trap > different birthdates veto an email match', t => {
  const ctx = setup(t);
  const a = people.create(ctx.db, ctx.secrets, { given_name: 'Mary', family_name: 'Smith', date_of_birth: '1960-02-01' });
  contacts.attachEmailToPerson(ctx.db, a, contacts.upsertEmail(ctx.db, ctx.secrets, 'm@example.org'));
  const r = plan(ctx, { sheets: [{ headers: ['First Name', 'Last Name', 'Email', 'DOB'], rows: [['Mary', 'Smith', 'm@example.org', '1990-07-04']] }] });
  const mary = persons(r)[0];
  assert.equal(mary.action, 'review');
  assert.ok(mary.candidates[0].reasons.includes('dob_conflict'));
});

test('trap > Jr and Sr with one email are two people', t => {
  const ctx = setup(t);
  const sr = people.create(ctx.db, ctx.secrets, { given_name: 'John', family_name: 'Smith', suffix: 'Sr.' });
  contacts.attachEmailToPerson(ctx.db, sr, contacts.upsertEmail(ctx.db, ctx.secrets, 'smiths@example.org'));
  const r = plan(ctx, { sheets: [{ headers: ['First Name', 'Last Name', 'Suffix', 'Email'], rows: [['John', 'Smith', 'Jr.', 'smiths@example.org']] }] });
  const jr = persons(r)[0];
  assert.equal(jr.action, 'review');
  assert.ok(jr.candidates[0].reasons.includes('suffix_conflict'));
});

test('trap > a suffix on one side only is not proof in a roster import', t => {
  const ctx = setup(t);
  const dad = people.create(ctx.db, ctx.secrets, { given_name: 'John', family_name: 'Smith', date_of_birth: '1970-01-01' });
  const r = plan(ctx, { sheets: [{ headers: ['First Name', 'Last Name', 'DOB'], rows: [['John', 'Smith Jr', '1970-01-01']] }] });
  assert.equal(persons(r)[0].action, 'review');
  assert.ok(persons(r)[0].candidates[0].reasons.includes('suffix_one_sided'));
  assert.ok(dad);
});

test('trap > an ambiguous nickname plus birthdate goes to review (twins Christopher / Christine)', t => {
  const ctx = setup(t);
  people.create(ctx.db, ctx.secrets, { given_name: 'Christine', family_name: 'Lee', date_of_birth: '2015-05-05' });
  const r = plan(ctx, { sheets: [{ headers: ['First Name', 'Last Name', 'DOB'], rows: [['Chris', 'Lee', '2015-05-05']] }] });
  assert.equal(persons(r)[0].action, 'review');
});

test('trap > an unambiguous nickname plus birthdate still matches', t => {
  const ctx = setup(t);
  const mike = people.create(ctx.db, ctx.secrets, { given_name: 'Michael', family_name: 'Lee', date_of_birth: '2015-05-05' });
  const r = plan(ctx, { sheets: [{ headers: ['First Name', 'Last Name', 'DOB'], rows: [['Mike', 'Lee', '05/05/2015']] }] });
  assert.equal(persons(r)[0].action, 'matched');
  assert.equal(persons(r)[0].community_id, ids.toCommunityId(mike));
});

test('trap > same-named father and son in one household go to review', t => {
  const ctx = setup(t);
  const sheet = {
    headers: ['Parent First Name', 'Parent Last Name', 'Parent Email', 'Student First Name', 'Student Last Name'],
    rows: [['John', 'Smith', 'dad@example.org', 'John', 'Smith']],
  };
  const r1 = commit(ctx, { sheets: [sheet] });
  const [dad, son] = persons(r1);
  assert.notEqual(dad.community_id, son.community_id, 'two people on one row are two people');
  const r2 = plan(ctx, { sheets: [sheet] });
  assert.equal(persons(r2)[0].community_id, dad.community_id, 'dad matches by email');
  assert.equal(persons(r2)[1].community_id, son.community_id, 'the son matches the child record, not dad');
});

test('trap > a child row never matches an adult record by name alone', t => {
  const ctx = setup(t);
  const parentSheet = { headers: ['Parent First Name', 'Parent Last Name', 'Parent Email', 'Student First Name', 'Student Last Name'],
    rows: [['John', 'Smith', 'dad@example.org', 'Amy', 'Smith']] };
  const r1 = commit(ctx, { sheets: [parentSheet] });
  const dad = persons(r1)[0].community_id;
  // A new child named after dad shows up.
  const r2 = plan(ctx, { sheets: [{ ...parentSheet, rows: [['John', 'Smith', 'dad@example.org', 'John', 'Smith']] }] });
  const junior = persons(r2)[1];
  assert.notEqual(junior.community_id, dad);
  assert.ok(['review', 'new'].includes(junior.action));
});

test('trap > an archived person who returns gets their old id back, only after a human says so', t => {
  const ctx = setup(t);
  const code = people.create(ctx.db, ctx.secrets, { given_name: 'Rosa', family_name: 'Diaz', date_of_birth: '2012-03-03' });
  people.archive(ctx.db, code, { actor: 'test' });
  const sheet = { headers: ['First Name', 'Last Name', 'DOB'], rows: [['Rosa', 'Diaz', '2012-03-03']] };
  const p = plan(ctx, { sheets: [sheet] });
  const rosa = persons(p)[0];
  assert.equal(rosa.action, 'review');
  assert.ok(rosa.review_reasons.includes('candidate_archived'));
  assert.equal(rosa.candidates[0].status, 'archived');
  const r = commit(ctx, { sheets: [sheet], decisions: { '0:0:0': { action: 'attach', target: rosa.candidates[0].community_id } } });
  assert.equal(persons(r)[0].community_id, ids.toCommunityId(code));
  assert.equal(ctx.db.prepare('SELECT status FROM persons WHERE code = ?').get(code).status, 'active');
});

test('trap > the 60th Garcia is still found (no silent candidate cap)', t => {
  const ctx = setup(t);
  for (let i = 0; i < 80; i++) people.create(ctx.db, ctx.secrets, { given_name: `Kid${i}`, family_name: 'Garcia', date_of_birth: '2010-01-01' });
  const target = people.create(ctx.db, ctx.secrets, { given_name: 'Lucia', family_name: 'Garcia', date_of_birth: '2011-11-11' });
  const r = plan(ctx, { sheets: [{ headers: ['First Name', 'Last Name', 'DOB'], rows: [['Lucia', 'Garcia', '2011-11-11']] }] });
  assert.equal(persons(r)[0].community_id, ids.toCommunityId(target));
});

test('trap > a merged person\'s old id still resolves to the survivor', t => {
  const ctx = setup(t);
  const a = people.create(ctx.db, ctx.secrets, { given_name: 'Pio', family_name: 'Nardi' });
  const b = people.create(ctx.db, ctx.secrets, { given_name: 'Pio', family_name: 'Nardi' });
  people.merge(ctx.db, ctx.secrets, a, b);
  const found = roster.lookup(ctx.db, ids.toCommunityId(a).toLowerCase());
  assert.equal(found.code, b);
  assert.equal(found.community_id, ids.toCommunityId(b));
  assert.equal(found.redirected, true);
  assert.equal(roster.lookup(ctx.db, 'I0000000000000000'), null);
});

// ---------------------------------------------------------------------------
// Households
// ---------------------------------------------------------------------------

test('household > members already in two different households go to review', t => {
  const ctx = setup(t);
  const sheetA = { headers: ['First Name', 'Last Name', 'Email', 'Spouse First Name', 'Spouse Email'],
    rows: [['Ann', 'Park', 'ann@example.org', 'Sam', 'sam@example.org']] };
  commit(ctx, { sheets: [{ headers: ['First Name', 'Last Name', 'Email'], rows: [['Ann', 'Park', 'ann@example.org']] }] });
  commit(ctx, { sheets: [{ headers: ['First Name', 'Last Name', 'Email'], rows: [['Sam', 'Park', 'sam@example.org']] }] });
  const r = plan(ctx, { sheets: [sheetA] });
  const fam = r.sheets[0].rows[0].family;
  assert.equal(fam.action, 'review');
  assert.ok(fam.review_reasons.includes('members_in_different_households'));
  assert.equal(fam.candidates.length, 2);
});

test('household > same address but no known members goes to review', t => {
  const ctx = setup(t);
  const sheet1 = { headers: ['First Name', 'Last Name', 'Address', 'City', 'Zip'], rows: [['Ann', 'Park', '5 Pine Rd', 'Austin', '78701']] };
  commit(ctx, { sheets: [sheet1] });
  const r = plan(ctx, { sheets: [{ ...sheet1, rows: [['Tomas', 'Ruiz', '5 Pine Rd', 'Austin', '78701']] }] });
  const fam = r.sheets[0].rows[0].family;
  assert.equal(fam.action, 'review');
  assert.ok(fam.review_reasons.includes('same_address_no_known_members'));
  const c = commit(ctx, { sheets: [{ ...sheet1, rows: [['Tomas', 'Ruiz', '5 Pine Rd', 'Austin', '78701']] }],
    decisions: { '0:0:family': { action: 'create' } } });
  assert.equal(c.committed, true);
  assert.equal(count(ctx.db, 'families'), 2);
});

// ---------------------------------------------------------------------------
// Sheet shapes
// ---------------------------------------------------------------------------

test('shape > parishioner list with a Children column', t => {
  const ctx = setup(t);
  const sheet = {
    headers: ['Family Name', 'Head', 'Spouse', 'Children', 'Address', 'City', 'Zip', 'Email'],
    rows: [['Smith Family', 'John Smith', 'Mary', 'Tom, Ann & Joe', '12 Maple St', 'Austin', '78701', 'jsmith@example.org']],
  };
  const r = commit(ctx, { sheets: [sheet] });
  assert.equal(r.committed, true);
  const row = r.sheets[0].rows[0];
  const names = row.persons.map(p => `${p.given_name} ${p.family_name} ${p.role}`);
  assert.deepEqual(names, ['John Smith parent', 'Mary Smith parent', 'Tom Smith child', 'Ann Smith child', 'Joe Smith child']);
  const ann = row.persons[3];
  assert.deepEqual(ann.name_cells, [{ col: 3, part: 'list', text: 'Ann', start: 5, index: 1 }]);
  assert.deepEqual(row.persons[0].name_cells, [{ col: 1, part: 'full' }]);
  assert.equal(row.family.cell.col, 0, 'the Family Name column carries the household id');
  assert.equal(new Set(row.persons.map(p => p.community_id)).size, 5);
  // Re-import: every child matches through the household.
  const r2 = plan(ctx, { sheets: [sheet] });
  assert.equal(r2.summary.persons.matched, 5);
  assert.deepEqual(r2.pending, []);
});

test('shape > a couple written in one cell is two people, never one', t => {
  const ctx = setup(t);
  const cases = [
    [['Name'], ['John & Mary Smith'], [['John', 'Smith'], ['Mary', 'Smith']]],
    [['Name'], ['Smith, John & Mary'], [['John', 'Smith'], ['Mary', 'Smith']]],
    [['Name'], ['John Smith and Mary Jones'], [['John', 'Smith'], ['Mary', 'Jones']]],
    [['Name'], ['Mr. & Mrs. John Smith'], [['John', 'Smith']]],
    [['First Name', 'Last Name'], ['John & Mary', 'Smith'], [['John', 'Smith'], ['Mary', 'Smith']]],
    [['Name'], ['Alexander Anderson'], [['Alexander', 'Anderson']]],
  ];
  for (const [headers, row, want] of cases) {
    const out = applyMapping(Object.fromEntries(headers.map((h, i) => [h, row[i]])), csv.inferMapping(headers));
    assert.deepEqual(out.persons.map(p => [p.given_name, p.family_name]), want, row.join(' | '));
  }
  // Both get their own id, and the cell is shared.
  const r = commit(ctx, { sheets: [{ headers: ['Name', 'Email'], rows: [['John & Mary Smith', 'js@example.org']] }] });
  const [john, mary] = persons(r);
  assert.notEqual(john.community_id, mary.community_id);
  assert.deepEqual(john.name_cells, [{ col: 0, part: 'full' }]);
  assert.deepEqual(mary.name_cells, [{ col: 0, part: 'full' }]);
  assert.equal(mary.role, 'spouse');
  // The email belongs to the row, which is one value - it stays with the
  // first-named person only, so it can never tie Mary to John's record.
  const maryEmails = ctx.db.prepare('SELECT COUNT(*) AS n FROM person_emails WHERE person_code = ?')
    .get(ids.fromCommunityId(mary.community_id)).n;
  assert.equal(maryEmails, 0);
});

test('shape > a spouse with her own column is not duplicated by a couple cell', () => {
  const mapping = csv.inferMapping(['Head', 'Spouse', 'Spouse Email']);
  const out = applyMapping({ Head: 'John & Mary Smith', Spouse: 'Mary', 'Spouse Email': 'mary@example.org' }, mapping);
  assert.deepEqual(out.persons.map(p => [p.given_name, p.family_name, p.emails.join()]),
    [['John', 'Smith', ''], ['Mary', 'Smith', 'mary@example.org']]);
});

test('roster > an organization in a name column goes to a human', t => {
  const ctx = setup(t);
  const r = plan(ctx, { sheets: [{ headers: ['First Name', 'Last Name'], rows: [['Smith', 'Construction LLC'], ['Ann', 'Banks']] }] });
  assert.deepEqual(persons(r)[0].review_reasons, ['looks_like_organization']);
  assert.equal(persons(r)[1].action, 'new', 'Banks is a surname');
});

test('shape > list splitting handles and/&/;, suffixes, and empty markers', () => {
  assert.deepEqual(splitNameList('Tom, Ann & Joe').map(e => e.text), ['Tom', 'Ann', 'Joe']);
  assert.deepEqual(splitNameList('Tom and Ann; Joe').map(e => e.text), ['Tom', 'Ann', 'Joe']);
  assert.deepEqual(splitNameList('Tom Smith, Jr., Ann').map(e => e.text), ['Tom Smith, Jr.', 'Ann']);
  assert.deepEqual(splitNameList('N/A'), []);
  assert.deepEqual(splitNameList('none'), []);
  const s = 'Tom, Ann & Joe';
  for (const e of splitNameList(s)) assert.equal(s.slice(e.start, e.start + e.text.length), e.text);
});

test('shape > a first name alone in a Spouse or Student column is a first name', () => {
  const mapping = csv.inferMapping(['Last Name', 'First Name', 'Spouse', 'Student']);
  const out = applyMapping({ 'Last Name': 'Nguyen', 'First Name': 'Linh', Spouse: 'Bao', Student: 'Mai' }, mapping);
  const names = out.persons.map(p => [p.given_name, p.family_name]);
  assert.deepEqual(names, [['Linh', 'Nguyen'], ['Bao', 'Nguyen'], ['Mai', 'Nguyen']]);
});

test('shape > blank rows, totals rows, and sheets with no name columns are skipped', t => {
  const ctx = setup(t);
  const r = plan(ctx, {
    sheets: [
      { headers: ['First Name', 'Last Name'], rows: [['Ann', 'Lee'], ['', ''], ['Total', '1']] },
      { headers: ['Pledge', 'Amount'], rows: [['2026', '100']] },
    ],
  });
  assert.deepEqual(r.sheets[0].rows.map(x => x.skipped || 'ok'), ['ok', 'blank', 'summary']);
  assert.equal(r.sheets[1].skipped, 'no_identity_columns');
});

test('shape > duplicate and empty headers stay distinct columns', t => {
  const ctx = setup(t);
  const r = plan(ctx, { sheets: [{ headers: ['First Name', 'Last Name', 'Email', 'Email', ''], rows: [['Ann', 'Lee', 'a@x.org', 'b@x.org', 'z']] }] });
  assert.deepEqual(r.sheets[0].columns, ['First Name', 'Last Name', 'Email', 'Email (2)', 'Column 5']);
});

test('shape > input limits are enforced', t => {
  const ctx = setup(t);
  assert.throws(() => plan(ctx, {}), /sheets array required/);
  assert.throws(() => plan(ctx, { sheets: [{ headers: ['a'] }] }), /headers and rows/);
  assert.throws(() => plan(ctx, { sheets: [{ headers: ['First Name'], rows: [['x'.repeat(roster.LIMITS.cellChars + 1)]] }] }), /longer than/);
});

// ---------------------------------------------------------------------------
// Global scorer fixes (apply to every import, not just rosters)
// ---------------------------------------------------------------------------

test('scorer > spouses at one address are not one person (last name alone no longer definitive)', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const address = { line1: '12 Maple St', city: 'Austin', region: 'TX', postal: '78701' };
  const r1 = importPipeline.importRow(db, s, defaultThresholds(), {
    family: { display_name: 'Smith' },
    persons: [{ given_name: 'Mary', family_name: 'Smith', role: 'parent' }],
    address,
  }, { source: 'csv' });
  const mary = r1.persons[0].code;
  // The identity API hands the resolver a person WITH an address. Before
  // 2026-09-28, same surname + same address scored "definitive" and John
  // was attached to Mary's record.
  const r = resolver.resolveOrCreatePerson(db, s, defaultThresholds(),
    { given_name: 'John', family_name: 'Smith', address });
  assert.notEqual(r.code, mary, 'John must never attach to Mary');
  assert.notEqual(r.action, 'attached');
  // Same first AND last name at the same address is still definitive.
  const again = resolver.resolveOrCreatePerson(db, s, defaultThresholds(),
    { given_name: 'Mary', family_name: 'Smith', address });
  assert.equal(again.code, mary);
  assert.equal(again.action, 'attached');
});

test('roster > placeholder names and bare initials always go to a human', t => {
  const ctx = setup(t);
  const r = plan(ctx, { sheets: [{ headers: ['First Name', 'Last Name'], rows: [['TBD', 'Smith'], ['J.', 'Lee'], ['Dad', 'Ruiz']] }] });
  assert.deepEqual(persons(r).map(p => p.review_reasons), [['placeholder_name'], ['initial_only'], ['placeholder_name']]);
});

test('scorer > dob and suffix conflicts are hard vetoes even outside strict mode', () => {
  const email = { emails: ['x@example.org'] };
  const a = { given_name: 'Mary', family_name: 'Smith', date_of_birth: '1960-01-01', ...email };
  const b = { given_name: 'Mary', family_name: 'Smith', date_of_birth: '1990-01-01', ...email };
  const s1 = matching.scoreMatch(a, b);
  assert.equal(s1.definitive, false);
  assert.ok(s1.confidence <= matching.VETO_CAP);
  assert.ok(s1.reasons.includes('dob_conflict'));
  const s2 = matching.scoreMatch(
    { given_name: 'John', family_name: 'Smith Jr.', ...email },
    { given_name: 'John', family_name: 'Smith', suffix: 'Sr', ...email });
  assert.equal(s2.definitive, false);
  assert.ok(s2.reasons.includes('suffix_conflict'));
  // Same date in two formats is the same date.
  const s3 = matching.scoreMatch(
    { given_name: 'Ann', family_name: 'Lee', date_of_birth: '03/04/2012' },
    { given_name: 'Ann', family_name: 'Lee', date_of_birth: '2012-03-04' });
  assert.equal(s3.definitive, true);
});

test('scorer > strict mode flags a transposed first name for review', () => {
  const s = matching.scoreMatch({ given_name: 'Jonh', family_name: 'Lee' }, { given_name: 'John', family_name: 'Lee' }, { strict: true });
  assert.ok(s.reasons.includes('first_name_typo'));
  const loose = matching.scoreMatch({ given_name: 'Jonh', family_name: 'Lee' }, { given_name: 'John', family_name: 'Lee' });
  assert.ok(!loose.reasons.includes('first_name_typo'), 'non-strict scoring is unchanged');
});

test('resolver > scoreCandidates keeps the old single-best behavior for resolveOrCreatePerson', t => {
  const ctx = setup(t);
  const a = people.create(ctx.db, ctx.secrets, { given_name: 'Mary', family_name: 'Smith', date_of_birth: '1985-04-12' });
  const list = resolver.scoreCandidates(ctx.db, ctx.secrets, { given_name: 'Mary', family_name: 'Smith', date_of_birth: '1985-04-12' });
  assert.equal(list[0].candidate.code, a);
  assert.equal(list[0].definitive, true);
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
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
        resolve({ status: res.statusCode, body: payload });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('api > scopes: plan needs pii.read, commit needs import; 409 on open reviews; big bodies accepted', async t => {
  process.env.FAMILY_GRAPH_DISABLE_RATE_LIMIT = '1';
  const { buildApp } = require('../server');
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const { server, port } = await listen(app);
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); cleanup(dir); });

  const readOnly = apiKeys.provision(db, { name: 'reader', scopes: ['pii.read'] });
  const anon = apiKeys.provision(db, { name: 'docanonymizer', scopes: ['pii.read', 'import'] });
  const H = tok => ({ authorization: `Bearer ${tok}` });

  assert.equal((await request(port, { method: 'POST', path: '/api/identity/roster/plan', body: { sheets: [SCHOOL] } })).status, 401);
  const p = await request(port, { method: 'POST', path: '/api/identity/roster/plan', headers: H(readOnly.token), body: { sheets: [SCHOOL] } });
  assert.equal(p.status, 200);
  assert.equal(p.body.committed, false);
  const denied = await request(port, { method: 'POST', path: '/api/identity/roster/commit', headers: H(readOnly.token), body: { sheets: [SCHOOL] } });
  assert.equal(denied.status, 403);
  const ok = await request(port, { method: 'POST', path: '/api/identity/roster/commit', headers: H(anon.token), body: { sheets: [SCHOOL], source: 'docanonymizer' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.committed, true);
  const someone = ok.body.sheets[0].rows[0].persons[0].community_id;
  const look = await request(port, { path: `/api/identity/roster/lookup/${someone}`, headers: H(readOnly.token) });
  assert.equal(look.status, 200);
  assert.equal(look.body.kind, 'person');
  assert.equal((await request(port, { path: '/api/identity/roster/lookup/nope', headers: H(readOnly.token) })).status, 404);

  // An open review: 409, nothing written, the plan comes back.
  people.create(db, secrets, { given_name: 'Mary', family_name: 'Ortiz' });
  const pending = await request(port, {
    method: 'POST', path: '/api/identity/roster/commit', headers: H(anon.token),
    body: { sheets: [{ headers: ['First Name', 'Last Name'], rows: [['Marie', 'Ortiz']] }] },
  });
  assert.equal(pending.status, 409);
  assert.equal(pending.body.error, 'review_incomplete');
  assert.deepEqual(pending.body.plan.pending, ['0:0:0']);

  // Bad input: 400 with a reason.
  const bad = await request(port, { method: 'POST', path: '/api/identity/roster/plan', headers: H(anon.token), body: { sheets: 'x' } });
  assert.equal(bad.status, 400);

  // A 2,000-row roster is well past the default 256 KB body cap.
  const rows = [];
  for (let i = 0; i < 2000; i++) rows.push([`First${i}`, `Last${i}`, `p${i}@example.org`, '123 Long Street Name Apartment 4', 'Austin', 'TX', '78701']);
  const big = await request(port, {
    method: 'POST', path: '/api/identity/roster/plan', headers: H(anon.token),
    body: { sheets: [{ headers: ['First Name', 'Last Name', 'Email', 'Address', 'City', 'State', 'Zip'], rows }] },
  });
  assert.equal(big.status, 200);
  assert.equal(big.body.summary.rows, 2000);
});
