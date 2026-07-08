'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../../log');

// Numbered migrations runner. Each migration file is named NNNN_description.sql
// or NNNN_description.js. SQL migrations are executed verbatim. JS migrations
// export `up(db)`. Migrations are applied in order; `schema_version` is updated
// after each successful migration. The runner is idempotent: re-running on a
// current database is a no-op.

function discover(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => /^(\d{4})_[a-z0-9_]+\.(sql|js)$/i.test(f))
    .map(f => {
      const m = /^(\d{4})_/.exec(f);
      return { version: Number(m[1]), file: f, full: path.join(dir, f) };
    })
    .sort((a, b) => a.version - b.version);
}

function currentVersion(db) {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  return row && row.v ? row.v : 0;
}

function applyOne(db, mig) {
  if (mig.file.endsWith('.sql')) {
    const sql = fs.readFileSync(mig.full, 'utf8');
    db.exec(sql);
  } else if (mig.file.endsWith('.js')) {
    const mod = require(mig.full);
    if (typeof mod.up !== 'function') throw new Error(`migration ${mig.file} has no up()`);
    mod.up(db);
  }
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(mig.version);
}

function run(db, migrationsDir) {
  // Ensure schema_version table exists (the bootstrap schema does this too).
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     )`
  );
  const cur = currentVersion(db);
  const all = discover(migrationsDir);
  const pending = all.filter(m => m.version > cur);
  for (const m of pending) {
    const tx = db.transaction(() => applyOne(db, m));
    tx();
    // One line per applied migration so a startup that ran migrations is
    // reconstructable from server.log alone ("schema jumped 17→19 at boot").
    log.info('db.migration_applied', { id: m.version, file: m.file });
  }
  return { from: cur, to: currentVersion(db), applied: pending.map(m => m.version) };
}

module.exports = { run, discover, currentVersion };
