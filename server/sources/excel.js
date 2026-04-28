'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { applyMapping } = require('./normalize');
const { inferMapping } = require('./csv');

function loadFile(filePath, opts = {}) {
  const wb = XLSX.readFile(filePath);
  const sheetName = opts.sheet || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`sheet not found: ${sheetName}`);
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const mapping = opts.mapping || inferMapping(headers);
  return {
    fileName: path.basename(filePath),
    sheet: sheetName,
    sheets: wb.SheetNames,
    rows,
    mapping,
    canonical: rows.map(r => applyMapping(r, mapping)),
  };
}

function loadBuffer(buffer, opts = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = opts.sheet || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`sheet not found: ${sheetName}`);
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const mapping = opts.mapping || inferMapping(headers);
  return {
    fileName: opts.fileName || 'inline.xlsx',
    sheet: sheetName,
    sheets: wb.SheetNames,
    rows,
    mapping,
    canonical: rows.map(r => applyMapping(r, mapping)),
  };
}

module.exports = { loadFile, loadBuffer };
