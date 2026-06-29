'use strict';

// Operator-facing settings API for ParentPoint (PP) outbound pairings.
//
// Mounted under /api/pp-pairings with the MASTER bearer (operator-only) —
// these rows hold the shared secrets that authorise FG's outbound dial-out,
// so they live behind the same gate as /api/settings, not a per-app scope.
//
// This API configures the dialer only. It opens NO inbound surface: PP never
// calls FG. The four FG→PP calls are made by server/integration/outbound-agent.js
// on the scheduler's cadence once a pairing is enabled. Secrets are stored
// encrypted (server/integration/pairing.js) and never returned in responses.

const express = require('express');
const { userFacingMessage } = require('./_errors');
const pairing = require('../integration/pairing');

function build({ db, secrets }) {
  const r = express.Router();

  // List all pairings (secret-safe view).
  r.get('/', (req, res) => {
    res.json({ items: pairing.list(db, secrets) });
  });

  // Show one pairing (secret-safe view).
  r.get('/:schoolId', (req, res) => {
    const d = pairing.describe(db, secrets, req.params.schoolId);
    if (!d) return res.status(404).json({ error: 'not_found' });
    res.json({ pairing: d, complete: pairing.isComplete(db, secrets, req.params.schoolId) });
  });

  // Create or update a pairing. Accepts any subset of:
  //   pp_base_url, pp_bearer_credential, shared_webhook_secret,
  //   envelope_key, check_in_interval_s, enabled.
  // Secrets are write-only — they go in encrypted and never come back.
  r.put('/:schoolId', (req, res) => {
    try {
      const d = pairing.set(db, secrets, req.params.schoolId, req.body || {}, {
        actor: req.auth?.actor || 'operator',
      });
      res.json({ pairing: d, complete: pairing.isComplete(db, secrets, req.params.schoolId) });
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  // Toggle enable/disable without resending other fields.
  r.patch('/:schoolId', (req, res) => {
    const body = req.body || {};
    const allowed = {};
    if ('enabled' in body) allowed.enabled = !!body.enabled;
    if ('check_in_interval_s' in body) allowed.check_in_interval_s = body.check_in_interval_s;
    if (allowed.enabled === true && !pairing.isComplete(db, secrets, req.params.schoolId)) {
      // Don't enable a pairing that can't actually dial out.
      if (!pairing.exists(db, req.params.schoolId)) {
        return res.status(404).json({ error: 'not_found' });
      }
      return res.status(400).json({ error: 'pairing incomplete — set all required fields before enabling' });
    }
    try {
      const d = pairing.set(db, secrets, req.params.schoolId, allowed, {
        actor: req.auth?.actor || 'operator',
      });
      res.json({ pairing: d, complete: pairing.isComplete(db, secrets, req.params.schoolId) });
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  // Remove a pairing entirely (clears its secrets).
  r.delete('/:schoolId', (req, res) => {
    const ok = pairing.clear(db, secrets, req.params.schoolId, {
      actor: req.auth?.actor || 'operator',
    });
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });

  return r;
}

module.exports = build;
