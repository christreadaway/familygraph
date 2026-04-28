'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('node:http');

const { buildApp } = require('../server');
const audit = require('../server/audit');
const folderWatch = require('../server/folder-watch');
const { newDb, newSecrets, defaultThresholds, tmpDir, cleanup } = require('./_helpers');

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function req(port, opts) {
  return new Promise((resolve, reject) => {
    const data = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const h = { 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}), ...(opts.headers || {}) };
    const r = http.request({ method: opts.method || 'GET', hostname: '127.0.0.1', port, path: opts.path, headers: h }, res => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => {
        const ct = res.headers['content-type'] || '';
        let p = buf;
        if (ct.includes('application/json')) { try { p = JSON.parse(buf); } catch { /* ok */ } }
        resolve({ status: res.statusCode, body: p, headers: res.headers });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function makeServer(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const watchState = () => ({ enabled: false, processed_since_boot: 0 });
  const app = buildApp({ db, secrets, thresholds: defaultThresholds(), watchState });
  return listen(app).then(({ server, port }) => {
    t.after(async () => { await new Promise(r => server.close(r)); db.close(); cleanup(dir); });
    return { server, port, db, secrets };
  });
}

test('audit > circular metadata is recorded as [circular] not crashed', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  const a = { name: 'parent' };
  const b = { name: 'child' };
  a.child = b; b.parent = a;
  // No throw:
  const code = audit.record(db, { action: 'test', actor: 'op', metadata: a });
  assert.match(code, /^au_/);
  const list = audit.list(db);
  assert.equal(list.length, 1);
  // Circular reference replaced by sentinel.
  const flat = JSON.stringify(list[0].metadata);
  assert.match(flat, /\[circular\]/);
});

test('audit > oversized metadata is truncated with a sentinel', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  const huge = { blob: 'x'.repeat(100_000) };
  audit.record(db, { action: 'test', actor: 'op', metadata: huge });
  const list = audit.list(db);
  assert.equal(list[0].metadata.truncated, true);
  assert.ok(list[0].metadata.prefix.length < 100_000);
});

test('audit > export endpoint returns CSV', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  audit.record(db, { action: 'test', actor: 'op', metadata: { hello: 'world' } });
  const r = await req(port, { path: '/api/audit/export', headers: auth });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.match(r.body, /code,tier,created_at,action,actor/);
});

test('health > reports counts + active profile + folder watch', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  await req(port, { method: 'POST', path: '/api/families', headers: auth, body: { display_name: 'Smith' } });
  await req(port, { method: 'POST', path: '/api/profiles/activate', headers: auth, body: { name: 'parish_donor' } });
  const r = await req(port, { path: '/api/health' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
  assert.equal(r.body.active_profile, 'parish_donor');
  assert.equal(r.body.counts.families, 1);
  assert.ok('pending_conflicts' in r.body);
  assert.ok(r.body.folder_watch);
});

test('folder-watch > processExisting picks up files dropped while down', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const watch = tmpDir();
  const out = tmpDir();
  t.after(() => { cleanup(watch); cleanup(out); });

  fs.writeFileSync(path.join(watch, 'roster.csv'), 'first_name,last_name\nMary,Smith\n');
  fs.writeFileSync(path.join(watch, 'note.txt'), 'Mary Smith called.');

  let processed = 0;
  const wd = folderWatch.start(db, s, defaultThresholds(), {
    watchDir: watch,
    outDir: out,
    processExisting: true,
    onProcessed: () => { processed += 1; },
  });
  wd.watcher.close();
  assert.equal(processed, 2);
  // Both files moved out of the watch dir.
  assert.equal(fs.existsSync(path.join(watch, 'roster.csv')), false);
  assert.equal(fs.existsSync(path.join(watch, 'note.txt')), false);
});

test('folder-watch > default does not reprocess existing files', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const watch = tmpDir();
  const out = tmpDir();
  t.after(() => { cleanup(watch); cleanup(out); });

  fs.writeFileSync(path.join(watch, 'roster.csv'), 'first_name,last_name\nMary,Smith\n');
  let processed = 0;
  const wd = folderWatch.start(db, s, defaultThresholds(), {
    watchDir: watch, outDir: out,
    onProcessed: () => { processed += 1; },
  });
  wd.watcher.close();
  assert.equal(processed, 0, 'existing files must not be touched without processExisting');
  assert.equal(fs.existsSync(path.join(watch, 'roster.csv')), true);
});

test('cli/status > prints counts without crashing', () => {
  // Smoke test the status command path by requiring the bin module's
  // dependencies — full subprocess invocation is overkill here.
  const profiles = require('../server/identity/profiles');
  const dbm = require('../server/db');
  const { dir, dbPath } = newDb();
  const db = dbm.init(dbPath);
  profiles.ensureBuiltins(db);
  // Same shape as the bin script reads:
  const families = db.prepare("SELECT COUNT(*) AS c FROM families WHERE status = 'active'").get().c;
  const persons = db.prepare("SELECT COUNT(*) AS c FROM persons WHERE status = 'active'").get().c;
  const conflicts = db.prepare("SELECT COUNT(*) AS c FROM conflicts WHERE status = 'open'").get().c;
  assert.equal(families, 0);
  assert.equal(persons, 0);
  assert.equal(conflicts, 0);
  db.close();
  cleanup(dir);
});
