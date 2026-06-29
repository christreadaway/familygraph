'use strict';

// ParentPoint outbound agent (Option A — "no open doors") tests.
//
// Covers: pairing config storage + secret redaction, envelope encrypt/decrypt
// round-trip, HMAC signing of outbound calls, reconciliation batch assembly +
// cursor advance, outbox item processing per kind, scheduler dormancy with no
// enabled pairing, and a full mocked check-in cycle.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { newDb, newSecrets, cleanup } = require('./_helpers');
const pairing = require('../server/integration/pairing');
const envelope = require('../server/integration/envelope');
const agent = require('../server/integration/outbound-agent');
const scheduler = require('../server/integration/outbound-scheduler');
const webhooks = require('../server/integration/webhooks');
const people = require('../server/identity/people');
const sanitize = require('../server/sanitize');

function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  return { db, secrets };
}

const EKEY = 'a'.repeat(64); // 32-byte hex envelope key

function configurePairing(db, secrets, schoolId, { enabled = true, interval = 20 } = {}) {
  pairing.set(db, secrets, schoolId, {
    pp_base_url: 'https://pp.example.org',
    pp_bearer_credential: 'pp-bearer-token-secret',
    shared_webhook_secret: 'shared-hmac-secret',
    envelope_key: EKEY,
    check_in_interval_s: interval,
    enabled,
  }, { actor: 'test' });
}

// ---------------------------------------------------------------------------
// Pairing config storage
// ---------------------------------------------------------------------------

test('pairing > stores config and never echoes secrets in describe()', t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys');
  const d = pairing.describe(db, secrets, 'st-marys');
  assert.equal(d.schoolId, 'st-marys');
  assert.equal(d.enabled, true);
  assert.equal(d.check_in_interval_s, 20);
  // secrets present but value never exposed
  assert.equal(d.fields.pp_bearer_credential.set, true);
  assert.equal('value' in d.fields.pp_bearer_credential, false);
  assert.equal(d.fields.shared_webhook_secret.set, true);
  assert.equal(d.fields.envelope_key.set, true);
  // non-secret field value IS exposed
  assert.equal(d.fields.pp_base_url.value, 'https://pp.example.org');
});

test('pairing > load() returns plaintext secrets for internal use', t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys');
  const cfg = pairing.load(db, secrets, 'st-marys');
  assert.equal(cfg.pp_bearer_credential, 'pp-bearer-token-secret');
  assert.equal(cfg.shared_webhook_secret, 'shared-hmac-secret');
  assert.equal(cfg.envelope_key, EKEY);
  assert.equal(cfg.pp_base_url, 'https://pp.example.org');
});

test('pairing > isComplete only when all required fields set', t => {
  const { db, secrets } = setup(t);
  pairing.set(db, secrets, 'partial', { pp_base_url: 'https://pp.example.org' }, { actor: 'test' });
  assert.equal(pairing.isComplete(db, secrets, 'partial'), false);
  configurePairing(db, secrets, 'partial');
  assert.equal(pairing.isComplete(db, secrets, 'partial'), true);
});

test('pairing > rejects non-https base url and bad envelope key', t => {
  const { db, secrets } = setup(t);
  assert.throws(() => pairing.set(db, secrets, 's1', { pp_base_url: 'http://insecure.example' }, {}), /https/);
  assert.throws(() => pairing.set(db, secrets, 's1', { envelope_key: 'tooshort' }, {}), /64 hex/);
});

test('pairing > clear removes config and index entry', t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'gone');
  assert.equal(pairing.exists(db, 'gone'), true);
  pairing.clear(db, secrets, 'gone', { actor: 'test' });
  assert.equal(pairing.exists(db, 'gone'), false);
  assert.equal(pairing.describe(db, secrets, 'gone'), null);
});

test('pairing > cursor and check-in bookkeeping round-trips', t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys');
  pairing.setLastAckedCursor(db, 'st-marys', '2026-06-19T00:00:00.000Z');
  pairing.setLastCheckInAt(db, 'st-marys', 1_700_000_000_000);
  const cfg = pairing.load(db, secrets, 'st-marys');
  assert.equal(cfg.lastAckedCursor, '2026-06-19T00:00:00.000Z');
  assert.equal(cfg.lastCheckInAt, 1_700_000_000_000);
});

// ---------------------------------------------------------------------------
// Envelope encryption
// ---------------------------------------------------------------------------

