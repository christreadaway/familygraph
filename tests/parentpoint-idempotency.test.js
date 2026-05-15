'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { newDb, cleanup } = require('./_helpers');
const idem = require('../server/parentpoint/idempotency');

function setup(t) {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  return { db };
}

test('idempotency > lookup returns null for a fresh key', async t => {
  const { db } = setup(t);
  const out = idem.lookup(db, { requestId: 'pp_1', method: 'POST', path: '/v1/persons' });
  assert.equal(out, null);
});

test('idempotency > record + lookup round-trip the response', async t => {
  const { db } = setup(t);
  idem.record(db, { requestId: 'pp_1', method: 'POST', path: '/v1/persons', status: 201, body: { ok: true, code: 'p_a' } });
  const out = idem.lookup(db, { requestId: 'pp_1', method: 'POST', path: '/v1/persons' });
  assert.equal(out.status, 201);
  assert.deepEqual(out.body, { ok: true, code: 'p_a' });
});

test('idempotency > different methods or paths under the same id are independent', async t => {
  const { db } = setup(t);
  idem.record(db, { requestId: 'pp_1', method: 'POST', path: '/v1/persons', status: 201, body: { a: 1 } });
  idem.record(db, { requestId: 'pp_1', method: 'PATCH', path: '/v1/persons', status: 200, body: { b: 2 } });
  const a = idem.lookup(db, { requestId: 'pp_1', method: 'POST', path: '/v1/persons' });
  const b = idem.lookup(db, { requestId: 'pp_1', method: 'PATCH', path: '/v1/persons' });
  assert.deepEqual(a.body, { a: 1 });
  assert.deepEqual(b.body, { b: 2 });
});

test('idempotency > expired keys are dropped on lookup', async t => {
  const { db } = setup(t);
  // Insert a row directly with an expires_at in the past.
  db.prepare(
    `INSERT INTO pp_idempotency_keys (request_id, method, path, response_code, response_body, expires_at)
     VALUES ('pp_old', 'POST', '/v1/persons', 201, '{"old":true}', '2000-01-01T00:00:00.000Z')`
  ).run();
  const out = idem.lookup(db, { requestId: 'pp_old', method: 'POST', path: '/v1/persons' });
  assert.equal(out, null);
  const row = db.prepare(`SELECT 1 FROM pp_idempotency_keys WHERE request_id = 'pp_old'`).get();
  assert.equal(row, undefined);
});

test('idempotency > sweep clears expired rows', async t => {
  const { db } = setup(t);
  db.prepare(
    `INSERT INTO pp_idempotency_keys (request_id, method, path, response_code, response_body, expires_at)
     VALUES ('a', 'POST', '/v1/x', 201, '{}', '2000-01-01T00:00:00.000Z'),
            ('b', 'POST', '/v1/x', 201, '{}', '2099-01-01T00:00:00.000Z')`
  ).run();
  const removed = idem.sweep(db);
  assert.equal(removed, 1);
  const remaining = db.prepare(`SELECT request_id FROM pp_idempotency_keys`).all().map(r => r.request_id);
  assert.deepEqual(remaining, ['b']);
});
