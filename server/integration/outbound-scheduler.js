'use strict';

// Outbound check-in scheduler for ParentPoint pairings.
//
// A small in-process loop (modelled on server/connectors/scheduler.js) that
// wakes on a short cadence, asks each ENABLED + COMPLETE pairing "are you
// due?" against its per-tenant check_in_interval_s, and runs one outbound
// check-in for the ones that say yes. One check-in per tenant at a time;
// cross-tenant concurrency is allowed.
//
// DORMANCY GUARANTEE: this scheduler binds no port and listens for nothing.
// When there are zero enabled pairings, every tick is a no-op — it walks an
// empty list and returns. The loop's setInterval handle is unref()'d so it
// never holds the process open on its own. FG remains a pure outbound dialer:
// the only network traffic this produces is FG → PP, and only once a pairing
// is explicitly enabled.

const pairing = require('./pairing');
const agent = require('./outbound-agent');
const log = require('../log');

// Wake cadence. We tick every 5s and let each pairing's own interval gate
// whether it actually checks in — so a 20s pairing fires roughly every 20s
// without the scheduler needing per-tenant timers.
const TICK_MS = 5 * 1000;

// In-flight guard so a slow check-in for a tenant doesn't overlap itself.
const _running = new Set();

function dueTenants(db, secrets, { now = Date.now() } = {}) {
  const due = [];
  for (const schoolId of pairing.ids(db)) {
    const cfg = pairing.load(db, secrets, schoolId);
    if (!cfg || !cfg.enabled) continue;
    if (!pairing.isComplete(db, secrets, schoolId)) continue;
    if (_running.has(schoolId)) continue;
    const intervalMs = Math.max(1, Number(cfg.checkInIntervalS || pairing.DEFAULT_INTERVAL_S)) * 1000;
    const lastMs = cfg.lastCheckInAt ? Number(cfg.lastCheckInAt) : 0;
    if (now - lastMs >= intervalMs) due.push(schoolId);
  }
  return due;
}

async function tick(db, secrets, opts = {}) {
  const due = dueTenants(db, secrets, opts);
  if (due.length === 0) return [];
  log.debug('integration_pp.scheduler.tick', { tenants_due: due });
  const results = [];
  for (const schoolId of due) {
    _running.add(schoolId);
    try {
      const r = await agent.checkInOnce(db, secrets, schoolId, { fetchImpl: opts.fetchImpl || null });
      results.push(r);
    } catch (e) {
      log.error('integration_pp.scheduler.tick_error', { tenant: schoolId, reason: e.reason || String(e.message || e) });
      results.push({ tenant: schoolId, ok: false, error: e.reason || 'tick_error' });
    } finally {
      _running.delete(schoolId);
    }
  }
  return results;
}

function start(db, secrets, { intervalMs = TICK_MS } = {}) {
  if (process.env.FAMILY_GRAPH_DISABLE_PP_OUTBOUND === '1') {
    log.warn('integration_pp.scheduler.disabled', {});
    return { running: false, stop() {} };
  }
  let stopped = false;
  let inflight = Promise.resolve();
  const loop = () => {
    if (stopped) return;
    inflight = tick(db, secrets).catch(e => {
      log.error('integration_pp.scheduler.loop_error', { message: String(e.message || e), stack: e && e.stack });
    });
  };
  // Fire once on boot so an overdue pairing checks in immediately.
  loop();
  const handle = setInterval(loop, intervalMs);
  if (handle.unref) handle.unref();
  return {
    running: true,
    stop() {
      stopped = true;
      clearInterval(handle);
      return inflight;
    },
  };
}

module.exports = { start, tick, dueTenants, TICK_MS };
