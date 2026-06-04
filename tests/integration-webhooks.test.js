'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { newDb, newSecrets, cleanup } = require('./_helpers');
const webhooks = require('../server/integration/webhooks');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets };
}

test('webhooks > subscribe stores a row and returns metadata', async t => {
  const { db, secrets } = setup(t);
  const sub = webhooks.subscribe(db, secrets, {
    url: 'https://us-central1-integration.cloudfunctions.net/familyGraphWebhook',
    secret: 'shhhh',
    events: '*',
    schoolHint: 'st-marys',
  });
  assert.match(sub.code, /^wh_/);
  assert.equal(sub.url, 'https://us-central1-integration.cloudfunctions.net/familyGraphWebhook');
  assert.equal(sub.events, '*');
  assert.equal(sub.school_hint, 'st-marys');
  assert.equal(sub.has_secret, true);
});

test('webhooks > subscribe rejects invalid url', async t => {
  const { db, secrets } = setup(t);
  assert.throws(() => webhooks.subscribe(db, secrets, { url: 'not-a-url' }), /invalid url/);
});

test('webhooks > subscribe rejects unknown event names', async t => {
  const { db, secrets } = setup(t);
  assert.throws(
    () => webhooks.subscribe(db, secrets, { url: 'https://x.example/cb', events: ['banana'] }),
    /unknown event/
  );
});

test('webhooks > sign produces sha256 HMAC over the body', () => {
  const sig = webhooks.sign('shhhh', '{"foo":1}');
  const want = `sha256=${crypto.createHmac('sha256', 'shhhh').update('{"foo":1}').digest('hex')}`;
  assert.equal(sig, want);
});

test('webhooks > enqueue creates a delivery for matching subscriptions only', async t => {
  const { db, secrets } = setup(t);
  const a = webhooks.subscribe(db, secrets, { url: 'https://x.example/cb1', events: '*' });
  const b = webhooks.subscribe(db, secrets, {
    url: 'https://x.example/cb2', events: ['person.updated'],
  });
  webhooks.subscribe(db, secrets, { url: 'https://x.example/cb3', events: ['household.updated'] });

  const codes = webhooks.enqueue(db, secrets, {
    event: 'person.updated', personCode: 'p_a', schoolHints: ['st-marys'],
  });
  assert.equal(codes.length, 2);
  // Verify both deliveries are pending.
  const deliveries = webhooks.listDeliveries(db, { status: 'pending' });
  assert.equal(deliveries.length, 2);
  const subCodes = deliveries.map(d => d.subscription_code).sort();
  assert.deepEqual(subCodes, [a.code, b.code].sort());
});

test('webhooks > enqueue respects the school_hint filter', async t => {
  const { db, secrets } = setup(t);
  webhooks.subscribe(db, secrets, { url: 'https://t.example/cb', schoolHint: 'st-marys' });
  webhooks.subscribe(db, secrets, { url: 'https://j.example/cb', schoolHint: 'st-johns' });
  // Hint doesn't include st-marys → only the no-hint and matching subs fire.
  const codes = webhooks.enqueue(db, secrets, {
    event: 'household.updated', familyCode: 'f_x', schoolHints: ['st-marys'],
  });
  assert.equal(codes.length, 1);
  // No hint at all → fan out to every sub regardless of school_hint
  const codes2 = webhooks.enqueue(db, secrets, { event: 'household.updated', familyCode: 'f_x' });
  assert.equal(codes2.length, 2);
});

