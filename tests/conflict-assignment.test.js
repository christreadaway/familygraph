'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
const conflictsMod = require('../server/identity/conflicts');
const people = require('../server/identity/people');
const resolver = require('../server/identity/resolver');
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
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  return listen(app).then(({ server, port }) => {
    t.after(async () => { await new Promise(r => server.close(r)); db.close(); cleanup(dir); });
    return { server, port, db, secrets };
  });
}

// Seed a deterministic conflict pair (Pio Pietrelcina x2) into the queue.
function seedConflict(db, secrets) {
  const a = people.create(db, secrets, { given_name: 'Pio', family_name: 'Pietrelcina' });
  const b = people.create(db, secrets, { given_name: 'Pio', family_name: 'Pietrelcina' });
  resolver.rescorePerson(db, secrets, defaultThresholds(), b);
  return conflictsMod.list(db, { status: 'open' });
}

test('conflict-assignment > TTL whitelist enforced (helper)', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  seedConflict(db, s);
  for (const bad of [1, 2, 3, 5, 6, 36, 100, 'four', null, NaN]) {
    assert.throws(
      () => conflictsMod.assign(db, { all_open: true, allOpen: true, assignee: 'a@b.com', ttlHours: bad }),
      /ttl_hours must be one of/,
      `should reject ttl=${bad}`
    );
  }
  for (const good of [4, 12, 24, 48, 72]) {
    const r = conflictsMod.assign(db, { allOpen: true, assignee: 'a@b.com', ttlHours: good });
    assert.ok(r.assigned >= 1);
  }
});

test('conflict-assignment > rejects bad email shapes', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  seedConflict(db, s);
  for (const bad of ['', 'notanemail', 'no@dot', '@x.org', 'x@', null, undefined]) {
    assert.throws(() => conflictsMod.assign(db, { allOpen: true, assignee: bad, ttlHours: 24 }), /assignee must be an email/);
  }
});

test('conflict-assignment > all_open assigns every open conflict; expires_at is in the future', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  seedConflict(db, s);
  const before = Date.now();
  const r = conflictsMod.assign(db, { allOpen: true, assignee: 'sarah@example.org', ttlHours: 24 });
  assert.ok(r.assigned >= 1);
  const expMs = new Date(r.expires_at).getTime();
  const expectedMs = before + 24 * 3600 * 1000;
  assert.ok(Math.abs(expMs - expectedMs) < 5000, 'expires_at within 5s of now+24h');
  // Email is normalized to lowercase.
  assert.equal(r.assignee, 'sarah@example.org');
  const open = conflictsMod.list(db, { status: 'open' });
  for (const c of open) assert.equal(c.assigned_to, 'sarah@example.org');
});

test('conflict-assignment > codes-mode skips already-resolved conflicts', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const open = seedConflict(db, s);
  conflictsMod.resolveDismiss(db, open[0].code, { actor: 'op' });
  const r = conflictsMod.assign(db, {
    codes: open.map(c => c.code),
    assignee: 'a@b.com',
    ttlHours: 4,
  });
  // The dismissed one was excluded; remaining is at most (open.length - 1)
  assert.ok(r.assigned <= open.length - 1);
});

test('conflict-assignment > reassignment overwrites assignee + bumps expiry', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  seedConflict(db, s);
  conflictsMod.assign(db, { allOpen: true, assignee: 'first@x.com', ttlHours: 4 });
  const before = conflictsMod.list(db, { status: 'open' })[0];
  conflictsMod.assign(db, { allOpen: true, assignee: 'second@x.com', ttlHours: 72 });
  const after = conflictsMod.list(db, { status: 'open' })[0];
  assert.equal(after.assigned_to, 'second@x.com');
  assert.notEqual(after.assignment_expires_at, before.assignment_expires_at);
  // The new expiry should be later than the original 4h expiry.
  assert.ok(new Date(after.assignment_expires_at).getTime() > new Date(before.assignment_expires_at).getTime());
});

test('conflict-assignment > unassign clears + audits', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const open = seedConflict(db, s);
  conflictsMod.assign(db, { codes: [open[0].code], assignee: 'a@b.com', ttlHours: 4 });
  conflictsMod.unassign(db, open[0].code);
  const c = conflictsMod.get(db, open[0].code);
  assert.equal(c.assigned_to, null);
  assert.equal(c.assignment_expires_at, null);
  const events = db.prepare(`SELECT * FROM audit_events WHERE action = 'conflict_unassign'`).all();
  assert.equal(events.length, 1);
});

