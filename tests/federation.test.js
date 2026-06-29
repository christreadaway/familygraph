'use strict';

// Tests for server/integration/federation.js — the fat, hex-keyed push that
// hydrates + reconciles consumers that can't pull (e.g. a cloud app while
// FamilyGraph runs on-prem behind a firewall).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { newDb, newSecrets, cleanup } = require('./_helpers');
const people = require('../server/identity/people');
const webhooks = require('../server/integration/webhooks');
const federation = require('../server/integration/federation');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets };
}

function row(db, code) {
  return db.prepare(`SELECT * FROM webhook_subscriptions WHERE code = ?`).get(code);
}

function setUpdatedAt(db, code, iso) {
  db.prepare(`UPDATE persons SET updated_at = ? WHERE code = ?`).run(iso, code);
}

// A sender stub that records every POST and returns a configurable result.
function recordingSender(result = { ok: true, status: 200 }) {
  const calls = [];
  const fn = async ({ url, body, headers }) => {
    calls.push({ url, headers, body: JSON.parse(body), raw: body });
    return typeof result === 'function' ? result(calls.length) : result;
  };
  fn.calls = calls;
  return fn;
}

test('federation > hydrates a new subscription with full hex-keyed person objects', async t => {
  const { db, secrets } = setup(t);
  const a = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee', kind: 'adult' });
  const b = people.create(db, secrets, { given_name: 'Brian', family_name: 'Lee', kind: 'adult' });

  const sub = webhooks.subscribe(db, secrets, {
    url: 'https://consumer.example/fg', secret: 'shh', federationPush: true,
  });
  const sender = recordingSender();
  await federation.reconcileAll(db, secrets, { sender });

  assert.equal(sender.calls.length, 1, 'one batch posted');
  const { body, headers } = sender.calls[0];
  assert.equal(body.type, 'federation.sync');
  assert.equal(body.hydration, true, 'first batch is flagged as hydration');
  const ids = body.persons.map(p => p.personId).sort();
  assert.deepEqual(ids, [a, b].sort(), 'every active person rides the batch, keyed by hex');
  // The hex is the canonical p_ code and the object carries full detail.
  const amanda = body.persons.find(p => p.personId === a);
  assert.match(amanda.personId, /^p_[0-9a-f]+$/, 'personId is the unique hex');
  assert.equal(amanda.firstName, 'Amanda');
  assert.equal(amanda.active, true);
  // Signed with the subscription secret, same scheme as the thin webhook.
  const expected = 'sha256=' + crypto.createHmac('sha256', 'shh').update(sender.calls[0].raw).digest('hex');
  assert.equal(headers['x-fg-signature'], expected);
  assert.equal(headers['x-fg-event'], 'federation.sync');

  // Cursor advanced + hydrated_at stamped; nothing left to push.
  const r = row(db, sub.code);
  assert.ok(r.hydrated_at, 'hydrated_at stamped after first successful push');
  const second = recordingSender();
  await federation.reconcileAll(db, secrets, { sender: second });
  assert.equal(second.calls.length, 0, 'no second batch once everything is pushed');
});

test('federation > only pushes the changed-since delta on later ticks', async t => {
  const { db, secrets } = setup(t);
  const a = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  setUpdatedAt(db, a, '2026-01-01T00:00:00.000Z');
  webhooks.subscribe(db, secrets, { url: 'https://c.example/fg', secret: 's', federationPush: true });

  await federation.reconcileAll(db, secrets, { sender: recordingSender() });

  // A new person changes after the first push.
  const b = people.create(db, secrets, { given_name: 'Brian', family_name: 'Lee' });
  setUpdatedAt(db, b, '2026-02-01T00:00:00.000Z');

  const sender = recordingSender();
  await federation.reconcileAll(db, secrets, { sender });
  assert.equal(sender.calls.length, 1);
  const ids = sender.calls[0].body.persons.map(p => p.personId);
  assert.deepEqual(ids, [b], 'only the newly-changed person is resent');
  assert.equal(sender.calls[0].body.hydration, false, 'later batches are deltas, not hydration');
});

