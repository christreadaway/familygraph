'use strict';

// Organizations (parish / school) + dated affiliations + the rolling
// verification trail. The core model claims under test:
//   1. "Parish, school, or both" is computed from active affiliations,
//      never stored — ending one affiliation doesn't disturb the other.
//   2. Verification refreshes confidence (last_verified_at) and appends
//      to an immutable trail; staleness is a report, not an auto-expiry.
//   3. Merges re-point affiliations onto the winner without stacking
//      duplicate active rows.

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

async function seed(port, auth) {
  const family = (await req(port, {
    method: 'POST', path: '/api/families', headers: auth,
    body: { display_name: 'Placeholder Family' },
  })).body.code;
  const person = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'Kid', family_name: 'Placeholder', kind: 'child' },
  })).body.code;
  const parish = (await req(port, {
    method: 'POST', path: '/api/organizations', headers: auth,
    body: { name: '[Parish Name]', kind: 'parish' },
  })).body.code;
  const school = (await req(port, {
    method: 'POST', path: '/api/organizations', headers: auth,
    body: { name: '[School Name]', kind: 'school' },
  })).body.code;
  return { family, person, parish, school };
}

// ---------------------------------------------------------------------------
// Organization catalog
// ---------------------------------------------------------------------------

test('organizations > create / list / get / archive lifecycle', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };

  const created = await req(port, {
    method: 'POST', path: '/api/organizations', headers: auth,
    body: { name: '[Parish Name]', kind: 'parish' },
  });
  assert.equal(created.status, 201);
  assert.match(created.body.code, /^org_[0-9a-f]{16}$/);

  const list = await req(port, { path: '/api/organizations?kind=parish', headers: auth });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].kind, 'parish');

  const archived = await req(port, {
    method: 'DELETE', path: `/api/organizations/${created.body.code}`, headers: auth,
  });
  assert.equal(archived.status, 204);
  const after = await req(port, { path: '/api/organizations', headers: auth });
  assert.equal(after.body.items.length, 0);
  const all = await req(port, { path: '/api/organizations?status=all', headers: auth });
  assert.equal(all.body.items.length, 1);
});

test('organizations > rejects bad kind and duplicate active name', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const bad = await req(port, {
    method: 'POST', path: '/api/organizations', headers: auth,
    body: { name: '[Parish Name]', kind: 'club' },
  });
  assert.equal(bad.status, 400);

  await req(port, {
    method: 'POST', path: '/api/organizations', headers: auth,
    body: { name: '[Parish Name]', kind: 'parish' },
  });
  const dupe = await req(port, {
    method: 'POST', path: '/api/organizations', headers: auth,
    body: { name: '[Parish Name]', kind: 'parish' },
  });
  assert.equal(dupe.status, 400);
});

// ---------------------------------------------------------------------------
// Affiliations: temporal membership
// ---------------------------------------------------------------------------

test('affiliations > parish is family-level, school is person-level, both computed not stored', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const { family, person, parish, school } = await seed(port, auth);

  // Family registers at the parish; default role for a family at a
  // parish is 'registered'.
  const reg = await req(port, {
    method: 'POST', path: `/api/organizations/${parish}/affiliations`, headers: auth,
    body: { family_code: family },
  });
  assert.equal(reg.status, 201);

  // Child enrolls at the school.
  const enroll = await req(port, {
    method: 'POST', path: `/api/organizations/${school}/affiliations`, headers: auth,
    body: { person_code: person, role: 'student' },
  });
  assert.equal(enroll.status, 201);

  const parishView = await req(port, { path: `/api/organizations/${parish}`, headers: auth });
  assert.equal(parishView.body.affiliations.length, 1);
  assert.equal(parishView.body.affiliations[0].role, 'registered');
  assert.equal(parishView.body.affiliations[0].family_code, family);

  // Graduation: end the school affiliation. The parish registration is
  // untouched — that's the whole point of computed-not-stored.
  const ended = await req(port, {
    method: 'DELETE', path: `/api/organizations/affiliations/${enroll.body.code}`, headers: auth,
    body: { reason: 'graduated' },
  });
  assert.equal(ended.status, 204);

  const byPerson = await req(port, { path: `/api/organizations/by-person/${person}`, headers: auth });
  assert.equal(byPerson.body.items.length, 0, 'no active school affiliation after graduation');
  const byPersonEnded = await req(port, { path: `/api/organizations/by-person/${person}?status=ended`, headers: auth });
  assert.equal(byPersonEnded.body.items.length, 1);
  assert.equal(byPersonEnded.body.items[0].reason, 'graduated');

  const byFamily = await req(port, { path: `/api/organizations/by-family/${family}`, headers: auth });
  assert.equal(byFamily.body.items.length, 1, 'parish registration survives the graduation');
});

