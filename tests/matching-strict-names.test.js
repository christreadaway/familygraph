'use strict';

// Regression tests for the 2026-09-28 matcher review: gendered name pairs and
// prefix / edit-distance first names proving identity, fabricated birthdates,
// full names counted as ambiguous nicknames, and addresses whose route,
// building, or unit spelling decides whether two lines are one place.

const test = require('node:test');
const assert = require('node:assert/strict');

const roster = require('../server/identity/roster');
const matching = require('../server/identity/matching');
const { normalizeDate } = require('../server/sources/normalize');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets, th: defaultThresholds() };
}
const run = (ctx, body, mode) => roster.run(ctx.db, ctx.secrets, ctx.th, body, { mode, actor: 'test' });
const persons = r => r.sheets.flatMap(s => s.rows.flatMap(row => row.persons || []));
const byName = (r, given) => persons(r).filter(p => p.given_name === given);
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const strict = (a, b) => matching.scoreMatch(a, b, { strict: true });

const GENDERED = [
  ['Luis', 'Luisa'], ['Daniel', 'Daniela'], ['Paul', 'Paula'], ['Eric', 'Erica'],
  ['Julian', 'Juliana'], ['Gabriel', 'Gabriela'], ['Adrian', 'Adriana'], ['Carl', 'Carla'],
  ['Antonio', 'Antonia'], ['Francisco', 'Francisca'], ['Fernando', 'Fernanda'], ['Alejandro', 'Alejandra'],
];

// ---------------------------------------------------------------------------
// Findings 1 and 5: a different first name never proves identity
// ---------------------------------------------------------------------------

test('names > a whole name is not compared with itself as a compound part', () => {
  assert.ok(matching.firstNameMatchesCompound('Antonio', 'Antonia') < 0.9);
  assert.ok(matching.firstNameMatchesCompound('Francisco', 'Francisca') < 0.9);
  // A real compound still matches its parts.
  assert.equal(matching.firstNameMatchesCompound('Timothy & Mary', 'Mary'), 1);
  assert.equal(matching.firstNameMatchesCompound('Tim', 'Timothy and Mary'), 0.95);
});

test('names > gendered pairs at one address are never definitive in strict mode', () => {
  for (const [a, b] of GENDERED) {
    const s = strict(
      { given_name: a, family_name: 'Garcia', address_line1: '5 Elm St' },
      { given_name: b, family_name: 'Garcia', address_line1: '5 Elm St' });
    assert.equal(s.definitive, false, `${a}/${b} at one address`);
    assert.ok(!s.reasons.includes('exact_first_name'), `${a}/${b} is not an exact first name`);
    assert.ok(!s.reasons.includes('nickname_or_short_form'), `${a}/${b} is not a nickname`);
  }
});

test('names > gendered twins with one birthdate are never definitive in strict mode', () => {
  for (const [a, b] of GENDERED) {
    const s = strict(
      { given_name: a, family_name: 'Ruiz', date_of_birth: '2015-04-04' },
      { given_name: b, family_name: 'Ruiz', date_of_birth: '2015-04-04' });
    assert.equal(s.definitive, false, `${a}/${b} twins`);
  }
});

test('names > twins on the family email are not one person because the birthdate matches', () => {
  const s = strict(
    { given_name: 'Luis', family_name: 'Ruiz', date_of_birth: '2015-04-04', email: 'ruiz@example.org' },
    { given_name: 'Luisa', family_name: 'Ruiz', date_of_birth: '2015-04-04', email: 'ruiz@example.org' });
  assert.equal(s.definitive, false);
  assert.ok(s.reasons.includes('contact_match_name_unaligned'));
  // Same person on the family email still merges.
  const same = strict(
    { given_name: 'Luis', family_name: 'Ruiz', date_of_birth: '2015-04-04', email: 'ruiz@example.org' },
    { given_name: 'Luis', family_name: 'Ruiz', date_of_birth: '2015-04-04', email: 'ruiz@example.org' });
  assert.equal(same.definitive, true);
});

test('names > a real nickname and an exact name still prove identity', () => {
  for (const [a, b] of [['Robert', 'Bob'], ['Daniel', 'Dan'], ['Francisco', 'Paco'], ['Luis', 'Luis']]) {
    const s = strict(
      { given_name: a, family_name: 'Garcia', address_line1: '5 Elm St' },
      { given_name: b, family_name: 'Garcia', address_line1: '5 Elm St' });
    assert.equal(s.definitive, true, `${a}/${b} should still match`);
  }
  const dob = strict(
    { given_name: 'Robert', family_name: 'Smith', date_of_birth: '2015-03-04' },
    { given_name: 'Bob', family_name: 'Smith', date_of_birth: '2015-03-04' });
  assert.equal(dob.definitive, true);
});