test('federation > archived persons arrive as tombstones, never PII', async t => {
  const { db, secrets } = setup(t);
  const a = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  setUpdatedAt(db, a, '2026-01-01T00:00:00.000Z');
  webhooks.subscribe(db, secrets, { url: 'https://c.example/fg', secret: 's', federationPush: true });
  await federation.reconcileAll(db, secrets, { sender: recordingSender() });

  // Archive + bump updated_at so the delta picks it up.
  db.prepare(`UPDATE persons SET status = 'archived', updated_at = ? WHERE code = ?`)
    .run('2026-03-01T00:00:00.000Z', a);

  const sender = recordingSender();
  await federation.reconcileAll(db, secrets, { sender });
  const p = sender.calls[0].body.persons.find(x => x.personId === a);
  assert.equal(p.active, false, 'archived person is a tombstone');
  assert.equal(p.firstName, undefined, 'tombstone carries no name');
});

test('federation > a failed delivery does not advance the cursor (retried next tick)', async t => {
  const { db, secrets } = setup(t);
  const a = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  setUpdatedAt(db, a, '2026-01-01T00:00:00.000Z');
  const sub = webhooks.subscribe(db, secrets, { url: 'https://c.example/fg', secret: 's', federationPush: true });

  await federation.reconcileAll(db, secrets, { sender: recordingSender({ ok: false, status: 503 }) });
  let r = row(db, sub.code);
  assert.equal(r.reconcile_persons_cursor, null, 'cursor not advanced on failure');
  assert.equal(r.hydrated_at, null, 'not marked hydrated on failure');
  assert.equal(r.last_status, 'error');

  // Recovery: a later tick with a healthy consumer pushes the same record.
  const sender = recordingSender();
  await federation.reconcileAll(db, secrets, { sender });
  assert.equal(sender.calls.length, 1);
  assert.deepEqual(sender.calls[0].body.persons.map(p => p.personId), [a]);
});

test('federation > thin webhook subscriptions are left untouched by the pusher', async t => {
  const { db, secrets } = setup(t);
  people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  // A plain (thin) subscription — no federation flag.
  webhooks.subscribe(db, secrets, { url: 'https://thin.example/cb', secret: 's' });

  const sender = recordingSender();
  await federation.reconcileAll(db, secrets, { sender });
  assert.equal(sender.calls.length, 0, 'federation pusher ignores thin subscriptions');
});

test('federation > a federation subscription is excluded from thin per-change webhooks', async t => {
  const { db, secrets } = setup(t);
  const fed = webhooks.subscribe(db, secrets, { url: 'https://c.example/fg', federationPush: true });
  const thin = webhooks.subscribe(db, secrets, { url: 'https://t.example/cb' });

  const codes = webhooks.enqueue(db, secrets, { event: 'person.updated', personCode: 'p_x' });
  const subs = codes.map(c =>
    db.prepare(`SELECT subscription_code FROM webhook_deliveries WHERE code = ?`).get(c).subscription_code
  );
  assert.ok(subs.includes(thin.code), 'thin subscription still gets the notification');
  assert.ok(!subs.includes(fed.code), 'federation subscription does NOT get a thin notification');
});

test('federation > resync resets cursors so the next tick re-hydrates', async t => {
  const { db, secrets } = setup(t);
  const a = people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  setUpdatedAt(db, a, '2026-01-01T00:00:00.000Z');
  const sub = webhooks.subscribe(db, secrets, { url: 'https://c.example/fg', secret: 's', federationPush: true });
  await federation.reconcileAll(db, secrets, { sender: recordingSender() });

  assert.equal(federation.resync(db, sub.code), true);
  const r = row(db, sub.code);
  assert.equal(r.reconcile_persons_cursor, null);
  assert.equal(r.hydrated_at, null);

  const sender = recordingSender();
  await federation.reconcileAll(db, secrets, { sender });
  assert.equal(sender.calls.length, 1, 'everything re-sent after resync');
  assert.deepEqual(sender.calls[0].body.persons.map(p => p.personId), [a]);
  assert.equal(sender.calls[0].body.hydration, true);
});

test('federation > never persists batch PII in webhook_deliveries', async t => {
  const { db, secrets } = setup(t);
  people.create(db, secrets, { given_name: 'Amanda', family_name: 'Lee' });
  webhooks.subscribe(db, secrets, { url: 'https://c.example/fg', secret: 's', federationPush: true });
  await federation.reconcileAll(db, secrets, { sender: recordingSender() });
  const n = db.prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries`).get().n;
  assert.equal(n, 0, 'fat batches are materialized at send time, not stored');
});
