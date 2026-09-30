'use strict';

// Connected-app contract (2026-09-29): a donor app records that a family is a
// grandparent household or alumni, links grandparent and grandchild families,
// and stores an alumni class year. All through a key issued as
// `issue-key missioniq` with its default scopes.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
const apiKeys = require('../server/auth/api-keys');
const families = require('../server/identity/families');
const people = require('../server/identity/people');
const tags = require('../server/identity/tags');
const relationships = require('../server/identity/relationships');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

const MISSIONIQ_SCOPES = ['pii.read', 'pii.write', 'sanitize', 'audit.write'];

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

async function setup(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); cleanup(dir); });
  const key = apiKeys.provision(db, { name: 'missioniq', scopes: MISSIONIQ_SCOPES });
  const auth = { authorization: `Bearer ${key.token}` };
  const call = (method, path, body) => req(server.address().port, { method, path, body, headers: auth });
  const fam = () => families.create(db, secrets, { display_name: '[Family Name]' });
  const person = () => people.create(db, secrets, { given_name: '[Given]', family_name: '[Surname]' });
  return { db, secrets, call, fam, person };
}

const rels = (db, from) => db.prepare('SELECT from_code, to_code, kind FROM relationships WHERE from_code = ? ORDER BY kind').all(from);

test('relationships > grandparent_of creates grandchild_of and deleting either removes both', async t => {
  const c = await setup(t);
  const g = c.fam(); const k = c.fam();
  const r = await c.call('POST', '/api/relationships', { from: g, to: k, kind: 'grandparent_of' });
  assert.equal(r.status, 201);
  assert.deepEqual(rels(c.db, k), [{ from_code: k, to_code: g, kind: 'grandchild_of' }]);
  const d = await c.call('DELETE', `/api/relationships/${r.body.code}`);
  assert.equal(d.status, 204);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM relationships').get().n, 0);

  // grandchild_of first, between two persons.
  const a = c.person(); const b = c.person();
  const r2 = await c.call('POST', '/api/relationships', { from: a, to: b, kind: 'grandchild_of' });
  assert.equal(r2.status, 201);
  assert.deepEqual(rels(c.db, b), [{ from_code: b, to_code: a, kind: 'grandparent_of' }]);
  const reverse = rels(c.db, b)[0];
  const rid = c.db.prepare('SELECT code FROM relationships WHERE from_code = ? AND kind = ?').get(reverse.from_code, reverse.kind).code;
  assert.equal((await c.call('DELETE', `/api/relationships/${rid}`)).status, 204);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM relationships').get().n, 0);
});

test('relationships > grandparent kinds refuse a family paired with a person, or a self-link', async t => {
  const c = await setup(t);
  const f = c.fam(); const p = c.person();
  assert.equal((await c.call('POST', '/api/relationships', { from: f, to: p, kind: 'grandparent_of' })).status, 400);
  assert.equal((await c.call('POST', '/api/relationships', { from: f, to: f, kind: 'grandparent_of' })).status, 400);
});

test('relationships > POST is idempotent for an identical triple (all kinds)', async t => {
  const c = await setup(t);
  const g = c.fam(); const k = c.fam();
  const first = await c.call('POST', '/api/relationships', { from: g, to: k, kind: 'grandparent_of' });
  const again = await c.call('POST', '/api/relationships', { from: g, to: k, kind: 'grandparent_of' });
  assert.equal(again.status, 200);
  assert.equal(again.body.existing, true);
  assert.equal(again.body.code, first.body.code);
  assert.equal(again.body.kind, 'grandparent_of');
  // Posting the reverse is also "already there".
  const rev = await c.call('POST', '/api/relationships', { from: k, to: g, kind: 'grandchild_of' });
  assert.equal(rev.status, 200);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM relationships').get().n, 2);
  const a = c.person(); const b = c.person();
  assert.equal((await c.call('POST', '/api/relationships', { from: a, to: b, kind: 'godparent_of' })).status, 201);
  assert.equal((await c.call('POST', '/api/relationships', { from: a, to: b, kind: 'godparent_of' })).status, 200);
  assert.equal(relationships.listFor(c.db, a, { kind: 'godparent_of' }).length, 1);
});

test('relationships > DELETE by (from, to, kind) removes the pair; 404 when none; 400 when incomplete', async t => {
  const c = await setup(t);
  const g = c.fam(); const k = c.fam();
  await c.call('POST', '/api/relationships', { from: g, to: k, kind: 'grandparent_of' });
  const q = `/api/relationships?from=${k}&to=${g}&kind=grandchild_of`;
  assert.equal((await c.call('DELETE', q)).status, 204);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM relationships').get().n, 0);
  assert.equal((await c.call('DELETE', q)).status, 404);
  assert.equal((await c.call('DELETE', `/api/relationships?from=${g}`)).status, 400);
});

