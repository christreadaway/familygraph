'use strict';

const express = require('express');

const ALLOWED_KEYS = new Set([
  'audit_retention_days',
  'auto_merge',
  'review_threshold',
  'institution_name',
  'operator_name',
]);

function build({ db }) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const rows = db.prepare('SELECT key, value_json, updated_at FROM settings ORDER BY key ASC').all();
    res.json({
      items: rows.map(row => ({ key: row.key, value: JSON.parse(row.value_json), updated_at: row.updated_at })),
    });
  });

  r.put('/:key', (req, res) => {
    const k = req.params.key;
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
