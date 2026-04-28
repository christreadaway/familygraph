'use strict';

const express = require('express');
const notify = require('../notify');
const templates = require('../notify/templates');

function build({ db }) {
  const r = express.Router();

  r.get('/', (req, res) => {
    res.json({
      items: notify.listAll(db, {
        status: req.query.status || null,
        kind: req.query.kind || null,
        limit: req.query.limit ? Number(req.query.limit) : 200,
      }),
      config: {
        ...notify.effectiveConfig(db),
        // Don't echo the token through the API. We expose only whether one is configured.
        postmark: {
          ...notify.effectiveConfig(db).postmark,
          token_configured: !!notify.effectiveConfig(db).postmark.token,
          token: undefined,
        },
      },
    });
  });

  r.post('/dispatch', async (req, res) => {
    try {
      const r2 = await notify.dispatchPending(db);
      res.json(r2);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  r.post('/:code/retry', (req, res) => {
    const ok = notify.retry(db, req.params.code);
    res.status(ok ? 200 : 404).json({ ok });
  });

  r.post('/:code/cancel', (req, res) => {
    const ok = notify.cancel(db, req.params.code);
    res.status(ok ? 200 : 404).json({ ok });
  });

  // Send a test notification to an arbitrary email so the operator can verify
  // their Postmark configuration without faking a conflict.
  r.post('/test', (req, res) => {
    const { to } = req.body || {};
    if (!to) return res.status(400).json({ error: 'to required' });
    const cfg = notify.effectiveConfig(db);
    const subject = '[Family Graph] Test notification';
    const text = `Hi,\n\nThis is a test notification from Family Graph to confirm your Postmark configuration is working.\n\nDashboard: ${cfg.dashboardUrl}\n\n— Family Graph`;
    const code = notify.enqueue(db, { kind: 'test', to, subject, text });
    res.status(201).json({ code });
  });

  return r;
}

module.exports = build;