test('tags > tags/add unions into the list for families and persons', async t => {
  const c = await setup(t);
  const f = c.fam(); const p = c.person();
  tags.setFamilyTags(c.db, f, ['parishioner']);
  const r = await c.call('POST', `/api/families/${f}/tags/add`, { tags: ['grandparent', 'Grandparent'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { code: f, tags: ['grandparent', 'parishioner'] });
  const r2 = await c.call('POST', `/api/families/${f}/tags/add`, { tags: ['school-alumni'] });
  assert.deepEqual(r2.body.tags, ['grandparent', 'parishioner', 'school-alumni']);
  const rp = await c.call('POST', `/api/people/${p}/tags/add`, { tags: ['school-alumni'] });
  assert.deepEqual(rp.body, { code: p, tags: ['school-alumni'] });
  assert.equal((await c.call('POST', `/api/families/${f}/tags/add`, { tags: [] })).status, 400);
  assert.equal((await c.call('POST', `/api/families/${f}/tags/add`, { tags: 'x' })).status, 400);
  assert.equal((await c.call('POST', '/api/families/f_0000000000000000/tags/add', { tags: ['x'] })).status, 404);
  const del = await c.call('DELETE', `/api/families/${f}/tags/parishioner`);
  assert.deepEqual(del.body.tags, ['grandparent', 'school-alumni']);
});

test('tags > concurrent tags/add calls never lose a tag', async t => {
  const c = await setup(t);
  const f = c.fam();
  const names = Array.from({ length: 20 }, (_, i) => `t${String(i).padStart(2, '0')}`);
  const rs = await Promise.all(names.map(n => c.call('POST', `/api/families/${f}/tags/add`, { tags: [n] })));
  assert.ok(rs.every(r => r.status === 200));
  assert.deepEqual(tags.getFamilyTags(c.db, f), names);
});

test('tags > a tag call on a merged-away family or person lands on the survivor (review 9/30)', async t => {
  const c = await setup(t);
  const loser = c.fam(); const winner = c.fam();
  families.merge(c.db, c.secrets, loser, winner);
  const r = await c.call('POST', `/api/families/${loser}/tags/add`, { tags: ['grandparent'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { code: winner, tags: ['grandparent'] });
  assert.deepEqual(tags.getFamilyTags(c.db, winner), ['grandparent']);
  assert.equal(c.db.prepare('SELECT tags FROM families WHERE code = ?').get(loser).tags, null, 'the merged-away row is untouched');
  // Reads follow the alias too, and a remove by the old code clears the survivor.
  assert.deepEqual(tags.getFamilyTags(c.db, loser), ['grandparent']);
  const del = await c.call('DELETE', `/api/families/${loser}/tags/grandparent`);
  assert.equal(del.status, 200);
  assert.deepEqual(tags.getFamilyTags(c.db, winner), []);
  await c.call('PUT', `/api/families/${loser}/tags`, { tags: ['school-alumni'] });
  assert.deepEqual(tags.getFamilyTags(c.db, winner), ['school-alumni']);
  const audits = c.db.prepare(`SELECT entity_code FROM audit_events WHERE action LIKE 'family_%tag%'`).all();
  assert.ok(audits.length >= 3 && audits.every(a => a.entity_code === winner), 'audited on the survivor');

  const pl = c.person(); const pw = c.person();
  people.merge(c.db, c.secrets, pl, pw);
  const rp = await c.call('POST', `/api/people/${pl}/tags/add`, { tags: ['school-alumni'] });
  assert.deepEqual(rp.body, { code: pw, tags: ['school-alumni'] });
  assert.deepEqual(tags.getPersonTags(c.db, pw), ['school-alumni']);
});

test('relationships > re-adding a triple whose reverse went missing writes the reverse and audits it (codes only)', async t => {
  const c = await setup(t);
  const g = c.fam(); const k = c.fam();
  await c.call('POST', '/api/relationships', { from: g, to: k, kind: 'grandparent_of' });
  c.db.prepare(`DELETE FROM relationships WHERE from_code = ? AND kind = 'grandchild_of'`).run(k);
  const again = await c.call('POST', '/api/relationships', { from: g, to: k, kind: 'grandparent_of' });
  assert.equal(again.status, 200);
  assert.equal(again.body.existing, true);
  assert.deepEqual(rels(c.db, k), [{ from_code: k, to_code: g, kind: 'grandchild_of' }]);
  const rows = c.db.prepare(`SELECT metadata FROM audit_events WHERE action = 'relationship_reverse_add'`).all();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(rows[0].metadata)).sort(), ['code', 'from', 'kind', 'to']);
  // A plain repeat (nothing written) still leaves no audit row.
  await c.call('POST', '/api/relationships', { from: g, to: k, kind: 'grandparent_of' });
  assert.equal(c.db.prepare(`SELECT COUNT(*) n FROM audit_events WHERE action = 'relationship_reverse_add'`).get().n, 1);
});

test('schema > SCHEMA_VERSION matches the newest migration and /health reports it', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { SCHEMA_VERSION } = require('../server/db');
  const newest = Math.max(...fs.readdirSync(path.join(__dirname, '..', 'server', 'db', 'migrations'))
    .map(f => /^(\d{4})_/.exec(f)).filter(Boolean).map(m => Number(m[1])));
  assert.equal(SCHEMA_VERSION, newest);
  const c = await setup(t);
  const h = await c.call('GET', '/api/health');
  assert.equal(h.body.schema, SCHEMA_VERSION);
});

test('affiliations > class_year validates, round-trips, and survives the alumni transition', async t => {
  const c = await setup(t);
  const p = c.person();
  const org = await c.call('POST', '/api/organizations', { name: '[School Name]', kind: 'school' });
  assert.equal(org.status, 201);
  const base = `/api/organizations/${org.body.code}/affiliations`;
  for (const bad of [1899, 2101, 2009.5, 'class of 09', true]) {
    const r = await c.call('POST', base, { person_code: p, role: 'student', class_year: bad });
    assert.equal(r.status, 400, `class_year ${JSON.stringify(bad)} refused`);
  }
  const a = await c.call('POST', base, { person_code: p, role: 'student', class_year: 2030 });
  assert.equal(a.status, 201);
  const list = await c.call('GET', `/api/organizations/${org.body.code}`);
  assert.equal(list.body.affiliations.find(x => x.code === a.body.code).class_year, 2030);
  const tr = await c.call('POST', `/api/organizations/affiliations/${a.body.code}/transition`, {});
  assert.equal(tr.status, 201);
  const after = await c.call('GET', `/api/organizations/${org.body.code}`);
  const alum = after.body.affiliations.find(x => x.code === tr.body.code);
  assert.equal(alum ? alum.class_year : c.db.prepare('SELECT class_year FROM affiliations WHERE code = ?').get(tr.body.code).class_year, 2030);
  // Explicit null clears it on a re-affiliate; omitting keeps it.
  const f = c.fam();
  const fa = await c.call('POST', base, { family_code: f, role: 'alumni', class_year: '1998' });
  assert.equal(c.db.prepare('SELECT class_year FROM affiliations WHERE code = ?').get(fa.body.code).class_year, 1998);
  await c.call('POST', base, { family_code: f, role: 'alumni' });
  assert.equal(c.db.prepare('SELECT class_year FROM affiliations WHERE code = ?').get(fa.body.code).class_year, 1998);
  await c.call('POST', base, { family_code: f, role: 'alumni', class_year: null });
  assert.equal(c.db.prepare('SELECT class_year FROM affiliations WHERE code = ?').get(fa.body.code).class_year, null);
});

test('audit > new write paths log ids and counts, never tag values or names', async t => {
  const c = await setup(t);
  const g = c.fam(); const k = c.fam();
  await c.call('POST', `/api/families/${g}/tags/add`, { tags: ['grandparent'] });
  await c.call('POST', '/api/relationships', { from: g, to: k, kind: 'grandparent_of' });
  await c.call('DELETE', `/api/relationships?from=${g}&to=${k}&kind=grandparent_of`);
  const rows = c.db.prepare(`SELECT * FROM audit_events`).all();
  const text = JSON.stringify(rows);
  assert.ok(!text.includes('[Family Name]'));
});

test('migration 0021 > an older database keeps its relationships and gains the new kinds', t => {
  const Database = require('better-sqlite3');
  const path = require('node:path');
  const { tmpDir } = require('./_helpers');
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const db = new Database(path.join(dir, 'old.db'));
  db.exec(`CREATE TABLE relationships (code TEXT PRIMARY KEY, from_code TEXT NOT NULL, to_code TEXT NOT NULL,
    kind TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x',
    CHECK (kind IN ('parent_of','child_of','other')));
    CREATE TABLE affiliations (code TEXT PRIMARY KEY);
    INSERT INTO relationships (code, from_code, to_code, kind) VALUES ('r_1', 'p_1', 'p_2', 'parent_of');`);
  require('../server/db/migrations/0021_grandparent_links_class_year.js').up(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relationships').get().n, 1);
  db.prepare(`INSERT INTO relationships (code, from_code, to_code, kind) VALUES ('r_2', 'f_1', 'f_2', 'grandparent_of')`).run();
  assert.ok(db.prepare('PRAGMA table_info(affiliations)').all().some(c => c.name === 'class_year'));
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'relationships_from_idx'`).get());
  db.close();
});