test('names > a bare prefix or a one-letter typo goes to review, not auto-match (strict)', () => {
  const s = strict(
    { given_name: 'Nat', family_name: 'Lee', address_line1: '5 Elm St' },
    { given_name: 'Natalie', family_name: 'Lee', address_line1: '5 Elm St' });
  assert.equal(s.definitive, false);
  assert.ok(s.reasons.includes('similar_first_name'), 'still a first-name signal so the pair reaches review');
});

test('roster > Luis and Luisa on one sheet at one address get two ids', t => {
  const ctx = setup(t);
  const sheet = {
    headers: ['Student First Name', 'Student Last Name', 'Grade', 'Parent First Name', 'Parent Last Name', 'Address', 'City', 'Zip'],
    rows: [
      ['Luis', 'Garcia', '5', 'Maria', 'Garcia', '5 Elm St', 'Austin', '78701'],
      ['Luisa', 'Garcia', 'K', 'Maria', 'Garcia', '5 Elm St', 'Austin', '78701'],
    ],
  };
  const r = run(ctx, { sheets: [sheet] }, 'plan');
  const luisa = byName(r, 'Luisa')[0];
  assert.notEqual(luisa.action, 'matched');
  assert.notEqual(luisa.same_as, '0:0:1', 'never Luis\'s slot');
});

test('roster > Daniel then Daniela across two years is never matched', t => {
  const ctx = setup(t);
  const headers = ['Student First Name', 'Student Last Name', 'Grade', 'Parent First Name', 'Parent Last Name', 'Address', 'City', 'Zip'];
  run(ctx, { sheets: [{ headers, rows: [['Daniel', 'Garcia', '5', 'Maria', 'Garcia', '5 Elm St', 'Austin', '78701']] }] }, 'commit');
  const r = run(ctx, { sheets: [{ headers, rows: [['Daniela', 'Garcia', '1', 'Maria', 'Garcia', '5 Elm St', 'Austin', '78701']] }] }, 'plan');
  assert.notEqual(byName(r, 'Daniela')[0].action, 'matched');
});

test('roster > twins Antonio and Antonia with one birthdate are not fused', t => {
  const ctx = setup(t);
  const r = run(ctx, { households: [{ persons: [
    { given_name: 'Antonio', family_name: 'Ruiz', date_of_birth: '2015-04-04', role: 'child' },
    { given_name: 'Antonia', family_name: 'Ruiz', date_of_birth: '2015-04-04', role: 'child' },
  ] }] }, 'plan');
  assert.notEqual(byName(r, 'Antonia')[0].action, 'matched');
});

// ---------------------------------------------------------------------------
// Findings 8 and 13: dates are never fabricated, and an unsure date never
// tells two records apart
// ---------------------------------------------------------------------------

test('dates > impossible and partial dates are not rolled over', () => {
  assert.equal(normalizeDate('2010-13-45'), null);
  assert.equal(normalizeDate('02/30/2010'), null);
  assert.equal(normalizeDate('2010-02-30'), null);
  assert.equal(normalizeDate('01/15'), null);
  assert.equal(normalizeDate('2010'), null);
  assert.equal(normalizeDate('Mar 2015'), null);
  assert.equal(normalizeDate('13/13/2015'), null);
});

test('dates > the readable formats still read the same', () => {
  assert.equal(normalizeDate('2010-01-15'), '2010-01-15');
  assert.equal(normalizeDate('1/15/2010'), '2010-01-15');
  assert.equal(normalizeDate('01-15-2010'), '2010-01-15');
  assert.equal(normalizeDate('Jan 15, 2010'), '2010-01-15');
  assert.equal(normalizeDate('January 15 2010'), '2010-01-15');
  assert.equal(normalizeDate('15 Jan 2010'), '2010-01-15');
  assert.equal(normalizeDate('2010/01/15'), '2010-01-15');
  assert.equal(normalizeDate('2010-01-15T08:00:00Z'), '2010-01-15');
  assert.equal(normalizeDate(new Date(Date.UTC(2010, 0, 15))), '2010-01-15');
  assert.equal(normalizeDate('2012-02-29'), '2012-02-29', 'a real leap day');
  // Day first is the only reading when the first number cannot be a month.
  assert.equal(normalizeDate('15/01/2010'), '2010-01-15');
  // A two-digit year is never read as a birthdate in the future.
  assert.equal(normalizeDate('5/6/45'), '1945-05-06');
  assert.equal(normalizeDate('5/6/15'), '2015-05-06');
});

