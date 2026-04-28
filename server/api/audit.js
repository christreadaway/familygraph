'use strict';

const express = require('express');
const { stringify } = require('csv-stringify/sync');
const audit = require('../audit');

function buildList({ db }) {
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
  r.get('/export', (req, res) => {
    const events = audit.list(db, {
      limit: req.query.limit ? Number(req.query.limit) : 10000,
      action: req.query.action,
      actor: req.query.actor,
      entityCode: req.query.entity_code,
    });
    const flat = events.map(e => ({
      code: e.code,
      tier: e.tier,
      created_at: e.created_at,
      action: e.action,
      actor: e.actor,
      entity_kind: e.entity_kind,
      entity_code: e.entity_code,
      destination: e.destination,
      metadata: e.metadata ? JSON.stringify(e.metadata) : '',
    }));
    res.set('content-type', 'text/csv; charset=utf-8');
    res.send(stringify(flat, { header: true }));
  });
  return r;
}

function buildExternalExport({ db }) {
  const r = express.Router();
  r.post('/', (req, res) => {
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

module.exports = buildList;
module.exports.buildList = buildList;
module.exports.buildExternalExport = buildExternalExport;
