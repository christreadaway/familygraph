'use strict';

const express = require('express');

const ALLOWED_KEYS = new Set([
  'audit_retention_days',
  'auto_merge',
  'review_threshold',
  'institution_name',
  'operator_name',
  // Operator email — used by the connector failure-notify path. Stored
  // as a setting (not env) so it can be backed up and travels with the
  // database to a new machine.
  'operator_email',
  // Notifications
  'notifications.enabled',
  'notifications.transport',        // 'postmark' | 'log'
  'notifications.reminder_hours',   // number, default 1
  'dashboard_url',                  // base URL the recipient clicks back to
  'postmark.from',                  // verified sender address
  'postmark.message_stream',        // default 'outbound'
  // EIM (Ethics and Integrity in Ministry) — Catholic safe-environment cert.
  // Renewal cycle varies by diocese; common values are 3 (default) or 5
  // years. The dashboard auto-fills eim_expires_on from eim_completed_on
  // using this number when the operator only provides a completion date.
  'eim.renewal_years',
  // How many days ahead the dashboard treats a cert as "expiring soon" so
  // the operator gets a heads-up before the lapse date arrives.
  'eim.expiring_soon_days',
]);

// Connector credentials live under `connector.<name>.<field>` in the
// settings table (the connectors module owns that key prefix). The
// generic GET /api/settings response must never expose those keys to a
// caller — even the base64 ciphertext leaks existence and length, which
// PRD §5.1 explicitly forbids. The dashboard reads connector status via
// /api/connectors instead, where each field is reduced to a `set: true`
// flag.
function _isConnectorKey(key) { return /^connector\./.test(String(key)); }

// For each connector key we DO surface, expose only the public value
// (plain-text URLs, schedule, enabled flag) — never any `_ct` keys.
function _isConnectorCiphertextKey(key) { return /^connector\.[^.]+\..+_ct$/.test(String(key)); }

function build({ db }) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const rows = db.prepare('SELECT key, value_json, updated_at FROM settings ORDER BY key ASC').all();
    const items = [];
    const connectorFlags = {};
    for (const row of rows) {
      if (_isConnectorCiphertextKey(row.key)) {
        // Reduce to a `_set: true` flag with no value.
        // Key shape: connector.<name>.<field>_ct → connector_<name>_<field>_set.
        const m = /^connector\.([^.]+)\.(.+)_ct$/.exec(row.key);
        if (m) connectorFlags[`connector_${m[1]}_${m[2]}_set`] = true;
        continue;
      }
      if (_isConnectorKey(row.key)) {
        // Surface the plain-text connector keys (api_base_url, schedule,
        // enabled, last_sync_at, etc.) — these are not PII and the
        // dashboard wants them visible in the settings inventory.
        items.push({ key: row.key, value: JSON.parse(row.value_json), updated_at: row.updated_at });
        continue;
      }
      items.push({ key: row.key, value: JSON.parse(row.value_json), updated_at: row.updated_at });
    }
    for (const [k, v] of Object.entries(connectorFlags)) {
      items.push({ key: k, value: v, updated_at: null });
    }
    res.json({ items });
  });

  r.put('/:key', (req, res) => {
    const k = req.params.key;
    if (_isConnectorKey(k)) {
      return res.status(400).json({ error: `connector keys are managed via /api/connectors/${k.split('.')[1] || ''}` });
    }
    if (!ALLOWED_KEYS.has(k) && !k.startsWith('custom.')) {
      return res.status(400).json({ error: `unknown setting key: ${k}` });
    }
    const v = (req.body && 'value' in req.body) ? req.body.value : null;
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(k, JSON.stringify(v));
    res.json({ key: k, value: v });
  });

  r.delete('/:key', (req, res) => {
    db.prepare('DELETE FROM settings WHERE key = ?').run(req.params.key);
    res.status(204).end();
  });

  return r;
}

module.exports = build;
