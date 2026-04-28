'use strict';

const express = require('express');
const { SCHEMA_VERSION } = require('../db');
const profiles = require('../identity/profiles');

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
    });
  });
  return r;
}

module.exports = build;
