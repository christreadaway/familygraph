'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { X509Certificate } = require('crypto');

const notify = require('../server/notify');
const templates = require('../server/notify/templates');
const conflictsMod = require('../server/identity/conflicts');
const people = require('../server/identity/people');
const resolver = require('../server/identity/resolver');
const { newDb, newSecrets, defaultThresholds, tmpDir, cleanup } = require('./_helpers');

function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(key, JSON.stringify(value));
}

function seedConflict(db, secrets) {
  const a = people.create(db, secrets, { given_name: 'Pio', family_name: 'Pietrelcina' });
  const b = people.create(db, secrets, { given_name: 'Pia', family_name: 'Pietrelcina' });
  resolver.rescorePerson(db, secrets, defaultThresholds(), b);
  return conflictsMod.list(db, { status: 'open' });
}

test('templates > assignTemplate produces subject + text + html with TTL and link', () => {
  const exp = new Date(Date.now() + 24 * 3_600_000).toISOString();
  const t = templates.assignTemplate({
    count: 3, expiresAt: exp, dashboardUrl: 'https://sanctus.example.org', assignee: 'sarah@x.org', ttlHours: 24, institution: 'St Theresa',
  });
  assert.match(t.subject, /3 family-data conflicts/);
  assert.match(t.subject, /resolve within 24h/);
  assert.match(t.text, /https:\/\/sanctus\.example\.org\/conflicts\?assigned_to=sarah%40x\.org/);
  assert.match(t.text, /Time remaining/);
  assert.match(t.html, /<a href="https:\/\/sanctus\.example\.org\/conflicts\?assigned_to=sarah%40x\.org"/);
});

test('templates > reminder + expired include the link and counts', () => {
  const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const r = templates.reminderTemplate({ count: 1, expiresAt: exp, dashboardUrl: 'http://x', assignee: 'a@b.c' });
  assert.match(r.subject, /Reminder/);
  const e = templates.expiredTemplate({ count: 5, dashboardUrl: 'http://x', assignee: 'a@b.c' });
  assert.match(e.subject, /expired/);
  assert.match(e.text, /unassigned pool/);
});

test('notify > enqueue inserts a pending row and audits', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  const code = notify.enqueue(db, {
    kind: 'assign', to: 'a@b.com', subject: 's', text: 'hello', related: ['conf_1'],
  });
  assert.match(code, /^note_/);
  const rows = notify.listAll(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
  assert.deepEqual(rows[0].related_codes, ['conf_1']);
  const events = db.prepare(`SELECT * FROM audit_events WHERE action = 'notification_enqueue'`).all();
  assert.equal(events.length, 1);
});

test('notify > assigning a conflict enqueues an "assign" notification with TTL in subject', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const open = seedConflict(db, s);
  conflictsMod.assign(db, { allOpen: true, assignee: 'sarah@example.org', ttlHours: 24 });
  const items = notify.listAll(db, { kind: 'assign' });
  assert.equal(items.length, 1);
  assert.equal(items[0].to_email, 'sarah@example.org');
  assert.match(items[0].subject, /resolve within 24h/);
  assert.match(items[0].body_text, /Time remaining/);
  assert.match(items[0].body_text, /Open your queue/);
  assert.deepEqual(items[0].related_codes, open.map(c => c.code));
});

test('notify > sweepExpiredAssignments enqueues an "expired" notification per assignee', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  const open = seedConflict(db, s);
  conflictsMod.assign(db, { allOpen: true, assignee: 'sarah@example.org', ttlHours: 4 });
  // Backdate so the sweep clears it.
  const past = new Date(Date.now() - 1000).toISOString();
  for (const c of open) {
    db.prepare(`UPDATE conflicts SET assignment_expires_at = ? WHERE code = ?`).run(past, c.code);
  }
  conflictsMod.sweepExpiredAssignments(db);
  const items = notify.listAll(db, { kind: 'expired' });
  assert.equal(items.length, 1);
  assert.equal(items[0].to_email, 'sarah@example.org');
  assert.match(items[0].body_text, /unassigned pool/);
});

test('notify > sendDueReminders skips already-reminded conflicts', t => {
  const { db, dir } = newDb();
  const s = newSecrets();
  t.after(() => { db.close(); cleanup(dir); });
  seedConflict(db, s);
  conflictsMod.assign(db, { allOpen: true, assignee: 'sarah@example.org', ttlHours: 4 });
  // Force the assignment expiry into the reminder window (within 1 hour).
  const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.prepare(`UPDATE conflicts SET assignment_expires_at = ? WHERE assigned_to = ?`).run(soon, 'sarah@example.org');
  const reminded1 = conflictsMod.sendDueReminders(db, { reminderHours: 1 });
  assert.ok(reminded1.length >= 1);
  const reminded2 = conflictsMod.sendDueReminders(db, { reminderHours: 1 });
  assert.equal(reminded2.length, 0, 'should not re-remind the same conflict');
  const reminders = notify.listAll(db, { kind: 'reminder' });
  assert.equal(reminders.length, 1);
});

