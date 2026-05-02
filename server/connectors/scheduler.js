'use strict';

// Connector scheduler. One in-process loop wakes every 60 seconds, asks
// each connector "are you due?", and triggers `runSync` for the ones that
// say yes. Only one sync per connector at a time; cross-connector
// concurrency is allowed.
//
// Scheduling primitives are deliberately simple: the operator picks one
// of a handful of cadences in the dashboard, and the scheduler computes
// the next-due timestamp from `last_sync_at`. No cron syntax, no
// catch-up loops, no double-runs after a laptop wakes from sleep.

const credentials = require('./credentials');
const runs = require('./runs');
const registry = require('./index');
const log = require('../log');

const TICK_MS = 60 * 1000;

function _hourly(lastMs) { return Date.now() - (lastMs || 0) >= 60 * 60 * 1000; }

function _atHourLocalUtc(lastMs, hour, dayOfWeek = null) {
  // "Daily at 02:00 UTC" / "Weekly Sunday 02:00 UTC". We compute due
  // times in UTC; the operator's local-time interpretation is that this
  // runs sometime in the early hours when nobody's looking. Across DST
  // boundaries the run can drift by an hour either way; the spec accepts
  // that as "good enough overnight".
  const now = new Date();
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
  if (candidate.getTime() > now.getTime()) {
    // Today's slot hasn't happened yet; use yesterday's slot as the cutoff.
    candidate.setUTCDate(candidate.getUTCDate() - 1);
  }
  if (dayOfWeek != null) {
    // Walk back to the most recent slot on the target day-of-week.
    while (candidate.getUTCDay() !== dayOfWeek) {
      candidate.setUTCDate(candidate.getUTCDate() - 1);
    }
  }
  if (!lastMs) return true;
  return lastMs < candidate.getTime();
}

function isDue(schedule, lastSyncMs) {
  if (!schedule || schedule === 'off') return false;
  if (schedule === 'hourly') return _hourly(lastSyncMs);
  if (schedule === 'daily_2am') return _atHourLocalUtc(lastSyncMs, 2, null);
  if (schedule === 'weekly_sun_2am') return _atHourLocalUtc(lastSyncMs, 2, 0);
  return false;
}

function dueConnectors(db, secrets) {
  const due = [];
  for (const name of registry.names()) {
    const c = credentials.describe(db, secrets, name);
    if (!c.enabled) continue;
    if (!credentials.isComplete(db, secrets, name)) continue;
    if (runs.isRunning(db, name)) continue;
    const lastSyncMs = c.last_sync_at ? Number(c.last_sync_at) : 0;
    if (isDue(c.schedule, lastSyncMs)) due.push(name);
  }
  return due;
}

async function tick(db, secrets, thresholds, opts = {}) {
  const due = dueConnectors(db, secrets);
  log.debug('connector.scheduler.tick', { connectors_due: due });
  const results = [];
  for (const name of due) {
    try {
      const r = await registry.runSync(db, secrets, thresholds, name, {
        trigger: 'scheduled',
        actor: 'scheduler',
        fetchImpl: opts.fetchImpl || null,
      });
      results.push({ connector: name, ...r });
    } catch (e) {
      log.error('connector.scheduler.tick_error', { connector: name, error: String(e.message || e) });
      results.push({ connector: name, ok: false, reason: 'scheduler_error', message: String(e.message || e) });
    }
  }
  return results;
}

function start(db, secrets, thresholds) {
  if (process.env.FAMILY_GRAPH_DISABLE_CONNECTORS === '1') {
    log.warn('connector.scheduler.disabled', {});
    return { running: false };
  }
  // Reap any rows left in `running` state from a previous (crashed) process.
  try { runs.reapStalled(db); } catch (_) { /* ignore at boot */ }

  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    try { await tick(db, secrets, thresholds); }
    catch (e) {
      log.error('connector.scheduler.loop_error', { message: String(e.message || e), stack: e && e.stack });
    }
  };
  // Fire once on boot so an overdue sync runs immediately, then every 60s.
  loop();
  const handle = setInterval(loop, TICK_MS);
  if (handle.unref) handle.unref();
  return {
    running: true,
    stop() { stopped = true; clearInterval(handle); },
  };
}

module.exports = { start, tick, isDue, dueConnectors, TICK_MS };
