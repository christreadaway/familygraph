'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
const importPipeline = require('../server/identity/import');
const sources = require('../server/sources');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

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
        let p = buf; try { p = JSON.parse(buf); } catch { /* ok */ }
        resolve({ status: res.statusCode, body: p });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function makeServer(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  return listen(app).then(({ server, port }) => {
    t.after(async () => { await new Promise(r => server.close(r)); db.close(); cleanup(dir); });
    return { server, port, db, secrets };
  });
}

const TWO_FAMILIES_CSV = [
  'first_name,last_name,email,city,state,zip',
  'Mary,Smith,mary@example.org,Lima,OH,45801',
  'John,Doe,john@example.org,Lima,OH,45801',
].join('\n') + '\n';

test('import_runs > batch writes a run row with totals and code', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const out = sources.csv.loadString(TWO_FAMILIES_CSV);
  const r = importPipeline.importBatch(db, s, defaultThresholds(), out.canonical, {
    source: 'csv',
    sourceRef: 'unit-test',
    category: 'church',
    tags: ['q1-2026', 'donor-list'],
    actor: 'op',
  });
  assert.match(r.importRunCode, /^imp_/);
  assert.equal(r.totals.families_created, 2);
  assert.equal(r.totals.persons_created, 2);
  assert.equal(r.totals.persons_attached, 0);
  assert.equal(r.totals.addresses_attached, 2);
  assert.equal(r.totals.emails_attached, 2);
  assert.equal(r.totals.memberships_opened, 2);

  const persisted = importPipeline.getImportRun(db, r.importRunCode);
  assert.equal(persisted.rows, 2);
  assert.equal(persisted.category, 'church');
  assert.deepEqual(persisted.tags, ['q1-2026', 'donor-list']);
  assert.equal(persisted.families_created, 2);
});

test('import_runs > source_records inherit category/tags + import_run_code', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const out = sources.csv.loadString(TWO_FAMILIES_CSV);
  const r = importPipeline.importBatch(db, s, defaultThresholds(), out.canonical, {
    source: 'csv', sourceRef: 'x', category: 'school', tags: ['enrollment'], actor: 'op',
  });
  const rows = db.prepare('SELECT * FROM source_records WHERE import_run_code = ?').all(r.importRunCode);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.category, 'school');
    assert.deepEqual(JSON.parse(row.tags), ['enrollment']);
  }
});

test('import_runs > affectedEntities lists distinct family + person codes', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const out = sources.csv.loadString(TWO_FAMILIES_CSV);
  const r = importPipeline.importBatch(db, s, defaultThresholds(), out.canonical, {
    source: 'csv', sourceRef: 'x', actor: 'op',
  });
  const aff = importPipeline.affectedEntities(db, r.importRunCode);
  const fields = new Set(aff.map(a => a.field));
  assert.ok(fields.has('family'));
  assert.ok(fields.has('person'));
  // 2 families + 2 persons + 1 address (dedup'd by norm_hash) = 5 distinct rows.
  assert.equal(aff.length, 5);
});

test('import_runs > donation-shaped CSV with extra columns yields zero financial fact storage', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  // Donation-shaped CSV: identity columns + amount/date/method we DO NOT store
  // anywhere queryable. The resolver still resolves identity from the row.
  const csv = [
    'first_name,last_name,email,city,state,zip,Donation Date,Amount,Payment Method',
    'Mary,Smith,mary@example.org,Lima,OH,45801,2026-04-15,$50.00,check',
    'John,Doe,john@example.org,Lima,OH,45801,2026-04-15,$25.00,cash',
  ].join('\n') + '\n';
  const out = sources.csv.loadString(csv);
  const r = importPipeline.importBatch(db, s, defaultThresholds(), out.canonical, {
    source: 'csv', sourceRef: 'donations.csv', category: 'church', tags: ['donations'], actor: 'op',
  });
  assert.equal(r.totals.persons_created, 2);
  assert.equal(r.totals.families_created, 2);
  // No domain-events or aggregations table — Family Graph stays narrow.
  assert.throws(() => db.prepare('SELECT 1 FROM domain_events').get());
});

test('api > /api/import/run accepts category + tags and returns import_run + totals', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const r = await req(port, {
    method: 'POST', path: '/api/import/run', headers: auth,
    body: { content: TWO_FAMILIES_CSV, category: 'church', tags: 'q1-2026, donor-list' },
  });
  assert.equal(r.status, 201);
  assert.match(r.body.import_run, /^imp_/);
  assert.equal(r.body.totals.families_created, 2);
  assert.equal(r.body.totals.persons_created, 2);
});

test('api > /api/import/run rejects unknown category', async t => {
  const { port, secrets } = await makeServer(t);
  const r = await req(port, {
    method: 'POST', path: '/api/import/run',
    headers: { authorization: `Bearer ${secrets.master}` },
    body: { content: TWO_FAMILIES_CSV, category: 'parish' }, // not in the allow-list
  });
  assert.equal(r.status, 400);
});

test('api > /api/imports lists runs with totals + filter by category', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  await req(port, { method: 'POST', path: '/api/import/run', headers: auth, body: { content: TWO_FAMILIES_CSV, category: 'church' } });
  await req(port, { method: 'POST', path: '/api/import/run', headers: auth, body: { content: TWO_FAMILIES_CSV, category: 'school' } });
  const all = await req(port, { path: '/api/imports', headers: auth });
  assert.equal(all.body.items.length, 2);
  const justChurch = await req(port, { path: '/api/imports?category=church', headers: auth });
  assert.equal(justChurch.body.items.length, 1);
  assert.equal(justChurch.body.items[0].category, 'church');
});

test('api > /api/imports/:code returns the run + affected entities', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const run = await req(port, {
    method: 'POST', path: '/api/import/run', headers: auth,
    body: { content: TWO_FAMILIES_CSV, category: 'church', tags: ['donations'] },
  });
  const code = run.body.import_run;
  const detail = await req(port, { path: `/api/imports/${code}`, headers: auth });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.run.code, code);
  assert.equal(detail.body.run.category, 'church');
  assert.deepEqual(detail.body.run.tags, ['donations']);
  assert.ok(detail.body.affected.length > 0);
});

test('migration > 0005 idempotent on a fresh schema', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  const mod = require('../server/db/migrations/0005_source_tagging');
  mod.up(db);
  mod.up(db); // running it again must not throw
  const cols = db.prepare(`PRAGMA table_info(source_records)`).all().map(r => r.name);
  for (const c of ['category', 'tags', 'import_run_code']) assert.ok(cols.includes(c));
  // import_runs table exists.
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='import_runs'`).get());
});
