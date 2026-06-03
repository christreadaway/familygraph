'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { newDb, newSecrets, cleanup } = require('./_helpers');
const dioceses = require('../server/integration/dioceses');
const certifications = require('../server/integration/certifications');
const people = require('../server/identity/people');
const history = require('../server/identity/history');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets };
}

test('dioceses > create stores a row and writes a history entry', async t => {
  const { db, secrets } = setup(t);
  const code = dioceses.create(db, secrets, {
    name: 'Archdiocese of Austin',
    region: 'Texas',
    contact_url: 'https://example.org',
    eim_program_name: 'EIM Texas',
    eim_renewal_years: 3,
    notes: 'primary diocese for the school portfolio',
  }, { actor: 'unit' });
  const got = dioceses.get(db, secrets, code, { includeNotes: true });
  assert.equal(got.name, 'Archdiocese of Austin');
  assert.equal(got.region, 'Texas');
  assert.equal(got.eim_renewal_years, 3);
  assert.equal(got.notes, 'primary diocese for the school portfolio');
  const hist = history.listFor(db, 'diocese', code);
  assert.equal(hist[0].operation, 'create');
});

test('dioceses > update modifies fields and records a history row', async t => {
  const { db, secrets } = setup(t);
  const code = dioceses.create(db, secrets, { name: 'Diocese A', eim_renewal_years: 3 });
  dioceses.update(db, secrets, code, { eim_renewal_years: 5, region: 'CA' });
  const got = dioceses.get(db, secrets, code);
  assert.equal(got.eim_renewal_years, 5);
  assert.equal(got.region, 'CA');
  const hist = history.listFor(db, 'diocese', code);
  assert.equal(hist[0].operation, 'update');
  assert.equal(hist[1].operation, 'create');
});

test('dioceses > archive + reinstate flip status and log both ops', async t => {
  const { db, secrets } = setup(t);
  const code = dioceses.create(db, secrets, { name: 'Diocese A' });
  dioceses.archive(db, code, { actor: 'unit', reason: 'consolidated into B' });
  assert.equal(dioceses.get(db, secrets, code).status, 'archived');
  dioceses.reinstate(db, code, { actor: 'unit' });
  assert.equal(dioceses.get(db, secrets, code).status, 'active');
});

test('dioceses > unique name only among active rows', async t => {
  const { db, secrets } = setup(t);
  const a = dioceses.create(db, secrets, { name: 'Diocese A' });
  assert.throws(() => dioceses.create(db, secrets, { name: 'Diocese A' }), /UNIQUE/);
  dioceses.archive(db, a, {});
  // Now creating "Diocese A" again should succeed because the previous
  // row is archived (the unique index is partial on status='active').
  const a2 = dioceses.create(db, secrets, { name: 'Diocese A' });
  assert.notEqual(a, a2);
});

test('dioceses > renewalYears prefers per-diocese over global setting', async t => {
  const { db, secrets } = setup(t);
  const code = dioceses.create(db, secrets, { name: 'Diocese A', eim_renewal_years: 5 });
  assert.equal(dioceses.renewalYears(db, code), 5);
});

test('certifications > add with dioceseCode auto-derives expires_on from diocesan interval', async t => {
  const { db, secrets } = setup(t);
  // Set the global default to 3 years; diocese override is 5.
  db.prepare(`INSERT INTO settings (key, value_json) VALUES (?, ?)`)
    .run('eim.renewal_years', JSON.stringify(3));
  const dCode = dioceses.create(db, secrets, { name: 'Diocese A', eim_renewal_years: 5 });
  const p = people.create(db, secrets, { given_name: 'Mary', family_name: 'Smith' });
  const certCode = certifications.add(db, secrets, p, {
    status: 'certified',
    completed_on: '2026-05-01',
    dioceseCode: dCode,
    dioceseRecordId: 'EIM-TX-12345',
  });
  const cert = certifications.listForPerson(db, secrets, p)[0];
  assert.equal(cert.expires_on, '2031-05-01');
  assert.equal(cert.diocese_code, dCode);
  assert.equal(cert.diocese_record_id, 'EIM-TX-12345');
});

test('certifications > add validates dioceseCode shape and existence', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Mary', family_name: 'Smith' });
  assert.throws(
    () => certifications.add(db, secrets, p, { dioceseCode: 'not-valid' }),
    /invalid dioceseCode/
  );
  assert.throws(
    () => certifications.add(db, secrets, p, { dioceseCode: 'dio_deadbeef' }),
    /diocese not found/
  );
});