test('envelope > seal/open round-trips an object (CANONICAL enc shape)', () => {
  const value = { name: '[Name]', personId: 'p_abc', nested: { a: [1, 2, 3] } };
  const wire = envelope.seal(EKEY, value);
  assert.equal(envelope.isSealed(wire), true);
  // Canonical wire shape shared with ParentPoint: { enc, iv, tag, ct }.
  assert.equal(wire.enc, 'aes-256-gcm');
  assert.equal('__fg_enc' in wire, false);
  assert.equal('alg' in wire, false);
  assert.equal(typeof wire.iv, 'string');
  assert.equal(typeof wire.tag, 'string');
  assert.equal(typeof wire.ct, 'string');
  // ciphertext does not contain the plaintext
  assert.equal(JSON.stringify(wire).includes('[Name]'), false);
  const back = envelope.open(EKEY, wire);
  assert.deepEqual(back, value);
});

test('envelope > tamper / wrong key fails to open', () => {
  const wire = envelope.seal(EKEY, { secret: 'x' });
  // wrong key
  assert.throws(() => envelope.open('b'.repeat(64), wire), /unable to authenticate|bad decrypt|Unsupported|auth/i);
  // tampered ciphertext
  const tampered = { ...wire, ct: Buffer.from('garbage').toString('base64') };
  assert.throws(() => envelope.open(EKEY, tampered));
});

test('envelope > isSealed rejects plain objects', () => {
  assert.equal(envelope.isSealed({ foo: 1 }), false);
  assert.equal(envelope.isSealed(null), false);
  assert.equal(envelope.isSealed('string'), false);
});

// ---------------------------------------------------------------------------
// HMAC signing of outbound calls (via a capturing fetch stub)
// ---------------------------------------------------------------------------

test('agent > outbound write carries bearer, signature, tenant, version, actor, request-id', async t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys');
  const captured = [];
  const fakeFetch = async (url, opts) => {
    captured.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ ackedCursor: '2026-06-19T01:00:00.000Z' }) };
  };
  await agent.pushBatch(db, secrets, pairing.load(db, secrets, 'st-marys'), { fetchImpl: fakeFetch });
  assert.equal(captured.length, 1);
  const { url, opts } = captured[0];
  assert.match(url, /^https:\/\/pp\.example\.org\/familygraph-sync\?tenant=st-marys$/);
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers.authorization, 'Bearer pp-bearer-token-secret');
  assert.equal(opts.headers['x-source-tenant'], 'st-marys');
  assert.equal(opts.headers['x-fg-contract-version'], 'v0.2');
  assert.equal(opts.headers['x-family-graph-actor'], 'familygraph');
  assert.match(opts.headers['x-request-id'], /^fg_/);
  // signature is HMAC-SHA256(rawBody, shared secret)
  const want = `sha256=${crypto.createHmac('sha256', 'shared-hmac-secret').update(opts.body).digest('hex')}`;
  assert.equal(opts.headers['x-fg-signature'], want);
});

// ---------------------------------------------------------------------------
// Batch assembly + cursor advance
// ---------------------------------------------------------------------------

test('agent > assembleBatch collects changed persons and advances cursor', t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys');
  people.create(db, secrets, { given_name: 'Ann', family_name: 'Smith' });
  people.create(db, secrets, { given_name: 'Bob', family_name: 'Jones' });
  const cfg = pairing.load(db, secrets, 'st-marys');
  const batch = agent.assembleBatch(db, secrets, cfg, {});
  // Canonical: a flat ChangeEvent array, not separate persons/households.
  assert.ok(Array.isArray(batch.changes));
  assert.equal(batch.changes.length >= 2, true);
  assert.equal(batch.count, batch.changes.length);
  assert.ok(batch.cursor);
  // Every event is a canonical person.* / household.* ChangeEvent.
  for (const ev of batch.changes) {
    assert.match(ev.type, /^(person|household)\.(updated|deleted)$/);
  }
});

