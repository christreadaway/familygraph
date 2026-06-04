'use strict';

const path = require('path');
const ExcelJS = require('exceljs');
const { applyMapping } = require('./normalize');
const { inferMapping } = require('./csv');

/**
 * Convert an ExcelJS worksheet into an array of plain objects
 * matching the shape xlsx's sheet_to_json({ defval: '', raw: false }) produced:
 * keys = first-row headers, values = string cell contents (empty → '').
 */
function _sheetToRows(ws) {
  const rows = [];
  const headers = [];
  let headerRow = null;

  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (!headerRow) {
      headerRow = rowNumber;
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        // ExcelJS column numbers are 1-based
        headers[colNumber] = cell.text != null ? String(cell.text) : '';
      });
      return;
    }
    const obj = {};
    for (let c = 1; c <= headers.length; c++) {
      const key = headers[c];
      if (key === undefined) continue;
      const cell = row.getCell(c);
      // cell.text gives the formatted string representation,
      // matching xlsx's raw:false behavior
      obj[key] = cell.text != null ? String(cell.text) : '';
    }
    rows.push(obj);
  });

  return rows;
}

async function loadFile(filePath, opts = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheetNames = wb.worksheets.map(s => s.name);
  const sheetName = opts.sheet || sheetNames[0];
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`sheet not found: ${sheetName}`);
  const rows = _sheetToRows(ws);
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const mapping = opts.mapping || inferMapping(headers);
  return {
    fileName: path.basename(filePath),
    sheet: sheetName,
    sheets: sheetNames,
    rows,
    mapping,
    canonical: rows.map(r => applyMapping(r, mapping)),
  };
}

async function loadBuffer(buffer, opts = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheetNames = wb.worksheets.map(s => s.name);
  const sheetName = opts.sheet || sheetNames[0];
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`sheet not found: ${sheetName}`);
  const rows = _sheetToRows(ws);
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const mapping = opts.mapping || inferMapping(headers);
  return {
    fileName: opts.fileName || 'inline.xlsx',
    sheet: sheetName,
    sheets: sheetNames,
    rows,
    mapping,
    canonical: rows.map(r => applyMapping(r, mapping)),
  };
}

module.exports = { loadFile, loadBuffer };
