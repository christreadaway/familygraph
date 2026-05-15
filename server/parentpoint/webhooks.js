'use strict';

// PP webhook subscriptions + outbound dispatcher. §6.5: when an identity /
// household / consent record changes, FamilyGraph POSTs to a registered
// ParentPoint Cloud Function URL with an HMAC-SHA256 signature.
//
// Body shape (from the contract):
//   {
//     event: 'person.updated' | 'person.deleted'
//          | 'household.updated' | 'household.deleted'
//          | 'consent.updated',
//     personId: 'p_...',
//     householdId: 'f_...',
//     updatedAt: '<iso>',
//     schoolHints: ['st-theresa']   // optional
//   }
//
// Signature header:
//   X-FG-Signature: sha256=<hex of HMAC-SHA256(secret, body)>
//
// Storage:
//   pp_webhook_subscriptions — registered endpoints (one per consumer).
//   pp_webhook_deliveries    — one row per attempted delivery, with
//                              exponential-backoff retry semantics that
//                              mirror notifications.

const crypto = require('crypto');
const { URL } = require('url');
const audit = require('../audit');
const enc = require('../crypto/encryption');
const { newCode } = require('../crypto/identifiers');
const log = require('../log');

const KNOWN_EVENTS = new Set([
  'person.updated',
  'person.deleted',
  'household.updated',
  'household.deleted',
  'consent.updated',
]);

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];

function sign(secret, body) {
  if (!secret) return null;
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const sig = crypto.createHmac('sha256', secret).update(bytes).digest('hex');
  return `sha256=${sig}`;
}

function _row2sub(db, secrets, row) {
  if (!row) return null;
  return {
    code: row.code,
    url: row.url,
    events: row.events,
    school_hint: row.school_hint || null,
    enabled: !!row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_delivered_at: row.last_delivered_at,
    last_status: row.last_status,
    last_error: row.last_error,
    has_secret: !!row.secret_ct,
  };
}

// SSRF guard. We POST signed payloads to operator-supplied URLs. A
// loopback / link-local / metadata-service target is almost never
// what an operator actually means, so reject those outright. Plain
// http:// passes (we sign the body for integrity) but logs a warning
// — confidentiality is the operator's network responsibility.
function _isLoopbackOrLinkLocal(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  if (h === 'localhost') return true;
  if (h === '0.0.0.0') return true;
  if (/^127\./.test(h)) return true;
  if (h === '::1' || h === '[::1]') return true;
  if (/^169\.254\./.test(h)) return true;       // IPv4 link-local + cloud metadata
  if (/^fe80:/i.test(h)) return true;           // IPv6 link-local
  if (/^10\./.test(h)) return true;             // RFC1918 — block by default
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
  return false;
}