test('affiliations > exactly one of person/family; student must be a person', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const { family, person, school } = await seed(port, auth);

  const both = await req(port, {
    method: 'POST', path: `/api/organizations/${school}/affiliations`, headers: auth,
    body: { person_code: person, family_code: family },
  });
  assert.equal(both.status, 400);

  const neither = await req(port, {
    method: 'POST', path: `/api/organizations/${school}/affiliations`, headers: auth,
    body: {},
  });
  assert.equal(neither.status, 400);

  const familyStudent = await req(port, {
    method: 'POST', path: `/api/organizations/${school}/affiliations`, headers: auth,
    body: { family_code: family, role: 'student' },
  });
  assert.equal(familyStudent.status, 400);
  assert.match(familyStudent.body.error, /requires a person_code/);
});

test('affiliations > re-affiliating while active updates in place instead of stacking', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const { person, school } = await seed(port, auth);

  const first = await req(port, {
    method: 'POST', path: `/api/organizations/${school}/affiliations`, headers: auth,
    body: { person_code: person, role: 'student' },
  });
  const second = await req(port, {
    method: 'POST', path: `/api/organizations/${school}/affiliations`, headers: auth,
    body: { person_code: person, role: 'staff' },
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.code, first.body.code, 'same affiliation row, role updated');

  const view = await req(port, { path: `/api/organizations/${school}`, headers: auth });
  assert.equal(view.body.affiliations.length, 1);
  assert.equal(view.body.affiliations[0].role, 'staff');
});

test('affiliations > leaving and returning produces a second dated row', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const { family, parish } = await seed(port, auth);

  const first = await req(port, {
    method: 'POST', path: `/api/organizations/${parish}/affiliations`, headers: auth,
    body: { family_code: family },
  });
  await req(port, {
    method: 'DELETE', path: `/api/organizations/affiliations/${first.body.code}`, headers: auth,
    body: { reason: 'moved' },
  });
  const second = await req(port, {
    method: 'POST', path: `/api/organizations/${parish}/affiliations`, headers: auth,
    body: { family_code: family },
  });
  assert.notEqual(second.body.code, first.body.code, 'return is a new affiliation, history preserved');

  const all = await req(port, { path: `/api/organizations/by-family/${family}?status=all`, headers: auth });
  assert.equal(all.body.items.length, 2);
});

// ---------------------------------------------------------------------------
// Rolling verification
// ---------------------------------------------------------------------------

test('verification > each observed activity appends to the trail and bumps last_verified_at', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const { family, parish } = await seed(port, auth);
  const aff = (await req(port, {
    method: 'POST', path: `/api/organizations/${parish}/affiliations`, headers: auth,
    body: { family_code: family },
  })).body.code;

  for (const method of ['giving', 'liturgy', 'communication']) {
    const v = await req(port, {
      method: 'POST', path: `/api/organizations/affiliations/${aff}/verify`, headers: auth,
      body: { method, source: 'test' },
    });
    assert.equal(v.status, 201, `${method} should verify`);
  }

  const trail = await req(port, { path: `/api/organizations/affiliations/${aff}/verifications`, headers: auth });
  assert.equal(trail.body.items.length, 3);

  const view = await req(port, { path: `/api/organizations/by-family/${family}`, headers: auth });
  assert.ok(view.body.items[0].last_verified_at, 'last_verified_at set');

  const badMethod = await req(port, {
    method: 'POST', path: `/api/organizations/affiliations/${aff}/verify`, headers: auth,
    body: { method: 'vibes' },
  });
  assert.equal(badMethod.status, 400);
});

