'use strict';

const express = require('express');
const conflicts = require('../identity/conflicts');

function build({ db, secrets }) {
  const r = express.Router();

  r.get('/', (req, res) => {
    res.json({
      items: conflicts.list(db, {
        status: req.query.status || 'open',
        limit: req.query.limit ? Number(req.query.limit) : 100,
      }),
    });
  });

  r.get('/:code', (req, res) => {
    const c = conflicts.get(db, req.params.code);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ conflict: c });
  });

  r.post('/:code/resolve', (req, res) => {
    const { decision, winner_code } = req.body || {};
    const actor = req.auth?.actor || 'operator';
    try {
      if (decision === 'merge') {
        const code = conflicts.resolveMerge(db, secrets, req.params.code, { winnerCode: winner_code, actor });
        return res.json({ code });
      }
      if (decision === 'reject') {
        conflicts.resolveReject(db, req.params.code, { actor });
        return res.json({ ok: true });
      }
      if (decision === 'dismiss') {
        conflicts.resolveDismiss(db, req.params.code, { actor });
        return res.json({ ok: true });
      }
      return res.status(400).json({ error: 'decision must be merge | reject | dismiss' });
    } catch (e) {
      return res.status(400).json({ error: String(e.message || e) });
    }
  });

  return r;
}

module.exports = build;
