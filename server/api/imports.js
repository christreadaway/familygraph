'use strict';

const express = require('express');
const importPipeline = require('../identity/import');

function build({ db }) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const items = importPipeline.listImportRuns(db, {
      category: req.query.category || null,
      limit: req.query.limit ? Number(req.query.limit) : 50,
    });
    res.json({ items });
  });

  r.get('/:code', (req, res) => {
    const run = importPipeline.getImportRun(db, req.params.code);
    if (!run) return res.status(404).json({ error: 'not found' });
    const affected = importPipeline.affectedEntities(db, req.params.code);
    res.json({ run, affected });
  });

  return r;
}

module.exports = build;