test('verification > backdated activity never moves last_verified_at backwards', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const { family, parish } = await seed(port, auth);
  const aff = (await req(port, {
    method: 'POST', path: `/api/organizations/${parish}/affiliations`, headers: auth,
    body: { family_code: family },
  })).body.code;

  await req(port, {
    method: 'POST', path: `/api/organizations/affiliations/${aff}/verify`, headers: auth,
    body: { method: 'giving' },
  });
  const fresh = db.prepare('SELECT last_verified_at FROM affiliations WHERE code = ?').get(aff).last_verified_at;

  // A late-imported giving batch from last year.
  await req(port, {
    method: 'POST', path: `/api/organizations/affiliations/${aff}/verify`, headers: auth,
    body: { method: 'giving', verified_at: '2025-01-01T00:00:00.000Z' },
  });
  const after = db.prepare('SELECT last_verified_at FROM affiliations WHERE code = ?').get(aff).last_verified_at;
  assert.equal(after, fresh, 'older verification recorded in trail but high-water mark unchanged');

  const trail = await req(port, { path: `/api/organizations/affiliations/${aff}/verifications`, headers: auth });
  assert.equal(trail.body.items.length, 2);
});

test('verification > stale report surfaces quiet affiliations, never auto-expires them', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const { family, person, parish } = await seed(port, auth);

  const quiet = (await req(port, {
    method: 'POST', path: `/api/organizations/${parish}/affiliations`, headers: auth,
    body: { family_code: family },
  })).body.code;
  const active = (await req(port, {
    method: 'POST', path: `/api/organizations/${parish}/affiliations`, headers: auth,
    body: { person_code: person, role: 'parishioner' },
  })).body.code;

  // The quiet family last showed activity two years ago.
  db.prepare(`UPDATE affiliations SET last_verified_at = '2024-06-01T00:00:00.000Z', started_at = '2023-06-01T00:00:00.000Z' WHERE code = ?`).run(quiet);
  // The active person verified just now.
  await req(port, {
    method: 'POST', path: `/api/organizations/affiliations/${active}/verify`, headers: auth,
    body: { method: 'ministry' },
  });

  const stale = await req(port, { path: `/api/organizations/${parish}/stale?days=365`, headers: auth });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.items.length, 1);
  assert.equal(stale.body.items[0].code, quiet);
  assert.equal(stale.body.items[0].ended_at, null, 'stale is still ACTIVE — staleness is a signal, not an expiry');

  // Brand-new affiliations fall back to started_at and are not instantly stale.
  const both = await req(port, { path: `/api/organizations/${parish}`, headers: auth });
  assert.equal(both.body.affiliations.length, 2, 'both affiliations remain active');
});

// ---------------------------------------------------------------------------
// Alumni transitions, departure classes, participation years
// ---------------------------------------------------------------------------

