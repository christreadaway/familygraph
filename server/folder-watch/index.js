'use strict';

const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');

const sources = require('../sources');
const importPipeline = require('../identity/import');
const sanitize = require('../sanitize');
const audit = require('../audit');
const log = require('../log');

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

// Cross-device fallback for rename. fs.renameSync throws EXDEV when source
// and destination live on different mounts (common in containerized
// deployments where the watch dir is a bind-mounted volume). Fall back to
// copy + unlink so the move still completes.
function _renameOrCopy(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
    } else {
      throw e;
    }
  }
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
  _renameOrCopy(from, target);
  return target;
}

// Write a sidecar without clobbering an existing one. Same numbering scheme
// as safeMove so a re-run lands `roster.csv.import-summary.1.json` instead of
// overwriting the prior summary.
function _safeSidecar(dir, baseName, content) {
  let target = path.join(dir, baseName);
  let i = 1;
  while (fs.existsSync(target)) {
    const ext = path.extname(baseName);
    const stem = baseName.slice(0, baseName.length - ext.length);
    target = path.join(dir, `${stem}.${i}${ext}`);
    i += 1;
  }
  fs.writeFileSync(target, content);
  return target;
}

// Classify a thrown error into a short category so operators can scan
// folder-watch errors without reading the stack. EACCES/EPERM → permissions.
// ENOENT → file vanished between detection and processing.
function _errorCategory(e) {
  if (!e) return 'unknown';
  const code = e.code || (e.cause && e.cause.code);
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied';
  if (code === 'ENOENT') return 'file_missing';
  if (code === 'EISDIR') return 'is_directory';
  if (code === 'EMFILE' || code === 'ENFILE') return 'too_many_open_files';
  if (code === 'EXDEV') return 'cross_device';
  if (/parse|CSV|delimiter|encoding/i.test(String(e.message || ''))) return 'malformed_input';
  return 'other';
}

function processFile(db, secrets, thresholds, filePath, opts = {}) {
  const kind = classify(filePath);
  const outDir = opts.outDir;
  const processedDir = path.join(outDir, 'processed');
  const errorDir = path.join(outDir, 'errors');
  const baseName = path.basename(filePath);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  log.info('folder_watch_file_seen', { file: baseName, kind });

  try {
    if (kind === 'csv' || kind === 'excel') {
      const parsed = sources.load(filePath, opts.sourceOpts || {});
      const batch = importPipeline.importBatch(db, secrets, thresholds, parsed.canonical, {
        actor: 'folder_watch',
        source: parsed.source || kind,
        sourceRef: parsed.fileName,
        category: opts.category || null,
        tags: opts.tags || null,
      });
      const summary = {
        file: parsed.fileName,
        source: parsed.source || kind,
        rows: parsed.canonical.length,
        import_run: batch.importRunCode,
        totals: batch.totals,
        results: batch.results.map(r => ({
          family: r.family ? { code: r.family.code, action: r.family.action } : null,
          persons: r.persons.map(p => ({ code: p.code, action: p.action })),
        })),
      };
      const sidecar = _safeSidecar(outDir, `${baseName}.import-summary.json`, JSON.stringify(summary, null, 2));
      safeMove(filePath, processedDir);
      audit.record(db, {
        action: 'folder_watch_import',
        actor: 'folder_watch',
        metadata: {
          file: parsed.fileName,
          rows: parsed.canonical.length,
          import_run: batch.importRunCode,
          totals: batch.totals,
        },
      });
      log.info('folder_watch_imported', {
        file: baseName,
        rows: parsed.canonical.length,
        import_run: batch.importRunCode,
        sidecar: path.basename(sidecar),
      });
      return { ok: true, kind: 'import', summary };
    }
    if (kind === 'text') {
      const content = fs.readFileSync(filePath, 'utf8');
      const r = sanitize.sanitizeText(db, secrets, content, { actor: 'folder_watch' });
      const ext = path.extname(baseName);
      const stem = baseName.slice(0, baseName.length - ext.length);
      const sanitizedPath = _safeSidecar(outDir, `${stem}.sanitized${ext}`, r.sanitized);
      _safeSidecar(outDir, `${stem}.token-set.json`, JSON.stringify({ tokenSet: r.tokenSet, file: baseName }, null, 2));
      safeMove(filePath, processedDir);
      log.info('folder_watch_sanitized', { file: baseName, sanitized: path.basename(sanitizedPath) });
      return { ok: true, kind: 'sanitize', sanitized: sanitizedPath, tokenSet: r.tokenSet };
    }
    // Unknown: move to errors with note.
    const dest = safeMove(filePath, errorDir);
    fs.writeFileSync(dest + '.error.txt', 'Unsupported file type for folder-watch agent.');
    log.warn('folder_watch_unsupported', { file: baseName });
    return { ok: false, kind: 'unknown' };
  } catch (e) {
    const category = _errorCategory(e);
    fs.mkdirSync(errorDir, { recursive: true, mode: 0o700 });
    let dest;
    try { dest = safeMove(filePath, errorDir); } catch { dest = filePath; }
    try { fs.writeFileSync(dest + '.error.txt', String(e && e.stack ? e.stack : e)); }
    catch (_writeErr) { /* swallow — disk errors here are documented in the log line below */ }
    audit.record(db, {
      action: 'folder_watch_error',
      actor: 'folder_watch',
      metadata: { file: baseName, error: String(e.message || e), category, code: e && e.code || null },
    });
    log.error('folder_watch_error', {
      file: baseName,
      kind,
      category,
      code: e && e.code || null,
      error: String(e.message || e),
    });
    return { ok: false, kind: 'error', category, code: e && e.code || null, error: String(e.message || e) };
  }
}

function start(db, secrets, thresholds, opts) {
  const watchDir = path.resolve(opts.watchDir);
  const outDir = path.resolve(opts.outDir);
  const onProcessed = typeof opts.onProcessed === 'function' ? opts.onProcessed : null;

  // Refuse to start if outDir is the same as watchDir or sits inside it.
  // The sidecars we write (.import-summary.json, .sanitized, .token-set.json)
  // land directly in outDir; if outDir == watchDir, chokidar's depth-0
  // listener will re-detect them and loop forever. Even with depth > 0,
  // nesting outDir inside watchDir is a foot-gun that's better caught at boot.
  if (outDir === watchDir) {
    throw new Error('folder-watch: outDir must not equal watchDir (would re-process sidecar files)');
  }
  if (outDir.startsWith(watchDir + path.sep)) {
    throw new Error('folder-watch: outDir must not be inside watchDir (would re-process sidecar files)');
  }
  fs.mkdirSync(watchDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  log.info('folder_watch_started', { watchDir, outDir, processExisting: !!opts.processExisting });

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
  watcher.on('error', e => {
    log.error('folder_watch_watcher_error', { error: String(e && e.message || e), code: e && e.code || null });
  });
  return { watcher, processFile: fp => processFile(db, secrets, thresholds, fp, { outDir, ...opts }) };
}

module.exports = { start, processFile, classify, safeMove };
