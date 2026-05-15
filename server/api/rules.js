'use strict';


const { userFacingMessage } = require('./_errors');
const express = require('express');
const rules = require('../identity/rules');

function build({ db }) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const items = rules.list(db, {
      kind: req.query.kind || null,
      enabledOnly: req.query.enabled === '1',
    });
    res.json({ items });
  });

  r.post('/', (req, res) => {
    const { kind, rule, enabled = true } = req.body || {};
    try {
      const code = rules.create(db, { kind, rule, enabled });
      res.status(201).json({ code });
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.patch('/:code', (req, res) => {
    try {
      const code = rules.update(db, req.params.code, req.body || {});
      if (!code) return res.status(404).json({ error: 'not found' });
      res.json({ code });
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.delete('/:code', (req, res) => {
    const n = rules.remove(db, req.params.code);
    res.status(n ? 204 : 404).end();
  });

  return r;
}

module.exports = build;
