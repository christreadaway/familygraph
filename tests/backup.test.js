'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const backup = require('../server/backup');
const families = require('../server/identity/families');
const dbModule = require('../server/db');
const { newDb, newSecrets, tmpDir, cleanup } = require('./_helpers');

test('backup > hot backup and plain restore by copy', async t => {
  const { db, dir, dbPath } = newDb();
  const s = newSecrets();
  t.after(() => { try { db.close(); } catch {} cleanup(dir); });
  families.create(db, s, { display_name: 'BackupTest' });

  const backupsDir = tmpDir();
  t.after(() => cleanup(backupsDir));
  const out = await backup.hotBackup(db, backupsDir);
  assert.ok(fs.existsSync(out));
  // Restore by copying.
  const restoreDir = tmpDir();
  const restorePath = path.join(restoreDir, 'restored.sqlite');
  fs.copyFileSync(out, restorePath);
  const db2 = dbModule.init(restorePath);
  const fams = db2.prepare('SELECT * FROM families').all();
  assert.equal(fams.length, 1);
  db2.close();
  cleanup(restoreDir);
});

test('backup > encrypted hot backup round trip', async t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { try { db.close(); } catch {} cleanup(dir); });
  families.create(db, s, { display_name: 'EncBackup' });

  const backupsDir = tmpDir();
  t.after(() => cleanup(backupsDir));
  const out = await backup.hotBackup(db, backupsDir, { passphrase: 'correct-horse-battery' });
  assert.ok(out.endsWith('.sanctus-backup'));
  const restoreDir = tmpDir();
  t.after(() => cleanup(restoreDir));
  const restorePath = path.join(restoreDir, 'restored.sqlite');
  backup.decryptedRestore(out, restorePath, 'correct-horse-battery');
  const db2 = dbModule.init(restorePath);
  const fams = db2.prepare('SELECT * FROM families').all();
  assert.equal(fams.length, 1);
  db2.close();
});

test('backup > wrong passphrase fails', async t => {
  const { db, dir } = newDb();
  t.after(() => { try { db.close(); } catch {} cleanup(dir); });
  const backupsDir = tmpDir();
  t.after(() => cleanup(backupsDir));
  const out = await backup.hotBackup(db, backupsDir, { passphrase: 'right' });
  const dest = path.join(tmpDir(), 'r.sqlite');
  assert.throws(() => backup.decryptedRestore(out, dest, 'wrong'));
});
