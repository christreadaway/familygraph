'use strict';

// CANONICAL FG↔PP wire-shape FIXTURE tests.
//
// These lock the EXACT bytes on the wire so the two repos (FamilyGraph and
// ParentPoint) can never silently re-diverge. The SAME fixtures
// (FIXED_KEY_HEX, SEALED_BLOB, the sync / outbox / inbox example payloads) are
// asserted in ParentPoint's `familyGraphWire.fixtures.test.ts`. If you change a
// shape here, change it there too — see FG_PP_WIRE_CONTRACT (PP) /
// FAMILYGRAPH_INTEGRATION.md appendix (FG).

const test = require('node:test');
const assert = require('node:assert/strict');

const envelope = require('../server/integration/envelope');
const agent = require('../server/integration/outbound-agent');

// ── Shared cross-language fixtures (identical literals in PP) ─────────────────

// 32-byte key as 64 hex chars. BOTH repos accept hex.
const FIXED_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// A known sealed blob produced under FIXED_KEY_HEX. Decrypts to FIXED_PLAINTEXT
// in BOTH repos. The canonical envelope wire shape is { enc, iv, tag, ct }.
const SEALED_BLOB = {
  enc: 'aes-256-gcm',
  iv: 'I0OQY6BAXR1itJgI',
  tag: 'tzwOz/xGnfjobN0KVYtuog==',
  ct: 'utgnlmMIVOeKSDvOEFGJB7CvNhb+BhBZ61wQso4QHnK8lhGcmqIgBJCSLibJfBVOy32rDDnhJ/sM',
};
const FIXED_PLAINTEXT = { text: 'Amanda Lee', personId: 'fg_p_1', items: [1, 2, 3] };

// ── A. Envelope cross-language round-trip ────────────────────────────────────

test('wire > FG opens the canonical SEALED_BLOB to the shared plaintext', () => {
  const opened = envelope.open(FIXED_KEY_HEX, SEALED_BLOB);
  assert.deepEqual(opened, FIXED_PLAINTEXT);
});

test('wire > FG seal() emits the canonical { enc, iv, tag, ct } shape', () => {
  const wire = envelope.seal(FIXED_KEY_HEX, FIXED_PLAINTEXT);
  assert.equal(wire.enc, 'aes-256-gcm');
  assert.deepEqual(Object.keys(wire).sort(), ['ct', 'enc', 'iv', 'tag']);
  assert.equal('__fg_enc' in wire, false);
  assert.equal('alg' in wire, false);
  // self-round-trip
  assert.deepEqual(envelope.open(FIXED_KEY_HEX, wire), FIXED_PLAINTEXT);
});

// ── B. Sync request — POST {pp}/familygraph-sync?tenant=<sid> ─────────────────

test('wire > sync request: tenant/sinceCursor/cursor cleartext, changes sealed', async () => {
  // Build a real push body via a capturing fetch.
  const crypto = require('node:crypto');
  const { newDb, newSecrets, cleanup } = require('./_helpers');
  const pairing = require('../server/integration/pairing');
  const people = require('../server/identity/people');
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    pairing.set(db, secrets, 'st-marys', {
      pp_base_url: 'https://pp.example.org',
      pp_bearer_credential: 'bearer',
      shared_webhook_secret: 'secret',
      envelope_key: FIXED_KEY_HEX,
      check_in_interval_s: 20,
      enabled: true,
    }, { actor: 'test' });
    people.create(db, secrets, { given_name: 'Ann', family_name: 'Smith' });

    let body = null;
    await agent.pushBatch(db, secrets, pairing.load(db, secrets, 'st-marys'), {
      fetchImpl: async (_url, opts) => {
        body = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ ackedCursor: body.cursor, applied: 1, skipped: 0 }) };
      },
    });

    // Exact top-level keys of the canonical sync request.
    assert.deepEqual(Object.keys(body).sort(), ['changes', 'cursor', 'sinceCursor', 'tenant']);
    assert.equal(body.tenant, 'st-marys');
    assert.equal(body.sinceCursor, null);
    assert.equal(typeof body.cursor, 'string');
    // changes is a sealed envelope of a ChangeEvent array.
    assert.equal(envelope.isSealed(body.changes), true);
    const events = envelope.open(FIXED_KEY_HEX, body.changes);
    assert.ok(Array.isArray(events));
    for (const ev of events) {
      assert.match(ev.type, /^(person|household|consent)\.(updated|deleted)$/);
      assert.equal(ev.data !== undefined || ev.id !== undefined, true);
    }
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ── C. Outbox response item — GET {pp}/familygraph-outbox ────────────────────