test('conflict-assignment > sweepExpiredAssignments clears past expiries and audits once', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const open = seedConflict(db, s);
  // Manually backdate two conflicts' expiry to the past.
  const past = new Date(Date.now() - 1000).toISOString();
  for (const c of open) {
    db.prepare(
      `UPDATE conflicts SET assigned_to = 'old@x.com', assigned_at = ?, assignment_expires_at = ? WHERE code = ?`
    ).run(past, past, c.code);
  }
  const cleared = conflictsMod.sweepExpiredAssignments(db);
  assert.equal(cleared.length, open.length);
  const remaining = conflictsMod.list(db, { status: 'open', assigned: 'assigned' });
  assert.equal(remaining.length, 0);
  const events = db.prepare(`SELECT * FROM audit_events WHERE action = 'conflict_assignment_expired'`).all();
  assert.equal(events.length, 1);
});

test('conflict-assignment > sweep with nothing expired is a no-op', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  seedConflict(db, s);
  conflictsMod.assign(db, { allOpen: true, assignee: 'a@b.com', ttlHours: 72 });
  const cleared = conflictsMod.sweepExpiredAssignments(db);
  assert.equal(cleared.length, 0);
});

test('conflict-assignment > list filter ?assigned=unassigned excludes assigned rows', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const open = seedConflict(db, s);
  conflictsMod.assign(db, { codes: [open[0].code], assignee: 'a@b.com', ttlHours: 24 });
  const unassigned = conflictsMod.list(db, { status: 'open', assigned: 'unassigned' });
  for (const c of unassigned) assert.equal(c.assigned_to, null);
  const assigned = conflictsMod.list(db, { status: 'open', assigned: 'assigned' });
  for (const c of assigned) assert.equal(c.assigned_to, 'a@b.com');
});

test('api > /api/conflicts/assign with all_open', async t => {
  const { port, secrets, db } = await makeServer(t);
  seedConflict(db, secrets);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const r = await req(port, {
    method: 'POST', path: '/api/conflicts/assign', headers: auth,
    body: { all_open: true, assignee: 'sarah@example.org', ttl_hours: 24 },
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.assigned >= 1);
});

test('api > /api/conflicts/assign rejects ttl=10', async t => {
  const { port, secrets, db } = await makeServer(t);
  seedConflict(db, secrets);
  const r = await req(port, {
    method: 'POST', path: '/api/conflicts/assign',
    headers: { authorization: `Bearer ${secrets.master}` },
    body: { all_open: true, assignee: 'sarah@example.org', ttl_hours: 10 },
  });
  assert.equal(r.status, 400);
});

test('api > /api/conflicts?assigned_to filters', async t => {
  const { port, secrets, db } = await makeServer(t);
  const open = seedConflict(db, secrets);
  conflictsMod.assign(db, { codes: [open[0].code], assignee: 'mary@example.org', ttlHours: 24 });
  const r = await req(port, {
    path: '/api/conflicts?assigned_to=mary@example.org',
    headers: { authorization: `Bearer ${secrets.master}` },
  });
  assert.equal(r.status, 200);
  for (const c of r.body.items) assert.equal(c.assigned_to, 'mary@example.org');
  // Server advertises the allowed TTLs back to the dashboard.
  assert.deepEqual(r.body.ttl_options.sort((a, b) => a - b), [4, 12, 24, 48, 72]);
});

test('api > DELETE /api/conflicts/:code/assignment unassigns', async t => {
  const { port, secrets, db } = await makeServer(t);
  const open = seedConflict(db, secrets);
  conflictsMod.assign(db, { codes: [open[0].code], assignee: 'mary@example.org', ttlHours: 24 });
  const r = await req(port, {
    method: 'DELETE', path: `/api/conflicts/${open[0].code}/assignment`,
    headers: { authorization: `Bearer ${secrets.master}` },
  });
  assert.equal(r.status, 204);
  const c = conflictsMod.get(db, open[0].code);
  assert.equal(c.assigned_to, null);
});

test('migration > 0003 is idempotent on a fresh schema', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  // Fresh init already includes the columns from schema.sql; running the
  // migration a second time must be a no-op (no thrown duplicate-column).
  const mod = require('../server/db/migrations/0003_conflicts_assignee');
  mod.up(db);
  mod.up(db);
  const cols = db.prepare(`PRAGMA table_info(conflicts)`).all().map(r => r.name);
  for (const c of ['assigned_to', 'assigned_at', 'assignment_expires_at']) {
    assert.ok(cols.includes(c), `column ${c} present`);
  }
});
