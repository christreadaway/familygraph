'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const folderWatch = require('../server/folder-watch');
const { newDb, newSecrets, defaultThresholds, tmpDir, cleanup } = require('./_helpers');

test('folder-watch > processes a CSV import file', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const watch = tmpDir();
  const out = tmpDir();
  t.after(() => { cleanup(watch); cleanup(out); });

  const csvPath = path.join(watch, 'roster.csv');
  fs.writeFileSync(csvPath, 'first_name,last_name,email\nMary,Smith,mary@example.org\n');
  const r = folderWatch.processFile(db, s, defaultThresholds(), csvPath, { outDir: out });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'import');
  assert.equal(r.summary.rows, 1);
  // Source file moved to processed.
  assert.equal(fs.existsSync(csvPath), false);
  assert.ok(fs.existsSync(path.join(out, 'processed', 'roster.csv')));
  assert.ok(fs.existsSync(path.join(out, 'roster.csv.import-summary.json')));
});

test('folder-watch > sanitizes a text file', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const watch = tmpDir();
  const out = tmpDir();
  t.after(() => { cleanup(watch); cleanup(out); });

  const txt = path.join(watch, 'note.txt');
  fs.writeFileSync(txt, 'Mary lives at 12 Maple Street. mary@example.org');
  const r = folderWatch.processFile(db, s, defaultThresholds(), txt, { outDir: out });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'sanitize');
  const sanitized = fs.readFileSync(r.sanitized, 'utf8');
  assert.doesNotMatch(sanitized, /mary@example\.org/);
  assert.ok(fs.existsSync(path.join(out, 'note.token-set.json')));
});

test('folder-watch > unknown kinds go to errors', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const watch = tmpDir();
  const out = tmpDir();
  t.after(() => { cleanup(watch); cleanup(out); });

  const f = path.join(watch, 'binary.bin');
  fs.writeFileSync(f, Buffer.from([0, 1, 2]));
  const r = folderWatch.processFile(db, s, defaultThresholds(), f, { outDir: out });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unknown');
  assert.ok(fs.existsSync(path.join(out, 'errors', 'binary.bin')));
});