test('wire > outbox item shape { id, kind, payload, requestId } is what processItem consumes', () => {
  const { newDb, newSecrets, cleanup } = require('./_helpers');
  const pairing = require('../server/integration/pairing');
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    pairing.set(db, secrets, 'st-marys', {
      pp_base_url: 'https://pp.example.org',
      pp_bearer_credential: 'bearer',
      shared_webhook_secret: 'secret',
      envelope_key: FIXED_KEY_HEX,
      check_in_interval_s: 20,
      enabled: true,
    }, { actor: 'test' });
    const cfg = pairing.load(db, secrets, 'st-marys');

    // Canonical outbox item: a sanitize task with a SEALED payload { text }.
    const item = {
      id: 'fgo_1',
      kind: 'sanitize',
      payload: envelope.seal(FIXED_KEY_HEX, { text: 'Call Bob Jones at bob@example.org' }),
      requestId: 'pp_1',
    };
    const res = agent.processItem(db, secrets, cfg, item);
    assert.equal(res.ok, true);
    assert.equal(res.id, 'fgo_1');
    // sanitize result is CLEARTEXT { sanitized, tokenSetId } — opaque ref only.
    assert.equal(envelope.isSealed(res.result), false);
    assert.equal(typeof res.result.sanitized, 'string');
    assert.equal(typeof res.result.tokenSetId, 'string');
    assert.equal('mappings' in res.result, false);
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ── D. Inbox batch — POST {pp}/familygraph-inbox ─────────────────────────────

test('wire > inbox return is a BATCH { tenant, results:[{ id, kind, ok, result }] }', async () => {
  const { newDb, newSecrets, cleanup } = require('./_helpers');
  const pairing = require('../server/integration/pairing');
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    pairing.set(db, secrets, 'st-marys', {
      pp_base_url: 'https://pp.example.org',
      pp_bearer_credential: 'bearer',
      shared_webhook_secret: 'secret',
      envelope_key: FIXED_KEY_HEX,
      check_in_interval_s: 20,
      enabled: true,
    }, { actor: 'test' });
    const cfg = pairing.load(db, secrets, 'st-marys');

    let body = null;
    const results = [
      { id: 'fgo_1', kind: 'sanitize', ok: true, result: { sanitized: 'Call p_x at e_y', tokenSetId: 'tk_1' } },
      { id: 'fgo_2', kind: 'desanitize', ok: true, result: envelope.seal(FIXED_KEY_HEX, { text: 'real name' }) },
    ];
    await agent.returnInbox(cfg, results, {
      fetchImpl: async (_url, opts) => {
        body = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ ok: true, applied: 2 }) };
      },
    });
    assert.deepEqual(Object.keys(body).sort(), ['results', 'tenant']);
    assert.equal(body.tenant, 'st-marys');
    assert.ok(Array.isArray(body.results));
    assert.equal(body.results.length, 2);
    for (const r of body.results) {
      assert.equal(typeof r.id, 'string');
      assert.equal(typeof r.kind, 'string');
      assert.equal(typeof r.ok, 'boolean');
    }
    // desanitize result rides SEALED on the wire (PII).
    const des = body.results.find(r => r.kind === 'desanitize');
    assert.equal(envelope.isSealed(des.result), true);
    // sanitize result is cleartext (codes + opaque ref).
    const san = body.results.find(r => r.kind === 'sanitize');
    assert.equal(envelope.isSealed(san.result), false);
    assert.equal(typeof san.result.tokenSetId, 'string');
  } finally {
    db.close();
    cleanup(dir);
  }
});

// ── F. Document vault wire shapes — store / fetch / document.updated ──────────
//
// These pin the EXACT bytes for the Document Vault contract. PP asserts the
// identical shapes in its mirror fixture test. SEAL on store/fetch payloads
// (bytes + PII); CLEARTEXT on the store result (opaque docRef only) and on the
// fetch DENY result (no PII); SEALED envelope on the fetch ALLOW result.

function _vaultSetup() {
  const { newDb, newSecrets } = require('./_helpers');
  const pairing = require('../server/integration/pairing');
  const people = require('../server/identity/people');
  const { db, dir } = newDb();
  const secrets = newSecrets();
  pairing.set(db, secrets, 'st-marys', {
    pp_base_url: 'https://pp.example.org',
    pp_bearer_credential: 'bearer',
    shared_webhook_secret: 'secret',
    envelope_key: FIXED_KEY_HEX,
    check_in_interval_s: 20,
    enabled: true,
  }, { actor: 'test' });
  const cfg = pairing.load(db, secrets, 'st-marys');
  const personCode = people.create(db, secrets, { given_name: 'Kid', family_name: 'Smith', kind: 'child' });
  return { db, dir, secrets, cfg, personCode };
}

