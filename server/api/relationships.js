'use strict';

const express = require('express');
const relationships = require('../identity/relationships');
const audit = require('../audit');
const { isValidCode } = require('../crypto/identifiers');

function build({ db }) {
  const r = express.Router();

  r.get('/:code', (req, res) => {
    if (!isValidCode(req.params.code)) return res.status(400).json({ error: 'invalid code' });
    res.json({ items: relationships.listFor(db, req.params.code, { kind: req.query.kind }) });
  });

  r.post('/', (req, res) => {
    const { from, to, kind, detail = null } = req.body || {};
    if (!isValidCode(from) || !isValidCode(to) || !kind) {
      return res.status(400).json({ error: 'from, to, kind required' });
    }
    if (!relationships.VALID_KINDS.has(kind)) {
      return res.status(400).json({ error: `invalid kind: ${kind}` });
    }
    try {
      const code = relationships.add(db, from, to, kind, detail);
      audit.record(db, {
        action: 'relationship_add',
        actor: req.auth?.actor || 'unknown',
        metadata: { code, from, to, kind },
      });
      res.status(201).json({ code });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  r.delete('/:code', (req, res) => {
    const n = relationships.remove(db, req.params.code);
    if (n) {
      audit.record(db, {
        action: 'relationship_remove',
        actor: req.auth?.actor || 'unknown',
        metadata: { code: req.params.code },
      });
    }
    res.status(n ? 204 : 404).end();
  });

  return r;
}

module.exports = build;
