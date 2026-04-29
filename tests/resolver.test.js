'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const resolver = require('../server/identity/resolver');
const people = require('../server/identity/people');
const importPipeline = require('../server/identity/import');
const conflictsMod = require('../server/identity/conflicts');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

test('resolver > exact name + DOB auto-merges', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const t_ = defaultThresholds();
  const a = people.create(db, s, { given_name: 'Mary', family_name: 'Smith', date_of_birth: '1985-04-12' });
  const r = resolver.resolveOrCreatePerson(db, s, t_, { given_name: 'Mary', family_name: 'Smith', date_of_birth: '1985-04-12' });
  assert.equal(r.action, 'attached');
  assert.equal(r.code, a);
});

test('resolver > similar names without DOB go to conflict queue', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const t_ = defaultThresholds();
  people.create(db, s, { given_name: 'Mary', family_name: 'Smith' });
  // Mary/Marie are now treated as nickname-equivalent across English/French
  // (NICKNAME_GROUPS in matching.js). Same surname + nickname → review.
  const r = resolver.resolveOrCreatePerson(db, s, t_, { given_name: 'Marie', family_name: 'Smith' });
  assert.equal(r.action, 'enqueued');
  const open = conflictsMod.list(db, { status: 'open' });
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'person');
});

test('resolver > exact same name without DOB also goes to conflict queue', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const t_ = defaultThresholds();
  people.create(db, s, { given_name: 'Pio', family_name: 'Pietrelcina' });
  const r = resolver.resolveOrCreatePerson(db, s, t_, { given_name: 'Pio', family_name: 'Pietrelcina' });
  // Without DOB or contact info, two identical-named records go to review,
  // not auto-merge — they could be father and son.
  assert.equal(r.action, 'enqueued');
});

test('resolver > exact email auto-merges across different last names (definitive)', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const t_ = defaultThresholds();
  const enc = require('../server/crypto/encryption');
  const contacts = require('../server/identity/contacts');

  const aCode = people.create(db, s, { given_name: 'Mary', family_name: 'Escamilla' });
  const ec = contacts.upsertEmail(db, s, 'mary@example.org');
  contacts.attachEmailToPerson(db, aCode, ec);

  const r = resolver.resolveOrCreatePerson(db, s, t_, {
    given_name: 'Mary', family_name: 'Torre', emails: ['mary@example.org'],
  });
  assert.equal(r.action, 'attached');
  assert.equal(r.code, aCode);
  assert.ok(r.reasons.includes('exact_email_match'));
});

test('resolver > address-only match auto-merges (same household, different last names)', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const t_ = defaultThresholds();

  const row1 = {
    family: { display_name: 'Smith-Torre' },
    persons: [{ given_name: 'Mary', family_name: 'Escamilla', role: 'parent' }],
    address: { line1: '123 Main Street', city: 'Lima', region: 'OH', postal: '45801' },
  };
  const r1 = importPipeline.importRow(db, s, t_, row1, { source: 'csv' });

  const row2 = {
    persons: [{ given_name: 'John', family_name: 'Torre', role: 'parent' }],
    address: { line1: '123 Main St', city: 'Lima', region: 'OH', postal: '45801' },
  };
  const r2 = importPipeline.importRow(db, s, t_, row2, { source: 'csv' });
  // Same household by address → John attaches to existing family.
  assert.equal(r2.family.code, r1.family.code);
});

test('resolver > unrelated person is created', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const t_ = defaultThresholds();
  people.create(db, s, { given_name: 'Mary', family_name: 'Smith' });
  const r = resolver.resolveOrCreatePerson(db, s, t_, { given_name: 'Karol', family_name: 'Wojtyła' });
  assert.equal(r.action, 'created');
});

test('resolver > family resolution attaches existing family when persons overlap', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const t_ = defaultThresholds();

  // Row 1 establishes the household. Mary carries a DOB so she's identifiable
  // across imports — the new scorer requires a definitive signal (email,
  // phone, name+DOB, or close address) before it'll auto-merge.
  const row1 = {
    family: { display_name: 'Smith' },
    persons: [
      { given_name: 'Mary', family_name: 'Smith', date_of_birth: '1985-04-12', role: 'parent' },
      { given_name: 'John', family_name: 'Smith', role: 'parent' },
    ],
    address: { line1: '12 Maple', city: 'Lima', region: 'OH', postal: '45801' },
  };
  const r1 = importPipeline.importRow(db, s, t_, row1, { source: 'csv' });
  assert.equal(r1.persons.length, 2);
  assert.ok(r1.family);

  const row2 = {
    family: { display_name: 'Smith' },
    persons: [
      // Same Mary — same DOB — definitive auto-merge.
      { given_name: 'Mary', family_name: 'Smith', date_of_birth: '1985-04-12', role: 'parent' },
      { given_name: 'Lucy', family_name: 'Smith', role: 'child' },
    ],
  };
  const r2 = importPipeline.importRow(db, s, t_, row2, { source: 'csv' });
  // Mary is auto-attached via name+DOB; Lucy is created. Since one of the
  // two persons already maps to row1's family, the family resolver attaches.
  assert.equal(r2.family.code, r1.family.code, 'family should be attached');
  assert.equal(r2.family.action, 'attached');
});

test('resolver > rescore creates conflicts for new dupes', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const t_ = defaultThresholds();
  const a = people.create(db, s, { given_name: 'Pio', family_name: 'Pietrelcina' });
  const b = people.create(db, s, { given_name: 'Pio', family_name: 'Pietrelcina' });
  const matches = resolver.rescorePerson(db, s, t_, b);
  assert.ok(matches.length >= 1);
  const open = conflictsMod.list(db, { status: 'open' });
  assert.ok(open.find(c => (c.left_code === b && c.right_code === a) || (c.left_code === a && c.right_code === b)));
});

test('resolver > similarity edge cases', () => {
  assert.equal(resolver.similarity('', ''), 0);
  assert.equal(resolver.similarity('abc', null), 0);
  assert.ok(resolver.similarity('abc', 'abc') === 1);
  assert.ok(resolver.similarity('Smith', 'Smyth') > 0.6);
});
