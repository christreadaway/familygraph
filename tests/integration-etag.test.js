'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const etag = require('../server/integration/etag');

test('etag > stableStringify produces deterministic output regardless of key order', () => {
  const a = { foo: 1, bar: [1, 2, { z: true, a: false }] };
  const b = { bar: [1, 2, { a: false, z: true }], foo: 1 };
  assert.equal(etag.stableStringify(a), etag.stableStringify(b));
});

test('etag > compute returns a weak validator', () => {
  const t = etag.compute({ foo: 1 });
  assert.match(t, /^W\/"[0-9a-f]{16}"$/);
});

test('etag > matches accepts both quoted and weakly-prefixed forms', () => {
  const t = etag.compute({ foo: 1 });
  assert.ok(etag.matches(t, t));
  assert.ok(etag.matches(t.replace('W/', ''), t));
  assert.ok(etag.matches('*', t));
  assert.ok(!etag.matches('W/"deadbeefdeadbeef"', t));
});

test('etag > different content produces different tags', () => {
  assert.notEqual(etag.compute({ foo: 1 }), etag.compute({ foo: 2 }));
});
