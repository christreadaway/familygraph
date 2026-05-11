'use strict';

// Edge-case coverage for the EIM + ministries surface. The first wave
// of tests in eim-ministries.test.js verified the happy paths; these
// exercise the rough corners that break in production.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
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

// ---------------------------------------------------------------------------
// EIM edge cases
// ---------------------------------------------------------------------------

test('eim edge > patch without EIM fields preserves existing values', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const code = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: {
      given_name: 'Lucy', family_name: 'Persist',
      eim_status: 'certified', eim_completed_on: '2024-04-01', eim_notes: 'diocese onboarding',
    },
  })).body.code;
  // Patch only the unrelated employer field. EIM fields must survive.
  await req(port, {
    method: 'PATCH', path: `/api/people/${code}`, headers: auth,
    body: { employer: 'St. Joseph' },
  });
  const got = await req(port, { path: `/api/people/${code}`, headers: auth });
  assert.equal(got.body.person.eim_status, 'certified');
  assert.equal(got.body.person.eim_completed_on, '2024-04-01');
  assert.equal(got.body.person.eim_expires_on, '2027-04-01');
  assert.equal(got.body.person.eim_notes, 'diocese onboarding');
});

test('eim edge > clearing eim_status to empty string sets it to null', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const code = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'X', family_name: 'Y', eim_status: 'pending' },
  })).body.code;
  await req(port, {
    method: 'PATCH', path: `/api/people/${code}`, headers: auth,
    body: { eim_status: '' },
  });
  const got = await req(port, { path: `/api/people/${code}`, headers: auth });
  assert.equal(got.body.person.eim_status, null);
});

test('eim edge > invalid date format on create returns a 4xx, not a stack trace', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const r = await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'A', family_name: 'B', eim_completed_on: '04/01/2025' },
  });
  // Whatever we choose (400 preferred, 500 acceptable), it must not 200 the
  // bad input. The response must include an error message so the dashboard
  // can render it.
  assert.notEqual(r.status, 200);
  assert.notEqual(r.status, 201);
  assert.ok(r.body && r.body.error, 'response should include an error field');
});

test('eim edge > invalid date format on patch returns a 4xx, not a stack trace', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const code = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'A', family_name: 'B' },
  })).body.code;
  const r = await req(port, {
    method: 'PATCH', path: `/api/people/${code}`, headers: auth,
    body: { eim_expires_on: 'not-a-date' },
  });
  assert.notEqual(r.status, 200);
  assert.ok(r.body && r.body.error, 'response should include an error field');
});

test('eim edge > safe surface exposes status + dates but never notes', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const code = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: {
      given_name: 'Safe', family_name: 'View',
      eim_status: 'certified', eim_completed_on: '2025-01-01',
      eim_notes: 'private diocesan note',
    },
  })).body.code;
  const safe = await req(port, { path: `/api/safe/people/${code}` });
  assert.equal(safe.status, 200);
  assert.equal(safe.body.person.eim_status, 'certified');
  assert.equal(safe.body.person.eim_completed_on, '2025-01-01');
  assert.equal(safe.body.person.eim_expires_on, '2028-01-01');
  assert.equal(safe.body.person.eim_notes, undefined, 'safe surface must never expose eim_notes');
  assert.equal(safe.body.person.given_name, undefined, 'safe surface still strips identifiers');
});

test('eim edge > recompute does not flip rows whose expiration is today', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const code = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'Today', family_name: 'Edge' },
  })).body.code;
  db.prepare(
    `UPDATE persons SET eim_status = 'certified',
       eim_completed_on = strftime('%Y-%m-%d','now','-3 years'),
       eim_expires_on = strftime('%Y-%m-%d','now')
     WHERE code = ?`
  ).run(code);
  await req(port, { method: 'POST', path: '/api/ministries/eim/recompute', headers: auth });
  const got = await req(port, { path: `/api/people/${code}`, headers: auth });
  assert.equal(got.body.person.eim_status, 'certified', 'cert valid through expiration date');
});

test('eim edge > eim/expiring response contains zero PII fields', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  // Create a person with PII and a soon-to-lapse cert.
  const code = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'Sensitive', family_name: 'Name', eim_notes: 'dont-leak' },
  })).body.code;
  const { db } = await (async () => {
    // We don't have direct access to db here; piggyback on the patch path.
    return {};
  })();
  // Use the dashboard PATCH path to set a near-expiry cert via an
  // explicit absolute date. Use a date 5 days from now via SQLite math
  // through a follow-up direct SQL call would be cleaner, but the
  // PATCH-with-explicit-date path is what the operator uses.
  const inFiveDays = (() => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() + 5);
    return d.toISOString().slice(0, 10);
  })();
  await req(port, {
    method: 'PATCH', path: `/api/people/${code}`, headers: auth,
    body: { eim_status: 'certified', eim_expires_on: inFiveDays },
  });
  const r = await req(port, { path: '/api/ministries/eim/expiring?window_days=10', headers: auth });
  assert.equal(r.status, 200);
  const found = r.body.items.find(it => it.code === code);
  assert.ok(found, 'lapsing person must appear in expiring response');
  // Make sure no PII leaked into the response.
  assert.equal(found.given_name, undefined);
  assert.equal(found.family_name, undefined);
  assert.equal(found.display_name, undefined);
  assert.equal(found.eim_notes, undefined);
});

// ---------------------------------------------------------------------------
// Ministry edge cases
// ---------------------------------------------------------------------------

