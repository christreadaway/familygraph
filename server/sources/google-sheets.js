'use strict';

// Google Sheets handler. The expected delivery method is a CSV export from
// Google Sheets ("File → Download → CSV"). The mapping is the generic
// inferred mapping; an operator can override per-row in the import wizard.

const csv = require('./csv');

function loadFile(filePath, opts = {}) {
  const out = csv.loadFile(filePath, opts);
  out.source = 'sheets';
  return out;
}

function loadString(content, opts = {}) {
  const out = csv.loadString(content, opts);
  out.source = 'sheets';
  return out;
}

module.exports = { loadFile, loadString };
