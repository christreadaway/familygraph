'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const secretModule = require('../server/crypto/secret');
const { tmpDir, cleanup } = require('./_helpers');

test('secret > load creates a fresh file with mode 0600 if missing', t => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const sp = path.join(dir, 'secret.key');
  const s = secretModule.load(sp);
  assert.ok(fs.existsSync(sp));
  assert.equal(s.master.length, 64);
  assert.equal(s.dataKey.length, 64);
  assert.equal(s.hmacKey.length, 64);
  const stat = fs.statSync(sp);
  // On Linux, file mode bits are checkable; CI may run umask.
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600);
  }
});

test('secret > rotate changes master but preserves dataKey', t => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const sp = path.join(dir, 'secret.key');
  const a = secretModule.load(sp);
  const b = secretModule.rotate(sp);
  assert.notEqual(a.master, b.master);
  assert.equal(a.dataKey, b.dataKey);
  assert.equal(a.hmacKey, b.hmacKey);
});

test('secret > load rejects malformed file', t => {
  const dir = tmpDir();
  t.after(() => cleanup(dir));
  const sp = path.join(dir, 'secret.key');
  fs.writeFileSync(sp, JSON.stringify({ junk: true }));
  assert.throws(() => secretModule.load(sp), /malformed/);
});