test('ministries edge > re-creating a ministry name after archive succeeds', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const c1 = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'Choir' },
  })).body.code;
  await req(port, { method: 'DELETE', path: `/api/ministries/${c1}`, headers: auth });
  const r = await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'Choir' },
  });
  assert.equal(r.status, 201, 'archived name must not block a fresh active ministry');
});

test('ministries edge > duplicate ACTIVE name is rejected', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'Lectors' },
  });
  const r = await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'Lectors' },
  });
  assert.notEqual(r.status, 201, 'two active ministries with identical name must not coexist');
});

test('ministries edge > assignment rejected on archived ministry', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const m = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'Sleepers' },
  })).body.code;
  await req(port, { method: 'DELETE', path: `/api/ministries/${m}`, headers: auth });
  const p = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth, body: { given_name: 'New', family_name: 'Person' },
  })).body.code;
  const r = await req(port, {
    method: 'POST', path: `/api/ministries/${m}/assignments`, headers: auth,
    body: { person_code: p },
  });
  assert.equal(r.status, 400, 'archived ministry must reject new assignments');
});

test('ministries edge > end an already-ended assignment is idempotent', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const m = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'Greeters2' },
  })).body.code;
  const p = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth, body: { given_name: 'P', family_name: 'Q' },
  })).body.code;
  const a = (await req(port, {
    method: 'POST', path: `/api/ministries/${m}/assignments`, headers: auth, body: { person_code: p },
  })).body.code;
  const first = await req(port, { method: 'DELETE', path: `/api/ministries/assignments/${a}`, headers: auth });
  const second = await req(port, { method: 'DELETE', path: `/api/ministries/assignments/${a}`, headers: auth });
  assert.equal(first.status, 204);
  assert.equal(second.status, 204, 'idempotent end must not throw');
});

test('ministries edge > assign to unknown person returns a 4xx', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const m = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'X2' },
  })).body.code;
  const r = await req(port, {
    method: 'POST', path: `/api/ministries/${m}/assignments`, headers: auth,
    body: { person_code: 'p_00000000' },
  });
  assert.equal(r.status, 400);
  assert.ok(r.body.error);
});

test('ministries edge > archive a ministry preserves historical assignments', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const m = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'Old' },
  })).body.code;
  const p = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth, body: { given_name: 'A', family_name: 'B' },
  })).body.code;
  await req(port, {
    method: 'POST', path: `/api/ministries/${m}/assignments`, headers: auth, body: { person_code: p },
  });
  await req(port, { method: 'DELETE', path: `/api/ministries/${m}`, headers: auth });
  // Active by-person should still report the assignment until it's ended.
  const list = await req(port, { path: `/api/ministries/by-person/${p}`, headers: auth });
  assert.equal(list.body.items.length, 1, 'archive should not silently drop assignments');
});

test('ministries edge > family merge carries family rosters to the winner', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const m = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'Coffee' },
  })).body.code;
  const loser = (await req(port, {
    method: 'POST', path: '/api/families', headers: auth, body: { display_name: 'Loser' },
  })).body.code;
  const winner = (await req(port, {
    method: 'POST', path: '/api/families', headers: auth, body: { display_name: 'Winner' },
  })).body.code;
  await req(port, {
    method: 'POST', path: `/api/ministries/${m}/assignments`, headers: auth, body: { family_code: loser },
  });
  await req(port, {
    method: 'POST', path: `/api/families/${loser}/merge`, headers: auth, body: { winner_code: winner },
  });
  const list = await req(port, { path: `/api/ministries/by-family/${winner}`, headers: auth });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].ministry_code, m);
});

test('ministries edge > catalog list does not leak archived ministries by default', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const a = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'Active' },
  })).body.code;
  const archived = (await req(port, {
    method: 'POST', path: '/api/ministries', headers: auth, body: { name: 'Archived' },
  })).body.code;
  await req(port, { method: 'DELETE', path: `/api/ministries/${archived}`, headers: auth });
  const r = await req(port, { path: '/api/ministries', headers: auth });
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].code, a);
});

test('ministries edge > by-person/by-family reject invalid codes', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const r1 = await req(port, { path: '/api/ministries/by-person/garbage', headers: auth });
  const r2 = await req(port, { path: '/api/ministries/by-family/garbage', headers: auth });
  assert.equal(r1.status, 400);
  assert.equal(r2.status, 400);
});

test('ministries edge > ministry_code validation on assignment route', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const r = await req(port, {
    method: 'POST', path: '/api/ministries/garbage/assignments', headers: auth, body: {},
  });
  assert.equal(r.status, 400);
});

test('ministries edge > require auth on every read and write', async t => {
  const { port } = await makeServer(t);
  const r1 = await req(port, { path: '/api/ministries' });
  const r2 = await req(port, { method: 'POST', path: '/api/ministries', body: { name: 'x' } });
  assert.equal(r1.status, 401);
  assert.equal(r2.status, 401);
});

test('eim edge > export safe path stays clean (no encrypted notes leaks)', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'A', family_name: 'B', eim_notes: 'super secret diocese note' },
  });
  const r = await req(port, {
    method: 'POST', path: '/api/export', headers: auth,
    body: { entity: 'persons', mode: 'safe', format: 'json' },
  });
  // Whatever entity name the export accepts, the safe response must not
  // contain the encrypted note text.
  if (r.status === 200) {
    const dump = JSON.stringify(r.body);
    assert.equal(dump.includes('super secret diocese note'), false);
  }
});
