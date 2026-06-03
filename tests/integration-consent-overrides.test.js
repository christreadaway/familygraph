'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { newDb, newSecrets, cleanup } = require('./_helpers');
const people = require('../server/identity/people');
const consents = require('../server/integration/consents');
const objects = require('../server/integration/objects');
const history = require('../server/identity/history');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets };
}

test('overrides > setOverride creates a per-school row and effective merges it on the base', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  consents.set(db, p, { photoConsent: 'allow', directoryListing: 'allow' });
  consents.setOverride(db, p, 'st-theresa', { photoConsent: 'deny' });

  // Base unchanged.
  const base = consents.get(db, p);
  assert.equal(base.photo_consent, 'allow');

  // Effective at st-theresa: deny photos, but directory still allow (base).
  const eff = consents.effective(db, p, 'st-theresa');
  assert.equal(eff.photo_consent, 'deny');
  assert.equal(eff.directory_listing, 'allow');
  assert.equal(eff.override_applied, true);
  assert.equal(eff.base_photo_consent, 'allow');

  // Effective at another school: no override → straight base.
  const elsewhere = consents.effective(db, p, 'st-johns');
  assert.equal(elsewhere.photo_consent, 'allow');
  assert.equal(elsewhere.override_applied, false);
});

test('overrides > a school can override only one of the two fields', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  consents.set(db, p, { photoConsent: 'allow', directoryListing: 'allow' });
  consents.setOverride(db, p, 'st-theresa', { directoryListing: 'deny' });
  const eff = consents.effective(db, p, 'st-theresa');
  assert.equal(eff.photo_consent, 'allow');     // from base
  assert.equal(eff.directory_listing, 'deny');  // from override
  const over = consents.getOverride(db, p, 'st-theresa');
  assert.equal(over.photo_consent, null);
  assert.equal(over.directory_listing, 'deny');
});

test('overrides > clearOverride removes the row when both fields end up null', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  consents.setOverride(db, p, 'st-theresa', { photoConsent: 'deny' });
  consents.clearOverride(db, p, 'st-theresa');
  assert.equal(consents.getOverride(db, p, 'st-theresa'), null);
  // Effective falls back to the base default.
  const eff = consents.effective(db, p, 'st-theresa');
  assert.equal(eff.photo_consent, 'allow');
  assert.equal(eff.override_applied, false);
});

test('overrides > listOverridesForPerson returns one row per school', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  consents.setOverride(db, p, 'st-theresa', { photoConsent: 'deny' });
  consents.setOverride(db, p, 'st-johns', { photoConsent: 'group_only' });
  const list = consents.listOverridesForPerson(db, p);
  assert.equal(list.length, 2);
  const schools = list.map(o => o.school_id).sort();
  assert.deepEqual(schools, ['st-johns', 'st-theresa']);
});

test('overrides > setOverride writes an entity_changes row', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  consents.setOverride(db, p, 'st-theresa', { photoConsent: 'deny' }, { actor: 'unit' });
  const hist = history.listFor(db, 'consent_override', `${p}/st-theresa`);
  assert.equal(hist[0].operation, 'create');
  assert.equal(hist[0].actor, 'unit');
});

test('overrides > consentObject(schoolId) returns the effective shape', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  consents.set(db, p, { photoConsent: 'allow', directoryListing: 'allow' });
  consents.setOverride(db, p, 'st-theresa', { photoConsent: 'group_only' });
  const obj = objects.consentObject(db, p, 'st-theresa');
  assert.equal(obj.schoolId, 'st-theresa');
  assert.equal(obj.photoConsent, 'group_only');
  assert.equal(obj.directoryListing, 'allow');
  assert.equal(obj.overrideApplied, true);
  assert.equal(obj.basePhotoConsent, 'allow');
});

test('overrides > consentObject without schoolId returns the base unchanged', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  consents.set(db, p, { photoConsent: 'group_only' });
  const obj = objects.consentObject(db, p);
  assert.equal(obj.photoConsent, 'group_only');
  assert.equal(obj.overrideApplied, false);
  assert.equal(obj.schoolId, null);
});

test('overrides > listChangedPersonCodes picks up override updates', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  const cursor = new Date().toISOString();
  // Make sure the next write strictly exceeds the cursor.
  await new Promise(r => setTimeout(r, 2));
  consents.setOverride(db, p, 'st-theresa', { photoConsent: 'deny' });
  const codes = consents.listChangedPersonCodes(db, cursor);
  assert.ok(codes.includes(p));
});
