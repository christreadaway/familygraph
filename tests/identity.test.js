'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const people = require('../server/identity/people');
const families = require('../server/identity/families');
const contacts = require('../server/identity/contacts');
const aliases = require('../server/identity/aliases');
const relationships = require('../server/identity/relationships');
const { newDb, newSecrets, cleanup } = require('./_helpers');

test('identity > person create + read', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });

  const code = people.create(db, s, { given_name: 'Mary', family_name: 'Smith', date_of_birth: '1985-04-12' });
  const got = people.get(db, s, code, { includePii: true });
  assert.equal(got.given_name, 'Mary');
  assert.equal(got.family_name, 'Smith');
  assert.equal(got.display_name, 'Mary Smith');

  const safe = people.get(db, s, code, { includePii: false });
  assert.equal(safe.given_name, undefined);
  assert.equal(safe.code, code);
});

test('identity > findByName uses HMAC search', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const c1 = people.create(db, s, { given_name: 'Mary', family_name: 'Smith' });
  people.create(db, s, { given_name: 'John', family_name: 'Smith' });
  const found = people.findByName(db, s, 'mary', 'SMITH');
  assert.equal(found.length, 1);
  assert.equal(found[0].code, c1);
});

test('identity > family + members + contacts', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });

  const f = families.create(db, s, { display_name: 'Smith Household' });
  const p1 = people.create(db, s, { given_name: 'Mary', family_name: 'Smith' });
  const p2 = people.create(db, s, { given_name: 'John', family_name: 'Smith' });
  const p3 = people.create(db, s, { given_name: 'Lucy', family_name: 'Smith' });
  families.addMember(db, s, f, p1, { role: 'parent', custody: 'joint' });
  families.addMember(db, s, f, p2, { role: 'parent', custody: 'joint' });
  families.addMember(db, s, f, p3, { role: 'child' });

  const ec = contacts.upsertEmail(db, s, 'mary@example.org');
  contacts.attachEmailToPerson(db, p1, ec, { isPrimary: true });
  const ac = contacts.upsertAddress(db, s, { line1: '12 Maple St', city: 'Lima', region: 'OH', postal: '45801', country: 'US' });
  contacts.attachAddressToFamily(db, f, ac, { label: 'home', isPrimary: true });

  const m = families.members(db, s, f, { includePii: true });
  assert.equal(m.length, 3);
  assert.deepEqual(m.map(x => x.role).sort(), ['child', 'parent', 'parent']);

  const cb = contacts.familyContacts(db, s, f, { includePii: true });
  assert.equal(cb.addresses.length, 1);
  assert.equal(cb.addresses[0].line1, '12 Maple St');
  assert.equal(cb.emails.length, 1);
  assert.equal(cb.emails[0].value, 'mary@example.org');
});

test('identity > person merge preserves relationships and codes', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });

  const winner = people.create(db, s, { given_name: 'Mary', family_name: 'Smith' });
  const loser = people.create(db, s, { given_name: 'Mary', family_name: 'Smith', notes: 'duplicate' });
  const f = families.create(db, s);
  families.addMember(db, s, f, loser, { role: 'parent' });
  const ec = contacts.upsertEmail(db, s, 'mary.dup@example.org');
  contacts.attachEmailToPerson(db, loser, ec);

  people.merge(db, s, loser, winner);

  // The loser code resolves to winner via alias.
  assert.equal(aliases.resolveAlias(db, loser), winner);
  // get() transparently follows the alias.
  const got = people.get(db, s, loser, { includePii: true });
  assert.equal(got.code, winner);
  // Membership re-pointed.
  const m = families.members(db, s, f, { activeOnly: true });
  assert.equal(m.length, 1);
  assert.equal(m[0].person_code, winner);
  // Email attached to winner.
  const cb = contacts.familyContacts(db, s, f, { includePii: true });
  assert.ok(cb.emails.find(e => e.value === 'mary.dup@example.org'));
});

