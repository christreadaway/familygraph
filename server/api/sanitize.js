'use strict';

const express = require('express');
const sanitize = require('../sanitize');

function buildSanitize({ db, secrets }) {
  const r = express.Router();
  r.post('/', (req, res) => {
    const { text, payload } = req.body || {};
    const input = typeof text === 'string' ? text : payload ? JSON.stringify(payload) : '';
    if (!input) return res.status(400).json({ error: 'text or payload required' });
    const out = sanitize.sanitizeText(db, secrets, input, {
      actor: req.auth?.actor || 'unknown',
    });
    res.json({ sanitized: out.sanitized, token_set: out.tokenSet });
  });
  return r;
}

function buildDesanitize({ db, secrets }) {
  const r = express.Router();
  r.post('/', (req, res) => {
    const { text, token_set } = req.body || {};
    if (typeof text !== 'string' || !token_set) {
      return res.status(400).json({ error: 'text and token_set required' });
    }
    try {
      const restored = sanitize.desanitizeText(db, secrets, text, token_set, {
        actor: req.auth?.actor || 'unknown',
      });
      res.json({ text: restored });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });
  return r;
}

module.exports = { buildSanitize, buildDesanitize };
