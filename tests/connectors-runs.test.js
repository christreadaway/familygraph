'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const runs = require('../server/connectors/runs');
const { newDb, cleanup } = require('./_helpers');

test('connector_runs > start/finish round-trip and isRunning gate', () => {
  const { db, dir } = newDb();
  try {
    assert.equal(runs.isRunning(db, 'facts'), false);
    const code = runs.start(db, { connector: 'facts', trigger: 'manual' });
    assert.equal(runs.isRunning(db, 'facts'), true);
    runs.finish(db, code, { importRun: 'imp_x', metadata: { rows_pulled: 3 } });
    assert.equal(runs.isRunning(db, 'facts'), false);
    const row = runs.get(db, code);
    assert.equal(row.status, 'ok');
    assert.equal(row.import_run, 'imp_x');
    assert.equal(row.metadata.rows_pulled, 3);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('connector_runs > fail records reason; consecutiveFailures resets on success', () => {
  const { db, dir } = newDb();
  try {
    for (let i = 0; i < 3; i++) {
      const code = runs.start(db, { connector: 'facts', trigger: 'scheduled' });
      runs.fail(db, code, { reason: 'auth_failed' });
    }
    assert.equal(runs.consecutiveFailures(db, 'facts'), 3);
    const ok = runs.start(db, { connector: 'facts', trigger: 'manual' });
    runs.finish(db, ok, {});
    assert.equal(runs.consecutiveFailures(db, 'facts'), 0);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('connector_runs > reapStalled marks orphaned running rows as error', () => {
  const { db, dir } = newDb();
  try {
    const code = runs.start(db, { connector: 'ministry_platform', trigger: 'manual' });
    // Backdate started_at by 2h to simulate a crashed process.
    db.prepare(`UPDATE connector_runs SET started_at = ? WHERE code = ?`).run(Date.now() - 2 * 60 * 60 * 1000, code);
    const reaped = runs.reapStalled(db);
    assert.equal(reaped, 1);
    const row = runs.get(db, code);
    assert.equal(row.status, 'error');
  } finally {
    db.close();
    cleanup(dir);
  }
});