test('dates > a day/month swap or a century slip is not a birthdate conflict', () => {
  const swap = strict(
    { given_name: 'Emma', family_name: 'Okafor', date_of_birth: '05/01/2010' },
    { given_name: 'Emma', family_name: 'Okafor', date_of_birth: '2010-01-05' });
  assert.ok(!swap.reasons.includes('dob_conflict'));
  const century = strict(
    { given_name: 'Rose', family_name: 'Garcia', date_of_birth: '1920-05-06' },
    { given_name: 'Rose', family_name: 'Garcia', date_of_birth: '2020-05-06' });
  assert.ok(!century.reasons.includes('dob_conflict'));
  // A plainly different birthdate is still a conflict.
  const diff = strict(
    { given_name: 'Emma', family_name: 'Okafor', date_of_birth: '2010-01-15' },
    { given_name: 'Emma', family_name: 'Okafor', date_of_birth: '2012-07-20' });
  assert.ok(diff.reasons.includes('dob_conflict'));
});

test('dates > a two-digit year and an exact email still merge', () => {
  const s = matching.scoreMatch(
    { given_name: 'Rose', family_name: 'Garcia', date_of_birth: '5/6/45', email: 'r@example.org' },
    { given_name: 'Rose', family_name: 'Garcia', date_of_birth: '1945-05-06', emails: ['r@example.org'] });
  assert.equal(s.definitive, true);
  assert.ok(!s.reasons.includes('dob_conflict'));
});

test('roster > a day-first birthdate then the ISO birthdate is one child', t => {
  for (const [first, second] of [['15/01/2010', '2010-01-15'], ['2010-01-15', '15/01/2010']]) {
    const { db, dir } = newDb();
    const ctx = { db, secrets: newSecrets(), th: defaultThresholds() };
    try {
      const child = dob => ({ households: [{ persons: [{ given_name: 'Emma', family_name: 'Okafor', date_of_birth: dob, role: 'child', grade: '3' }] }] });
      run(ctx, child(first), 'commit');
      const r = run(ctx, child(second), 'commit');
      const p = persons(r)[0];
      assert.equal(p.action, 'matched', `${first} then ${second}`);
      assert.equal(count(db, 'persons'), 1);
    } finally { db.close(); cleanup(dir); }
  }
});

test('roster > an impossible birthdate is never stored as a rolled-over date', t => {
  const ctx = setup(t);
  const child = dob => ({ households: [{ persons: [{ given_name: 'Emma', family_name: 'Okafor', date_of_birth: dob, role: 'child', grade: '3' }] }] });
  run(ctx, child('02/30/2010'), 'commit');
  const r = run(ctx, child('2010-03-02'), 'plan');
  const p = persons(r)[0];
  assert.notEqual(p.action, 'new', 'an unreadable birthdate proves nothing, so this is not a second child');
  assert.ok(!p.told_apart, 'never told apart on a fabricated date');
});

// ---------------------------------------------------------------------------
// Finding 22: a full name listed in two rows is not an ambiguous short form
// ---------------------------------------------------------------------------

test('nicknames > full names in two rows are not ambiguous; shared short forms are', () => {
  for (const n of ['Joseph', 'John', 'Elizabeth', 'Nicholas', 'Joe', 'Liz', 'Nick', 'Johnny', 'Libby', 'Nico'])
    assert.equal(matching.nicknameAmbiguous(n), false, n);
  for (const n of ['Chris', 'Pat', 'Alex', 'Sam', 'Kate', 'Jon', 'Max', 'Ted', 'Al', 'Fran'])
    assert.equal(matching.nicknameAmbiguous(n), true, n);
});

