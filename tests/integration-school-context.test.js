'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { newDb, newSecrets, cleanup } = require('./_helpers');
const people = require('../server/identity/people');
const sc = require('../server/integration/schoolContext');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets };
}

test('schoolContext > upsert stores the §7.3 snapshot and returns it', async t => {
  const { db, secrets } = setup(t);
  const annie = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  const code = sc.upsert(db, annie, {
    schoolId: 'st-theresa',
    schoolYear: '2026-2027',
    grade: '3',
    classroomId: '3A',
    classroomName: 'Room 204 — Ms. Lee',
    activities: [
      { kind: 'sport', label: 'Basketball — Girls 4A', season: '2026-2027 Winter' },
      { kind: 'enrichment', label: 'Drama Camp (May 2026)', season: '2026-2027' },
    ],
    allergies: ['peanuts'],
  });
  assert.match(code, /^sc_/);
  const got = sc.getOne(db, annie, 'st-theresa');
  assert.equal(got.schoolYear, '2026-2027');
  assert.equal(got.grade, '3');
  assert.equal(got.classroomId, '3A');
  assert.equal(got.classroomName, 'Room 204 — Ms. Lee');
  assert.equal(got.activities.length, 2);
  assert.deepEqual(got.allergies, ['peanuts']);
  assert.equal(got.sourceApp, 'integration');
});

test('schoolContext > upsert overwrites the previous snapshot for (person, school)', async t => {
  const { db, secrets } = setup(t);
  const annie = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  sc.upsert(db, annie, { schoolId: 'st-theresa', grade: '3', activities: ['a'] });
  sc.upsert(db, annie, { schoolId: 'st-theresa', grade: '4', activities: ['b'] });
  const list = sc.listForPerson(db, annie);
  assert.equal(list.length, 1);
  assert.equal(list[0].grade, '4');
  assert.deepEqual(list[0].activities, ['b']);
});

test('schoolContext > a person can have one snapshot per school', async t => {
  const { db, secrets } = setup(t);
  const annie = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  sc.upsert(db, annie, { schoolId: 'st-theresa', grade: '3' });
  sc.upsert(db, annie, { schoolId: 'st-johns', grade: '4' });
  const list = sc.listForPerson(db, annie);
  assert.equal(list.length, 2);
});

test('schoolContext > requires schoolId', async t => {
  const { db, secrets } = setup(t);
  const annie = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  assert.throws(() => sc.upsert(db, annie, { grade: '3' }), /schoolId required/);
});

test('schoolContext > rejects unknown person', async t => {
  const { db } = setup(t);
  assert.throws(() => sc.upsert(db, 'p_deadbeef', { schoolId: 'x' }), /not found/);
});
