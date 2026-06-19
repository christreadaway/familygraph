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

// Assemble the batch of person + household changes since PP's last-acked
// cursor, reusing the existing changed-feed machinery. The cursor is an ISO
// timestamp (the changed feed's own cursor shape). Person/household objects
// carry PII fields, so the items array is SEALED with the envelope key. The
// cursor and tenant stay cleartext.
function assembleBatch(db, secrets, pairingCfg, { limit = DEFAULT_BATCH_LIMIT } = {}) {
  const since = pairingCfg.lastAckedCursor || null;
  const persons = changes.listChangedPersons(db, secrets, since, { limit });
  const households = changes.listChangedHouseholds(db, secrets, since, { limit });
  // The next cursor is the max of both feeds' cursors so a tick that only
  // moved households still advances past person-only-empty windows.
  const cursor = [persons.cursor, households.cursor]
    .filter(Boolean)
    .sort()
    .pop() || (since || '1970-01-01T00:00:00.000Z');
  return {
    persons: persons.items,
    households: households.items,
    cursor,
    count: persons.items.length + households.items.length,
  };
}

async function pushBatch(db, secrets, pairingCfg, { limit = DEFAULT_BATCH_LIMIT, fetchImpl = null } = {}) {
  const batch = assembleBatch(db, secrets, pairingCfg, { limit });
  // Seal the PII-bearing items; cursor + tenant stay cleartext.
  const body = {
    tenant: pairingCfg.schoolId,
    since: pairingCfg.lastAckedCursor || null,
    cursor: batch.cursor,
    count: batch.count,
    payload: envelope.seal(pairingCfg.envelope_key, {
      persons: batch.persons,
      households: batch.households,
    }),
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
// identity-resolved names) are SEALED; code-only results (sanitize) stay
// cleartext.
//
// Each item shape (as PP parks it):
//   { id, kind, ...kind-specific fields }
// `kind`-specific input fields may themselves be sealed by PP if they carry
// PII (e.g. desanitize text). We open any sealed input before processing.
function processItem(db, secrets, pairingCfg, item) {
  const id = item && item.id;
  const kind = item && item.kind;
  const base = { id, kind };
  try {
    if (kind === 'sanitize') {
      // text → codes. Input text may be sealed (it's PII). Result contains
      // only pseudonymous codes → cleartext.
      const text = _openMaybe(pairingCfg, item.text);
      const out = sanitize.sanitizeText(db, secrets, String(text || ''), { actor: `pp:${pairingCfg.schoolId}` });
      return { ...base, ok: true, result: { sanitized: out.sanitized, token_set: out.tokenSet } };
    }
    if (kind === 'desanitize') {
      // codes → text (authorized). Result contains names → SEALED.
      const text = _openMaybe(pairingCfg, item.text);
      const tokenSet = item.token_set || item.tokenSet;
      const restored = sanitize.desanitizeText(db, secrets, String(text || ''), tokenSet, {
        actor: `pp:${pairingCfg.schoolId}`,
        // PP is an authorized de-anonymization caller for its own token sets.
        authKind: 'master',
      });
      return { ...base, ok: true, result: envelope.seal(pairingCfg.envelope_key, { text: restored }) };
    }
    if (kind === 'identity.resolve') {
      // record → code/action. The incoming record carries PII → may be
      // sealed by PP. The result code is pseudonymous, but reasons can echo
      // matched values, so SEAL the result to be safe.
      const record = _openMaybe(pairingCfg, item.record);
      const incoming = _toIncoming(record);
      const thresholds = _thresholds(db);
      const out = resolver.resolveOrCreatePerson(db, secrets, thresholds, incoming, {
        actor: `pp:${pairingCfg.schoolId}`,
        source: `pp:${pairingCfg.schoolId}`,
      });
      return { ...base, ok: true, result: envelope.seal(pairingCfg.envelope_key, out) };
    }
    if (kind === 'schoolContext') {
      // PP-supplied child/school snapshot → apply via existing logic. The
      // snapshot carries child PII → may be sealed. We ack with the stored
      // shape (codes + non-PII fields) — but seal it since grade/classroom
      // can be sensitive in aggregate.
      const snapshot = _openMaybe(pairingCfg, item.snapshot || item.schoolContext || item);
      const personCode = snapshot.personId || snapshot.personCode || snapshot.person_code || snapshot.person_id;
      schoolContext.upsert(db, personCode, { ...snapshot, source_app: `pp:${pairingCfg.schoolId}` });
      const stored = schoolContext.getOne(db, personCode, snapshot.schoolId || snapshot.school_id);
      return { ...base, ok: true, result: envelope.seal(pairingCfg.envelope_key, { schoolContext: stored }) };
    }
    if (kind === 'document.fetch') {
      // Reserved for a later phase. Accept-and-no-op cleanly so PP can mark
      // the item handled without it sticking in the outbox forever.
      return { ...base, ok: true, deferred: true, result: { status: 'not_implemented' } };
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
