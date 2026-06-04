'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { newDb, newSecrets, cleanup } = require('./_helpers');
const people = require('../server/identity/people');
const consents = require('../server/integration/consents');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets };
}

test('consents > get returns the defaulted record when no row exists', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  const c = consents.get(db, p);
  assert.equal(c.photo_consent, 'allow');
  assert.equal(c.directory_listing, 'allow');
  assert.equal(c.defaulted, true);
});

test('consents > set creates and persists a row, get follows', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  const before = db.prepare('SELECT updated_at FROM persons WHERE code = ?').get(p);
  consents.set(db, p, { photoConsent: 'deny', directoryListing: 'deny' });
  const after = db.prepare('SELECT updated_at FROM persons WHERE code = ?').get(p);
  const c = consents.get(db, p);
  assert.equal(c.photo_consent, 'deny');
  assert.equal(c.directory_listing, 'deny');
  assert.equal(c.defaulted, false);
  assert.ok(after.updated_at >= before.updated_at, 'persons.updated_at should be bumped');
});

test('consents > set without one field keeps the existing value', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  consents.set(db, p, { photoConsent: 'group_only', directoryListing: 'deny' });
  consents.set(db, p, { photoConsent: 'allow' });
  const c = consents.get(db, p);
  assert.equal(c.photo_consent, 'allow');
  assert.equal(c.directory_listing, 'deny');
});

test('consents > set rejects invalid values', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  assert.throws(() => consents.set(db, p, { photoConsent: 'never' }), /invalid/);
  assert.throws(() => consents.set(db, p, { directoryListing: 'maybe' }), /invalid/);
});

test('consents > set throws when person is unknown', async t => {
  const { db } = setup(t);
  assert.throws(() => consents.set(db, 'p_deadbeef', { photoConsent: 'deny' }), /not found/);
});

test('consents > listChangedPersonCodes returns codes whose consent row was bumped', async t => {
  const { db, secrets } = setup(t);
  const a = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  const b = people.create(db, secrets, { given_name: 'B', family_name: 'X' });
  consents.set(db, a, { photoConsent: 'deny' });
  // Take the cursor just after A's write so only B's later write should
  // appear.
  const cursor = consents.get(db, a).updated_at;
  // Sleep a millisecond to ensure B's timestamp strictly exceeds the cursor.
  const wait = until => { while (new Date().toISOString() <= until) { /* spin */ } };
  wait(cursor);
  consents.set(db, b, { photoConsent: 'group_only' });
  const codes = consents.listChangedPersonCodes(db, cursor);
  assert.deepEqual(codes, [b]);
});
