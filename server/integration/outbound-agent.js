'use strict';

// FamilyGraph outbound sync agent (Option A — "no open doors").
//
// FG opens NO inbound internet ports. It binds loopback by default and the
// dialer here is the ONLY thing that talks to ParentPoint (PP). FG is the
// sole initiator: on each check-in tick FG makes four OUTBOUND HTTPS calls
// to PP's public endpoints and processes any work PP parked for it, locally,
// with FG's existing engines. PP never calls FG.
//
// The locked inversion protocol, per configured PP tenant:
//   1. POST {ppBaseUrl}/familygraph-sync?tenant=<schoolId>
//        Push the reconciliation batch of changes since PP's last-acked
//        cursor (reusing FG's persons/households changed-feed machinery).
//        PP responds { ackedCursor }; we persist it per tenant.
//   2. GET  {ppBaseUrl}/familygraph-outbox?tenant=<schoolId>&max=N
//        Fetch PP's parked work items: sanitize | desanitize |
//        identity.resolve | schoolContext | document.fetch (stub).
//   3. Process each item LOCALLY with server/sanitize, server/identity/
//        resolver, server/integration/schoolContext.
//   4. POST {ppBaseUrl}/familygraph-inbox?tenant=<schoolId>
//        Return results keyed by each item's id for idempotent ack.
//
// Headers on every call:
//   Authorization: Bearer <pp_bearer_credential>
//   X-FG-Signature: sha256=<HMAC-SHA256(rawBody, shared_webhook_secret)>
//   X-Source-Tenant: <schoolId>
//   X-FG-Contract-Version: v0.2
//   X-Family-Graph-Actor: familygraph
//   X-Request-Id: fg_<uuid>           (on writes)
//
// Envelope encryption (server/integration/envelope.js): any FG→PP payload
// carrying PII / de-anonymized text / identity-resolved names is sealed
// with the pairing's shared envelope_key on TOP of TLS. Codes, cursors,
// request ids and acks travel cleartext inside the TLS+HMAC envelope.
//
// Real-time FG→PP webhooks (server/integration/webhooks.js) stay the
// low-latency path; the step-1 batch is the catch-up backstop.

const crypto = require('crypto');
const log = require('../log');
const audit = require('../audit');
const webhooks = require('./webhooks');
const envelope = require('./envelope');
const pairing = require('./pairing');
const changes = require('./changes');
const schoolContext = require('./schoolContext');
const documents = require('./documents');
const documentPolicy = require('./documentPolicy');
const sanitize = require('../sanitize');
const resolver = require('../identity/resolver');
const httpClient = require('../connectors/http');

const CONTRACT_VERSION = 'v0.2';
const ACTOR = 'familygraph';
const DEFAULT_OUTBOX_MAX = 50;
const DEFAULT_BATCH_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 30_000;

// Jitter-backoff retry budget for a single outbound call. Reuses the
// connector http sleep() so we don't hand-roll a second backoff. Only
// network-class errors retry; an HTTP 4xx from PP is a contract problem,
// not a transient one, and surfaces immediately.
const RETRY_DELAYS_MS = [500, 1500, 4000];

function _newRequestId() {
  return `fg_${crypto.randomUUID()}`;
}

function _path(url) {
  try { return new URL(url).pathname; } catch (_) { return '[unparseable]'; }
}

