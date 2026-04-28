'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../server/auth/middleware');

function reqMock(headers, ip) {
  return {
    get(k) { return headers[k.toLowerCase()] || ''; },
    socket: { remoteAddress: ip },
  };
}

function resMock() {
  const r = {};
  r.status = c => { r._status = c; return r; };
  r.json = b => { r._body = b; return r; };
  return r;
}

test('auth > bearer matches in constant time', () => {
  const mw = auth.bearerAuth({ master: 'abc123abc123' });
  const req = reqMock({ authorization: 'Bearer abc123abc123', 'x-family-graph-actor': 'mq' }, '127.0.0.1');
  const res = resMock();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.auth.actor, 'mq');
});

test('auth > bearer rejects wrong token', () => {
  const mw = auth.bearerAuth({ master: 'abc123abc123' });
  const req = reqMock({ authorization: 'Bearer wrong' }, '127.0.0.1');
  const res = resMock();
  mw(req, res, () => { throw new Error('next should not be called'); });
  assert.equal(res._status, 401);
});

test('auth > loopbackOnly allows 127.0.0.1 and ::1', () => {
  const mw = auth.loopbackOnly();
  let n = 0;
  mw(reqMock({}, '127.0.0.1'), resMock(), () => { n++; });
  mw(reqMock({}, '::1'), resMock(), () => { n++; });
  mw(reqMock({}, '::ffff:127.0.0.1'), resMock(), () => { n++; });
  assert.equal(n, 3);
});

test('auth > loopbackOnly rejects external IP', () => {
  const mw = auth.loopbackOnly();
  const res = resMock();
  mw(reqMock({}, '8.8.8.8'), res, () => { throw new Error('should not pass'); });
  assert.equal(res._status, 403);
});

test('auth > tokensEqual rejects different lengths', () => {
  assert.equal(auth.tokensEqual('a', 'aa'), false);
  assert.equal(auth.tokensEqual('abc', 'abc'), true);
  assert.equal(auth.tokensEqual(null, 'abc'), false);
});
