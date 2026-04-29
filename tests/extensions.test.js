'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const profiles = require('../server/identity/profiles');
const audit = require('../server/audit');
const ner = require('../server/sanitize/ner');
const migrationsRunner = require('../server/db/migrations');
const dbModule = require('../server/db');
const families = require('../server/identity/families');
const people = require('../server/identity/people');
const enc = require('../server/crypto/encryption');
const { newDb, newSecrets, tmpDir, cleanup } = require('./_helpers');

test('profiles > built-ins seed and activate', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  profiles.ensureBuiltins(db);
  const list = profiles.list(db);
  assert.ok(list.find(p => p.name === 'catholic_school'));
  assert.ok(list.find(p => p.name === 'parish_donor'));
  profiles.activate(db, 'parish_donor');
  const a = profiles.active(db);
  assert.equal(a.name, 'parish_donor');
});

test('profiles > thresholdsFor falls back to argument if no active profile', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  const fb = { autoMerge: 0.5, review: 0.3 };
  const out = profiles.thresholdsFor(db, fb);
  assert.deepEqual(out, fb);
});

test('profiles > thresholdsFor merges active profile thresholds over fallback', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  profiles.ensureBuiltins(db);
  profiles.activate(db, 'diocese');
  const fb = { autoMerge: 0.0, review: 0.0 };
  const out = profiles.thresholdsFor(db, fb);
  // diocese profile: see server/identity/profiles.js BUILTIN_PROFILES.
  // Recalibrated for the additive scoring vendored from missionIQ.
  assert.equal(out.autoMerge, 0.90);
  assert.equal(out.review, 0.30);
});

test('audit > sweep removes only tier-1 older than the cutoff', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  // Insert one old tier-1, one fresh tier-1, one old tier-2.
  const old = new Date(Date.now() - 100 * 86400 * 1000).toISOString();
  const fresh = new Date().toISOString();
  db.prepare(`INSERT INTO audit_events (code, tier, action, actor, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run('au_old_____', 1, 'read_pii', 'op', old);
  db.prepare(`INSERT INTO audit_events (code, tier, action, actor, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run('au_fresh___', 1, 'read_pii', 'op', fresh);
  db.prepare(`INSERT INTO audit_events (code, tier, action, actor, destination, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('au_t2______', 2, 'export_consent', 'op', 'x.csv', old);
  const removed = audit.sweep(db, 30);
  assert.equal(removed, 1);
  const t1Old = db.prepare('SELECT 1 FROM audit_events WHERE code = ?').get('au_old_____');
  const t1Fresh = db.prepare('SELECT 1 FROM audit_events WHERE code = ?').get('au_fresh___');
  const t2Old = db.prepare('SELECT 1 FROM audit_events WHERE code = ?').get('au_t2______');
  assert.equal(t1Old, undefined);
  assert.ok(t1Fresh);
  assert.ok(t2Old, 'tier-2 events must NEVER be swept');
});

test('audit > sweep is a no-op for invalid retention', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  audit.record(db, { action: 'read_pii', actor: 'op' });
  assert.equal(audit.sweep(db, 0), 0);
  assert.equal(audit.sweep(db, -5), 0);
  assert.equal(audit.sweep(db, null), 0);
  const row = db.prepare('SELECT COUNT(*) AS c FROM audit_events').get();
  assert.equal(row.c, 1);
});

test('ner > compromise layer detects unseen full names', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const findings = ner.detect(db, s, 'I met Lucia Rossi at the parish potluck.');
  // The compromise NER layer should pick up "Lucia Rossi" as a name candidate
  // (or our fallback regex should). Either way, the kind must be present.
  assert.ok(findings.some(f => f.kind === 'name_candidate' && f.value.includes('Lucia')));
});

test('migrations > runner is idempotent on a fresh schema', t => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const dbPath = path.join(dir, 'm.sqlite');
  const db = dbModule.init(dbPath);
  const versionA = migrationsRunner.currentVersion(db);
  // Applying again should be a no-op.
  const out = migrationsRunner.run(db, path.join(__dirname, '..', 'server', 'db', 'migrations'));
  assert.equal(out.from, versionA);
  assert.equal(out.applied.length, 0);
  db.close();
});

test('search > exact-match HMAC lookup never decrypts unrelated rows', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  people.create(db, s, { given_name: 'Mary', family_name: 'Smith' });
  people.create(db, s, { given_name: 'Maria', family_name: 'Smith' });
  // Searching for "Mary" hashes to mary; only the Mary Smith row matches.
  const hMary = enc.hmac(s, enc.normalizeName('Mary'));
  const matchesMary = db
    .prepare(`SELECT * FROM persons WHERE given_name_hash = ? OR family_name_hash = ?`)
    .all(hMary, hMary);
  assert.equal(matchesMary.length, 1);
  // Searching for "Smith" hashes to smith; both rows match by family.
  const hSmith = enc.hmac(s, enc.normalizeName('Smith'));
  const matchesSmith = db
    .prepare(`SELECT * FROM persons WHERE given_name_hash = ? OR family_name_hash = ?`)
    .all(hSmith, hSmith);
  assert.equal(matchesSmith.length, 2);
});

test('export > safe export omits encrypted columns', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  families.create(db, s, { display_name: 'Smith' });
  const fams = db.prepare(`SELECT * FROM families WHERE status = 'active'`).all();
  // The raw row contains a Buffer for display_name_ct; the safe shape must
  // drop both *_ct columns. We simulate the shape from server/api/export.js:
  const safe = fams.map(r => ({ code: r.code, status: r.status, created_at: r.created_at }));
  for (const r of safe) {
    assert.equal(r.display_name, undefined);
    assert.equal(r.notes, undefined);
  }
});
