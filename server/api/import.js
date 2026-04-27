'use strict';

const express = require('express');
const sources = require('../sources');
const importPipeline = require('../identity/import');
const audit = require('../audit');
const profiles = require('../identity/profiles');

function build({ db, secrets, thresholds }) {
  const effective = () => profiles.thresholdsFor(db, thresholds);
  const r = express.Router();

  r.post('/preview', (req, res) => {
    const { content, mapping = null, source = null } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content required' });
    const handler = (source && sources.HANDLERS[source]) || sources.csv;
    const out = handler.loadString(content, { mapping });
    res.json({
      source: out.source || source || 'csv',
      rows: out.rows.slice(0, 10),
      mapping: out.mapping,
      row_count: out.rows.length,
      canonical_preview: out.canonical.slice(0, 10),
    });
  });

  r.post('/run', (req, res) => {
    const { content, mapping = null, source = null, source_ref = 'inline' } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content required' });
    const handler = (source && sources.HANDLERS[source]) || sources.csv;
    const out = handler.loadString(content, { mapping });
    const results = importPipeline.importBatch(db, secrets, effective(), out.canonical, {
      source: out.source || source || 'csv',
      sourceRef: source_ref,
      actor: req.auth?.actor || 'operator',
    });
    audit.record(db, {
      action: 'bulk_import',
      actor: req.auth?.actor || 'operator',
      metadata: { rows: out.canonical.length, source: out.source || source || 'csv' },
    });
    res.status(201).json({
      rows: out.canonical.length,
      results: results.map(r => ({
        family: r.family ? { code: r.family.code, action: r.family.action } : null,
        persons: r.persons.map(p => ({ code: p.code, action: p.action, score: p.score })),
      })),
    });
  });

  return r;
}

module.exports = build;