test('webhooks > dispatchPending fires each pending row through the supplied sender', async t => {
  const { db, secrets } = setup(t);
  webhooks.subscribe(db, secrets, { url: 'https://x.example/cb', secret: 's', events: '*' });
  webhooks.enqueue(db, secrets, { event: 'person.updated', personCode: 'p_a' });
  const calls = [];
  const sender = async args => { calls.push(args); return { ok: true, status: 200 }; };
  const result = await webhooks.dispatchPending(db, secrets, { sender });
  assert.equal(result.length, 1);
  assert.equal(result[0].ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://x.example/cb');
  assert.equal(calls[0].headers['x-fg-signature'].startsWith('sha256='), true);
  assert.equal(calls[0].headers['x-fg-contract-version'], 'v0.1');
  // Body should be valid JSON shaped per the contract.
  const body = JSON.parse(calls[0].body);
  assert.equal(body.event, 'person.updated');
  assert.equal(body.personId, 'p_a');
  assert.ok(body.updatedAt);
  // Delivery should be marked sent.
  const sent = webhooks.listDeliveries(db, { status: 'sent' });
  assert.equal(sent.length, 1);
});

test('webhooks > dispatchPending backs off failed deliveries with exponential schedule', async t => {
  const { db, secrets } = setup(t);
  webhooks.subscribe(db, secrets, { url: 'https://x.example/cb', secret: 's' });
  webhooks.enqueue(db, secrets, { event: 'person.updated', personCode: 'p_a' });
  const sender = async () => { throw new Error('boom'); };
  await webhooks.dispatchPending(db, secrets, { sender });
  const row = webhooks.listDeliveries(db, {})[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /boom/);
  assert.ok(row.next_attempt_at, 'next_attempt_at should be set');
});

test('webhooks > dispatchPending gives up after MAX_ATTEMPTS', async t => {
  const { db, secrets } = setup(t);
  webhooks.subscribe(db, secrets, { url: 'https://x.example/cb', secret: 's' });
  const codes = webhooks.enqueue(db, secrets, { event: 'person.updated', personCode: 'p_a' });
  const code = codes[0];
  // Bump attempts to MAX_ATTEMPTS - 1 so the next failure trips 'failed'.
  db.prepare(`UPDATE webhook_deliveries SET attempts = ?, next_attempt_at = NULL WHERE code = ?`)
    .run(webhooks.MAX_ATTEMPTS - 1, code);
  const sender = async () => { throw new Error('still down'); };
  await webhooks.dispatchPending(db, secrets, { sender });
  const row = webhooks.listDeliveries(db, {}).find(r => r.code === code);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, webhooks.MAX_ATTEMPTS);
});

test('webhooks > unsubscribe soft-disables; the row + deliveries survive', async t => {
  const { db, secrets } = setup(t);
  const sub = webhooks.subscribe(db, secrets, { url: 'https://x.example/cb' });
  webhooks.enqueue(db, secrets, { event: 'person.updated', personCode: 'p_a' });
  assert.equal(webhooks.unsubscribe(db, sub.code), true);
  // Default list filters to active only — soft-disabled rows are hidden.
  assert.equal(webhooks.list(db, secrets).length, 0);
  // The row itself is still there under status='all'.
  const all = webhooks.list(db, secrets, { status: 'all' });
  assert.equal(all.length, 1);
  assert.equal(all[0].enabled, false);
  // Deliveries are NOT cascaded — the audit trail survives.
  assert.equal(webhooks.listDeliveries(db, {}).length, 1);
});

test('webhooks > resubscribe re-enables a soft-disabled subscription', async t => {
  const { db, secrets } = setup(t);
  const sub = webhooks.subscribe(db, secrets, { url: 'https://x.example/cb' });
  webhooks.unsubscribe(db, sub.code);
  assert.equal(webhooks.resubscribe(db, sub.code), true);
  const list = webhooks.list(db, secrets);
  assert.equal(list.length, 1);
  assert.equal(list[0].enabled, true);
});

test('webhooks > disabled subscription is skipped by the dispatcher', async t => {
  const { db, secrets } = setup(t);
  const sub = webhooks.subscribe(db, secrets, { url: 'https://x.example/cb', secret: 's' });
  webhooks.enqueue(db, secrets, { event: 'person.updated', personCode: 'p_a' });
  db.prepare(`UPDATE webhook_subscriptions SET enabled = 0 WHERE code = ?`).run(sub.code);
  const sender = async () => { throw new Error('should not fire'); };
  const out = await webhooks.dispatchPending(db, secrets, { sender });
  assert.deepEqual(out, []);
});
