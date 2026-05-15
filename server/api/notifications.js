'use strict';


const { userFacingMessage } = require('./_errors');
const express = require('express');
const notify = require('../notify');
const templates = require('../notify/templates');

function build({ db }) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const items = notify.listAll(db, {
      status: req.query.status || null,
      kind: req.query.kind || null,
      limit: req.query.limit ? Number(req.query.limit) : 200,
    });
    // Body text / HTML can contain PII (a conflict-resolved person's
    // name in an "operator merged X and Y" notification, for instance).
    // Mask by default; the operator passes `?include_body=1` from the
    // dashboard when they need to inspect the actual payload, and that
    // query is itself audited via the request log.
    const includeBody = req.query.include_body === '1' || req.query.includeBody === '1';
    const cleaned = items.map(item => {
      if (includeBody) return item;
      const { body_text: _bt, body_html: _bh, ...rest } = item;
      return {
        ...rest,
        body_text: null,
        body_html: null,
        body_preview: item.body_text ? String(item.body_text).slice(0, 80) : null,
      };
    });
    res.json({
      items: cleaned,
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
      res.status(500).json({ error: userFacingMessage(e) });
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
