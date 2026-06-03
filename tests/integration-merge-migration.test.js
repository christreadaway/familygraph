'use strict';

// Verify that a person merge moves all the Integration-contract tables
// (person_consents, person_consent_overrides, eim_certifications,
// school_contexts) onto the winner. Pre-fix these rows were orphaned
// on the loser code — the alias chain made the loser unreadable but
// the override rows stayed unreachable from `listOverridesForPerson`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { newDb, newSecrets, cleanup } = require('./_helpers');
const people = require('../server/identity/people');
const consents = require('../server/integration/consents');
const certifications = require('../server/integration/certifications');
const schoolContext = require('../server/integration/schoolContext');
const history = require('../server/identity/history');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets };
}

test('merge > person_consents on loser are merged into winner with more-restrictive precedence', async t => {
  const { db, secrets } = setup(t);
  const a = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  const b = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  consents.set(db, a, { photoConsent: 'deny', directoryListing: 'allow' });
  consents.set(db, b, { photoConsent: 'allow', directoryListing: 'deny' });
  people.merge(db, secrets, a, b);
  const c = consents.get(db, b);
  // 'deny' beats 'allow' on both axes (more restrictive wins).
  assert.equal(c.photo_consent, 'deny');
  assert.equal(c.directory_listing, 'deny');
  // The loser row was removed; the winner has the merged row.
  const loser = db.prepare(`SELECT 1 FROM person_consents WHERE person_code = ?`).get(a);
  assert.equal(loser, undefined);
});

test('merge > person_consent_overrides on loser are re-pointed onto winner', async t => {
  const { db, secrets } = setup(t);
  const a = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  const b = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  consents.setOverride(db, a, 'st-theresa', { photoConsent: 'deny' });
  people.merge(db, secrets, a, b);
  const list = consents.listOverridesForPerson(db, b);
  assert.equal(list.length, 1);
  assert.equal(list[0].school_id, 'st-theresa');
  assert.equal(list[0].photo_consent, 'deny');
});

test('merge > overlapping consent_overrides for the same school resolve to the stricter value', async t => {
  const { db, secrets } = setup(t);
  const a = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  const b = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  consents.setOverride(db, a, 'st-theresa', { photoConsent: 'deny', directoryListing: 'allow' });
  consents.setOverride(db, b, 'st-theresa', { photoConsent: 'group_only', directoryListing: 'deny' });
  people.merge(db, secrets, a, b);
  const list = consents.listOverridesForPerson(db, b);
  assert.equal(list.length, 1);
  assert.equal(list[0].photo_consent, 'deny');     // deny > group_only
  assert.equal(list[0].directory_listing, 'deny'); // deny > allow
});

test('merge > eim_certifications history follows the winner', async t => {
  const { db, secrets } = setup(t);
  const a = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  const b = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  certifications.add(db, secrets, a, { status: 'certified', completed_on: '2024-01-01', expires_on: '2027-01-01' });
  certifications.add(db, secrets, b, { status: 'certified', completed_on: '2026-01-01', expires_on: '2029-01-01' });
  people.merge(db, secrets, a, b);
  const list = certifications.listForPerson(db, secrets, b);
  assert.equal(list.length, 2, 'both cert rows survive on the winner');
});

test('merge > school_contexts move to winner; conflicts keep the newer snapshot', async t => {
  const { db, secrets } = setup(t);
  const a = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  const b = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  schoolContext.upsert(db, a, { schoolId: 'st-theresa', grade: '3', activities: ['a'] });
  // Touch B with the same school slightly later. The "newer wins" rule
  // should keep B's grade ('4') because A's snapshot is older.
  await new Promise(r => setTimeout(r, 5));
  schoolContext.upsert(db, b, { schoolId: 'st-theresa', grade: '4', activities: ['b'] });
  // Also give A a unique-school snapshot so the re-point path is covered.
  schoolContext.upsert(db, a, { schoolId: 'st-johns', grade: '3' });
  people.merge(db, secrets, a, b);
  const list = schoolContext.listForPerson(db, b);
  assert.equal(list.length, 2);
  const byId = Object.fromEntries(list.map(r => [r.schoolId, r]));
  assert.equal(byId['st-theresa'].grade, '4', 'newer snapshot survives');
  assert.equal(byId['st-johns'].grade, '3', 'unique snapshot re-points');
});

test('merge > entity_changes log records the operation with the loser as a related code', async t => {
  const { db, secrets } = setup(t);
  const a = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  const b = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  people.merge(db, secrets, a, b, { actor: 'unit', reason: 'duplicate' });
  const hist = history.listFor(db, 'person', b);
  const merge = hist.find(h => h.operation === 'merge');
  assert.ok(merge, 'merge event present');
  assert.equal(merge.actor, 'unit');
  assert.equal(merge.reason, 'duplicate');
  assert.deepEqual(merge.related_codes, [a]);
});

test('merge > listOverridesForPerson on the winner returns the merged set', async t => {
  const { db, secrets } = setup(t);
  const a = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  const b = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  consents.setOverride(db, a, 'st-theresa', { photoConsent: 'deny' });
  consents.setOverride(db, b, 'st-johns', { photoConsent: 'group_only' });
  people.merge(db, secrets, a, b);
  const list = consents.listOverridesForPerson(db, b);
  const schools = list.map(o => o.school_id).sort();
  assert.deepEqual(schools, ['st-johns', 'st-theresa']);
});
