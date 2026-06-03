'use strict';

// Tests for server/identity/history.js — the entity_changes log and
// the archive/reinstate round-trip on persons + families.

const test = require('node:test');
const assert = require('node:assert/strict');

const { newDb, newSecrets, cleanup } = require('./_helpers');
const people = require('../server/identity/people');
const families = require('../server/identity/families');
const history = require('../server/identity/history');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets };
}

test('history > record + listFor round-trips a change row', async t => {
  const { db } = setup(t);
  const code = history.record(db, {
    entityKind: 'person', entityCode: 'p_demo0001', operation: 'create',
    before: null, after: { code: 'p_demo0001', display_name: 'Demo' },
    actor: 'unit-test',
  });
  assert.match(code, /^chg_/);
  const items = history.listFor(db, 'person', 'p_demo0001');
  assert.equal(items.length, 1);
  assert.equal(items[0].operation, 'create');
  assert.equal(items[0].actor, 'unit-test');
  assert.deepEqual(items[0].after, { code: 'p_demo0001', display_name: 'Demo' });
  assert.equal(items[0].before, null);
});

test('history > snapshot encodes BLOB columns as base64 without losing data', () => {
  const buf = Buffer.from([1, 2, 3, 4, 0xff]);
  const out = history.snapshot({ code: 'p_x', name_ct: buf });
  assert.match(out, /"name_ct":{"_ct":"[A-Za-z0-9+/=]+"}/);
  const parsed = JSON.parse(out);
  const decoded = Buffer.from(parsed.name_ct._ct, 'base64');
  assert.deepEqual(Array.from(decoded), Array.from(buf));
});

test('history > snapshot truncates rows above MAX_SNAPSHOT_BYTES', () => {
  const huge = { foo: 'x'.repeat(history.MAX_SNAPSHOT_BYTES + 100) };
  const out = JSON.parse(history.snapshot(huge));
  assert.equal(out._truncated, true);
  assert.ok(out._prefix.length < history.MAX_SNAPSHOT_BYTES);
});

test('history > rejects unknown entity kinds and operations', () => {
  const { newDb: nd, cleanup: cl } = require('./_helpers');
  const { db, dir } = nd();
  try {
    assert.throws(() => history.record(db, { entityKind: 'martian', entityCode: 'm_1', operation: 'create' }), /unknown kind/);
    assert.throws(() => history.record(db, { entityKind: 'person', entityCode: 'p_1', operation: 'rebrand' }), /unknown operation/);
  } finally {
    db.close(); cl(dir);
  }
});

test('history > sweep retires old rows but preserves the latest event per entity', async t => {
  const { db } = setup(t);
  // Two stale rows for the same entity: an older create and a slightly
  // newer update. The newer one is the latest and must survive even
  // though both are past the cutoff.
  db.prepare(
    `INSERT INTO entity_changes (code, entity_kind, entity_code, operation, created_at)
       VALUES ('chg_old00001', 'person', 'p_demo0001', 'create', '2000-01-01T00:00:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO entity_changes (code, entity_kind, entity_code, operation, created_at)
       VALUES ('chg_old00002', 'person', 'p_demo0001', 'archive', '2000-06-01T00:00:00.000Z')`
  ).run();
  // A stale row for a different entity. Its only history row is the
  // latest for that entity, so the floor preserves it too.
  db.prepare(
    `INSERT INTO entity_changes (code, entity_kind, entity_code, operation, created_at)
       VALUES ('chg_old00003', 'person', 'p_orphan01', 'create', '2000-01-01T00:00:00.000Z')`
  ).run();
  // And a fresh row that should never be swept regardless.
  history.record(db, { entityKind: 'person', entityCode: 'p_recent01', operation: 'create' });

  const removed = history.sweep(db, 30);
  assert.equal(removed, 1, 'only the superseded 2000-01 create is removed');
  const remaining = db.prepare(
    `SELECT code, entity_code FROM entity_changes ORDER BY created_at ASC`
  ).all();
  // Both per-entity floors survive + the fresh row.
  const surviving = remaining.map(r => r.code).sort();
  assert.deepEqual(surviving, ['chg_old00002', 'chg_old00003', remaining.find(r => r.entity_code === 'p_recent01').code].sort());
});

test('history > sweep is a no-op when nothing exceeds the cutoff', async t => {
  const { db } = setup(t);
  history.record(db, { entityKind: 'person', entityCode: 'p_recent01', operation: 'create' });
  const removed = history.sweep(db, 30);
  assert.equal(removed, 0);
});

test('history > effectiveRetentionDays reads the setting', async t => {
  const { db } = setup(t);
  assert.equal(history.effectiveRetentionDays(db, 90), 90);
  db.prepare(`INSERT INTO settings (key, value_json) VALUES (?, ?)`)
    .run('entity_changes_retention_days', JSON.stringify(30));
  assert.equal(history.effectiveRetentionDays(db), 30);
});

// -----------------------------------------------------------------------------
// people.archive / people.reinstate
// -----------------------------------------------------------------------------

test('people > archive flips status and writes a history row', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Demo', family_name: 'User' });
  const result = people.archive(db, p, { actor: 'unit', reason: 'graduated' });
  assert.equal(result.code, p);
  const got = people.get(db, secrets, p);
  assert.equal(got.status, 'archived');
  const hist = history.listFor(db, 'person', p);
  assert.equal(hist[0].operation, 'archive');
  assert.equal(hist[0].reason, 'graduated');
  assert.equal(hist[0].actor, 'unit');
  assert.equal(hist[0].before.status, 'active');
  assert.equal(hist[0].after.status, 'archived');
});

test('people > reinstate restores an archived person', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Demo', family_name: 'User' });
  people.archive(db, p, { actor: 'unit' });
  people.reinstate(db, p, { actor: 'unit', reason: 'returning' });
  assert.equal(people.get(db, secrets, p).status, 'active');
  const hist = history.listFor(db, 'person', p);
  assert.equal(hist[0].operation, 'reinstate');
  assert.equal(hist[1].operation, 'archive');
});

test('people > archive is idempotent on an already-archived row', async t => {
  const { db, secrets } = setup(t);
  const p = people.create(db, secrets, { given_name: 'Demo', family_name: 'User' });
  people.archive(db, p, { actor: 'unit' });
  const second = people.archive(db, p, { actor: 'unit' });
  assert.equal(second.noop, true);
  const hist = history.listFor(db, 'person', p);
  // Two archive rows, one of which is the no-op marker.
  const archiveOps = hist.filter(h => h.operation === 'archive');
  assert.equal(archiveOps.length, 2);
});

test('people > archive refuses to touch a merged row', async t => {
  const { db, secrets } = setup(t);
  const winner = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  const loser = people.create(db, secrets, { given_name: 'A', family_name: 'X' });
  people.merge(db, secrets, loser, winner);
  assert.throws(() => people.archive(db, loser), /merged/);
});

// -----------------------------------------------------------------------------
// families.archive / families.reinstate
// -----------------------------------------------------------------------------

test('families > archive and reinstate the household', async t => {
  const { db, secrets } = setup(t);
  const f = families.create(db, secrets, { display_name: 'Demo' });
  families.archive(db, f, { actor: 'unit' });
  assert.equal(families.get(db, secrets, f).status, 'archived');
  families.reinstate(db, f, { actor: 'unit' });
  assert.equal(families.get(db, secrets, f).status, 'active');
  const hist = history.listFor(db, 'family', f);
  const ops = hist.map(h => h.operation);
  assert.ok(ops.includes('archive'));
  assert.ok(ops.includes('reinstate'));
});