test('agent > pushBatch seals the payload and persists acked cursor', async t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys');
  people.create(db, secrets, { given_name: 'Ann', family_name: 'Smith' });
  let sentBody = null;
  const fakeFetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ ackedCursor: 'CURSOR-1' }) };
  };
  await agent.pushBatch(db, secrets, pairing.load(db, secrets, 'st-marys'), { fetchImpl: fakeFetch });
  // CANONICAL: changes array is sealed (PII); sinceCursor + cursor + tenant cleartext
  assert.equal(sentBody.tenant, 'st-marys');
  assert.equal('sinceCursor' in sentBody, true);
  assert.equal(typeof sentBody.cursor, 'string');
  assert.equal(envelope.isSealed(sentBody.changes), true);
  assert.equal(JSON.stringify(sentBody).includes('Smith'), false);
  // opened changes are canonical ChangeEvents { type, data } / tombstones { type, id }
  const events = envelope.open(EKEY, sentBody.changes);
  assert.ok(Array.isArray(events));
  assert.ok(events.length >= 1);
  assert.match(events[0].type, /^(person|household)\.(updated|deleted)$/);
  assert.ok(events[0].data || events[0].id);
  // acked cursor persisted
  assert.equal(pairing.load(db, secrets, 'st-marys').lastAckedCursor, 'CURSOR-1');
});

// ---------------------------------------------------------------------------
// Outbox item processing per kind
// ---------------------------------------------------------------------------

test('agent > processItem sanitize returns cleartext codes (not sealed)', t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys');
  const cfg = pairing.load(db, secrets, 'st-marys');
  const res = agent.processItem(db, secrets, cfg, {
    id: 'item-1', kind: 'sanitize', payload: { text: 'Call Bob Jones at bob@example.org' },
  });
  assert.equal(res.ok, true);
  assert.equal(res.id, 'item-1');
  // sanitize result is code-only → NOT sealed; carries an OPAQUE tokenSetId
  assert.equal(envelope.isSealed(res.result), false);
  assert.ok(res.result.tokenSetId);
  assert.equal('mappings' in res.result, false); // de-anon map NEVER on the wire
  assert.equal(typeof res.result.sanitized, 'string');
});

test('agent > processItem desanitize returns SEALED text', t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys');
  const cfg = pairing.load(db, secrets, 'st-marys');
  // First sanitize to create a token set
  const out = sanitize.sanitizeText(db, secrets, 'email me at jane@example.org', { actor: 'pp:st-marys' });
  const res = agent.processItem(db, secrets, cfg, {
    id: 'd-1', kind: 'desanitize', payload: { text: out.sanitized, tokenSetId: out.tokenSet },
  });
  assert.equal(res.ok, true);
  // result carries restored names/PII → must be sealed
  assert.equal(envelope.isSealed(res.result), true);
  const opened = envelope.open(EKEY, res.result);
  assert.match(opened.text, /jane@example\.org/);
});

test('agent > processItem identity.resolve returns SEALED result', t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys');
  const cfg = pairing.load(db, secrets, 'st-marys');
  const res = agent.processItem(db, secrets, cfg, {
    id: 'r-1', kind: 'identity.resolve',
    payload: { record: { first_name: 'Carol', last_name: 'Newperson', email: 'carol@example.org' } },
  });
  assert.equal(res.ok, true);
  assert.equal(envelope.isSealed(res.result), true);
  const opened = envelope.open(EKEY, res.result);
  assert.match(opened.code, /^p_/);
  assert.ok(['created', 'attached', 'enqueued'].includes(opened.action));
});

test('agent > processItem identity.resolve opens a SEALED input record', t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys');
  const cfg = pairing.load(db, secrets, 'st-marys');
  // Canonical: the whole payload { record } is sealed; processItem opens it.
  const sealedPayload = envelope.seal(EKEY, { record: { first_name: 'Dan', last_name: 'Sealed' } });
  const res = agent.processItem(db, secrets, cfg, {
    id: 'r-2', kind: 'identity.resolve', payload: sealedPayload,
  });
  assert.equal(res.ok, true);
  const opened = envelope.open(EKEY, res.result);
  assert.match(opened.code, /^p_/);
});

test('agent > processItem schoolContext applies snapshot via existing engine', t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys');
  const cfg = pairing.load(db, secrets, 'st-marys');
  const child = people.create(db, secrets, { given_name: 'Kid', family_name: 'Smith', kind: 'child' });
  const res = agent.processItem(db, secrets, cfg, {
    id: 'sc-1', kind: 'schoolContext',
    payload: { personCode: child, schoolId: 'st-marys', grade: '3', classroomName: 'Room 3A' },
  });
  assert.equal(res.ok, true);
  assert.equal(envelope.isSealed(res.result), true);
  const opened = envelope.open(EKEY, res.result);
  assert.equal(opened.schoolContext.grade, '3');
});

