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
        assignedTo: req.query.assigned_to || null,
        assigned: req.query.assigned || null,
        crossSource: 'cross_source' in req.query ? req.query.cross_source : null,
      }),
      ttl_options: [...conflicts.ALLOWED_TTL_HOURS],
    });
  });

  // Bulk-assign endpoint. Body shape:
  //   { codes?: string[], all_open?: boolean, assignee: string, ttl_hours: 4|12|24|48|72 }
  r.post('/assign', (req, res) => {
    const actor = req.auth?.actor || 'operator';
    const body = req.body || {};
    try {
      const out = conflicts.assign(db, {
        codes: body.codes || [],
        allOpen: !!body.all_open,
        assignee: body.assignee,
        ttlHours: body.ttl_hours,
        actor,
      });
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  r.get('/:code', (req, res) => {
    const c = conflicts.get(db, req.params.code);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ conflict: c });
  });

  // Per-conflict assign / unassign.
  r.post('/:code/assign', (req, res) => {
    const actor = req.auth?.actor || 'operator';
    try {
      const out = conflicts.assign(db, {
        codes: [req.params.code],
        assignee: req.body?.assignee,
        ttlHours: req.body?.ttl_hours,
        actor,
      });
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  r.delete('/:code/assignment', (req, res) => {
    const ok = conflicts.unassign(db, req.params.code, { actor: req.auth?.actor || 'operator' });
    res.status(ok ? 204 : 404).end();
  });

  r.post('/:code/resolve', (req, res) => {
    const { decision, winner_code, notes = null } = req.body || {};
    const actor = req.auth?.actor || 'operator';
    try {
      if (decision === 'merge') {
        const code = conflicts.resolveMerge(db, secrets, req.params.code, { winnerCode: winner_code, actor, notes });
        return res.json({ code });
      }
      if (decision === 'reject') {
        conflicts.resolveReject(db, req.params.code, { actor, notes });
        return res.json({ ok: true });
      }
      if (decision === 'dismiss') {
        conflicts.resolveDismiss(db, req.params.code, { actor, notes });
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