test('nicknames > Joseph/Joe, Elizabeth/Liz, Nicholas/Nick, John/Johnny with one birthdate are definitive', () => {
  for (const [a, b] of [['Joseph', 'Joe'], ['Elizabeth', 'Liz'], ['Nicholas', 'Nick'], ['John', 'Johnny'], ['Elizabeth', 'Libby']]) {
    const s = strict(
      { given_name: a, family_name: 'Smith', date_of_birth: '2015-03-04' },
      { given_name: b, family_name: 'Smith', date_of_birth: '2015-03-04' });
    assert.equal(s.definitive, true, `${a}/${b}`);
  }
  // Chris is still Christopher OR Christine: twins, one birthday.
  const chris = strict(
    { given_name: 'Christine', family_name: 'Smith', date_of_birth: '2015-03-04' },
    { given_name: 'Chris', family_name: 'Smith', date_of_birth: '2015-03-04' });
  assert.equal(chris.definitive, false);
});

// ---------------------------------------------------------------------------
// Findings 14 and 15: routes, numbered roads and buildings are part of the
// address; two spellings of one unit are one unit
// ---------------------------------------------------------------------------

test('address > route, county road, highway contract and building numbers tell places apart', () => {
  for (const [a, b] of [
    ['RR 2 Box 15', 'RR 3 Box 15'],
    ['HC 61 Box 20', 'HC 62 Box 20'],
    ['55 County Road 12', '55 County Road 21'],
    ['500 Oak St Bldg 3 Apt 12', '500 Oak St Bldg 4 Apt 12'],
    ['12 W 5th St', '12 W 6th St'],
    ['134 Pine St', '106 Pine St'],
    ['12 Main St Apt 4', '12 Main St Apt 7'],
    ['PO Box 12', 'PO Box 13'],
    ['123A Main St', '123 Main St'],
    ['123A Main St', '123B Main St'],
    ['123A Main St', '123 Main St Apt B'],
  ]) {
    assert.ok(matching.addressSimilarity(a, b) <= 0.5, `${a} vs ${b}`);
    const s = strict(
      { given_name: 'Jose', family_name: 'Garcia', address_line1: a },
      { given_name: 'Jose', family_name: 'Garcia', address_line1: b });
    assert.equal(s.definitive, false, `${a} vs ${b}`);
  }
});

test('address > the same place written two ways is still the same place', () => {
  for (const [a, b] of [
    ['12 Oak St Apt 4-B', '12 Oak St Apt 4B'],
    ['12 Oak St Apt 4 B', '12 Oak St Apt 4B'],
    ['12 Oak St #4B', '12 Oak St Apt 4B'],
    ['12 Oak St Unit 4', '12 Oak St Apt 4'],
    ['RR 2 Box 15', 'RR 2 Box 15'],
    ['55 County Road 12', '55 County Rd 12'],
    ['500 Oak St Bldg 3 Apt 12', '500 Oak Street Bldg 3 Apt 12'],
    ['12 Main St Apt 4', '12 Main Street'],
  ]) {
    assert.ok(matching.addressSimilarity(a, b) > 0.85, `${a} vs ${b}`);
    const s = strict(
      { given_name: 'Mary', family_name: 'Lee', address_line1: a },
      { given_name: 'Mary', family_name: 'Lee', address_line1: b });
    assert.equal(s.definitive, true, `${a} vs ${b}`);
  }
});

test('address > a house-number letter against a matching unit letter is not a different place, but not proof either', () => {
  const sim = matching.addressSimilarity('123A Main St', '123 Main St Apt A');
  assert.ok(sim > 0.65 && sim <= 0.85, `got ${sim}`);
  const s = strict(
    { given_name: 'Mary', family_name: 'Lee', address_line1: '123A Main St' },
    { given_name: 'Mary', family_name: 'Lee', address_line1: '123 Main St Apt A' });
  assert.equal(s.definitive, false);
  assert.ok(s.reasons.includes('similar_address'));
});

test('roster > a unit re-spelled with new email and phone is never a second person', t => {
  const ctx = setup(t);
  const headers = ['First Name', 'Last Name', 'Email', 'Phone', 'Address', 'City', 'State', 'Zip'];
  run(ctx, { sheets: [{ headers, rows: [['Mary', 'Lee', 'mary@example.org', '512-555-0101', '12 Oak St Apt 4-B', 'Austin', 'TX', '78701']] }] }, 'commit');
  const r = run(ctx, { sheets: [{ headers, rows: [['Mary', 'Lee', 'mlee@example.net', '512-555-0199', '12 Oak St Apt 4B', 'Austin', 'TX', '78701']] }] }, 'plan');
  assert.equal(byName(r, 'Mary')[0].action, 'matched');
});
