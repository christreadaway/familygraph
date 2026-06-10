'use strict';

// Staff accounts with domain-verified login (STAFF_ACCOUNTS_PRD.md).
// Claims under test:
//   1. The trust chain: domain verification gates invitations, and a
//      broken chain (re-set domain, archived org) stops logins.
//   2. Magic links are single-use, expiring, and never reveal whether
//      an account exists.
//   3. Sessions ride the standard scope system, attribute writes to
//      the named staff member, and die immediately on disable/logout.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildApp } = require('../server');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');
const domains = require('../server/auth/domains');

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

const STAFF_EMAIL = 'staff@parish-domain.example';

// Stand up a parish with a verified domain and return the org code.
async function verifiedParish(port, db, auth) {
  const org = (await req(port, {
    method: 'POST', path: '/api/organizations', headers: auth,
    body: { name: '[Parish Name]', kind: 'parish' },
  })).body.code;
  const set = await req(port, {
    method: 'POST', path: `/api/organizations/${org}/domain`, headers: auth,
    body: { domain: 'parish-domain.example' },
  });
  assert.equal(set.status, 200);
  const token = set.body.verification_token;
  const v = await domains.verifyDomain(db, org, {
    method: 'dns',
    resolveTxt: async () => [['familygraph-verify=' + token]],
  });
  assert.equal(v.verified, true);
  return org;
}

// Invite an account and pull its magic link out of the notifications
// queue (the log transport never sends, so the row is inspectable).
async function loginAs(port, db, auth, { scopes = ['pii.read', 'pii.write'], email = STAFF_EMAIL, name = 'Parish Secretary' } = {}) {
  const acct = (await req(port, {
    method: 'POST', path: '/api/accounts', headers: auth,
    body: { email, display_name: name, scopes },
  })).body.code;
  await req(port, { method: 'POST', path: '/api/auth/request-link', body: { email } });
  const note = db.prepare(
    `SELECT * FROM notifications WHERE kind = 'magic_link' ORDER BY created_at DESC LIMIT 1`
  ).get();
  const raw = /ml_[A-Za-z0-9_-]+/.exec(note.body_text)[0];
  const redeemed = await req(port, { method: 'POST', path: '/api/auth/redeem', body: { token: raw } });
  assert.equal(redeemed.status, 200);
  return { acct, session: redeemed.body.token, raw };
}

// ---------------------------------------------------------------------------
// Domain verification
// ---------------------------------------------------------------------------

test('domains > set, verify via dns, and re-set requires re-verification', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const org = await verifiedParish(port, db, auth);

  let row = db.prepare(`SELECT * FROM organizations WHERE code = ?`).get(org);
  assert.ok(row.domain_verified_at);
  assert.equal(row.domain_verification_method, 'dns');

  // Wrong token in DNS → verified: false, nothing changes.
  const bad = await domains.verifyDomain(db, org, {
    method: 'dns', resolveTxt: async () => [['familygraph-verify=not-the-token']],
  });
  assert.equal(bad.verified, false);

  // Changing the domain clears verification.
  const reset = await req(port, {
    method: 'POST', path: `/api/organizations/${org}/domain`, headers: auth,
    body: { domain: 'other-domain.example' },
  });
  assert.equal(reset.status, 200);
  row = db.prepare(`SELECT * FROM organizations WHERE code = ?`).get(org);
  assert.equal(row.domain_verified_at, null);
});

test('domains > management requires the master token', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const org = await verifiedParish(port, db, auth);
  const { session } = await loginAs(port, db, auth);
  const denied = await req(port, {
    method: 'POST', path: `/api/organizations/${org}/domain`,
    headers: { authorization: `Bearer ${session}` },
    body: { domain: 'hijack.example' },
  });
  assert.equal(denied.status, 403);
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

test('accounts > invite requires a verified domain and grantable scopes', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };

  // No org / no verified domain yet.
  const early = await req(port, {
    method: 'POST', path: '/api/accounts', headers: auth,
    body: { email: STAFF_EMAIL, display_name: 'Early Bird' },
  });
  assert.equal(early.status, 400);
  assert.match(early.body.error, /verified organization domain/);

  await verifiedParish(port, db, auth);

  // Wrong domain still refused.
  const wrongDomain = await req(port, {
    method: 'POST', path: '/api/accounts', headers: auth,
    body: { email: 'someone@unrelated.example', display_name: 'Stranger' },
  });
  assert.equal(wrongDomain.status, 400);

  // '*' is not grantable to staff.
  const greedy = await req(port, {
    method: 'POST', path: '/api/accounts', headers: auth,
    body: { email: STAFF_EMAIL, display_name: 'Greedy', scopes: ['*'] },
  });
  assert.equal(greedy.status, 400);

  const ok = await req(port, {
    method: 'POST', path: '/api/accounts', headers: auth,
    body: { email: STAFF_EMAIL, display_name: 'Parish Secretary' },
  });
  assert.equal(ok.status, 201);
  assert.match(ok.body.code, /^acct_[0-9a-f]{16}$/);

  // Invite leaves an entity_changes snapshot (any change → audit trail).
  const chg = db.prepare(
    `SELECT * FROM entity_changes WHERE entity_kind = 'admin_account' AND operation = 'create'`
  ).all();
  assert.equal(chg.length, 1);
});

