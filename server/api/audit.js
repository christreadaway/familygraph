'use strict';

const express = require('express');
const audit = require('../audit');

function build({ db }) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const events = audit.list(db, {
      limit: req.query.limit ? Number(req.query.limit) : 100,
      action: req.query.action,
      actor: req.query.actor,
      entityCode: req.query.entity_code,
    });
    res.json({ items: events });
  });

  r.post('/external-export', (req, res) => {
    const { destination, entity_codes = [], reason, consent_subject = null } = req.body || {};
    if (!destination) return res.status(400).json({ error: 'destination required' });
    const code = audit.record(db, {
      tier: 2,
      action: 'export_consent',
      actor: req.auth?.actor || 'unknown',
      destination,
      metadata: { entity_codes, reason, consent_subject },
    });
    res.status(201).json({ code });
  });

  return r;
}

module.exports = build;
