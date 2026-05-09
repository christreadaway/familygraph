'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
const eim = require('../server/identity/eim');
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

test('eim > completed_on auto-fills expires_on at the default 3-year cycle', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const create = await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'Mary', family_name: 'Volunteer', eim_status: 'certified', eim_completed_on: '2025-03-15' },
  });
  assert.equal(create.status, 201);
  const got = await req(port, { path: `/api/people/${create.body.code}`, headers: auth });
  assert.equal(got.body.person.eim_status, 'certified');
  assert.equal(got.body.person.eim_completed_on, '2025-03-15');
  assert.equal(got.body.person.eim_expires_on, '2028-03-15');
});

test('eim > renewal_years setting overrides the default', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  await req(port, {
    method: 'PUT', path: '/api/settings/eim.renewal_years', headers: auth, body: { value: 5 },
  });
  const create = await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'John', family_name: 'Cantor', eim_completed_on: '2024-06-01' },
  });
  const got = await req(port, { path: `/api/people/${create.body.code}`, headers: auth });
  assert.equal(got.body.person.eim_expires_on, '2029-06-01');
});

test('eim > explicit expires_on wins over auto-derivation', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const create = await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'Anna', family_name: 'Lector', eim_completed_on: '2025-01-01', eim_expires_on: '2026-12-31' },
  });
  const got = await req(port, { path: `/api/people/${create.body.code}`, headers: auth });
  assert.equal(got.body.person.eim_expires_on, '2026-12-31');
});

test('eim > recompute flips certified rows whose expiration passed', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const create = await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'Pete', family_name: 'Past', eim_status: 'certified', eim_completed_on: '2020-01-01', eim_expires_on: '2021-01-01' },
  });
  const changed = eim.recomputeStatus(db);
  assert.ok(changed >= 1);
  const got = await req(port, { path: `/api/people/${create.body.code}`, headers: auth });
  assert.equal(got.body.person.eim_status, 'expired');
});

test('eim > expiring endpoint surfaces certs lapsing inside the window', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  // Force a known "today" by inserting a row that expires 7 days from now via
  // SQLite arithmetic so the test isn't sensitive to clock drift.
  const code = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'Soon', family_name: 'Lapses' },
  })).body.code;
  db.prepare(
    `UPDATE persons SET eim_status = 'certified',
       eim_completed_on = strftime('%Y-%m-%d','now','-3 years','+7 days'),
       eim_expires_on   = strftime('%Y-%m-%d','now','+7 days')
     WHERE code = ?`
  ).run(code);
  const r = await req(port, { path: '/api/ministries/eim/expiring?window_days=14', headers: auth });
  assert.equal(r.status, 200);
  assert.equal(r.body.window_days, 14);
  assert.ok(r.body.items.find(it => it.code === code), 'expected lapsing person to surface');
});

test('eim > invalid status is rejected', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const r = await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'Bad', family_name: 'Status', eim_status: 'platinum' },
  });
  assert.equal(r.status, 500);
});

test('ministries > create + list catalog', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const c1 = await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth,
    body: { name: 'Lectors', description: 'Reads scripture at Mass', requires_eim: true },
  });
  assert.equal(c1.status, 201);
  const list = await req(port, { path: '/api/ministries', headers: auth });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].name, 'Lectors');
  assert.equal(list.body.items[0].requires_eim, true);
});

test('ministries > assign person and list by-person', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const m = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth,
    body: { name: 'Ushers' },
  })).body.code;
  const p = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'Tom', family_name: 'Usher' },
  })).body.code;
  const a = await req(port, {
    method: 'POST', path: `/api/ministries/${m}/assignments`, headers: auth,
    body: { person_code: p, role: 'coordinator' },
  });
  assert.equal(a.status, 201);
  const list = await req(port, { path: `/api/ministries/by-person/${p}`, headers: auth });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].role, 'coordinator');
  assert.equal(list.body.items[0].ministry_code, m);
});