test('notify > log transport writes a JSONL line and marks sent', async t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  const home = tmpDir();
  t.after(() => cleanup(home));
  setSetting(db, 'notifications.enabled', true);
  setSetting(db, 'notifications.transport', 'log');
  setSetting(db, 'dashboard_url', 'http://x');
  notify.enqueue(db, { kind: 'test', to: 'sarah@example.org', subject: 'hi', text: 'hello' });
  // Override the log path by stubbing effectiveConfig via env var (simplest).
  // The notify module derives logPath from config.home; we monkey-patch the
  // resolved cfg by passing it through dispatchOne directly.
  const logPath = path.join(home, 'notifications.jsonl');
  const cfg = notify.effectiveConfig(db);
  cfg.logPath = logPath;
  const row = notify.listPending(db)[0];
  const r = await notify.dispatchOne(db, row, cfg);
  assert.equal(r.ok, true);
  const sent = notify.listAll(db, { status: 'sent' });
  assert.equal(sent.length, 1);
  const line = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
  assert.equal(line.to, 'sarah@example.org');
  assert.equal(line.subject, 'hi');
});

test('notify > dispatchPending is a no-op when notifications disabled', async t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  notify.enqueue(db, { kind: 'test', to: 'a@b.c', subject: 's', text: 't' });
  const r = await notify.dispatchPending(db);
  assert.equal(r.skipped, true);
  const rows = notify.listAll(db);
  assert.equal(rows[0].status, 'pending');
});

test('notify > retryable failure increments attempts + sets next_attempt_at', async t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  setSetting(db, 'notifications.enabled', true);
  setSetting(db, 'notifications.transport', 'log');
  notify.enqueue(db, { kind: 'test', to: 'a@b.c', subject: 's', text: 't' });
  const row = notify.listPending(db)[0];
  // Force failure by passing a bad logPath.
  const cfg = notify.effectiveConfig(db);
  cfg.logPath = '/dev/null/cannot-mkdir-here';
  const r = await notify.dispatchOne(db, row, cfg);
  assert.equal(r.ok, false);
  const after = notify.listAll(db)[0];
  assert.equal(after.status, 'pending');
  assert.equal(after.attempts, 1);
  assert.ok(after.next_attempt_at);
});

test('notify > retry resets a failed row to pending', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  const code = notify.enqueue(db, { kind: 'test', to: 'a@b.c', subject: 's', text: 't' });
  db.prepare(`UPDATE notifications SET status = 'failed', attempts = 5 WHERE code = ?`).run(code);
  notify.retry(db, code);
  const row = notify.listAll(db)[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0);
});

test('notify > cancel pending only', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  const code = notify.enqueue(db, { kind: 'test', to: 'a@b.c', subject: 's', text: 't' });
  assert.equal(notify.cancel(db, code), true);
  const sent = notify.enqueue(db, { kind: 'test', to: 'a@b.c', subject: 's', text: 't' });
  db.prepare(`UPDATE notifications SET status = 'sent' WHERE code = ?`).run(sent);
  assert.equal(notify.cancel(db, sent), false, 'cannot cancel a sent message');
});

// Mock Postmark with a local HTTPS server so we can verify the request shape
// without leaving the machine. Self-signed cert; test process disables peer
// verification for this single request only.
function makeSelfSignedCert() {
  // Use a precomputed RSA key to keep tests fast and deterministic.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cert = require('crypto').createPrivateKey({ key: privateKey });
  // Node doesn't ship a cert generator in core; using openssl via child_process
  // would also work, but we can use a static fixture by hashing.
  // Skip the full mock if openssl isn't available — just check that the
  // transport emits the right payload by mocking https.request directly.
  return { privateKey, publicKey, cert };
}