test('alumni > graduation transitions student to alumni, history intact', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const { person, school } = await seed(port, auth);
  const student = (await req(port, {
    method: 'POST', path: `/api/organizations/${school}/affiliations`, headers: auth,
    body: { person_code: person, role: 'student' },
  })).body.code;

  const grad = await req(port, {
    method: 'POST', path: `/api/organizations/affiliations/${student}/transition`, headers: auth,
    body: { ended_at: '2026-05-29', reason_detail: 'class of 2026' },
  });
  assert.equal(grad.status, 201);
  assert.notEqual(grad.body.code, student);

  const all = await req(port, { path: `/api/organizations/by-person/${person}?status=all`, headers: auth });
  const ended = all.body.items.find(a => a.code === student);
  const alum = all.body.items.find(a => a.code === grad.body.code);
  assert.equal(ended.ended_at, '2026-05-29', 'approximate operator-supplied date honoured');
  assert.equal(ended.reason, 'graduated', 'alumni transition defaults to graduated');
  assert.equal(ended.reason_detail, 'class of 2026');
  assert.equal(alum.role, 'alumni');
  assert.equal(alum.ended_at, null, 'alumni affiliation is ongoing');
  assert.equal(alum.started_at, '2026-05-29', 'alumni begins where student ended');

  // The kid is still in the community: active affiliations include alumni.
  const active = await req(port, { path: `/api/organizations/by-person/${person}`, headers: auth });
  assert.equal(active.body.items.length, 1);
  assert.equal(active.body.items[0].role, 'alumni');

  // Already-ended affiliations can't transition again.
  const again = await req(port, {
    method: 'POST', path: `/api/organizations/affiliations/${student}/transition`, headers: auth,
    body: {},
  });
  assert.equal(again.status, 400);
});

test('alumni > transfer to another school is alumni too, classed as transferred', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const { person, school } = await seed(port, auth);
  const student = (await req(port, {
    method: 'POST', path: `/api/organizations/${school}/affiliations`, headers: auth,
    body: { person_code: person, role: 'student' },
  })).body.code;
  const moved = await req(port, {
    method: 'POST', path: `/api/organizations/affiliations/${student}/transition`, headers: auth,
    body: { reason: 'transferred', reason_detail: 'enrolled at [School Name 2]' },
  });
  assert.equal(moved.status, 201);
  const all = await req(port, { path: `/api/organizations/by-person/${person}?status=all`, headers: auth });
  assert.equal(all.body.items.find(a => a.code === student).reason, 'transferred');
  assert.equal(all.body.items.find(a => a.code === moved.body.code).role, 'alumni');
});

test('departure > reason must be a known class; detail carries the story', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const { family, parish } = await seed(port, auth);
  const aff = (await req(port, {
    method: 'POST', path: `/api/organizations/${parish}/affiliations`, headers: auth,
    body: { family_code: family },
  })).body.code;

  const vague = await req(port, {
    method: 'DELETE', path: `/api/organizations/affiliations/${aff}`, headers: auth,
    body: { reason: 'just because' },
  });
  assert.equal(vague.status, 400);
  assert.match(vague.body.error, /reason must be one of/);

  const ended = await req(port, {
    method: 'DELETE', path: `/api/organizations/affiliations/${aff}`, headers: auth,
    body: { reason: 'moved', reason_detail: 'relocated out of state', ended_at: '2025-08' },
  });
  assert.equal(ended.status, 204);
  const rows = await req(port, { path: `/api/organizations/by-family/${family}?status=ended`, headers: auth });
  assert.equal(rows.body.items[0].reason, 'moved');
  assert.equal(rows.body.items[0].reason_detail, 'relocated out of state');
  assert.equal(rows.body.items[0].ended_at, '2025-08', 'approximate month-level date accepted');
});