// One outbound call with HMAC signing, bearer auth, structured + redacted
// logging, and network-only retry/backoff. `body` (when present) is already
// a JS object; we serialise it once so the signature covers the exact bytes
// on the wire.
async function _call(pairingCfg, { method, path, query = {}, body = null, isWrite = false, fetchImpl = null }) {
  const _fetch = fetchImpl || globalThis.fetch;
  if (!_fetch) throw _agentError('fetch_unavailable', 'no fetch implementation');

  const base = pairingCfg.pp_base_url.replace(/\/+$/, '');
  const qs = new URLSearchParams(query).toString();
  const url = `${base}${path}${qs ? `?${qs}` : ''}`;

  const rawBody = body == null ? null : JSON.stringify(body);
  const headers = {
    authorization: `Bearer ${pairingCfg.pp_bearer_credential}`,
    'x-source-tenant': pairingCfg.schoolId,
    'x-fg-contract-version': CONTRACT_VERSION,
    'x-family-graph-actor': ACTOR,
    accept: 'application/json',
  };
  if (rawBody != null) {
    headers['content-type'] = 'application/json';
    // Reuse the webhook signing util: sha256=<HMAC-SHA256(rawBody, secret)>.
    headers['x-fg-signature'] = webhooks.sign(pairingCfg.shared_webhook_secret, rawBody);
  }
  if (isWrite) headers['x-request-id'] = _newRequestId();

  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const start = Date.now();
    let resp;
    try {
      resp = await _fetch(url, {
        method,
        headers,
        body: rawBody == null ? undefined : rawBody,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      lastErr = _agentError('network_error', 'pp endpoint unreachable or timed out');
      log.warn('integration_pp.call.network_error', {
        tenant: pairingCfg.schoolId, method, path: _path(url),
        attempt, duration_ms: Date.now() - start,
      });
      // Network error → retry with backoff if budget remains.
      if (attempt < RETRY_DELAYS_MS.length) {
        await httpClient.sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw lastErr;
    }
    const dur = Date.now() - start;
    log.info('integration_pp.call', {
      tenant: pairingCfg.schoolId, method, path: _path(url),
      status: resp.status, duration_ms: dur,
    });
    if (resp.status === 429 || resp.status >= 500) {
      // PP transient. Retry on backoff if budget remains; otherwise surface.
      lastErr = _agentError('upstream_unavailable', `pp returned ${resp.status}`);
      if (attempt < RETRY_DELAYS_MS.length) {
        await httpClient.sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      try { await resp.text(); } catch (_) { /* drain */ }
      throw lastErr;
    }
    if (!resp.ok) {
      // 4xx (other than 429) is a contract error — don't retry, don't leak
      // the body (it could echo signed payload / PII).
      try { await resp.text(); } catch (_) { /* drain */ }
      throw _agentError('contract_error', `pp returned ${resp.status}`);
    }
    if (resp.status === 204) return null;
    try { return await resp.json(); }
    catch (e) { throw _agentError('parse_error', 'pp response was not valid json'); }
  }
  throw lastErr || _agentError('retry_exhausted', 'outbound call retry budget exhausted');
}

function _agentError(reason, message) {
  const e = new Error(message || reason);
  e.reason = reason;
  return e;
}

// ---------------------------------------------------------------------------
// Step 1 — reconciliation batch push
// ---------------------------------------------------------------------------

// Map a changed person/household object into the CANONICAL ChangeEvent shape —
// the SAME `{ type, data }` (or tombstone `{ type, id }`) the webhook emits, so
// the sync push and the real-time webhook are byte-identical on PP's side.
//
// A tombstone object from the changed feed is `{ personId|householdId, active:
// false, ... }`; the contract carries it as `{ type: '...deleted', id }`.
function _personChangeEvent(obj) {
  if (obj.active === false) {
    return { type: 'person.deleted', id: obj.personId };
  }
  return { type: 'person.updated', data: obj };
}
function _householdChangeEvent(obj) {
  if (obj.active === false) {
    return { type: 'household.deleted', id: obj.householdId };
  }
  return { type: 'household.updated', data: obj };
}

// Document + safety-flag ChangeEvents. METADATA ONLY — no document bytes ever
// ride the sync batch (bytes move only on an authorized document.fetch). These
// ride INSIDE the already-sealed `changes` array (the title + safety summary
// are PII, which is exactly why the whole array is sealed).
function _documentChangeEvent(obj) {
  if (obj.deleted === true) {
    return { type: 'document.deleted', id: obj.docRef };
  }
  return {
    type: 'document.updated',
    data: {
      docRef: obj.docRef,
      personCode: obj.personCode,
      kind: obj.kind,
      subtype: obj.subtype,
      title: obj.title,
      date: obj.date,
      status: obj.status,
      policyKey: obj.policyKey,
    },
  };
}
function _safetyFlagChangeEvent(obj) {
  if (obj.cleared === true) {
    return { type: 'health.safetyFlags.cleared', id: obj.personCode };
  }
  return {
    type: 'health.safetyFlags.updated',
    data: {
      personCode: obj.personCode,
      allergens: obj.allergens || [],
      severity: obj.severity || null,
      medication: obj.medication || null,
      emergencyContact: obj.emergencyContact || null,
      updatedAt: obj.updatedAt,
    },
  };
}

// Assemble the batch of person + household changes since PP's last-acked
// cursor, reusing the existing changed-feed machinery. The cursor is an ISO
// timestamp (the changed feed's own cursor shape). Each change becomes a
// canonical ChangeEvent; the array is SEALED with the envelope key (it carries
// PII). The cursor and tenant stay cleartext.
function assembleBatch(db, secrets, pairingCfg, { limit = DEFAULT_BATCH_LIMIT } = {}) {
  const since = pairingCfg.lastAckedCursor || null;
  const persons = changes.listChangedPersons(db, secrets, since, { limit });
  const households = changes.listChangedHouseholds(db, secrets, since, { limit });
  const documents = changes.listChangedDocuments(db, secrets, since, { limit });
  const safety = changes.listChangedSafetyFlags(db, secrets, since, { limit });
  // The next cursor is the max of all feeds' cursors so a tick that only moved
  // documents/safety flags still advances past person/household-empty windows.
  const cursor = [persons.cursor, households.cursor, documents.cursor, safety.cursor]
    .filter(Boolean)
    .sort()
    .pop() || (since || '1970-01-01T00:00:00.000Z');
  const changeEvents = [
    ...persons.items.map(_personChangeEvent),
    ...households.items.map(_householdChangeEvent),
    ...documents.items.map(_documentChangeEvent),
    ...safety.items.map(_safetyFlagChangeEvent),
  ];
  return {
    changes: changeEvents,
    cursor,
    count: changeEvents.length,
  };
}

async function pushBatch(db, secrets, pairingCfg, { limit = DEFAULT_BATCH_LIMIT, fetchImpl = null } = {}) {
  const batch = assembleBatch(db, secrets, pairingCfg, { limit });
  // CANONICAL sync request: cursor + sinceCursor + tenant cleartext; the
  // ChangeEvent array is SEALED (it carries PII) under `changes`.
  const body = {
    tenant: pairingCfg.schoolId,
    sinceCursor: pairingCfg.lastAckedCursor || null,
    cursor: batch.cursor,
    changes: envelope.seal(pairingCfg.envelope_key, batch.changes),
  };
  const resp = await _call(pairingCfg, {
    method: 'POST', path: '/familygraph-sync',
    query: { tenant: pairingCfg.schoolId },
    body, isWrite: true, fetchImpl,
  });
  // PP responds { ackedCursor }. Persist it so the next tick resumes there.
  const ackedCursor = resp && (resp.ackedCursor || resp.acked_cursor);
  if (ackedCursor) pairing.setLastAckedCursor(db, pairingCfg.schoolId, ackedCursor);
  log.info('integration_pp.sync.pushed', {
    tenant: pairingCfg.schoolId, count: batch.count,
    acked_cursor: ackedCursor || null,
  });
  return { count: batch.count, ackedCursor: ackedCursor || null };
}

// ---------------------------------------------------------------------------
// Step 2/3/4 — outbox fetch, local process, inbox return
// ---------------------------------------------------------------------------

async function fetchOutbox(pairingCfg, { max = DEFAULT_OUTBOX_MAX, fetchImpl = null } = {}) {
  const resp = await _call(pairingCfg, {
    method: 'GET', path: '/familygraph-outbox',
    query: { tenant: pairingCfg.schoolId, max: String(max) },
    fetchImpl,
  });
  const items = (resp && Array.isArray(resp.items)) ? resp.items : [];
  return items;
}

// Process one outbox item with FG's existing engines. Returns a result
// object keyed by the item's id. PII-bearing results (desanitize text,
// identity-resolved names, schoolContext snapshot) are SEALED; the sanitize
// result is code-only (codes + an OPAQUE tokenSetId) → cleartext.
//
// CANONICAL item shape (as PP parks it):
//   { id, kind, payload: ENVELOPE-or-plain, requestId }
// We open the payload (if sealed) ONCE, then read the kind-specific fields off
// the opened object. payload plaintext per kind:
//   sanitize        { text }
//   desanitize      { text, tokenSetId }
//   identity.resolve { record:{…} }
//   schoolContext   { schoolId, personCode, schoolYear?, grade?, … }
function processItem(db, secrets, pairingCfg, item) {
  const id = item && item.id;
  const kind = item && item.kind;
  const base = { id, kind };
  try {
    const payload = _openMaybe(pairingCfg, item && item.payload) || {};
    if (kind === 'sanitize') {
      // text → codes. Result is code-only (codes + an opaque token-set ref) →
      // cleartext. The codes→names map NEVER leaves FamilyGraph; only the
      // opaque tokenSetId travels. FG persists the map in its own encrypted
      // token_sets store.
      const text = payload.text;
      const out = sanitize.sanitizeText(db, secrets, String(text || ''), { actor: `pp:${pairingCfg.schoolId}` });
      return { ...base, ok: true, result: { sanitized: out.sanitized, tokenSetId: out.tokenSet } };
    }
    if (kind === 'desanitize') {
      // codes → text (authorized). The map is looked up BY tokenSetId from
      // FG's own encrypted store — PP never sent the mapping, only the id.
      // Result contains names → SEALED.
      const text = payload.text;
      const tokenSetId = payload.tokenSetId;
      const restored = sanitize.desanitizeText(db, secrets, String(text || ''), tokenSetId, {
        actor: `pp:${pairingCfg.schoolId}`,
        // PP is an authorized de-anonymization caller for its own token sets.
        authKind: 'master',
      });
      return { ...base, ok: true, result: envelope.seal(pairingCfg.envelope_key, { text: restored }) };
    }
    if (kind === 'identity.resolve') {
      // record → code/action. The result code is pseudonymous, but reasons can
      // echo matched values, so SEAL the result to be safe.
      const record = payload.record || payload;
      const incoming = _toIncoming(record);
      const thresholds = _thresholds(db);
      const out = resolver.resolveOrCreatePerson(db, secrets, thresholds, incoming, {
        actor: `pp:${pairingCfg.schoolId}`,
        source: `pp:${pairingCfg.schoolId}`,
      });
      return { ...base, ok: true, result: envelope.seal(pairingCfg.envelope_key, out) };
    }
    if (kind === 'schoolContext') {
      // PP-supplied child/school snapshot → apply via existing logic. We ack
      // with the stored shape (codes + non-PII fields) — SEALED since
      // grade/classroom can be sensitive in aggregate.
      const snapshot = payload;
      const personCode = snapshot.personCode || snapshot.personId || snapshot.person_code || snapshot.person_id;
      schoolContext.upsert(db, personCode, { ...snapshot, source_app: `pp:${pairingCfg.schoolId}` });
      const stored = schoolContext.getOne(db, personCode, snapshot.schoolId || snapshot.school_id);
      return { ...base, ok: true, result: envelope.seal(pairingCfg.envelope_key, { schoolContext: stored }) };
    }
    if (kind === 'document.store') {
      // PP parks a document for the vault. payload (SEALED — it carries bytes
      // + PII): { personCode, kind, subtype, title, contentType, contentBase64,
      // source }. We persist to the vault (bytes encrypted at rest with the
      // dataKey), derive the policyKey, and emit a document.updated change on
      // the next sync tick (the row's updated_at feeds the changed-feed). The
      // result is the cleartext opaque docRef.
      const out = documents.store(db, secrets, {
        personCode: payload.personCode || payload.person_code,
        kind: payload.kind,
        subtype: payload.subtype,
        title: payload.title,
        contentType: payload.contentType || payload.content_type,
        contentBase64: payload.contentBase64 || payload.content_base64,
        source: payload.source || `pp:${pairingCfg.schoolId}`,
      }, { actor: `pp:${pairingCfg.schoolId}` });
      audit.record(db, {
        tier: 2,
        action: 'document_store',
        actor: `pp:${pairingCfg.schoolId}`,
        entityCode: out.docRef,
        entityKind: 'document',
        destination: `pp:${pairingCfg.schoolId}`,
        metadata: {
          doc_ref: out.docRef, person_code: out.personCode,
          policy_key: out.policyKey, byte_size: out.byteSize, decision: 'stored',
        },
      });
      // result is cleartext: just the opaque ref (no PII, no bytes).
      return { ...base, ok: true, result: { docRef: out.docRef } };
    }
    if (kind === 'document.fetch') {
      // PP asks for a document's bytes for an ASSERTED viewer. payload:
      // { docRef, personCode, viewer:{ userId, role, relationship } }. FG is
      // the authoritative GATE: it applies the access matrix to the asserted
      // viewer (PP owns user auth; FG trusts + LOGS PP's signed assertion),
      // enforces the size cap, and on allow RE-SEALS the bytes for transport.
      return _processDocumentFetch(db, secrets, pairingCfg, base, payload);
    }
    return { ...base, ok: false, error: 'unknown_kind' };
  } catch (e) {
    // Never leak PII or secrets in the error returned to PP.
    log.warn('integration_pp.outbox.item_error', {
      tenant: pairingCfg.schoolId, kind, id, reason: e.reason || 'error',
    });
    return { ...base, ok: false, error: e.reason || 'processing_error' };
  }
}

// ParentPoint-driven document fetch. The access decision + audit live here;
// the matrix itself is in documentPolicy.js (pure). On DENY the result is
// cleartext and carries NO PII — just { ok:false, error }. On ALLOW the result
// is the wire ENVELOPE (sealed bytes), expiring ~5 minutes out.
const FETCH_TTL_MS = 5 * 60 * 1000;

function _processDocumentFetch(db, secrets, pairingCfg, base, payload) {
  const docRef = payload.docRef || payload.doc_ref;
  const personCode = payload.personCode || payload.person_code || null;
  const viewer = (payload.viewer && typeof payload.viewer === 'object') ? payload.viewer : {};
  const role = viewer.role || null;
  const relationship = viewer.relationship || null;
  const viewerId = viewer.userId || viewer.user_id || null;

  // Helper that audits the decision then returns the result. `error` null = allow.
  const finish = (decision, reason, error, extra) => {
    audit.record(db, {
      tier: 2,
      action: 'document_fetch',
      actor: `pp:${pairingCfg.schoolId}`,
      entityCode: docRef || null,
      entityKind: 'document',
      destination: `pp:${pairingCfg.schoolId}`,
      metadata: {
        // Viewer identity is asserted by PP; we LOG it (no name, just id/role).
        doc_ref: docRef || null, person_code: personCode || null,
        viewer_id: viewerId || null, viewer_role: role || null,
        viewer_relationship: relationship || null,
        decision, reason,
      },
    });
    log.info('documents.fetch.decision', {
      tenant: pairingCfg.schoolId, doc_ref: docRef || null,
      viewer_role: role || null, viewer_relationship: relationship || null,
      decision, reason,
    });
    if (error) return { ...base, ok: false, error };
    return { ...base, ok: true, result: extra };
  };

  const meta = docRef ? documents.getMeta(db, docRef) : null;
  // Not found, archived, or addressed at the wrong person → not_found (we don't
  // leak whether a doc exists for a person the viewer didn't name correctly).
  if (!meta || meta.status !== 'active') {
    return finish('deny', 'not_found', 'not_found');
  }
  if (personCode && meta.personCode !== _resolveCode(db, personCode)) {
    return finish('deny', 'person_mismatch', 'not_found');
  }

  const verdict = documentPolicy.decide({ policyKey: meta.policyKey, role, relationship });
  if (!verdict.allow) {
    return finish('deny', verdict.reason, 'forbidden');
  }

  // Size cap: never put more than MAX_BYTES on the wire even if a row slipped
  // past the store-time cap.
  if (meta.byteSize > documents.MAX_BYTES) {
    return finish('deny', 'too_large', 'too_large');
  }

  const full = documents.getWithBytes(db, secrets, docRef);
  if (!full) return finish('deny', 'not_found', 'not_found');

  const sealed = envelope.seal(pairingCfg.envelope_key, {
    docRef: full.docRef,
    contentType: full.contentType,
    contentBase64: full.contentBase64,
    expiresAt: new Date(Date.now() + FETCH_TTL_MS).toISOString(),
  });
  return finish('allow', verdict.reason, null, sealed);
}

function _resolveCode(db, code) {
  try { return require('../identity/aliases').resolveAlias(db, code); }
  catch (_) { return code; }
}

function _openMaybe(pairingCfg, value) {
  if (envelope.isSealed(value)) return envelope.open(pairingCfg.envelope_key, value);
  return value;
}

// Translate PP's loose record shape into the resolver's incoming shape.
// Mirrors server/api/identity.js _toIncoming so behaviour is identical.
function _toIncoming(record) {
  const r = record && typeof record === 'object' ? record : {};
  return {
    given_name: r.given_name || r.first_name || r.firstName || null,
    family_name: r.family_name || r.last_name || r.lastName || null,
    middle_name: r.middle_name || r.middleName || null,
    date_of_birth: r.date_of_birth || r.dob || r.dateOfBirth || null,
    gender: r.gender || null,
    emails: Array.isArray(r.emails) ? r.emails : (r.email ? [r.email] : []),
    phones: Array.isArray(r.phones) ? r.phones : (r.phone ? [r.phone] : []),
    address: r.address || (r.address_line1 || r.city || r.zip || r.postal
      ? {
          line1: r.address_line1 || null,
          line2: r.address_line2 || null,
          city: r.city || null,
          region: r.state || r.region || null,
          postal: r.postal || r.zip || null,
          country: r.country || null,
        }
      : null),
  };
}

function _thresholds(db) {
  try {
    const profiles = require('../identity/profiles');
    const config = require('../config');
    return profiles.thresholdsFor(db, config.resolverThresholds);
  } catch (_) {
    return { autoMerge: 0.85, review: 0.30 };
  }
}

async function returnInbox(pairingCfg, results, { fetchImpl = null } = {}) {
  if (!results.length) return { returned: 0 };
  const body = { tenant: pairingCfg.schoolId, results };
  await _call(pairingCfg, {
    method: 'POST', path: '/familygraph-inbox',
    query: { tenant: pairingCfg.schoolId },
    body, isWrite: true, fetchImpl,
  });
  log.info('integration_pp.inbox.returned', { tenant: pairingCfg.schoolId, count: results.length });
  return { returned: results.length };
}

// ---------------------------------------------------------------------------
// One full check-in for a single tenant (steps 1→4).
// ---------------------------------------------------------------------------

async function checkInOnce(db, secrets, schoolId, { fetchImpl = null, outboxMax = DEFAULT_OUTBOX_MAX, batchLimit = DEFAULT_BATCH_LIMIT } = {}) {
  const cfg = pairing.load(db, secrets, schoolId);
  if (!cfg) throw _agentError('no_pairing', `no pairing for ${schoolId}`);
  if (!cfg.enabled) return { tenant: schoolId, skipped: 'disabled' };
  if (!pairing.isComplete(db, secrets, schoolId)) return { tenant: schoolId, skipped: 'incomplete' };

  const summary = { tenant: schoolId, pushed: 0, processed: 0, returned: 0, errors: 0 };
  // Step 1: push reconciliation batch.
  try {
    const r = await pushBatch(db, secrets, cfg, { limit: batchLimit, fetchImpl });
    summary.pushed = r.count;
    summary.ackedCursor = r.ackedCursor;
  } catch (e) {
    summary.errors += 1;
    log.warn('integration_pp.checkin.push_failed', { tenant: schoolId, reason: e.reason || 'error' });
  }

  // Step 2: fetch outbox.
  let items = [];
  try {
    items = await fetchOutbox(cfg, { max: outboxMax, fetchImpl });
  } catch (e) {
    summary.errors += 1;
    log.warn('integration_pp.checkin.outbox_failed', { tenant: schoolId, reason: e.reason || 'error' });
  }

  // Step 3: process locally.
  const results = [];
  for (const item of items) {
    const res = processItem(db, secrets, cfg, item);
    if (!res.ok) summary.errors += 1;
    results.push(res);
  }
  summary.processed = results.length;

  // Step 4: return results to inbox.
  if (results.length) {
    try {
      const r = await returnInbox(cfg, results, { fetchImpl });
      summary.returned = r.returned;
    } catch (e) {
      summary.errors += 1;
      log.warn('integration_pp.checkin.inbox_failed', { tenant: schoolId, reason: e.reason || 'error' });
    }
  }

  pairing.setLastCheckInAt(db, schoolId, Date.now());
  audit.record(db, {
    action: 'pp_pairing_checkin',
    actor: ACTOR,
    metadata: {
      school_id: schoolId,
      pushed: summary.pushed, processed: summary.processed,
      returned: summary.returned, errors: summary.errors,
    },
  });
  return summary;
}

module.exports = {
  CONTRACT_VERSION,
  ACTOR,
  assembleBatch,
  pushBatch,
  fetchOutbox,
  processItem,
  returnInbox,
  checkInOnce,
  // exported for tests
  _toIncoming,
  _newRequestId,
};
