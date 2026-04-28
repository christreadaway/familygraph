'use strict';

const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');

const sources = require('../sources');
const importPipeline = require('../identity/import');
const sanitize = require('../sanitize');
const audit = require('../audit');

// Folder-watch agent. Two modes per file:
//   *.in.csv | *.in.xlsx | drop directly  -> import into the registry.
//   *.txt | *.md          -> sanitize the text into <name>.sanitized.txt and
//                            write a JSON sidecar with the token-set code.
// Outputs are written to opts.outDir; the original file is moved to outDir/processed.

function classify(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'csv';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.xlsm')) return 'excel';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.json') || lower.endsWith('.eml')) return 'text';
  return 'unknown';
}

function safeMove(from, toDir) {
  fs.mkdirSync(toDir, { recursive: true, mode: 0o700 });
  const base = path.basename(from);
  let target = path.join(toDir, base);
  let i = 1;
  while (fs.existsSync(target)) {
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    target = path.join(toDir, `${stem}.${i}${ext}`);
    i += 1;
  }
  fs.renameSync(from, target);
  return target;
}

function processFile(db, secrets, thresholds, filePath, opts = {}) {
  const kind = classify(filePath);
  const outDir = opts.outDir;
  const processedDir = path.join(outDir, 'processed');
  const errorDir = path.join(outDir, 'errors');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  try {
    if (kind === 'csv' || kind === 'excel') {
      const parsed = sources.load(filePath, opts.sourceOpts || {});
      const results = importPipeline.importBatch(db, secrets, thresholds, parsed.canonical, {
        actor: 'folder_watch',
        source: parsed.source || kind,
        sourceRef: parsed.fileName,
      });
      const summary = {
        file: parsed.fileName,
        source: parsed.source || kind,
        rows: parsed.canonical.length,
        results: results.map(r => ({
          family: r.family ? { code: r.family.code, action: r.family.action } : null,
          persons: r.persons.map(p => ({ code: p.code, action: p.action })),
        })),
      };
      const sidecar = path.join(outDir, `${path.basename(filePath)}.import-summary.json`);
      fs.writeFileSync(sidecar, JSON.stringify(summary, null, 2));
      safeMove(filePath, processedDir);
      audit.record(db, {
        action: 'folder_watch_import',
        actor: 'folder_watch',
        metadata: { file: parsed.fileName, rows: parsed.canonical.length },
      });
      return { ok: true, kind: 'import', summary };
    }
    if (kind === 'text') {
      const content = fs.readFileSync(filePath, 'utf8');
      const r = sanitize.sanitizeText(db, secrets, content, { actor: 'folder_watch' });
      const base = path.basename(filePath);
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      const sanitizedPath = path.join(outDir, `${stem}.sanitized${ext}`);
      const sidecarPath = path.join(outDir, `${stem}.token-set.json`);
      fs.writeFileSync(sanitizedPath, r.sanitized);
      fs.writeFileSync(
        sidecarPath,
        JSON.stringify({ tokenSet: r.tokenSet, file: base }, null, 2)
      );
      safeMove(filePath, processedDir);
      return { ok: true, kind: 'sanitize', sanitized: sanitizedPath, tokenSet: r.tokenSet };
    }
    // Unknown: move to errors with note.
    const dest = safeMove(filePath, errorDir);
    fs.writeFileSync(dest + '.error.txt', 'Unsupported file type for folder-watch agent.');
    return { ok: false, kind: 'unknown' };
  } catch (e) {
    fs.mkdirSync(errorDir, { recursive: true, mode: 0o700 });
    let dest;
    try { dest = safeMove(filePath, errorDir); } catch { dest = filePath; }
    fs.writeFileSync(dest + '.error.txt', String(e && e.stack ? e.stack : e));
    audit.record(db, {
      action: 'folder_watch_error',
      actor: 'folder_watch',
      metadata: { file: path.basename(filePath), error: String(e.message || e) },
    });
    return { ok: false, kind: 'error', error: String(e.message || e) };
  }
}

function start(db, secrets, thresholds, opts) {
  const watchDir = opts.watchDir;
  const outDir = opts.outDir;
  const onProcessed = typeof opts.onProcessed === 'function' ? opts.onProcessed : null;
  fs.mkdirSync(watchDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  // Optionally process whatever is already in the watch dir at startup. Useful
  // when files were dropped while Family Graph was down. Off by default — a fresh
  // boot shouldn't accidentally re-import files left over from prior runs.
  if (opts.processExisting) {
    const existing = fs
      .readdirSync(watchDir)
      .filter(n => !n.startsWith('.'))
      .map(n => path.join(watchDir, n))
      .filter(p => {
        try { return fs.statSync(p).isFile(); } catch { return false; }
      });
    for (const fp of existing) {
      const r = processFile(db, secrets, thresholds, fp, { outDir, ...opts });
      if (onProcessed && r && r.ok !== false) onProcessed(r);
    }
  }

  const watcher = chokidar.watch(watchDir, {
    ignoreInitial: true,
    persistent: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  watcher.on('add', filePath => {
    if (path.dirname(filePath) !== watchDir) return;
    if (path.basename(filePath).startsWith('.')) return;
    const r = processFile(db, secrets, thresholds, filePath, { outDir, ...opts });
    if (onProcessed && r && r.ok !== false) onProcessed(r);
  });
  return { watcher, processFile: fp => processFile(db, secrets, thresholds, fp, { outDir, ...opts }) };
}

module.exports = { start, processFile, classify, safeMove };
