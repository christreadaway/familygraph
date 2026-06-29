'use strict';

// Federation push — present the canonical person/household hex to consumers
// that cannot pull.
//
// The per-change webhook (webhooks.js) is a THIN notification: it carries only
// the changed entity's hex id and assumes the consumer will GET the full
// record back. That assumption breaks for any app that lives OUTSIDE
// FamilyGraph's network — a cloud service while FamilyGraph runs on-prem
// behind a firewall can receive our outbound POSTs but can never reach back in
// to pull. It would hold an id it can never resolve.
//
// A subscription flagged `federation_push = 1` instead receives FAT batches:
// FamilyGraph POSTs the full person / household objects (the exact shapes the
// changed-since feed serves — `personId: 'p_<hex>'`, `householdId: 'f_<hex>'`,
// members keyed by the same hex), so the consumer federates identity on the
// canonical hex without ever pulling. Active records carry full detail;
// archived records arrive as `{ <id>, active: false }` tombstones.
//
// Two per-subscription cursors track how far each entity stream has been
// pushed. A null cursor means "never pushed", so a brand-new federation
// subscription hydrates the entire active graph on its first tick and then
// only ships changed-since deltas. The batch is materialized fresh from the
// live graph on every send and is NEVER persisted, so no plaintext PII lands
// in `webhook_deliveries` at rest.
//
// This module is app-agnostic by construction: it pushes to whatever URL a
// subscription registered. No consuming app is named or special-cased.

const enc = require('../crypto/encryption');
const log = require('../log');
const changes = require('./changes');
const webhooks = require('./webhooks');

const CONTRACT_VERSION = 'v0.1';
const DEFAULT_BATCH = 500;
// Per tick, drain up to this many batches per subscription so a large initial
// hydration doesn't take one 60s tick per page. Anything still outstanding
// rolls to the next tick.
const MAX_DRAIN = 50;

function _activeFederationSubs(db) {
  return db.prepare(
    `SELECT * FROM webhook_subscriptions
       WHERE enabled = 1 AND federation_push = 1
       ORDER BY created_at ASC`
  ).all();
}

function _touch(db, code, status, error) {
  db.prepare(
    `UPDATE webhook_subscriptions
        SET last_delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            last_status = ?, last_error = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE code = ?`
  ).run(status, error, code);
}

// Build the fat batch for one subscription from its current cursors. Returns
// null when nothing has changed since the subscription was last pushed.
function buildBatch(db, secrets, sub, { limit = DEFAULT_BATCH } = {}) {
  const personsSince = sub.reconcile_persons_cursor || null;
  const householdsSince = sub.reconcile_households_cursor || null;
  const persons = changes.listChangedPersons(db, secrets, personsSince, { limit });
  const households = changes.listChangedHouseholds(db, secrets, householdsSince, { limit });
  if (persons.items.length === 0 && households.items.length === 0) return null;

  const nextPersonsCursor = persons.items.length ? persons.cursor : personsSince;
  const nextHouseholdsCursor = households.items.length ? households.cursor : householdsSince;
  const body = {
    type: 'federation.sync',
    contractVersion: CONTRACT_VERSION,
    // `hydration: true` on the first batch lets a consumer treat it as a full
    // snapshot (e.g. mark-and-sweep its cache) rather than an incremental delta.
    hydration: !sub.hydrated_at,
    generatedAt: new Date().toISOString(),
    persons: persons.items,
    households: households.items,
    cursors: { persons: nextPersonsCursor, households: nextHouseholdsCursor },
  };
  return {
    body,
    nextPersonsCursor,
    nextHouseholdsCursor,
    // If a page came back full there is very likely more behind it.
    more: persons.items.length >= limit || households.items.length >= limit,
  };
}

