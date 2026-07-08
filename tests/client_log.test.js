'use strict';

// The client log buffer (client/src/log.js) is ESM (client/package.json sets
// "type": "module"), so this CJS test loads it via dynamic import(). Only the
// pure parts run here — the module guards every window / sessionStorage /
// document touch, which is exactly what these tests prove by importing it in
// a bare node process.

const test = require('node:test');
const assert = require('node:assert/strict');

let mod;
test.before(async () => {
  mod = await import('../client/src/log.js');
});

test('client log > module imports cleanly with no window / sessionStorage', () => {
  assert.equal(typeof mod.createLogBuffer, 'function');
  assert.equal(typeof mod.redact, 'function');
  assert.equal(typeof mod.formatLine, 'function');
  assert.ok(mod.log, 'singleton export exists');
});

test('client log > redactor matches the server redactor key-for-key', () => {
  const serverLog = require('../server/log');
  const sample = {
    method: 'POST',
    headers: { authorization: 'Bearer secret-token' },
    body: {
      first_name: 'Mary', email: 'a@b.c', password: 'hunter2',
      dob: '2001-01-01', phone: '5550001111', address: '1 Main St',
      other: 'fine',
    },
    token: 'abc123',
    nested: [{ client_secret: 'shh', kind: 'work' }],
  };
  assert.deepEqual(mod.redact(sample), serverLog._redact(sample));
  const flat = JSON.stringify(mod.redact(sample));
  assert.doesNotMatch(flat, /secret-token|hunter2|a@b\.c|Mary|abc123|shh|5550001111|1 Main St/);
  assert.match(flat, /\[redacted\]/);
  assert.match(flat, /"other":"fine"/);
});

test('client log > redact survives circular context', () => {
  const a = { label: 'a' }; const b = { label: 'b' };
  a.b = b; b.a = a;
  const out = mod.redact({ graph: a });
  assert.match(JSON.stringify(out), /\[circular\]/);
});

test('client log > entries carry ts/level/scope/msg/ctx and ctx is redacted', () => {
  const buf = mod.createLogBuffer({ mirror: false });
  buf.info('api', 'GET /api/families 200', { status: 200, token: 'leak-me' });
  const [e] = buf.entries();
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(e.level, 'info');
  assert.equal(e.scope, 'api');
  assert.equal(e.msg, 'GET /api/families 200');
  assert.equal(e.ctx.status, 200);
  assert.equal(e.ctx.token, '[redacted]');
});

test('client log > ring buffer drops oldest entries past the cap', () => {
  const buf = mod.createLogBuffer({ mirror: false, max: 5 });
  for (let i = 0; i < 12; i++) buf.info('t', `line ${i}`);
  assert.equal(buf.count(), 5);
  const msgs = buf.entries().map(e => e.msg);
  assert.deepEqual(msgs, ['line 7', 'line 8', 'line 9', 'line 10', 'line 11']);
});

test('client log > formatLine + text produce the documented line shape', () => {
  const buf = mod.createLogBuffer({ mirror: false });
  buf.warn('window', 'slow response', { ms: 1234 });
  buf.error('react', 'render crash');
  const lines = buf.text().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[warn\] \[window\] slow response \{"ms":1234\}$/);
  assert.match(lines[1], /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[error\] \[react\] render crash$/);
  assert.equal(mod.formatLine(buf.entries()[0]), lines[0]);
});

test('client log > clear empties the buffer', () => {
  const buf = mod.createLogBuffer({ mirror: false });
  buf.info('t', 'one');
  buf.clear();
  assert.equal(buf.count(), 0);
  assert.equal(buf.text(), '');
});

test('client log > download/copy degrade gracefully without a DOM', async () => {
  const buf = mod.createLogBuffer({ mirror: false });
  buf.info('t', 'line');
  // No DOM in node: download/copy report false instead of throwing.
  assert.equal(buf.download(), false);
  assert.equal(await buf.copy(), false);
  // install() is a no-op without window.
  buf.install();
  assert.equal(buf.entries().some(e => e.msg === 'client log buffer installed'), false);
});