test('agent > processItem document.fetch with no docRef denies not_found, no throw', t => {
  // The document.fetch stub is now a real access gate (see
  // integration-documents.test.js for the full matrix). A fetch with no/unknown
  // docRef is a clean deny — never a throw, never PII in the result.
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys');
  const cfg = pairing.load(db, secrets, 'st-marys');
  const res = agent.processItem(db, secrets, cfg, {
    id: 'doc-1', kind: 'document.fetch',
    payload: { viewer: { role: 'admin', relationship: 'staff' } },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
  assert.equal('result' in res, false);
});

test('agent > processItem unknown kind returns ok:false without throwing', t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys');
  const cfg = pairing.load(db, secrets, 'st-marys');
  const res = agent.processItem(db, secrets, cfg, { id: 'x', kind: 'bogus' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown_kind');
});

// ---------------------------------------------------------------------------
// Full mocked check-in (steps 1→4)
// ---------------------------------------------------------------------------

test('agent > checkInOnce runs sync, outbox, process, inbox', async t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys');
  people.create(db, secrets, { given_name: 'Ann', family_name: 'Smith' });
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(url);
    if (url.includes('/familygraph-sync')) {
      return { ok: true, status: 200, json: async () => ({ ackedCursor: 'C2' }) };
    }
    if (url.includes('/familygraph-outbox')) {
      return { ok: true, status: 200, json: async () => ({ items: [
        { id: 'o1', kind: 'sanitize', payload: { text: 'hi Ann Smith' } },
      ] }) };
    }
    if (url.includes('/familygraph-inbox')) {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    throw new Error(`unexpected url ${url}`);
  };
  const summary = await agent.checkInOnce(db, secrets, 'st-marys', { fetchImpl: fakeFetch });
  assert.equal(summary.tenant, 'st-marys');
  assert.equal(summary.processed, 1);
  assert.equal(summary.returned, 1);
  assert.equal(summary.errors, 0);
  assert.equal(calls.some(u => u.includes('/familygraph-sync')), true);
  assert.equal(calls.some(u => u.includes('/familygraph-outbox')), true);
  assert.equal(calls.some(u => u.includes('/familygraph-inbox')), true);
  // last check-in timestamp recorded
  assert.ok(pairing.load(db, secrets, 'st-marys').lastCheckInAt);
});

test('agent > checkInOnce skips a disabled pairing', async t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys', { enabled: false });
  let called = false;
  const fakeFetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  const r = await agent.checkInOnce(db, secrets, 'st-marys', { fetchImpl: fakeFetch });
  assert.equal(r.skipped, 'disabled');
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// Scheduler dormancy
// ---------------------------------------------------------------------------

test('scheduler > dueTenants is empty with no enabled pairing', t => {
  const { db, secrets } = setup(t);
  // No pairings at all → empty.
  assert.deepEqual(scheduler.dueTenants(db, secrets), []);
  // A configured-but-disabled pairing is never due.
  configurePairing(db, secrets, 'st-marys', { enabled: false });
  assert.deepEqual(scheduler.dueTenants(db, secrets), []);
});

test('scheduler > tick is a no-op (no outbound calls) when dormant', async t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys', { enabled: false });
  let called = false;
  const results = await scheduler.tick(db, secrets, {
    fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; },
  });
  assert.deepEqual(results, []);
  assert.equal(called, false);
});

test('scheduler > enabled+complete pairing becomes due after its interval', t => {
  const { db, secrets } = setup(t);
  configurePairing(db, secrets, 'st-marys', { enabled: true, interval: 20 });
  // never checked in → due now
  assert.deepEqual(scheduler.dueTenants(db, secrets), ['st-marys']);
  // just checked in → not due
  pairing.setLastCheckInAt(db, 'st-marys', Date.now());
  assert.deepEqual(scheduler.dueTenants(db, secrets), []);
  // 21s ago → due again
  pairing.setLastCheckInAt(db, 'st-marys', Date.now() - 21_000);
  assert.deepEqual(scheduler.dueTenants(db, secrets), ['st-marys']);
});

test('scheduler > start() returns dormant handle when disabled via env', t => {
  const { db, secrets } = setup(t);
  const prev = process.env.FAMILY_GRAPH_DISABLE_PP_OUTBOUND;
  process.env.FAMILY_GRAPH_DISABLE_PP_OUTBOUND = '1';
  t.after(() => { if (prev === undefined) delete process.env.FAMILY_GRAPH_DISABLE_PP_OUTBOUND; else process.env.FAMILY_GRAPH_DISABLE_PP_OUTBOUND = prev; });
  const h = scheduler.start(db, secrets);
  assert.equal(h.running, false);
  h.stop();
});