test('wire > document.store: SEALED payload in, CLEARTEXT { docRef } out', () => {
  const { newDb, newSecrets, cleanup } = require('./_helpers');
  void newDb; void newSecrets; // referenced via _vaultSetup
  const { db, dir, secrets, cfg, personCode } = _vaultSetup();
  try {
    // Canonical document.store payload (SEALED — carries bytes + PII).
    const payload = envelope.seal(FIXED_KEY_HEX, {
      personCode,
      kind: 'sacramental',
      subtype: 'baptism',
      title: 'Baptismal Record',
      contentType: 'application/pdf',
      contentBase64: Buffer.from('%PDF-1.4 fake', 'utf8').toString('base64'),
      source: 'pp',
    });
    const item = { id: 'fgo_doc_store', kind: 'document.store', payload, requestId: 'pp_ds' };
    const res = agent.processItem(db, secrets, cfg, item);
    assert.equal(res.ok, true);
    assert.equal(res.id, 'fgo_doc_store');
    // Result is CLEARTEXT: opaque docRef only — no envelope, no bytes, no PII.
    assert.equal(envelope.isSealed(res.result), false);
    assert.match(res.result.docRef, /^doc_[0-9a-f]{16}$/);
    assert.deepEqual(Object.keys(res.result), ['docRef']);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('wire > document.fetch ALLOW: SEALED { docRef, contentType, contentBase64, expiresAt }', () => {
  const { cleanup } = require('./_helpers');
  const documents = require('../server/integration/documents');
  const { db, dir, secrets, cfg, personCode } = _vaultSetup();
  try {
    const stored = documents.store(db, secrets, {
      personCode, kind: 'sacramental', subtype: 'baptism',
      title: 'Baptismal Record', contentType: 'application/pdf',
      contentBase64: Buffer.from('%PDF-1.4 fake', 'utf8').toString('base64'),
    });
    // Canonical document.fetch payload (SEALED — carries the asserted viewer).
    const payload = envelope.seal(FIXED_KEY_HEX, {
      docRef: stored.docRef, personCode,
      viewer: { userId: 'pp_user_1', role: 'clergy', relationship: 'staff' },
    });
    const res = agent.processItem(db, secrets, cfg, { id: 'fgo_doc_fetch', kind: 'document.fetch', payload });
    assert.equal(res.ok, true);
    // ALLOW result is a SEALED envelope of { docRef, contentType, contentBase64, expiresAt }.
    assert.equal(envelope.isSealed(res.result), true);
    const opened = envelope.open(FIXED_KEY_HEX, res.result);
    assert.deepEqual(Object.keys(opened).sort(), ['contentBase64', 'contentType', 'docRef', 'expiresAt']);
    assert.equal(opened.docRef, stored.docRef);
    assert.equal(opened.contentType, 'application/pdf');
    assert.equal(typeof opened.expiresAt, 'string');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('wire > document.fetch DENY: CLEARTEXT { ok:false, error } with no PII', () => {
  const { cleanup } = require('./_helpers');
  const documents = require('../server/integration/documents');
  const { db, dir, secrets, cfg, personCode } = _vaultSetup();
  try {
    const stored = documents.store(db, secrets, {
      personCode, kind: 'accommodation', subtype: 'iep',
      contentType: 'application/pdf', contentBase64: Buffer.from('iep', 'utf8').toString('base64'),
    });
    // Parent on an accommodation doc → DENY the file.
    const payload = envelope.seal(FIXED_KEY_HEX, {
      docRef: stored.docRef, personCode, viewer: { userId: 'pp_parent_1', relationship: 'parent_of' },
    });
    const res = agent.processItem(db, secrets, cfg, { id: 'fgo_doc_deny', kind: 'document.fetch', payload });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'forbidden');
    assert.equal('result' in res, false);
    assert.equal(envelope.isSealed(res), false);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('wire > document.updated ChangeEvent: metadata only, NO bytes, in sealed batch', () => {
  const { cleanup } = require('./_helpers');
  const documents = require('../server/integration/documents');
  const { db, dir, secrets, cfg, personCode } = _vaultSetup();
  try {
    const stored = documents.store(db, secrets, {
      personCode, kind: 'sacramental', subtype: 'baptism', title: 'Baptism',
      contentType: 'application/pdf', contentBase64: Buffer.from('%PDF', 'utf8').toString('base64'),
    });
    documents.setSafetyFlags(db, secrets, personCode, { allergens: ['peanut'], severity: 'high', medication: 'EpiPen', emergencyContact: '[Parent]' });
    const batch = agent.assembleBatch(db, secrets, cfg, { limit: 200 });

    const docEv = batch.changes.find(e => e.type === 'document.updated');
    assert.deepEqual(Object.keys(docEv).sort(), ['data', 'type']);
    assert.deepEqual(Object.keys(docEv.data).sort(),
      ['date', 'docRef', 'kind', 'personCode', 'policyKey', 'status', 'subtype', 'title']);
    assert.equal(docEv.data.docRef, stored.docRef);
    assert.equal('contentBase64' in docEv.data, false);

    const sfEv = batch.changes.find(e => e.type === 'health.safetyFlags.updated');
    assert.deepEqual(Object.keys(sfEv.data).sort(),
      ['allergens', 'emergencyContact', 'medication', 'personCode', 'severity', 'updatedAt']);

    // The full ChangeEvent array seals/opens cleanly under `changes`.
    const wire = envelope.seal(FIXED_KEY_HEX, batch.changes);
    assert.equal(envelope.isSealed(wire), true);
    const back = envelope.open(FIXED_KEY_HEX, wire);
    assert.ok(back.some(e => e.type === 'document.updated'));
    assert.ok(back.some(e => e.type === 'health.safetyFlags.updated'));
  } finally {
    db.close();
    cleanup(dir);
  }
});
