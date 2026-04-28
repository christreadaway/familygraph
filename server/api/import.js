'use strict';

const express = require('express');
const sources = require('../sources');
const importPipeline = require('../identity/import');
const audit = require('../audit');
const profiles = require('../identity/profiles');

const VALID_CATEGORIES = new Set(['church', 'school', 'other']);

function _normalizeTags(input) {
  if (input == null || input === '') return null;
  if (Array.isArray(input)) return input.map(t => String(t).trim()).filter(Boolean);
  if (typeof input === 'string') {
    return input.split(',').map(t => t.trim()).filter(Boolean);
  }
  return null;
}

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
    const {
      content, mapping = null, source = null, source_ref = 'inline',
      category = null, tags = null,
    } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content required' });
    if (category != null && category !== '' && !VALID_CATEGORIES.has(category)) {
      return res.status(400).json({ error: `category must be one of ${[...VALID_CATEGORIES].join(', ')}` });
    }
    const handler = (source && sources.HANDLERS[source]) || sources.csv;
    const out = handler.loadString(content, { mapping });
    const normTags = _normalizeTags(tags);
    const result = importPipeline.importBatch(db, secrets, effective(), out.canonical, {
      source: out.source || source || 'csv',
      sourceRef: source_ref,
      actor: req.auth?.actor || 'operator',
      category: category || null,
      tags: normTags,
    });
    audit.record(db, {
      action: 'bulk_import',
      actor: req.auth?.actor || 'operator',
      metadata: {
        rows: out.canonical.length,
        source: out.source || source || 'csv',
        category: category || null,
        tags: normTags,
        import_run: result.importRunCode,
      },
    });
    res.status(201).json({
      import_run: result.importRunCode,
      rows: out.canonical.length,
      totals: result.totals,
      results: result.results.map(r => ({
        family: r.family ? { code: r.family.code, action: r.family.action } : null,
        persons: r.persons.map(p => ({ code: p.code, action: p.action, score: p.score })),
      })),
    });
  });

  return r;
}

module.exports = build;
module.exports.VALID_CATEGORIES = VALID_CATEGORIES;
