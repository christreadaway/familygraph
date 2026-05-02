'use strict';

const express = require('express');
const { SCHEMA_VERSION } = require('../db');
const profiles = require('../identity/profiles');
const runs = require('../connectors/runs');

function _connectorPosture(db) {
  // Lightweight summary the dashboard's status rail consumes. PRD §4.3:
  // each configured connector gets a green dot if its most recent sync
  // was OK, red if it errored. Connectors that aren't configured at all
  // are omitted from this list — the rail is for posture, not setup.
  const out = [];
  for (const name of ['facts', 'ministry_platform']) {
    const enabledRow = db.prepare(`SELECT value_json FROM settings WHERE key = ?`).get(`connector.${name}.enabled`);
    let enabled = false;
    try { enabled = enabledRow ? JSON.parse(enabledRow.value_json) === true : false; } catch (_) {}
    const last = runs.lastRun(db, name);
    if (!enabled && !last) continue;
    out.push({
      name,
      enabled,
      last_status: last ? last.status : 'untested',
      last_reason: last ? last.reason : null,
    });
  }
  return out;
}

function build({ db, watchState = null }) {
  const r = express.Router();
  r.get('/', (req, res) => {
    let dbOk = false;
    try {
      db.prepare('SELECT 1').get();
      dbOk = true;
    } catch (_) {
      dbOk = false;
    }
    let counts = null;
    let active = null;
    let pendingConflicts = 0;
    let connectors = [];
    if (dbOk) {
      try {
        counts = {
          families: db.prepare("SELECT COUNT(*) AS c FROM families WHERE status = 'active'").get().c,
          persons: db.prepare("SELECT COUNT(*) AS c FROM persons WHERE status = 'active'").get().c,
          audit_events: db.prepare('SELECT COUNT(*) AS c FROM audit_events').get().c,
          api_keys: db.prepare('SELECT COUNT(*) AS c FROM api_keys WHERE revoked_at IS NULL').get().c,
        };
        pendingConflicts = db.prepare("SELECT COUNT(*) AS c FROM conflicts WHERE status = 'open'").get().c;
        active = profiles.active(db);
        connectors = _connectorPosture(db);
      } catch (_) { /* schema mid-migration */ }
    }
    res.json({
      status: dbOk ? 'ok' : 'degraded',
      schema: SCHEMA_VERSION,
      time: new Date().toISOString(),
      counts,
      pending_conflicts: pendingConflicts,
      active_profile: active ? active.name : null,
      folder_watch: watchState ? watchState() : null,
      connectors,
    });
  });
  return r;
}

module.exports = build;