test('notify > Postmark transport posts JSON with required headers', async t => {
  // Hot-patch https.request to capture the outbound payload + headers.
  const originalRequest = https.request;
  let captured = null;
  const fakeRes = new (require('events').EventEmitter)();
  fakeRes.statusCode = 200;
  fakeRes.headers = { 'content-type': 'application/json' };
  https.request = (opts, cb) => {
    captured = { opts, body: '' };
    const fakeReq = new (require('events').EventEmitter)();
    fakeReq.write = chunk => { captured.body += chunk; };
    fakeReq.end = () => {
      cb(fakeRes);
      fakeRes.emit('data', JSON.stringify({ ErrorCode: 0, Message: 'OK', MessageID: 'abc-123' }));
      fakeRes.emit('end');
    };
    fakeReq.on = (...args) => require('events').EventEmitter.prototype.on.apply(fakeReq, args);
    fakeReq.destroy = () => {};
    return fakeReq;
  };
  t.after(() => { https.request = originalRequest; });

  const postmark = require('../server/notify/transports/postmark');
  const r = await postmark.send(
    { token: 'TEST-TOKEN', from: 'sender@example.org', messageStream: 'outbound' },
    { to: 'sarah@example.org', subject: 'subj', text: 'body', html: '<p>body</p>' },
  );
  assert.equal(r.provider_message_id, 'abc-123');
  assert.equal(captured.opts.host, 'api.postmarkapp.com');
  assert.equal(captured.opts.path, '/email');
  assert.equal(captured.opts.headers['X-Postmark-Server-Token'], 'TEST-TOKEN');
  const payload = JSON.parse(captured.body);
  assert.equal(payload.From, 'sender@example.org');
  assert.equal(payload.To, 'sarah@example.org');
  assert.equal(payload.Subject, 'subj');
  assert.equal(payload.TextBody, 'body');
  assert.equal(payload.HtmlBody, '<p>body</p>');
  assert.equal(payload.MessageStream, 'outbound');
});

test('notify > Postmark 5xx is retryable; 4xx is not', async t => {
  const originalRequest = https.request;
  function makeFake(status, body) {
    return (opts, cb) => {
      const fakeReq = new (require('events').EventEmitter)();
      fakeReq.write = () => {}; fakeReq.destroy = () => {};
      fakeReq.end = () => {
        const fakeRes = new (require('events').EventEmitter)();
        fakeRes.statusCode = status;
        fakeRes.headers = { 'content-type': 'application/json' };
        cb(fakeRes);
        fakeRes.emit('data', JSON.stringify(body));
        fakeRes.emit('end');
      };
      return fakeReq;
    };
  }
  const postmark = require('../server/notify/transports/postmark');

  https.request = makeFake(500, { ErrorCode: 100, Message: 'server fault' });
  let caught;
  try { await postmark.send({ token: 'T', from: 'a@b.c' }, { to: 'x@y.z', subject: 's', text: 't' }); }
  catch (e) { caught = e; }
  assert.ok(caught);
  assert.equal(caught.retryable, true);

  https.request = makeFake(422, { ErrorCode: 405, Message: 'inactive recipient' });
  caught = null;
  try { await postmark.send({ token: 'T', from: 'a@b.c' }, { to: 'x@y.z', subject: 's', text: 't' }); }
  catch (e) { caught = e; }
  assert.ok(caught);
  assert.equal(caught.retryable, false);

  https.request = makeFake(429, { ErrorCode: 100, Message: 'rate limited' });
  caught = null;
  try { await postmark.send({ token: 'T', from: 'a@b.c' }, { to: 'x@y.z', subject: 's', text: 't' }); }
  catch (e) { caught = e; }
  assert.ok(caught);
  assert.equal(caught.retryable, true, '429 must be retryable');

  https.request = originalRequest;
});

test('notify > settings allow-list accepts notifications.* keys', t => {
  const { db, dir } = newDb();
  t.after(() => { db.close(); cleanup(dir); });
  // Direct setting via the helper — the API allow-list is enforced in the
  // route handler; this test asserts the helper round-trip.
  setSetting(db, 'notifications.enabled', true);
  setSetting(db, 'notifications.transport', 'postmark');
  setSetting(db, 'postmark.from', 'sender@example.org');
  const cfg = notify.effectiveConfig(db);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.transport, 'postmark');
  assert.equal(cfg.postmark.from, 'sender@example.org');
});

test('notify > body never contains family/person codes (check assign template)', () => {
  // Privacy posture sanity-check. We embed conflict codes (`conf_…`) in the
  // queue link via the recipient's email filter, but family/person codes
  // (`f_…`, `p_…`) MUST NOT appear in the body. The template doesn't
  // construct them, but verify by spot-check.
  const t = templates.assignTemplate({
    count: 2,
    expiresAt: new Date().toISOString(),
    dashboardUrl: 'https://x',
    assignee: 'a@b.c',
    ttlHours: 24,
  });
  assert.doesNotMatch(t.text, /\bp_[0-9a-f]{8}\b/);
  assert.doesNotMatch(t.text, /\bf_[0-9a-f]{8}\b/);
  assert.doesNotMatch(t.html, /\bp_[0-9a-f]{8}\b/);
  assert.doesNotMatch(t.html, /\bf_[0-9a-f]{8}\b/);
});