test('ministries > assign family and list by-family', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const m = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth,
    body: { name: 'Coffee and Donuts' },
  })).body.code;
  const f = (await req(port, {
    method: 'POST', path: '/api/families', headers: auth, body: { display_name: 'Volunteers' },
  })).body.code;
  await req(port, {
    method: 'POST', path: `/api/ministries/${m}/assignments`, headers: auth,
    body: { family_code: f },
  });
  const list = await req(port, { path: `/api/ministries/by-family/${f}`, headers: auth });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].family_code, f);
});

test('ministries > rejects when both person_code and family_code are set', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const m = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'X' },
  })).body.code;
  const p = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth, body: { given_name: 'A', family_name: 'B' },
  })).body.code;
  const f = (await req(port, {
    method: 'POST', path: '/api/families', headers: auth, body: {},
  })).body.code;
  const r = await req(port, {
    method: 'POST', path: `/api/ministries/${m}/assignments`, headers: auth,
    body: { person_code: p, family_code: f },
  });
  assert.equal(r.status, 400);
});

test('ministries > duplicate active assignment is idempotent', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const m = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'Cantors' },
  })).body.code;
  const p = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth, body: { given_name: 'Cantor', family_name: 'One' },
  })).body.code;
  const a1 = await req(port, {
    method: 'POST', path: `/api/ministries/${m}/assignments`, headers: auth, body: { person_code: p },
  });
  const a2 = await req(port, {
    method: 'POST', path: `/api/ministries/${m}/assignments`, headers: auth,
    body: { person_code: p, role: 'lead' },
  });
  assert.equal(a1.body.code, a2.body.code, 'second assign should reuse the active row');
  const list = await req(port, { path: `/api/ministries/by-person/${p}`, headers: auth });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].role, 'lead');
});

test('ministries > end an assignment', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const m = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'Greeters' },
  })).body.code;
  const p = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth, body: { given_name: 'Pat', family_name: 'Greeter' },
  })).body.code;
  const a = (await req(port, {
    method: 'POST', path: `/api/ministries/${m}/assignments`, headers: auth, body: { person_code: p },
  })).body.code;
  const del = await req(port, {
    method: 'DELETE', path: `/api/ministries/assignments/${a}`, headers: auth, body: { reason: 'moved away' },
  });
  assert.equal(del.status, 204);
  const list = await req(port, { path: `/api/ministries/by-person/${p}`, headers: auth });
  assert.equal(list.body.items.length, 0);
  const ended = await req(port, { path: `/api/ministries/by-person/${p}?status=ended`, headers: auth });
  assert.equal(ended.body.items.length, 1);
});

test('ministries > person merge carries assignments to the winner', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const m = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'Sacristans' },
  })).body.code;
  const loser = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth, body: { given_name: 'Dup', family_name: 'A' },
  })).body.code;
  const winner = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth, body: { given_name: 'Dup', family_name: 'B' },
  })).body.code;
  await req(port, {
    method: 'POST', path: `/api/ministries/${m}/assignments`, headers: auth,
    body: { person_code: loser, role: 'lead' },
  });
  await req(port, {
    method: 'POST', path: `/api/people/${loser}/merge`, headers: auth, body: { winner_code: winner },
  });
  const list = await req(port, { path: `/api/ministries/by-person/${winner}`, headers: auth });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].ministry_code, m);
});

test('ministries > archive removes from active listing', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const code = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'Choir' },
  })).body.code;
  await req(port, { method: 'DELETE', path: `/api/ministries/${code}`, headers: auth });
  const active = await req(port, { path: '/api/ministries', headers: auth });
  assert.equal(active.body.items.length, 0);
  const all = await req(port, { path: '/api/ministries?status=all', headers: auth });
  assert.equal(all.body.items.length, 1);
  assert.equal(all.body.items[0].status, 'archived');
});
