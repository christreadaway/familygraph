'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../server/identity/rules');
const resolver = require('../server/identity/resolver');
const people = require('../server/identity/people');
const conflicts = require('../server/identity/conflicts');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

test('rules > create + list', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  const c = rules.create(db, {
    kind: 'person',
    rule: { match: { given_name: 'Mary', family_name: 'Smith' }, action: 'never_merge' },
  });
  assert.match(c, /^rule_/);
  const list = rules.list(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].rule.action, 'never_merge');
});

test('rules > validation rejects bad action and missing weight', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  assert.throws(() => rules.create(db, { kind: 'person', rule: { match: {}, action: 'nope' } }));
  assert.throws(() => rules.create(db, { kind: 'person', rule: { match: {}, action: 'boost' } }));
  assert.throws(() => rules.create(db, { kind: 'person', rule: { action: 'never_merge' } }));
});

test('rules > never_merge override pushes a high-similarity match into the create branch', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  const th = defaultThresholds();
  t.after(() => { db.close(); cleanup(dir); });
  // Two distinct Smiths who otherwise look identical.
  people.create(db, s, { given_name: 'Mary', family_name: 'Smith', date_of_birth: '1985-04-12' });
  rules.create(db, {
    kind: 'person',
    rule: { match: { given_name: 'Mary', family_name: 'Smith' }, action: 'never_merge' },
  });
  const r = resolver.resolveOrCreatePerson(db, s, th, {
    given_name: 'Mary', family_name: 'Smith', date_of_birth: '1985-04-12',
  });
  assert.equal(r.action, 'created', 'never_merge should suppress auto-merge');
  // No conflict was opened either.
  const open = conflicts.list(db);
  assert.equal(open.length, 0);
});

test('rules > auto_merge override forces attachment of an otherwise low-confidence match', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  const th = defaultThresholds();
  t.after(() => { db.close(); cleanup(dir); });
  const a = people.create(db, s, { given_name: 'Karol', family_name: 'Wojtyła' });
  rules.create(db, {
    kind: 'person',
    rule: { match: { given_name: 'Karol', family_name: 'Wojtyła' }, action: 'auto_merge' },
  });
  // Note: the candidate is the existing person with the same name; the rule
  // says auto_merge -> the resolver attaches.
  const r = resolver.resolveOrCreatePerson(db, s, th, { given_name: 'Karol', family_name: 'Wojtyła' });
  assert.equal(r.code, a);
  assert.equal(r.action, 'attached');
});

test('rules > boost lifts a marginal match across the auto-merge line', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  const th = defaultThresholds();
  t.after(() => { db.close(); cleanup(dir); });
  const a = people.create(db, s, { given_name: 'Mary', family_name: 'Smith' });
  rules.create(db, {
    kind: 'person',
    rule: { match: { given_name: 'Mary', family_name: 'Smith' }, action: 'boost', weight: 0.5 },
  });
  const r = resolver.resolveOrCreatePerson(db, s, th, { given_name: 'Mary', family_name: 'Smith' });
  assert.equal(r.action, 'attached');
  assert.equal(r.code, a);
});

test('rules > applyToScore returns reasons even when no match', () => {
  const r = rules.applyToScore([], { score: 0.6, reasons: ['fn'] }, {}, {}, {});
  assert.equal(r.score, 0.6);
  assert.equal(r.override, null);
  assert.deepEqual(r.reasons, ['fn']);
});
