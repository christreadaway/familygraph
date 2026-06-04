'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const folderWatch = require('../server/folder-watch');
const { newDb, newSecrets, defaultThresholds, tmpDir, cleanup } = require('./_helpers');

test('folder-watch > processes a CSV import file', async t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const watch = tmpDir();
  const out = tmpDir();
  t.after(() => { cleanup(watch); cleanup(out); });

  const csvPath = path.join(watch, 'roster.csv');
  fs.writeFileSync(csvPath, 'first_name,last_name,email\nMary,Smith,mary@example.org\n');
  const r = await folderWatch.processFile(db, s, defaultThresholds(), csvPath, { outDir: out });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'import');
  assert.equal(r.summary.rows, 1);
  // Source file moved to processed.
  assert.equal(fs.existsSync(csvPath), false);
  assert.ok(fs.existsSync(path.join(out, 'processed', 'roster.csv')));
  assert.ok(fs.existsSync(path.join(out, 'roster.csv.import-summary.json')));
});

test('folder-watch > sanitizes a text file', async t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const watch = tmpDir();
  const out = tmpDir();
  t.after(() => { cleanup(watch); cleanup(out); });

  const txt = path.join(watch, 'note.txt');
  fs.writeFileSync(txt, 'Mary lives at 12 Maple Street. mary@example.org');
  const r = await folderWatch.processFile(db, s, defaultThresholds(), txt, { outDir: out });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'sanitize');
  const sanitized = fs.readFileSync(r.sanitized, 'utf8');
  assert.doesNotMatch(sanitized, /mary@example\.org/);
  assert.ok(fs.existsSync(path.join(out, 'note.token-set.json')));
});

test('folder-watch > unknown kinds go to errors', async t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const watch = tmpDir();
  const out = tmpDir();
  t.after(() => { cleanup(watch); cleanup(out); });

  const f = path.join(watch, 'binary.bin');
  fs.writeFileSync(f, Buffer.from([0, 1, 2]));
  const r = await folderWatch.processFile(db, s, defaultThresholds(), f, { outDir: out });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unknown');
  assert.ok(fs.existsSync(path.join(out, 'errors', 'binary.bin')));
});

test('folder-watch > malformed CSV is categorized and moved to errors', async t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const watch = tmpDir();
  const out = tmpDir();
  t.after(() => { cleanup(watch); cleanup(out); });

  // Inconsistent column counts trip csv-parse with the default strict settings.
  const csvPath = path.join(watch, 'broken.csv');
  fs.writeFileSync(csvPath, 'first_name,last_name,email\n"unterminated quote,Smith\n');
  const r = await folderWatch.processFile(db, s, defaultThresholds(), csvPath, { outDir: out });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'error');
  // The file is moved out of watch/ regardless of error type.
  assert.equal(fs.existsSync(csvPath), false);
  assert.ok(fs.existsSync(path.join(out, 'errors', 'broken.csv')));
  // Audit record captures the category.
  const audited = db.prepare(
    `SELECT metadata FROM audit_events WHERE action = 'folder_watch_error' ORDER BY created_at DESC LIMIT 1`
  ).get();
  assert.ok(audited, 'folder_watch_error audit row written');
  const meta = JSON.parse(audited.metadata);
  assert.equal(meta.file, 'broken.csv');
  assert.ok(['malformed_input', 'other'].includes(meta.category));
});

test('folder-watch > permission error is categorized as permission_denied', async t => {
  // Skip on root: a CAP_DAC_OVERRIDE process can read any file, so the
  // chmod(0o000) trick below doesn't surface EACCES.
  if (process.getuid && process.getuid() === 0) {
    t.skip('cannot exercise EACCES as root');
    return;
  }
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const watch = tmpDir();
  const out = tmpDir();
  t.after(() => {
    // Restore perms so cleanup can walk the dir.
    try { fs.chmodSync(path.join(watch, 'locked.csv'), 0o600); } catch (_) {}
    cleanup(watch); cleanup(out);
  });

  const csvPath = path.join(watch, 'locked.csv');
  fs.writeFileSync(csvPath, 'first_name,last_name\nMary,Smith\n');
  fs.chmodSync(csvPath, 0o000);
  const r = await folderWatch.processFile(db, s, defaultThresholds(), csvPath, { outDir: out });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'error');
  assert.equal(r.category, 'permission_denied');
});

test('folder-watch > re-running the same filename produces a numbered sidecar (no clobber)', async t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const watch = tmpDir();
  const out = tmpDir();
  t.after(() => { cleanup(watch); cleanup(out); });

  async function dropAndProcess(content) {
    const p = path.join(watch, 'roster.csv');
    fs.writeFileSync(p, content);
    return folderWatch.processFile(db, s, defaultThresholds(), p, { outDir: out });
  }

  const r1 = await dropAndProcess('first_name,last_name\nMary,Smith\n');
  assert.equal(r1.ok, true);
  const r2 = await dropAndProcess('first_name,last_name\nLuke,Smith\n');
  assert.equal(r2.ok, true);
  // First sidecar at original name, second sidecar gets ".1." inserted.
  assert.ok(fs.existsSync(path.join(out, 'roster.csv.import-summary.json')));
  assert.ok(fs.existsSync(path.join(out, 'roster.csv.import-summary.1.json')));
});

test('folder-watch > start() refuses when outDir equals watchDir', async t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const shared = tmpDir();
  t.after(() => { cleanup(shared); });

  await assert.rejects(
    () => folderWatch.start(db, s, defaultThresholds(), { watchDir: shared, outDir: shared }),
    /outDir must not equal watchDir/,
  );
});

test('folder-watch > start() refuses when outDir is inside watchDir', async t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const watch = tmpDir();
  const out = path.join(watch, 'out');
  t.after(() => { cleanup(watch); });

  await assert.rejects(
    () => folderWatch.start(db, s, defaultThresholds(), { watchDir: watch, outDir: out }),
    /outDir must not be inside watchDir/,
  );
});

test('folder-watch > rapid drops of multiple distinct files all process', async t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const watch = tmpDir();
  const out = tmpDir();
  t.after(() => { cleanup(watch); cleanup(out); });

  // Drop five files back-to-back; processFile is async but these CSV files
  // go through the sync CSV path. Verify each one completes independently
  // and lands in processed/.
  const files = [];
  for (let i = 0; i < 5; i++) {
    const p = path.join(watch, `roster-${i}.csv`);
    fs.writeFileSync(p, `first_name,last_name\nP${i},Smith\n`);
    files.push(p);
  }
  for (const p of files) {
    const r = await folderWatch.processFile(db, s, defaultThresholds(), p, { outDir: out });
    assert.equal(r.ok, true, `${path.basename(p)} should process`);
  }
  for (let i = 0; i < 5; i++) {
    assert.ok(fs.existsSync(path.join(out, 'processed', `roster-${i}.csv`)));
    assert.ok(fs.existsSync(path.join(out, `roster-${i}.csv.import-summary.json`)));
  }
});
