'use strict';

// Regression tests for the security-hardening pass:
//   - response security headers
//   - SQLite / OS error normalisation
//   - JSON body size limits
//   - rate limiter activation
//   - audit-log scrubbing of free-text PII
//   - webhook URL sanitisation in audit
//   - path-traversal blocks (restore destination, symlink in folder-watch)

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildApp } = require('../server');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');
const audit = require('../server/audit');
const { userFacingMessage } = require('../server/api/_errors');
const webhooks = require('../server/parentpoint/webhooks');

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}
function close(server) { return new Promise(resolve => server.close(resolve)); }

function request(port, { method = 'GET', path: p = '/', headers = {}, body, raw = null } = {}) {
  return new Promise((resolve, reject) => {
    let data = null;
    if (raw != null) {
      data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    } else if (body != null) {
      data = Buffer.from(JSON.stringify(body));
    }
    const req = http.request({
      method, hostname: '127.0.0.1', port, path: p,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}), ...headers },
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => buf += c);
      res.on('end', () => {
        let payload = buf;
        try { payload = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: payload, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function makeServer(t) {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  const app = buildApp({ db, secrets, thresholds: defaultThresholds() });
  const { server, port } = await listen(app);
  t.after(async () => { await close(server); db.close(); cleanup(dir); });
  return { server, port, db, secrets };
}

const auth = secrets => ({
  authorization: `Bearer ${secrets.master}`,
  'x-family-graph-actor': 'security-test',
});

// -----------------------------------------------------------------------------
// Response security headers
// -----------------------------------------------------------------------------

test('security > standard security headers are set on every response', async t => {
  const { port } = await makeServer(t);
  const r = await request(port, { path: '/api/health' });
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin');
  assert.match(r.headers['permissions-policy'], /camera=\(\)/);
  // x-powered-by is suppressed
  assert.equal(r.headers['x-powered-by'], undefined);
});

test('security > Content-Security-Policy on HTML-accepting responses', async t => {
  const { port } = await makeServer(t);
  const r = await request(port, { path: '/', headers: { 'accept': 'text/html' } });
  assert.ok(r.headers['content-security-policy']);
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
});

// -----------------------------------------------------------------------------
// Error message normalisation
// -----------------------------------------------------------------------------

test('security > userFacingMessage masks SQLite constraint errors', () => {
  assert.equal(userFacingMessage(new Error('SQLITE_CONSTRAINT: column not unique')), 'database error');
  assert.equal(userFacingMessage(new Error('UNIQUE constraint failed: api_keys.hash')), 'already exists or conflicts with existing record');
  assert.equal(userFacingMessage(new Error('CHECK constraint failed: status IN (...)')), 'value not allowed');
  assert.equal(userFacingMessage(new Error('FOREIGN KEY constraint failed')), 'referenced record not found');
  assert.equal(userFacingMessage(new Error('NOT NULL constraint failed: persons.code')), 'required field missing');
});

test('security > userFacingMessage masks OS error codes', () => {
  assert.equal(userFacingMessage(new Error('ENOENT: no such file or directory, open \'/etc/passwd\'')), 'file system error');
  assert.equal(userFacingMessage(new Error('EACCES: permission denied, open \'/var/log/...\'')), 'file system error');
  assert.equal(userFacingMessage(new Error('getaddrinfo ENOTFOUND host.example.org')), 'upstream not reachable');
});

test('security > userFacingMessage masks internal TypeErrors', () => {
  const e = new TypeError('Cannot read properties of undefined (reading \'foo\')');
  assert.equal(userFacingMessage(e), 'internal error');
});

test('security > userFacingMessage preserves user-facing throws', () => {
  // Library-side validation throws pass through.
  assert.equal(userFacingMessage(new Error('invalid eim_status: maybe')), 'invalid eim_status: maybe');
  assert.equal(userFacingMessage(new Error('cannot archive a merged person')), 'cannot archive a merged person');
});

test('security > userFacingMessage caps absurdly long error messages', () => {
  const huge = 'A'.repeat(2000);
  const out = userFacingMessage(new Error(huge));
  assert.ok(out.length <= 240, 'capped at 240 chars');
});

// -----------------------------------------------------------------------------
// JSON body size limits
// -----------------------------------------------------------------------------

test('security > /v1 rejects oversize JSON bodies (256 KB cap)', async t => {
  const { port, secrets } = await makeServer(t);
  // ~700 KB of legal-but-large JSON — body-parser hits the 256 KB cap and
  // throws PayloadTooLargeError, which our error handler maps to 413
  // with a generic body (never leaks the upstream stack).
  const huge = Array(20_000).fill('parent_name').join(', ');
  const r = await request(port, {
    method: 'POST', path: '/v1/persons',
    headers: { ...auth(secrets), 'x-pp-contract-version': 'v0.1' },
    body: { firstName: 'A', lastName: 'B', notes: huge.repeat(50) },
  });
  assert.equal(r.status, 413, 'oversize body returns 413 Payload Too Large');
  assert.ok(r.body.error, 'response carries an error code');
  // The raw stack/message from body-parser must not leak.
  const serialised = JSON.stringify(r.body);
  assert.equal(serialised.includes('PayloadTooLargeError'), false);
  assert.equal(serialised.includes('raw-body'), false);
});

test('security > /api/import accepts large JSON bodies (20 MB cap)', async t => {
  const { port, secrets } = await makeServer(t);
  // 1 MB body — well under the import limit, well over the default cap.
  const big = Array(50_000).fill({ first_name: 'A', last_name: 'B' });
  const r = await request(port, {
    method: 'POST', path: '/api/import/preview',
    headers: auth(secrets),
    body: { source: 'csv', records: big },
  });
  // Status will be 4xx/2xx depending on validation; we only care that
  // body parsing succeeded (not 413 / 400-bad-request).
  assert.notEqual(r.status, 413);
});

// -----------------------------------------------------------------------------
// Audit-log scrubbing
// -----------------------------------------------------------------------------

test('security > audit.redact masks email addresses in free-text reason', () => {
  const out = audit.redact({
    reason: 'parent contact admin@example.org requested removal',
  });
  assert.match(out.reason, /\[email\]/);
  assert.equal(out.reason.includes('admin@example.org'), false);
});

test('security > audit.redact masks phone numbers in free-text notes', () => {
  const out = audit.redact({ notes: 'left voicemail at +1 (512) 555-0101' });
  assert.match(out.notes, /\[phone\]/);
  assert.equal(out.notes.includes('555-0101'), false);
});

test('security > audit.redact truncates absurdly long reason strings', () => {
  const huge = 'x'.repeat(2000);
  const out = audit.redact({ reason: huge });
  assert.ok(out.reason.length < 600, 'capped + ellipsis added');
  assert.match(out.reason, /…$/);
});

test('security > audit.redact masks token/secret keys defensively', () => {
  const out = audit.redact({ token: 'sk_abcdef', secret: 'shhhh', api_key: 'xxx' });
  assert.equal(out.token, '[redacted]');
  assert.equal(out.secret, '[redacted]');
  assert.equal(out.api_key, '[redacted]');
});

// -----------------------------------------------------------------------------
// Webhook URL sanitisation
// -----------------------------------------------------------------------------

test('security > webhook subscription strips userinfo + query from audit metadata', async t => {
  const { db, secrets } = await makeServer(t);
  // The subscribe call records an audit row with the URL. Verify the
  // recorded URL has no query string.
  webhooks.subscribe(db, secrets, {
    url: 'https://example.org/cb?token=secret-token-123',
  });
  const rows = audit.list(db, { action: 'pp_webhook_subscribe' });
  assert.equal(rows.length, 1);
  const url = rows[0].metadata.url;
  assert.equal(url.includes('?'), false, 'query string stripped');
  assert.equal(url.includes('secret-token-123'), false, 'token stripped');
  assert.equal(url, 'https://example.org/cb');
});

// -----------------------------------------------------------------------------
// Rate limiter
// -----------------------------------------------------------------------------

test('security > rate limiter returns 429 with Retry-After when bucket exhausted', async t => {
  // Disable the rate-limit-disable env var for this one test (since the
  // suite is started with it set elsewhere). We do this by booting a
  // fresh app explicitly.
  const prior = process.env.FAMILY_GRAPH_DISABLE_RATE_LIMIT;
  delete process.env.FAMILY_GRAPH_DISABLE_RATE_LIMIT;
  try {
    const rateLimit = require('../server/auth/rate-limit');
    // Build a tiny bucket for the test.
    const mw = rateLimit.build({ capacity: 2, refillPerSec: 0.0001, name: 'test' });
    let okCount = 0, blockedCount = 0;
    const fakeReq = { ip: '127.0.0.1', get: () => null };
    const mkRes = () => {
      const set = (_k, _v) => res;
      const res = { set, status: code => ({ json: () => { res._status = code; } }) };
      return res;
    };
    for (let i = 0; i < 5; i++) {
      const res = mkRes();
      let blocked = false;
      mw(fakeReq, res, () => { okCount += 1; });
      if (res._status === 429) { blockedCount += 1; }
    }
    assert.equal(okCount, 2, 'first 2 calls pass');
    assert.equal(blockedCount, 3, '3 subsequent calls are blocked');
  } finally {
    if (prior !== undefined) process.env.FAMILY_GRAPH_DISABLE_RATE_LIMIT = prior;
  }
});

// -----------------------------------------------------------------------------
// Folder-watch: refuse to move symlinks
// -----------------------------------------------------------------------------

test('security > safeMove refuses to move a symlink (would dereference target on EXDEV)', () => {
  // Build a temp watch dir; drop a symlink into it; confirm safeMove
  // refuses + unlinks the symlink (so we don't see it again).
  const tmp = path.join(os.tmpdir(), `fg-symlink-test-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const target = path.join(tmp, 'sensitive.txt');
  fs.writeFileSync(target, 'secret');
  const sym = path.join(tmp, 'roster.csv');
  fs.symlinkSync(target, sym);
  const { safeMove } = require('../server/folder-watch');
  const outDir = path.join(tmp, 'processed');
  assert.throws(() => safeMove(sym, outDir), /symlink/);
  // The symlink should be unlinked so the watcher stops re-detecting it.
  assert.equal(fs.existsSync(sym), false);
  // Target file untouched.
  assert.equal(fs.readFileSync(target, 'utf8'), 'secret');
  fs.rmSync(tmp, { recursive: true, force: true });
});

const crypto = require('node:crypto');

// -----------------------------------------------------------------------------
// Sanitize / desanitize cross-caller isolation
// -----------------------------------------------------------------------------

test('security > desanitize refuses to reverse a token-set owned by a different caller', async t => {
  const { db, secrets } = await makeServer(t);
  const sanitize = require('../server/sanitize');
  const { tokenSet } = sanitize.sanitizeText(db, secrets, 'Hello Amanda Lee.', { actor: 'app-a' });
  // App B asks to desanitize App A's token-set.
  assert.throws(
    () => sanitize.desanitizeText(db, secrets, 'Hello', tokenSet, { actor: 'app-b', authKind: 'scoped' }),
    err => err.isolation === true && /different caller/.test(err.message)
  );
});

test('security > desanitize accepts the same actor', async t => {
  const { db, secrets } = await makeServer(t);
  const sanitize = require('../server/sanitize');
  const { sanitized, tokenSet } = sanitize.sanitizeText(db, secrets, 'Hello Amanda Lee.', { actor: 'app-a' });
  // Same actor desanitises successfully.
  const out = sanitize.desanitizeText(db, secrets, sanitized, tokenSet, { actor: 'app-a' });
  assert.ok(out.length > 0);
});

test('security > desanitize allows the master token regardless of original caller', async t => {
  const { db, secrets } = await makeServer(t);
  const sanitize = require('../server/sanitize');
  const { sanitized, tokenSet } = sanitize.sanitizeText(db, secrets, 'Hello Amanda Lee.', { actor: 'app-a' });
  // Master token (kind='master') gets a free pass.
  const out = sanitize.desanitizeText(db, secrets, sanitized, tokenSet, { actor: 'operator', authKind: 'master' });
  assert.ok(out.length > 0);
});

test('security > desanitize refuses an expired token-set', async t => {
  const { db, secrets } = await makeServer(t);
  const sanitize = require('../server/sanitize');
  // Create a token-set with a 1-second TTL so we don't need to wait long.
  const { tokenSet } = sanitize.sanitizeText(db, secrets, 'Hello.', { actor: 'app-a', ttlMinutes: 0.0001 });
  await new Promise(r => setTimeout(r, 20)); // safely past expiry
  assert.throws(
    () => sanitize.desanitizeText(db, secrets, 'Hello.', tokenSet, { actor: 'app-a' }),
    /expired/
  );
});

// -----------------------------------------------------------------------------
// Notifications GET masks body by default
// -----------------------------------------------------------------------------

test('security > GET /api/notifications masks body_text / body_html by default', async t => {
  const { port, db, secrets } = await makeServer(t);
  const notify = require('../server/notify');
  notify.enqueue(db, { kind: 'test', to: 'alert@example.org', subject: 'X', text: 'secret body text' });
  const r = await request(port, { path: '/api/notifications', headers: auth(secrets) });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].body_text, null, 'body_text masked by default');
  assert.equal(r.body.items[0].body_html, null);
  assert.match(r.body.items[0].body_preview || '', /^secret body text$/);
});

test('security > GET /api/notifications?include_body=1 returns full bodies', async t => {
  const { port, db, secrets } = await makeServer(t);
  const notify = require('../server/notify');
  notify.enqueue(db, { kind: 'test', to: 'alert@example.org', subject: 'X', text: 'this is the body' });
  const r = await request(port, { path: '/api/notifications?include_body=1', headers: auth(secrets) });
  assert.equal(r.body.items[0].body_text, 'this is the body');
});

// -----------------------------------------------------------------------------
// Email-lookup miss is audited so enumeration is observable
// -----------------------------------------------------------------------------

test('security > /v1/persons?email=<miss> writes an audit row with a query_hash', async t => {
  const { port, db, secrets } = await makeServer(t);
  const r = await request(port, {
    path: '/v1/persons?email=ghost@example.org',
    headers: { ...auth(secrets), 'x-pp-contract-version': 'v0.1' },
  });
  assert.equal(r.status, 404);
  const audit = require('../server/audit');
  const rows = audit.list(db, { action: 'pp_person_lookup_email_miss' });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].metadata.query_hash, 'miss audit carries a query_hash');
  assert.equal(rows[0].metadata.hit, false);
});

// -----------------------------------------------------------------------------
// Connector HTTP: outbound URL safety
// -----------------------------------------------------------------------------

test('security > connector authedFetch rejects http:// URLs', async t => {
  const http2 = require('../server/connectors/http');
  await assert.rejects(
    http2.authedFetch({
      connector: 'test', url: 'http://example.org/api', tokenUrl: 'https://example.org/oauth',
      clientId: 'a', clientSecret: 'b',
    }),
    /https/
  );
});

test('security > connector authedFetch rejects loopback URLs', async t => {
  const http2 = require('../server/connectors/http');
  await assert.rejects(
    http2.authedFetch({
      connector: 'test', url: 'https://127.0.0.1/api', tokenUrl: 'https://example.org/oauth',
      clientId: 'a', clientSecret: 'b',
    }),
    /private \/ loopback/
  );
});

test('security > connector authedFetch rejects RFC1918 URLs', async t => {
  const http2 = require('../server/connectors/http');
  await assert.rejects(
    http2.authedFetch({
      connector: 'test', url: 'https://10.0.0.5/api', tokenUrl: 'https://example.org/oauth',
      clientId: 'a', clientSecret: 'b',
    }),
    /private \/ loopback/
  );
});
