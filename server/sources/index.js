'use strict';

const path = require('path');
const fs = require('fs');
const csv = require('./csv');
const excel = require('./excel');
const facts = require('./facts');
const renweb = require('./renweb');
const mp = require('./ministry-platform');
const sheets = require('./google-sheets');

const HANDLERS = {
  csv,
  excel,
  facts,
  renweb,
  ministry_platform: mp,
  sheets,
};

function load(filePath, opts = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (opts.source && HANDLERS[opts.source]) {
    return HANDLERS[opts.source].loadFile(filePath, opts);
  }
  if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
    return excel.loadFile(filePath, opts);
  }
  // CSV path: try to auto-detect FACTS / RenWeb / Ministry Platform.
  const out = csv.loadFile(filePath, opts);
  const headers = out.rows.length > 0 ? Object.keys(out.rows[0]) : [];
  const candidates = [
    { name: 'facts', score: facts.detect(headers) },
    { name: 'renweb', score: renweb.detect(headers) },
    { name: 'ministry_platform', score: mp.detect(headers) },
  ].sort((a, b) => b.score - a.score);
  if (candidates[0] && candidates[0].score >= 2 && !opts.mapping) {
    return HANDLERS[candidates[0].name].loadFile(filePath, opts);
  }
  out.source = out.source || 'csv';
  return out;
}

function detectSource(headers) {
  const candidates = [
    { name: 'facts', score: facts.detect(headers) },
    { name: 'renweb', score: renweb.detect(headers) },
    { name: 'ministry_platform', score: mp.detect(headers) },
  ].sort((a, b) => b.score - a.score);
  if (candidates[0].score >= 2) return candidates[0].name;
  return 'csv';
}

module.exports = { load, detectSource, HANDLERS, csv, excel, facts, renweb, mp, sheets };
