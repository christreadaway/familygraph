'use strict';

// Tests for server/integration/objects.js — the shape converters that turn
// FG rows into the Integration contract objects (§6.1, §6.2, §6.3).

const test = require('node:test');
const assert = require('node:assert/strict');

const { newDb, newSecrets, cleanup } = require('./_helpers');
const people = require('../server/identity/people');
const families = require('../server/identity/families');
const contacts = require('../server/identity/contacts');
const consents = require('../server/integration/consents');
const objects = require('../server/integration/objects');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets };
}

test('objects > personObject returns the §6.1 shape with primary+additional emails', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, {
    given_name: 'Amanda', family_name: 'Lee', preferred_name: 'Mandy',
    date_of_birth: '1985-04-12', kind: 'adult',
  });
  const e1 = contacts.upsertEmail(db, secrets, 'amanda@example.com');
  const e2 = contacts.upsertEmail(db, secrets, 'amanda2@example.com');
  contacts.attachEmailToPerson(db, p, e1, { isPrimary: true });
  contacts.attachEmailToPerson(db, p, e2, { isPrimary: false });
  const ph = contacts.upsertPhone(db, secrets, '(512) 555-0101', { kind: 'mobile', smsConsent: true });
  contacts.attachPhoneToPerson(db, p, ph, { isPrimary: true });

  const obj = objects.personObject(db, secrets, p);
  assert.equal(obj.personId, p);
  assert.equal(obj.primaryEmail, 'amanda@example.com');
  assert.deepEqual(obj.additionalEmails, ['amanda2@example.com']);
  assert.equal(obj.phones.length, 1);
  assert.equal(obj.phones[0].e164, '+15125550101');
  assert.equal(obj.phones[0].type, 'mobile');
  assert.equal(obj.phones[0].smsConsent, true);
  assert.equal(obj.firstName, 'Amanda');
  assert.equal(obj.lastName, 'Lee');
  assert.equal(obj.preferredName, 'Mandy');
  assert.equal(obj.dateOfBirth, '1985-04-12');
  assert.equal(obj.kind, 'adult');
  assert.equal(obj.active, true);
});

test('objects > personObject is null for an unknown code', async t => {
  const { db, secrets } = setup(t);
  assert.equal(objects.personObject(db, secrets, 'p_deadbeef'), null);
});

test('objects > personObject falls back to family mailing address when no personal one is set', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  const f = families.create(db, secrets, { display_name: 'Lee' });
  families.addMember(db, secrets, f, p, { role: 'parent', relationLabel: 'mother', custody: 'joint' });
  const ac = contacts.upsertAddress(db, secrets, {
    line1: '123 Main St', city: 'Austin', region: 'TX', postal: '78701', country: 'US',
  });
  contacts.attachAddressToFamily(db, f, ac, { label: 'home', isPrimary: true });

  const obj = objects.personObject(db, secrets, p);
  assert.equal(obj.mailingAddress.line1, '123 Main St');
  assert.equal(obj.mailingAddress.city, 'Austin');
  assert.equal(obj.mailingAddress.state, 'TX');
  assert.equal(obj.mailingAddress.postal, '78701');
});

test('objects > householdObject returns members with relation_label + custodial bool', async t => {
  const { db, secrets } = setup(t);
  const f = families.create(db, secrets, { display_name: 'Lee' });
  const mom = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee', kind: 'adult' });
  const dad = people.create(db, secrets, { given_name: 'Tim', family_name: 'Lee', kind: 'adult' });
  const kid = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  families.addMember(db, secrets, f, mom, { role: 'parent', relationLabel: 'mother', custody: 'joint' });
  families.addMember(db, secrets, f, dad, { role: 'parent', relationLabel: 'father', custody: 'joint' });
  families.addMember(db, secrets, f, kid, { role: 'child', relationLabel: 'child' });
  families.update(db, secrets, f, { primary_contact_person_code: mom, communication_language: 'en' });

  const h = objects.householdObject(db, secrets, f);
  assert.equal(h.householdId, f);
  assert.equal(h.members.length, 3);
  const byRole = Object.fromEntries(h.members.map(m => [m.role, m]));
  assert.ok(byRole.mother);
  assert.equal(byRole.mother.personId, mom);
  assert.equal(byRole.mother.custodial, true);
  assert.equal(byRole.father.custodial, true);
  assert.equal(byRole.child.personId, kid);
  assert.equal(byRole.child.custodial, false);
  assert.equal(h.primaryContactPersonId, mom);
  assert.equal(h.communicationLanguage, 'en');
});

test('objects > householdObject falls back to first adult when no primary is pinned', async t => {
  const { db, secrets } = setup(t);
  const f = families.create(db, secrets, {});
  const mom = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee', kind: 'adult' });
  const kid = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee', kind: 'child' });
  families.addMember(db, secrets, f, mom, { role: 'parent', relationLabel: 'mother', custody: 'joint' });
  families.addMember(db, secrets, f, kid, { role: 'child', relationLabel: 'child' });
  const h = objects.householdObject(db, secrets, f);
  assert.equal(h.primaryContactPersonId, mom);
  assert.equal(h.communicationLanguage, 'en');
});

test('objects > consentObject defaults to allow/allow for an unset person', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  const c = objects.consentObject(db, p);
  assert.equal(c.photoConsent, 'allow');
  assert.equal(c.directoryListing, 'allow');
});

test('objects > consentObject reflects an explicit override', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Annie', family_name: 'Lee' });
  consents.set(db, p, { photoConsent: 'group_only', directoryListing: 'deny' });
  const c = objects.consentObject(db, p);
  assert.equal(c.photoConsent, 'group_only');
  assert.equal(c.directoryListing, 'deny');
});

test('objects > personByEmail resolves to active person via normalized hash', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  const e = contacts.upsertEmail(db, secrets, 'Amanda@Example.COM');
  contacts.attachEmailToPerson(db, p, e, { isPrimary: true });
  assert.equal(objects.personByEmail(db, secrets, 'amanda@example.com'), p);
  assert.equal(objects.personByEmail(db, secrets, ' AMANDA@example.com '), p);
  assert.equal(objects.personByEmail(db, secrets, 'unknown@example.com'), null);
});

test('objects > householdForPerson returns the active membership', async t => {
  const { db, secrets } = setup(t);
  const f = families.create(db, secrets, {});
  const p = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  families.addMember(db, secrets, f, p, { role: 'parent', relationLabel: 'mother', custody: 'joint' });
  assert.equal(objects.householdForPerson(db, p), f);
});

test('objects > roleToInternal maps app labels to internal roles', () => {
  assert.equal(objects.roleToInternal('mother'), 'parent');
  assert.equal(objects.roleToInternal('father'), 'parent');
  assert.equal(objects.roleToInternal('step_parent'), 'parent');
  assert.equal(objects.roleToInternal('guardian'), 'guardian');
  assert.equal(objects.roleToInternal('grandparent'), 'grandparent');
  assert.equal(objects.roleToInternal('child'), 'child');
  assert.equal(objects.roleToInternal('other'), 'other_adult');
  assert.equal(objects.roleToInternal('alien'), null);
});

test('objects > relation_label falls back when memberships predate the contract', async t => {
  const { db, secrets } = setup(t);
  const f = families.create(db, secrets, {});
  const p = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  // Add without relation_label (the pre-contract write path).
  families.addMember(db, secrets, f, p, { role: 'parent', custody: 'joint' });
  const h = objects.householdObject(db, secrets, f);
  // 'parent' bucket has no app-label preference; falls back to 'other'.
  assert.equal(h.members[0].role, 'other');
  assert.equal(h.members[0].custodial, true);
});