function subscribe(db, secrets, { url, secret = null, events = '*', schoolHint = null } = {}) {
  if (!url || typeof url !== 'string') throw new Error('url required');
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error('invalid url'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported url scheme: ${parsed.protocol}`);
  }
  if (_isLoopbackOrLinkLocal(parsed.hostname)) {
    throw new Error('webhook url cannot target loopback / link-local / private addresses');
  }
  if (parsed.protocol === 'http:') {
    log.warn('pp_webhook.insecure_subscription', {
      host: parsed.hostname,
      detail: 'plain http; signed payload is integrity-protected but not confidential',
    });
  }
  // Allowed `events` values: '*' (all) or a comma-separated list of
  // known event names.
  let normalizedEvents = '*';
  if (events && events !== '*') {
    const list = Array.isArray(events) ? events : String(events).split(',');
    const cleaned = list.map(e => String(e).trim()).filter(Boolean);
    for (const e of cleaned) {
      if (!KNOWN_EVENTS.has(e)) throw new Error(`unknown event: ${e}`);
    }
    normalizedEvents = cleaned.join(',') || '*';
  }
  const code = newCode('audit').replace(/^au_/, 'wh_');
  db.prepare(
    `INSERT INTO pp_webhook_subscriptions
        (code, url, secret_ct, events, school_hint, enabled)
        VALUES (?, ?, ?, ?, ?, 1)`
  ).run(code, url, enc.encrypt(secrets, secret), normalizedEvents, schoolHint);
  audit.record(db, {
    action: 'pp_webhook_subscribe',
    actor: 'parentpoint',
    metadata: { code, url, events: normalizedEvents, school_hint: schoolHint || null },
  });
  return list(db, secrets).find(s => s.code === code);
}

// Default behaviour: list ACTIVE subscriptions only (enabled=1). Pass
// `status: 'all'` to see soft-disabled rows too — useful for the
// operator UI that wants to surface a "resubscribe" affordance.
function list(db, secrets, { status = 'active' } = {}) {
  const where = status === 'all' ? '' : 'WHERE enabled = 1';
  return db.prepare(
    `SELECT * FROM pp_webhook_subscriptions ${where} ORDER BY created_at DESC`
  ).all().map(r => _row2sub(db, secrets, r));
}

function get(db, secrets, code) {
  const row = db.prepare(`SELECT * FROM pp_webhook_subscriptions WHERE code = ?`).get(code);
  return _row2sub(db, secrets, row);
}

// Soft-unsubscribe: flip enabled=0 and record an entity_changes row.
// The row stays in the database so a later reinstate puts the
// subscription back where it was (URL, secret, school hint). Hard
// deletion would lose the secret — and the secret is the only thing
// keeping in-flight delivery signatures valid for the receiving end.
function unsubscribe(db, code) {
  const history = require('../identity/history');
  const before = db.prepare(`SELECT * FROM pp_webhook_subscriptions WHERE code = ?`).get(code);
  if (!before) return false;
  if (before.enabled === 0) return true;
  db.prepare(
    `UPDATE pp_webhook_subscriptions SET enabled = 0,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE code = ?`
  ).run(code);
  const after = db.prepare(`SELECT * FROM pp_webhook_subscriptions WHERE code = ?`).get(code);
  history.record(db, {
    entityKind: 'webhook_subscription', entityCode: code, operation: 'archive',
    before, after, actor: 'parentpoint',
  });
  audit.record(db, {
    action: 'pp_webhook_unsubscribe',
    actor: 'parentpoint',
    metadata: { code },
  });
  return true;
}

// Reverse a soft-unsubscribe.
function resubscribe(db, code) {
  const history = require('../identity/history');
  const before = db.prepare(`SELECT * FROM pp_webhook_subscriptions WHERE code = ?`).get(code);
  if (!before) return false;
  if (before.enabled === 1) return true;
  db.prepare(
    `UPDATE pp_webhook_subscriptions SET enabled = 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE code = ?`
  ).run(code);
  const after = db.prepare(`SELECT * FROM pp_webhook_subscriptions WHERE code = ?`).get(code);
  history.record(db, {
    entityKind: 'webhook_subscription', entityCode: code, operation: 'reinstate',
    before, after, actor: 'parentpoint',
  });
  audit.record(db, {
    action: 'pp_webhook_resubscribe', actor: 'parentpoint', metadata: { code },
  });
  return true;
}

function _subscriptionsForEvent(db, event, schoolHints) {
  // Filter by enabled + event-list match + (school hint or wildcard).
  const rows = db.prepare(
    `SELECT * FROM pp_webhook_subscriptions WHERE enabled = 1`
  ).all();
  return rows.filter(r => {
    if (r.events !== '*' && !r.events.split(',').includes(event)) return false;
    if (!r.school_hint) return true;
    if (!Array.isArray(schoolHints) || schoolHints.length === 0) return true;
    return schoolHints.includes(r.school_hint);
  });
}

// Enqueue a delivery for every subscription whose filter matches.
// `extra` is merged into the payload after the contract-defined keys —
// PP clients that read the body get to see things like `schoolId` for a
// school-scoped consent change without having to parse extra headers.
function enqueue(db, secrets, { event, personCode = null, familyCode = null, schoolHints = [], updatedAt = null, extra = null } = {}) {
  if (!KNOWN_EVENTS.has(event)) throw new Error(`unknown event: ${event}`);
  const subs = _subscriptionsForEvent(db, event, schoolHints);
  if (subs.length === 0) return [];
  const body = {
    event,
    personId: personCode || undefined,
    householdId: familyCode || undefined,
    updatedAt: updatedAt || new Date().toISOString(),
    schoolHints: schoolHints && schoolHints.length ? schoolHints : undefined,
  };
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== null && v !== undefined && body[k] === undefined) body[k] = v;
    }
  }
  const payload = JSON.stringify(body);
  const codes = [];
  for (const sub of subs) {
    const code = newCode('audit').replace(/^au_/, 'whd_');
    db.prepare(
      `INSERT INTO pp_webhook_deliveries
          (code, subscription_code, event, person_code, family_code, payload)
          VALUES (?, ?, ?, ?, ?, ?)`
    ).run(code, sub.code, event, personCode, familyCode, payload);
    codes.push(code);
  }
  return codes;
}

function listPendingDeliveries(db, { now = new Date(), limit = 50 } = {}) {
  return db.prepare(
    `SELECT d.*, s.url AS url, s.secret_ct AS secret_ct, s.enabled AS enabled
       FROM pp_webhook_deliveries d
       JOIN pp_webhook_subscriptions s ON s.code = d.subscription_code
      WHERE d.status = 'pending'
        AND s.enabled = 1
        AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
      ORDER BY d.created_at ASC LIMIT ?`
  ).all(now.toISOString(), Math.max(1, Math.min(500, limit)));
}

function listDeliveries(db, { subscriptionCode = null, status = null, limit = 100 } = {}) {
  const filters = [];
  const params = [];
  if (subscriptionCode) { filters.push('subscription_code = ?'); params.push(subscriptionCode); }
  if (status) { filters.push('status = ?'); params.push(status); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  params.push(Math.max(1, Math.min(1000, limit)));
  return db.prepare(
    `SELECT * FROM pp_webhook_deliveries ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...params);
}

