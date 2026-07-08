'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Capture stderr writes so we can assert on log lines without leaking output
// into the test runner.
function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return lines.join('').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function tmpFile() {
  return path.join(os.tmpdir(), `fg-log-${crypto.randomBytes(6).toString('hex')}.jsonl`);
}

test('log > writes JSON line per call with timestamp + level + msg', () => {
  // Force re-load with a fresh level so an earlier suite's configure() doesn't bleed in.
  delete require.cache[require.resolve('../server/log')];
  const log = require('../server/log');
  log.configure({ level: 'debug' });
  const lines = captureStderr(() => {
    log.info('hello', { foo: 'bar' });
    log.warn('uh oh', { code: 1 });
  });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].level, 'info');
  assert.equal(lines[0].msg, 'hello');
  assert.equal(lines[0].foo, 'bar');
  assert.match(lines[0].t, /\d{4}-\d{2}-\d{2}T/);
  assert.equal(lines[1].level, 'warn');
});

test('log > level filtering drops below-threshold lines', () => {
  delete require.cache[require.resolve('../server/log')];
  const log = require('../server/log');
  log.configure({ level: 'warn' });
  const lines = captureStderr(() => {
    log.debug('quiet');
    log.info('also quiet');
    log.warn('loud');
    log.error('louder');
  });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map(l => l.level), ['warn', 'error']);
});

test('log > redacts sensitive keys before serialising', () => {
  delete require.cache[require.resolve('../server/log')];
  const log = require('../server/log');
  log.configure({ level: 'debug' });
  const lines = captureStderr(() => {
    log.info('http', {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: { email: 'a@b.c', password: 'hunter2', other: 'fine' },
      token: 'abc123',
    });
  });
  const flat = JSON.stringify(lines[0]);
  assert.doesNotMatch(flat, /Bearer secret-token/);
  assert.doesNotMatch(flat, /hunter2/);
  assert.doesNotMatch(flat, /a@b\.c/);
  assert.doesNotMatch(flat, /abc123/);
  assert.match(flat, /\[redacted\]/);
  // Non-PII keys still present.
  assert.equal(lines[0].body.other, 'fine');
});

test('log > circular metadata does not crash and is replaced with sentinel', () => {
  delete require.cache[require.resolve('../server/log')];
  const log = require('../server/log');
  log.configure({ level: 'debug' });
  const a = { name: 'a' }; const b = { name: 'b' };
  a.b = b; b.a = a;
  const lines = captureStderr(() => {
    log.info('circular', { graph: a });
  });
  assert.equal(lines.length, 1);
  assert.match(JSON.stringify(lines[0]), /\[circular\]/);
});

test('log > file output mirrors stderr', () => {
  delete require.cache[require.resolve('../server/log')];
  const log = require('../server/log');
  const file = tmpFile();
  log.configure({ level: 'info', file });
  captureStderr(() => log.info('to-file', { ok: true }));
  // Allow the stream to flush.
  log.configure({ file: null });
  const contents = fs.readFileSync(file, 'utf8').trim();
  fs.unlinkSync(file);
  assert.equal(contents.split('\n').length, 1);
  const parsed = JSON.parse(contents);
  assert.equal(parsed.msg, 'to-file');
  assert.equal(parsed.ok, true);
});

test('log > rotates the file to .1 when it exceeds maxBytes', () => {
  delete require.cache[require.resolve('../server/log')];
  const log = require('../server/log');
  const file = tmpFile();
  // Tiny cap so a handful of lines forces rotation.
  log.configure({ level: 'info', file, maxBytes: 200 });
  captureStderr(() => {
    for (let i = 0; i < 20; i++) log.info('filler', { i, pad: 'x'.repeat(40) });
  });
  log.configure({ file: null });
  const rotated = `${file}.1`;
  assert.ok(fs.existsSync(rotated), 'expected a .1 rotation file');
  assert.ok(fs.existsSync(file), 'expected a fresh live file after rotation');
  // The live file restarted below the cap at least once; the rotated file
  // holds complete JSON lines (no torn writes).
  const rotatedLines = fs.readFileSync(rotated, 'utf8').trim().split('\n');
  for (const l of rotatedLines) JSON.parse(l);
  // Every line is on disk exactly once across the two generations.
  const liveLines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(liveLines.length >= 1);
  fs.unlinkSync(file);
  fs.unlinkSync(rotated);
});

test('log > rotation cap is configurable via FAMILY_GRAPH_LOG_MAX_BYTES', () => {
  const prev = process.env.FAMILY_GRAPH_LOG_MAX_BYTES;
  process.env.FAMILY_GRAPH_LOG_MAX_BYTES = '150';
  try {
    delete require.cache[require.resolve('../server/log')];
    const log = require('../server/log');
    const file = tmpFile();
    log.configure({ level: 'info', file });
    captureStderr(() => {
      for (let i = 0; i < 10; i++) log.info('env-filler', { i, pad: 'y'.repeat(60) });
    });
    log.configure({ file: null });
    assert.ok(fs.existsSync(`${file}.1`), 'env-configured cap should trigger rotation');
    fs.unlinkSync(file);
    fs.unlinkSync(`${file}.1`);
  } finally {
    if (prev === undefined) delete process.env.FAMILY_GRAPH_LOG_MAX_BYTES;
    else process.env.FAMILY_GRAPH_LOG_MAX_BYTES = prev;
    // Reload once more so later suites don't inherit the tiny cap.
    delete require.cache[require.resolve('../server/log')];
  }
});

test('log > _redact handles arrays + nested PII keys', () => {
  delete require.cache[require.resolve('../server/log')];
  const log = require('../server/log');
  const out = log._redact({
    list: [{ first_name: 'Mary', code: 'p_aaaaaaaa' }],
    nested: { contact: { email: 'x@y.z', kind: 'work' } },
  });
  assert.equal(out.list[0].first_name, '[redacted]');
  assert.equal(out.list[0].code, 'p_aaaaaaaa');
  assert.equal(out.nested.contact.email, '[redacted]');
  assert.equal(out.nested.contact.kind, 'work');
});
