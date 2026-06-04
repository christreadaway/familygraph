'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { newDb, newSecrets, cleanup } = require('./_helpers');
const people = require('../server/identity/people');
const certs = require('../server/integration/certifications');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets };
}

test('certifications > add records a row and promotes the cert to current', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Mary', family_name: 'Smith' });
  certs.add(db, secrets, p, {
    status: 'certified',
    completed_on: '2026-05-01',
    expires_on: '2029-05-01',
    source: 'diocese-of-austin',
    notes: 'completed online module',
  });
  const list = certs.listForPerson(db, secrets, p, { includePii: true });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'certified');
  assert.equal(list[0].completed_on, '2026-05-01');
  assert.equal(list[0].expires_on, '2029-05-01');
  assert.equal(list[0].source, 'diocese-of-austin');
  assert.equal(list[0].notes, 'completed online module');
  const person = db.prepare('SELECT eim_status, eim_completed_on, eim_expires_on FROM persons WHERE code = ?').get(p);
  assert.equal(person.eim_status, 'certified');
  assert.equal(person.eim_completed_on, '2026-05-01');
  assert.equal(person.eim_expires_on, '2029-05-01');
});

test('certifications > add auto-derives expiration from renewal years setting', async t => {
  const { db, secrets } = setup(t);
  db.prepare(`INSERT INTO settings (key, value_json) VALUES (?, ?)`)
    .run('eim.renewal_years', JSON.stringify(5));
  const p = people.create(db, secrets, { given_name: 'Mary', family_name: 'Smith' });
  certs.add(db, secrets, p, { status: 'certified', completed_on: '2026-05-01' });
  const list = certs.listForPerson(db, secrets, p);
  assert.equal(list[0].expires_on, '2031-05-01');
});

test('certifications > later expiration supplants the current cert', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Mary', family_name: 'Smith' });
  certs.add(db, secrets, p, { status: 'certified', completed_on: '2023-05-01', expires_on: '2026-05-01' });
  certs.add(db, secrets, p, { status: 'certified', completed_on: '2026-05-01', expires_on: '2029-05-01' });
  const person = db.prepare('SELECT eim_expires_on FROM persons WHERE code = ?').get(p);
  assert.equal(person.eim_expires_on, '2029-05-01');
});

test('certifications > backfilling an expired historical row does not demote a current cert', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Mary', family_name: 'Smith' });
  certs.add(db, secrets, p, { status: 'certified', completed_on: '2026-05-01', expires_on: '2029-05-01' });
  certs.add(db, secrets, p, { status: 'expired', completed_on: '2020-01-01', expires_on: '2023-01-01' });
  const person = db.prepare('SELECT eim_status, eim_expires_on FROM persons WHERE code = ?').get(p);
  assert.equal(person.eim_status, 'certified');
  assert.equal(person.eim_expires_on, '2029-05-01');
});

test('certifications > rejects invalid status and bad date format', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Mary', family_name: 'Smith' });
  assert.throws(() => certs.add(db, secrets, p, { status: 'maybe' }), /invalid status/);
  assert.throws(() => certs.add(db, secrets, p, { status: 'certified', completed_on: 'May 1, 2026' }), /invalid date/);
});

test('certifications > throws on missing person', async t => {
  const { db, secrets } = setup(t);
  assert.throws(() => certs.add(db, secrets, 'p_deadbeef', { status: 'certified' }), /not found|invalid/);
});