function _markSent(db, code, providerStatus) {
  db.prepare(
    `UPDATE pp_webhook_deliveries
        SET status = 'sent',
            sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            provider_status = ?
      WHERE code = ?`
  ).run(providerStatus, code);
}

function _markFailed(db, code, attempts, errMsg, providerStatus = null) {
  if (attempts >= MAX_ATTEMPTS) {
    db.prepare(
      `UPDATE pp_webhook_deliveries
          SET status = 'failed', attempts = ?, last_error = ?, provider_status = ?
        WHERE code = ?`
    ).run(attempts, errMsg, providerStatus, code);
    return;
  }
  const delayMs = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
  const nextAt = new Date(Date.now() + delayMs).toISOString();
  db.prepare(
    `UPDATE pp_webhook_deliveries
        SET attempts = ?, last_error = ?, provider_status = ?, next_attempt_at = ?
      WHERE code = ?`
  ).run(attempts, errMsg, providerStatus, nextAt, code);
}

function _touchSubscription(db, subscriptionCode, lastStatus, lastError) {
  db.prepare(
    `UPDATE pp_webhook_subscriptions
        SET last_delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            last_status = ?, last_error = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE code = ?`
  ).run(lastStatus, lastError, subscriptionCode);
}

// Pluggable HTTP sender. Defaults to a Node fetch-based call when not
// overridden; tests inject a stub so they don't need a real socket.
async function _defaultSender({ url, body, headers, timeoutMs = 10_000 }) {
  // fetch is global in Node 20+.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: controller.signal,
    });
    return { ok: r.ok, status: r.status };
  } finally {
    clearTimeout(t);
  }
}

async function dispatchOne(db, secrets, row, { sender = _defaultSender } = {}) {
  const attempts = (row.attempts || 0) + 1;
  const secret = enc.decrypt(secrets, row.secret_ct);
  const signature = sign(secret, row.payload);
  const headers = {
    'x-fg-contract-version': 'v0.1',
    'user-agent': 'familygraph-webhook/0.1',
  };
  if (signature) headers['x-fg-signature'] = signature;
  try {
    const result = await sender({
      url: row.url,
      body: row.payload,
      headers,
    });
    if (result.ok) {
      _markSent(db, row.code, result.status);
      _touchSubscription(db, row.subscription_code, 'sent', null);
      return { ok: true, code: row.code, status: result.status };
    }
    const msg = `provider returned ${result.status}`;
    _markFailed(db, row.code, attempts, msg, result.status);
    _touchSubscription(db, row.subscription_code, 'error', msg);
    return { ok: false, code: row.code, status: result.status, error: msg };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    _markFailed(db, row.code, attempts, msg, null);
    _touchSubscription(db, row.subscription_code, 'error', msg);
    return { ok: false, code: row.code, error: msg };
  }
}

async function dispatchPending(db, secrets, { now = new Date(), sender = _defaultSender, limit = 50 } = {}) {
  const pending = listPendingDeliveries(db, { now, limit });
  const out = [];
  for (const row of pending) {
    out.push(await dispatchOne(db, secrets, row, { sender }));
  }
  return out;
}

// Background ticker (mirrors the notifications dispatcher). Stop with the
// returned controller; tests call dispatchPending directly so they don't
// need the ticker at all.
//
// `stop()` is async-friendly: it stops scheduling new ticks AND awaits
// any in-flight dispatch so a graceful shutdown doesn't orphan a fetch
// mid-delivery. Callers that don't care can ignore the returned
// promise; setInterval-style callers should `await stop()` before
// closing the database.
function start(db, secrets, { intervalMs = 60_000 } = {}) {
  let stopped = false;
  let inflight = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    const p = dispatchPending(db, secrets).catch(e => {
      log.error('pp_webhook.dispatch_failed', { message: String(e && e.message || e), stack: e && e.stack });
    });
    inflight = p;
  };
  // Fire once immediately so a process restart doesn't park pending rows.
  tick();
  const handle = setInterval(tick, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(handle);
      return inflight;
    },
  };
}

module.exports = {
  subscribe,
  list,
  get,
  unsubscribe,
  resubscribe,
  enqueue,
  dispatchPending,
  dispatchOne,
  listPendingDeliveries,
  listDeliveries,
  sign,
  start,
  KNOWN_EVENTS,
  MAX_ATTEMPTS,
  BACKOFF_MS,
};
