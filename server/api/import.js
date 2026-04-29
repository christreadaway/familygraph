'use strict';

const express = require('express');
const sources = require('../sources');
const sheetsUrl = require('../sources/sheets-url');
const importPipeline = require('../identity/import');
const audit = require('../audit');
const profiles = require('../identity/profiles');

const VALID_CATEGORIES = new Set(['church', 'school', 'other']);

// Walk a mapping and collect every header it references.
function _collectUsedHeaders(mapping) {
  const used = new Set();
  const visit = v => {
    if (!v) return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (typeof v === 'string') { used.add(v); return; }
    if (typeof v === 'object') { Object.values(v).forEach(visit); return; }
  };
  if (mapping) {
    visit(mapping.family);
    visit(mapping.address);
    for (const t of mapping.persons || []) {
      for (const k of ['given_name', 'family_name', 'full_name', 'middle_name', 'prefix', 'suffix', 'email', 'phone', 'date_of_birth', 'gender', 'grade']) {
        visit(t[k]);
      }
    }
  }
  return used;
}

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
    const headers = out.headers || (out.rows.length > 0 ? Object.keys(out.rows[0]) : []);
    let rowsWithPersons = 0;
    let rowsWithAddress = 0;
    let rowsWithFamilyName = 0;
    let rowsBlank = 0;
    let totalPersons = 0;
    for (const c of out.canonical) {
      const hasPersons = (c.persons || []).length > 0;
      const hasFamily = !!(c.family && c.family.display_name);
      const hasAddress = !!c.address;
      if (hasPersons) { rowsWithPersons += 1; totalPersons += c.persons.length; }
      if (hasAddress) rowsWithAddress += 1;
      if (hasFamily) rowsWithFamilyName += 1;
      if (!hasPersons && !hasFamily) rowsBlank += 1;
    }
    const usedHeaders = _collectUsedHeaders(out.mapping);
    const unmappedColumns = headers.filter(h => !usedHeaders.has(h));
    res.json({
      source: out.source || out.platform || source || 'csv',
      platform: out.platform || null,
      rows: out.rows.slice(0, 10),
      mapping: out.mapping,
      row_count: out.rows.length,
      canonical_preview: out.canonical.slice(0, 10),
      headers,
      mapping_warning: out.mapping_warning || null,
      summary_rows_dropped: out.summary_rows_dropped || 0,
      diagnostic: {
        rows_with_persons: rowsWithPersons,
        rows_with_family_name: rowsWithFamilyName,
        rows_with_address: rowsWithAddress,
        rows_blank: rowsBlank,
        total_persons: totalPersons,
        unmapped_columns: unmappedColumns,
      },
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
        skipped: !!r.skipped,
        reason: r.reason || null,
        family: r.family ? { code: r.family.code, action: r.family.action } : null,
        persons: (r.persons || []).map(p => ({ code: p.code, action: p.action, score: p.score })),
      })),
    });
  });

  // POST /api/import/fetch-sheet
  // Body: { url }
  // Returns: { content, content_type, byte_len, final_url, source_ref }
  // The caller can then feed `content` straight into POST /api/import/run
  // (or POST /api/import/preview) along with their preferred category/tags.
  // Each fetch is recorded in the audit log: action 'sheet_fetch', actor =
  // the calling app, metadata = { url (host only), final_host, byte_len }.
  // The full URL is recorded too — operators may want to confirm later
  // exactly which sheet they pulled.
  r.post('/fetch-sheet', async (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    let parsed;
    try { parsed = sheetsUrl.parseSheetUrl(url); }
    catch (e) { return res.status(400).json({ error: String(e.message || e) }); }
    try {
      const r2 = await sheetsUrl.fetchSheetCsv(url);
      audit.record(db, {
        action: 'sheet_fetch',
        actor: req.auth?.actor || 'operator',
        metadata: {
          sheet_id: parsed.id,
          gid: parsed.gid,
          final_url: r2.finalUrl,
          byte_len: r2.byteLen,
          content_type: r2.contentType,
        },
      });
      res.json({
        content: r2.content,
        content_type: r2.contentType,
        byte_len: r2.byteLen,
        final_url: r2.finalUrl,
        source_ref: `sheet:${parsed.id}${parsed.gid ? `?gid=${parsed.gid}` : ''}`,
      });
    } catch (e) {
      audit.record(db, {
        action: 'sheet_fetch_failed',
        actor: req.auth?.actor || 'operator',
        metadata: { sheet_id: parsed.id, gid: parsed.gid, error: String(e.message || e) },
      });
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  return r;
}

module.exports = build;
module.exports.VALID_CATEGORIES = VALID_CATEGORIES;
