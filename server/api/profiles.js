'use strict';

const express = require('express');
const profiles = require('../identity/profiles');

function build({ db }) {
  const r = express.Router();
  r.get('/', (req, res) => {
    res.json({ items: profiles.list(db), active: profiles.active(db) });
  });
  r.post('/activate', (req, res) => {
    const { name } = req.body || {};
    try {
      const p = profiles.activate(db, name);
      res.json({ active: p });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });
  return r;
}

module.exports = build;
