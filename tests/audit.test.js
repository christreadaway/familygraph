'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const audit = require('../server/audit');
const { newDb, cleanup } = require('./_helpers');

test('audit > redact strips PII keys', () => {
  const out = audit.redact({
    name: 'Mary Smith',
    email: 'mary@example.org',
    score: 0.92,
    nested: { phone: '4155550100', ok: true },
    list: [{ first_name: 'Mary' }],
  });
  assert.equal(out.name, '[redacted]');
  assert.equal(out.email, '[redacted]');
  assert.equal(out.score, 0.92);
  assert.equal(out.nested.phone, '[redacted]');
  assert.equal(out.nested.ok, true);
  assert.equal(out.list[0].first_name, '[redacted]');
});

test('audit > record + list', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  audit.record(db, { action: 'read_pii', actor: 'unit_test', entityCode: 'p_deadbeef' });
  audit.record(db, { action: 'merge', actor: 'operator', entityCode: 'p_deadbeef' });
  const list = audit.list(db);
  assert.equal(list.length, 2);
  const filtered = audit.list(db, { action: 'merge' });
  assert.equal(filtered.length, 1);
});

test('audit > tier-2 export consent is stored separately', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  audit.record(db, {
    tier: 2,
    action: 'export_consent',
    actor: 'demo-app',
    destination: 'board-report.csv',
    metadata: { entity_codes: ['f_a7b3c91d'] },
  });
  const t2 = db.prepare('SELECT * FROM audit_events WHERE tier = 2').all();
  assert.equal(t2.length, 1);
  assert.equal(t2[0].destination, 'board-report.csv');
});