test('periods > verification rows carry year labels; distinct years listed for students and families', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const { family, person, parish, school } = await seed(port, auth);

  const student = (await req(port, {
    method: 'POST', path: `/api/organizations/${school}/affiliations`, headers: auth,
    body: { person_code: person, role: 'student' },
  })).body.code;
  for (const period of ['2024-2025', '2025-2026', '2025-2026']) {
    await req(port, {
      method: 'POST', path: `/api/organizations/affiliations/${student}/verify`, headers: auth,
      body: { method: 'connector_sync', source: 'school_sis', period },
    });
  }
  const studentTrail = await req(port, { path: `/api/organizations/affiliations/${student}/verifications`, headers: auth });
  assert.deepEqual(studentTrail.body.periods, ['2024-2025', '2025-2026'], 'distinct school years');

  const fam = (await req(port, {
    method: 'POST', path: `/api/organizations/${parish}/affiliations`, headers: auth,
    body: { family_code: family },
  })).body.code;
  for (const period of ['2025', '2026']) {
    await req(port, {
      method: 'POST', path: `/api/organizations/affiliations/${fam}/verify`, headers: auth,
      body: { method: 'giving', period },
    });
  }
  const famTrail = await req(port, { path: `/api/organizations/affiliations/${fam}/verifications`, headers: auth });
  assert.deepEqual(famTrail.body.periods, ['2025', '2026'], 'parish family years of participation');
  assert.equal(famTrail.body.items[0].period, '2026');
});

test('multi-community > alumni of one school, student at another; family moves parishes', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const { family, person, parish, school } = await seed(port, auth);
  const school2 = (await req(port, {
    method: 'POST', path: '/api/organizations', headers: auth,
    body: { name: '[School Name 2]', kind: 'school' },
  })).body.code;
  const parish2 = (await req(port, {
    method: 'POST', path: '/api/organizations', headers: auth,
    body: { name: '[Parish Name 2]', kind: 'parish' },
  })).body.code;

  // Kid attends School 1, transfers: alumni there, student at School 2.
  const enrollment = (await req(port, {
    method: 'POST', path: `/api/organizations/${school}/affiliations`, headers: auth,
    body: { person_code: person, role: 'student' },
  })).body.code;
  await req(port, {
    method: 'POST', path: `/api/organizations/affiliations/${enrollment}/transition`, headers: auth,
    body: { reason: 'transferred' },
  });
  await req(port, {
    method: 'POST', path: `/api/organizations/${school2}/affiliations`, headers: auth,
    body: { person_code: person, role: 'student' },
  });

  const kid = await req(port, { path: `/api/organizations/by-person/${person}`, headers: auth });
  assert.equal(kid.body.items.length, 2, 'one person, two simultaneous active affiliations');
  const byOrg = Object.fromEntries(kid.body.items.map(a => [a.org_code, a.role]));
  assert.equal(byOrg[school], 'alumni');
  assert.equal(byOrg[school2], 'student');

  // Family moves from Parish 1 to Parish 2; history survives at both.
  const reg1 = (await req(port, {
    method: 'POST', path: `/api/organizations/${parish}/affiliations`, headers: auth,
    body: { family_code: family },
  })).body.code;
  await req(port, {
    method: 'DELETE', path: `/api/organizations/affiliations/${reg1}`, headers: auth,
    body: { reason: 'moved', reason_detail: 'registered at [Parish Name 2]', ended_at: '2026-01' },
  });
  await req(port, {
    method: 'POST', path: `/api/organizations/${parish2}/affiliations`, headers: auth,
    body: { family_code: family },
  });

  const famActive = await req(port, { path: `/api/organizations/by-family/${family}`, headers: auth });
  assert.equal(famActive.body.items.length, 1);
  assert.equal(famActive.body.items[0].org_code, parish2, 'active registration at the new parish');
  const famAll = await req(port, { path: `/api/organizations/by-family/${family}?status=all`, headers: auth });
  assert.equal(famAll.body.items.length, 2, 'the old parish keeps its dated history row');
  const old = famAll.body.items.find(a => a.org_code === parish);
  assert.equal(old.reason, 'moved');
  assert.equal(old.ended_at, '2026-01');
});

// ---------------------------------------------------------------------------
// Merge integration
// ---------------------------------------------------------------------------