// Push one batch to one subscription. Advances the cursors only on a confirmed
// 2xx so a failed delivery is retried (at-least-once; the consumer dedupes by
// the hex + updatedAt, exactly as the changed-feed recovery channel expects).
async function pushToSubscription(db, secrets, sub, { sender = webhooks.defaultSender, limit = DEFAULT_BATCH } = {}) {
  const built = buildBatch(db, secrets, sub, { limit });
  if (!built) return { ok: true, code: sub.code, skipped: 'no_changes' };

  const payload = JSON.stringify(built.body);
  const secret = enc.decrypt(secrets, sub.secret_ct);
  const signature = webhooks.sign(secret, payload);
  const headers = {
    'x-fg-contract-version': CONTRACT_VERSION,
    'x-fg-event': 'federation.sync',
    'user-agent': 'familygraph-federation/0.1',
  };
  if (signature) headers['x-fg-signature'] = signature;

  try {
    const result = await sender({ url: sub.url, body: payload, headers });
    if (result.ok) {
      db.prepare(
        `UPDATE webhook_subscriptions
            SET reconcile_persons_cursor = ?, reconcile_households_cursor = ?,
                hydrated_at = COALESCE(hydrated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE code = ?`
      ).run(built.nextPersonsCursor, built.nextHouseholdsCursor, sub.code);
      _touch(db, sub.code, 'sent', null);
      log.info('federation.push_ok', {
        code: sub.code,
        persons: built.body.persons.length,
        households: built.body.households.length,
        hydration: built.body.hydration,
      });
      return {
        ok: true,
        code: sub.code,
        persons: built.body.persons.length,
        households: built.body.households.length,
        more: built.more,
      };
    }
    const msg = `consumer returned ${result.status}`;
    _touch(db, sub.code, 'error', msg);
    log.warn('federation.push_failed', { code: sub.code, status: result.status });
    return { ok: false, code: sub.code, status: result.status, error: msg };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    _touch(db, sub.code, 'error', msg);
    log.warn('federation.push_error', { code: sub.code, error: msg });
    return { ok: false, code: sub.code, error: msg };
  }
}

// Push to every active federation subscription, draining each until it has
// nothing left (capped at MAX_DRAIN pages per tick). Re-reads the subscription
// row between pages so the advanced cursors are picked up.
async function reconcileAll(db, secrets, { sender = webhooks.defaultSender, limit = DEFAULT_BATCH, maxDrain = MAX_DRAIN } = {}) {
  const out = [];
  for (const seed of _activeFederationSubs(db)) {
    let iterations = 0;
    let last;
    do {
      const fresh = db.prepare(`SELECT * FROM webhook_subscriptions WHERE code = ?`).get(seed.code);
      if (!fresh || !fresh.enabled) break;
      last = await pushToSubscription(db, secrets, fresh, { sender, limit });
      out.push(last);
      iterations += 1;
    } while (last && last.ok && last.more && iterations < maxDrain);
  }
  return out;
}

// Reset a subscription's cursors so the next tick re-hydrates it from scratch.
// The recovery affordance for "my cache is out of sync, send me everything".
function resync(db, code) {
  const row = db.prepare(`SELECT code FROM webhook_subscriptions WHERE code = ?`).get(code);
  if (!row) return false;
  db.prepare(
    `UPDATE webhook_subscriptions
        SET reconcile_persons_cursor = NULL, reconcile_households_cursor = NULL,
            hydrated_at = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE code = ?`
  ).run(code);
  log.info('federation.resync', { code });
  return true;
}

// Background ticker (mirrors the webhook dispatcher). Disable with
// FAMILY_GRAPH_DISABLE_FEDERATION_PUSH=1.
function start(db, secrets, { intervalMs = 60_000 } = {}) {
  if (process.env.FAMILY_GRAPH_DISABLE_FEDERATION_PUSH === '1') {
    log.warn('federation.disabled', {});
    return { running: false, stop() { return Promise.resolve(); } };
  }
  let stopped = false;
  let inflight = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    const p = reconcileAll(db, secrets).catch(e => {
      log.error('federation.tick_failed', { message: String(e && e.message || e), stack: e && e.stack });
    });
    inflight = p;
  };
  // Fire once on boot so a restart hydrates any waiting subscription promptly.
  tick();
  const handle = setInterval(tick, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return {
    running: true,
    stop() { stopped = true; clearInterval(handle); return inflight; },
  };
}

module.exports = {
  buildBatch,
  pushToSubscription,
  reconcileAll,
  resync,
  start,
  CONTRACT_VERSION,
};
