'use strict';

const express = require('express');
const { SCHEMA_VERSION } = require('../db');
const profiles = require('../identity/profiles');
const runs = require('../connectors/runs');

// Capability discovery. Consuming apps read this off the open /api/health
// endpoint to feature-detect what THIS FamilyGraph build supports, instead of
// hardcoding assumptions about the API. As new integration features land, add
// a flag here and bump CAPABILITIES_VERSION — a consuming app can then light up
// (or gate off) a feature based on what the running registry actually offers.
// This is the contract that keeps future integrations forward/backward
// compatible. Keep it in sync with the changelog in FAMILYGRAPH_INTEGRATION.md.
const CAPABILITIES_VERSION = 2;
const CAPABILITIES = {
  contract: 'v0.2',
  identity_match: true,            // POST /api/identity/match
  identity_resolve: true,          // POST /api/identity/resolve
  identity_resolve_family: true,   // resolve returns a family code; with_family creates one
  identity_resolve_batch: true,    // POST /api/identity/resolve-batch
  identity_feedback: true,         // POST /api/identity/feedback
  identity_changed_feed: true,     // GET  /api/identity/changed?since=
  identity_conflict_source_ref: true, // resolve stamps caller source_ref onto opened conflicts
  conflicts_api: true,             // /api/conflicts
  sanitize: true,                  // /api/sanitize + /api/desanitize
  audit_external_export: true,     // POST /api/audit/external-export
  scoped_keys: true,               // sk_ tokens via /api/keys (or CLI issue-key)
};

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
      capabilities_version: CAPABILITIES_VERSION,
      capabilities: CAPABILITIES,
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
