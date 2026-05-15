'use strict';


const { userFacingMessage } = require('./_errors');
const express = require('express');
const ministries = require('../identity/ministries');
const eim = require('../identity/eim');
const audit = require('../audit');
const { isValidCode } = require('../crypto/identifiers');

function build({ db, secrets, includePii }) {
  const r = express.Router();

  // ---------------------------------------------------------------------------
  // Ministry catalog
  // ---------------------------------------------------------------------------

  r.get('/', (req, res) => {
    const status = req.query.status || 'active';
    res.json({ items: ministries.listMinistries(db, { status }) });
  });

  r.post('/', (req, res) => {
    try {
      const code = ministries.createMinistry(db, req.body || {});
      audit.record(db, {
        action: 'ministry_create',
        actor: req.auth?.actor || 'unknown',
        entityCode: code,
        entityKind: 'ministry',
        metadata: { name: req.body?.name },
      });
      res.status(201).json({ code });
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.get('/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'ministry')) {
      return res.status(400).json({ error: 'invalid ministry code' });
    }
    const m = ministries.getMinistry(db, req.params.code);
    if (!m) return res.status(404).json({ error: 'not found' });
    const items = ministries.listAssignments(db, secrets, {
      ministry_code: req.params.code,
      status: 'active',
      includePii,
    });
    res.json({ ministry: m, assignments: items });
  });

  r.patch('/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'ministry')) {
      return res.status(400).json({ error: 'invalid ministry code' });
    }
    try {
      const code = ministries.updateMinistry(db, req.params.code, req.body || {});
      if (!code) return res.status(404).json({ error: 'not found' });
      audit.record(db, {
        action: 'ministry_update',
        actor: req.auth?.actor || 'unknown',
        entityCode: code,
        entityKind: 'ministry',
      });
      res.json({ code });
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.delete('/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'ministry')) {
      return res.status(400).json({ error: 'invalid ministry code' });
    }
    const code = ministries.archiveMinistry(db, req.params.code);
    if (!code) return res.status(404).json({ error: 'not found' });
    audit.record(db, {
      action: 'ministry_archive',
      actor: req.auth?.actor || 'unknown',
      entityCode: code,
      entityKind: 'ministry',
    });
    res.status(204).end();
  });

  // ---------------------------------------------------------------------------
  // Assignments
  // ---------------------------------------------------------------------------

  r.post('/:code/assignments', (req, res) => {
    if (!isValidCode(req.params.code, 'ministry')) {
      return res.status(400).json({ error: 'invalid ministry code' });
    }
    try {
      const code = ministries.assign(db, secrets, req.params.code, req.body || {});
      audit.record(db, {
        action: 'ministry_assign',
        actor: req.auth?.actor || 'unknown',
        entityCode: code,
        entityKind: 'ministry_assignment',
        metadata: {
          ministry_code: req.params.code,
          person_code: req.body?.person_code,
          family_code: req.body?.family_code,
          role: req.body?.role,
        },
      });
      res.status(201).json({ code });
    } catch (e) {
      res.status(400).json({ error: userFacingMessage(e) });
    }
  });

  r.delete('/assignments/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'ministry_assignment')) {
      return res.status(400).json({ error: 'invalid assignment code' });
    }
    const code = ministries.endAssignment(db, secrets, req.params.code, { reason: req.body?.reason });
    if (!code) return res.status(404).json({ error: 'not found' });
    audit.record(db, {
      action: 'ministry_end_assignment',
      actor: req.auth?.actor || 'unknown',
      entityCode: code,
      entityKind: 'ministry_assignment',
      metadata: { reason: req.body?.reason || null },
    });
    res.status(204).end();
  });

  // ---------------------------------------------------------------------------
  // Convenience: assignments by person or family + EIM expiring-soon report.
  // The latter has no PII fields in its response, but mounting it here keeps
  // the EIM surface co-located with the rosters that depend on it.
  // ---------------------------------------------------------------------------

  r.get('/by-person/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'person')) {
      return res.status(400).json({ error: 'invalid person code' });
    }
    res.json({
      items: ministries.listAssignments(db, secrets, {
        person_code: req.params.code,
        status: req.query.status || 'active',
        includePii,
      }),
    });
  });

  r.get('/by-family/:code', (req, res) => {
    if (!isValidCode(req.params.code, 'family')) {
      return res.status(400).json({ error: 'invalid family code' });
    }
    res.json({
      items: ministries.listAssignments(db, secrets, {
        family_code: req.params.code,
        status: req.query.status || 'active',
        includePii,
      }),
    });
  });

  r.get('/eim/expiring', (req, res) => {
    const wd = req.query.window_days ? Number(req.query.window_days) : undefined;
    res.json(eim.listExpiringSoon(db, { windowDays: wd }));
  });

  r.post('/eim/recompute', (req, res) => {
    const changed = eim.recomputeStatus(db);
    audit.record(db, {
      action: 'eim_recompute',
      actor: req.auth?.actor || 'unknown',
      metadata: { changed },
    });
    res.json({ changed });
  });

  return r;
}

module.exports = build;