test('merge > person merge re-points school affiliation onto the winner', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const { school } = await seed(port, auth);

  const dupA = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'Twin', family_name: 'Dup' },
  })).body.code;
  const dupB = (await req(port, {
    method: 'POST', path: '/api/people', headers: auth,
    body: { given_name: 'Twin', family_name: 'Dup' },
  })).body.code;

  await req(port, {
    method: 'POST', path: `/api/organizations/${school}/affiliations`, headers: auth,
    body: { person_code: dupB, role: 'student' },
  });
  const merged = await req(port, {
    method: 'POST', path: `/api/people/${dupB}/merge`, headers: auth,
    body: { winner_code: dupA },
  });
  assert.equal(merged.status, 200);

  const byWinner = await req(port, { path: `/api/organizations/by-person/${dupA}`, headers: auth });
  assert.equal(byWinner.body.items.length, 1, 'affiliation followed the merge winner');
  assert.equal(byWinner.body.items[0].role, 'student');
});

test('merge > family merge with affiliations on both sides ends the duplicate', async t => {
  const { port, secrets } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const { parish } = await seed(port, auth);

  const famA = (await req(port, {
    method: 'POST', path: '/api/families', headers: auth, body: { display_name: 'Dup A' },
  })).body.code;
  const famB = (await req(port, {
    method: 'POST', path: '/api/families', headers: auth, body: { display_name: 'Dup B' },
  })).body.code;
  await req(port, {
    method: 'POST', path: `/api/organizations/${parish}/affiliations`, headers: auth,
    body: { family_code: famA },
  });
  await req(port, {
    method: 'POST', path: `/api/organizations/${parish}/affiliations`, headers: auth,
    body: { family_code: famB },
  });

  const merged = await req(port, {
    method: 'POST', path: `/api/families/${famB}/merge`, headers: auth,
    body: { winner_code: famA },
  });
  assert.equal(merged.status, 200);

  const active = await req(port, { path: `/api/organizations/by-family/${famA}`, headers: auth });
  assert.equal(active.body.items.length, 1, 'exactly one active registration survives the merge');
});

// ---------------------------------------------------------------------------
// Auth posture
// ---------------------------------------------------------------------------

test('organizations > surface requires a bearer token', async t => {
  const { port } = await makeServer(t);
  const noAuth = await req(port, { path: '/api/organizations' });
  assert.equal(noAuth.status, 401);
});

// ---------------------------------------------------------------------------
// Audit trail: any change must leave one
// ---------------------------------------------------------------------------

test('audit > every organization/affiliation write lands an entity_changes snapshot', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}`, 'x-family-graph-actor': 'test_admin' };
  const { family, parish } = await seed(port, auth);

  const aff = (await req(port, {
    method: 'POST', path: `/api/organizations/${parish}/affiliations`, headers: auth,
    body: { family_code: family },
  })).body.code;
  await req(port, {
    method: 'POST', path: `/api/organizations/affiliations/${aff}/verify`, headers: auth,
    body: { method: 'giving' },
  });
  await req(port, {
    method: 'DELETE', path: `/api/organizations/affiliations/${aff}`, headers: auth,
    body: { reason: 'moved' },
  });
  await req(port, { method: 'DELETE', path: `/api/organizations/${parish}`, headers: auth });

  const changes = db.prepare(
    `SELECT entity_kind, operation, actor, before_json, after_json FROM entity_changes
      WHERE entity_kind IN ('organization','affiliation','affiliation_verification')
      ORDER BY created_at`
  ).all();
  const shapes = changes.map(c => `${c.entity_kind}:${c.operation}`);
  for (const expected of [
    'organization:create',      // seed created the parish (and school)
    'affiliation:create',
    'affiliation_verification:create',
    'affiliation:archive',      // end = dated archive, row survives
    'organization:archive',
  ]) {
    assert.ok(shapes.includes(expected), `expected a ${expected} change row, got ${shapes.join(', ')}`);
  }
  for (const c of changes) {
    assert.equal(c.actor, 'test_admin', 'actor recorded on every change row');
    assert.ok(c.after_json, 'after snapshot present');
  }
  const ended = changes.find(c => c.entity_kind === 'affiliation' && c.operation === 'archive');
  assert.ok(ended.before_json, 'end records the before snapshot');
});
