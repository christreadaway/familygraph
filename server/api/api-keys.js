'use strict';

const express = require('express');
const apiKeys = require('../auth/api-keys');

function build({ db }) {
  const r = express.Router();

  r.get('/', (req, res) => {
    res.json({ items: apiKeys.list(db) });
  });

  r.post('/', (req, res) => {
    try {
      const out = apiKeys.provision(db, req.body || {});
      // The plaintext token is returned exactly once. Operator must record it.
      res.status(201).json(out);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  r.delete('/:code', (req, res) => {
    const ok = apiKeys.revoke(db, req.params.code);
    res.status(ok ? 204 : 404).end();
  });

  return r;
}

module.exports = build;