test('accounts > management surface is master-only', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  await verifiedParish(port, db, auth);
  const { session } = await loginAs(port, db, auth);
  const denied = await req(port, {
    path: '/api/accounts', headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(denied.status, 403, 'staff session lacks * scope');
});

// ---------------------------------------------------------------------------
// Magic-link login
// ---------------------------------------------------------------------------

test('login > unknown email gets ok:true and no email is sent', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  await verifiedParish(port, db, auth);
  const res = await req(port, {
    method: 'POST', path: '/api/auth/request-link', body: { email: 'nobody@parish-domain.example' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  const n = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'magic_link'`).get().n;
  assert.equal(n, 0);
});

test('login > magic link is single-use and expires', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  await verifiedParish(port, db, auth);
  const { raw, session } = await loginAs(port, db, auth);
  assert.match(session, /^st_/);

  // Second redeem of the same link fails.
  const again = await req(port, { method: 'POST', path: '/api/auth/redeem', body: { token: raw } });
  assert.equal(again.status, 401);

  // An expired link fails even if unused.
  await req(port, { method: 'POST', path: '/api/auth/request-link', body: { email: STAFF_EMAIL } });
  const note = db.prepare(`SELECT * FROM notifications WHERE kind = 'magic_link' ORDER BY created_at DESC LIMIT 1`).get();
  const raw2 = /ml_[A-Za-z0-9_-]+/.exec(note.body_text)[0];
  db.prepare(`UPDATE admin_login_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE used_at IS NULL`).run();
  const expired = await req(port, { method: 'POST', path: '/api/auth/redeem', body: { token: raw2 } });
  assert.equal(expired.status, 401);
});

test('login > re-set (unverified) domain stops link issuance', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  const org = await verifiedParish(port, db, auth);
  await req(port, {
    method: 'POST', path: '/api/accounts', headers: auth,
    body: { email: STAFF_EMAIL, display_name: 'Parish Secretary' },
  });
  // Domain changed → verification cleared → trust chain broken.
  await req(port, {
    method: 'POST', path: `/api/organizations/${org}/domain`, headers: auth,
    body: { domain: 'parish-domain.example' },
  });
  const res = await req(port, { method: 'POST', path: '/api/auth/request-link', body: { email: STAFF_EMAIL } });
  assert.deepEqual(res.body, { ok: true }, 'response shape never changes');
  const n = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'magic_link'`).get().n;
  assert.equal(n, 0, 'no link issued while the domain is unverified');
});

// ---------------------------------------------------------------------------
// Sessions: scopes, attribution, revocation
// ---------------------------------------------------------------------------

test('sessions > staff write is scope-checked and attributed by name', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  await verifiedParish(port, db, auth);

  // Read-only account can read but not write.
  const reader = await loginAs(port, db, auth, {
    scopes: ['pii.read'], email: 'reader@parish-domain.example', name: 'Read Only',
  });
  const readerAuth = { authorization: `Bearer ${reader.session}` };
  assert.equal((await req(port, { path: '/api/people', headers: readerAuth })).status, 200);
  const deniedWrite = await req(port, {
    method: 'POST', path: '/api/people', headers: readerAuth,
    body: { given_name: 'Nope', family_name: 'Nope' },
  });
  assert.equal(deniedWrite.status, 403);
  assert.equal(deniedWrite.body.reason, 'missing_scope');

  // Read+write account writes, and the change is attributed to them.
  const writer = await loginAs(port, db, auth);
  const writerAuth = { authorization: `Bearer ${writer.session}` };
  const created = await req(port, {
    method: 'POST', path: '/api/people', headers: writerAuth,
    body: { given_name: 'Kid', family_name: 'Example' },
  });
  assert.equal(created.status, 201);
  const chg = db.prepare(
    `SELECT actor, actor_kind FROM entity_changes
      WHERE entity_kind = 'person' AND entity_code = ? AND operation = 'create'`
  ).get(created.body.code);
  assert.equal(chg.actor, 'Parish Secretary');
  assert.equal(chg.actor_kind, 'staff');
});

test('sessions > me, logout, and disable all behave', async t => {
  const { port, secrets, db } = await makeServer(t);
  const auth = { authorization: `Bearer ${secrets.master}` };
  await verifiedParish(port, db, auth);
  const { acct, session } = await loginAs(port, db, auth);
  const sessAuth = { authorization: `Bearer ${session}` };

  const me = await req(port, { path: '/api/auth/me', headers: sessAuth });
  assert.equal(me.status, 200);
  assert.equal(me.body.account.display_name, 'Parish Secretary');

  // Disable → session dead on the next request.
  await req(port, { method: 'DELETE', path: `/api/accounts/${acct}`, headers: auth });
  const dead = await req(port, { path: '/api/people', headers: sessAuth });
  assert.equal(dead.status, 401);
  assert.equal(dead.body.reason, 'unknown_or_expired_session');

  // Fresh account: logout revokes.
  const second = await loginAs(port, db, auth, {
    email: 'second@parish-domain.example', name: 'Second Staffer',
  });
  const secondAuth = { authorization: `Bearer ${second.session}` };
  await req(port, { method: 'POST', path: '/api/auth/logout', headers: secondAuth });
  const after = await req(port, { path: '/api/people', headers: secondAuth });
  assert.equal(after.status, 401);
});