test('identity > family merge moves memberships, addresses, relationships', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const winner = families.create(db, s, { display_name: 'Smith' });
  const loser = families.create(db, s, { display_name: 'Smith dupe' });
  const p = people.create(db, s, { given_name: 'Mary', family_name: 'Smith' });
  families.addMember(db, s, loser, p, { role: 'parent' });
  const ac = contacts.upsertAddress(db, s, { line1: '1 Main', city: 'Lima', region: 'OH', postal: '45801' });
  contacts.attachAddressToFamily(db, loser, ac, { isPrimary: true });

  families.merge(db, s, loser, winner);
  assert.equal(aliases.resolveAlias(db, loser), winner);

  const m = families.members(db, s, winner, { activeOnly: true });
  assert.equal(m.length, 1);
  const cb = contacts.familyContacts(db, s, winner);
  assert.equal(cb.addresses.length, 1);
});

test('identity > family split creates new family and ends source memberships', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const f = families.create(db, s);
  const p1 = people.create(db, s, { given_name: 'Mom', family_name: 'X' });
  const p2 = people.create(db, s, { given_name: 'Dad', family_name: 'X' });
  const p3 = people.create(db, s, { given_name: 'Kid', family_name: 'X' });
  families.addMember(db, s, f, p1, { role: 'parent' });
  families.addMember(db, s, f, p2, { role: 'parent' });
  families.addMember(db, s, f, p3, { role: 'child' });

  const newF = families.split(db, s, f, [p2, p3], { displayName: 'Split' });
  assert.notEqual(newF, f);
  const oldMembers = families.members(db, s, f, { activeOnly: true });
  assert.equal(oldMembers.length, 1);
  assert.equal(oldMembers[0].person_code, p1);
  const newMembers = families.members(db, s, newF, { activeOnly: true });
  assert.equal(newMembers.length, 2);
});

test('identity > relationships symmetric', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const a = people.create(db, s, { given_name: 'A', family_name: 'X' });
  const b = people.create(db, s, { given_name: 'B', family_name: 'X' });
  relationships.add(db, a, b, 'spouse_of');
  const fromA = relationships.listFor(db, a);
  const fromB = relationships.listFor(db, b);
  assert.ok(fromA.find(r => r.from_code === a && r.to_code === b && r.kind === 'spouse_of'));
  assert.ok(fromB.find(r => r.from_code === b && r.to_code === a && r.kind === 'spouse_of'));
});

test('identity > alias chain follows transitively', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const a = people.create(db, s, { given_name: 'A', family_name: 'X' });
  const b = people.create(db, s, { given_name: 'B', family_name: 'X' });
  const c = people.create(db, s, { given_name: 'C', family_name: 'X' });
  people.merge(db, s, a, b);
  people.merge(db, s, b, c);
  // a -> b -> c collapse: a should resolve to c after both merges.
  assert.equal(aliases.resolveAlias(db, a), c);
});

test('identity > contacts are deduplicated by hash', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const e1 = contacts.upsertEmail(db, s, 'Alice@Example.org');
  const e2 = contacts.upsertEmail(db, s, 'alice@example.org');
  assert.equal(e1, e2, 'normalized emails should dedupe');
  const ph1 = contacts.upsertPhone(db, s, '+1 (415) 555-0100');
  const ph2 = contacts.upsertPhone(db, s, '4155550100');
  assert.equal(ph1, ph2);
  const ad1 = contacts.upsertAddress(db, s, { line1: '12 Maple St', city: 'Lima', region: 'OH', postal: '45801' });
  const ad2 = contacts.upsertAddress(db, s, { line1: '12 maple st', city: 'lima', region: 'oh', postal: '45801' });
  assert.equal(ad1, ad2);
});

test('identity > active membership uniqueness', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const f = families.create(db, s);
  const p = people.create(db, s, { given_name: 'X', family_name: 'Y' });
  families.addMember(db, s, f, p, { role: 'parent' });
  assert.throws(() => families.addMember(db, s, f, p, { role: 'parent' }));
});
