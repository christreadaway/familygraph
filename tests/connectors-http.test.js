'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const http = require('../server/connectors/http');

function mockResponse({ status = 200, json = null, text = null }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    async json() {
      if (json === undefined || json === null) throw new Error('no json');
      return json;
    },
    async text() { return text || (json ? JSON.stringify(json) : ''); },
  };
}

function makeFetchSequence(responses) {
  let i = 0;
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses[i] || responses[responses.length - 1];
    i += 1;
    return r;
  };
  fn.calls = calls;
  return fn;
}

test('http > getAccessToken caches token until expiry', async () => {
  http.clearTokenCache();
  const fetchImpl = makeFetchSequence([
    mockResponse({ status: 200, json: { access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 } }),
    mockResponse({ status: 200, json: { access_token: 'tok-2', token_type: 'Bearer', expires_in: 3600 } }),
  ]);
  const t1 = await http.getAccessToken({
    connector: 'unit', tokenUrl: 'https://t.test/token', clientId: 'c', clientSecret: 's', fetchImpl,
  });
  const t2 = await http.getAccessToken({
    connector: 'unit', tokenUrl: 'https://t.test/token', clientId: 'c', clientSecret: 's', fetchImpl,
  });
  assert.equal(t1.access_token, 'tok-1');
  assert.equal(t2.access_token, 'tok-1', 'cached token reused');
  assert.equal(fetchImpl.calls.length, 1);

  const t3 = await http.getAccessToken({
    connector: 'unit', tokenUrl: 'https://t.test/token', clientId: 'c', clientSecret: 's',
    forceRefresh: true, fetchImpl,
  });
  assert.equal(t3.access_token, 'tok-2');
});

test('http > token endpoint 401 surfaces auth_failed', async () => {
  http.clearTokenCache();
  const fetchImpl = makeFetchSequence([
    mockResponse({ status: 401, json: { error: 'invalid_client' } }),
  ]);
  await assert.rejects(
    () => http.fetchToken({
      connector: 'unit', tokenUrl: 'https://t.test/token',
      clientId: 'c', clientSecret: 'wrong', fetchImpl,
    }),
    e => {
      assert.equal(e.reason, 'auth_failed');
      return true;
    }
  );
});

test('http > network error surfaces network_error reason', async () => {
  http.clearTokenCache();
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(
    () => http.fetchToken({
      connector: 'unit', tokenUrl: 'https://t.test/token',
      clientId: 'c', clientSecret: 's', fetchImpl,
    }),
    e => {
      assert.equal(e.reason, 'network_error');
      return true;
    }
  );
});

test('http > authedFetch retries once on 401 then succeeds', async () => {
  http.clearTokenCache();
  const fetchImpl = makeFetchSequence([
    mockResponse({ status: 200, json: { access_token: 'tok-A', token_type: 'Bearer', expires_in: 3600 } }),
    mockResponse({ status: 401 }),
    mockResponse({ status: 200, json: { access_token: 'tok-B', token_type: 'Bearer', expires_in: 3600 } }),
    mockResponse({ status: 200, json: { hello: 'world' } }),
  ]);
  const out = await http.authedFetch({
    connector: 'unit', url: 'https://api.test/x',
    tokenUrl: 'https://t.test/token', clientId: 'c', clientSecret: 's',
    fetchImpl,
  });
  assert.deepEqual(out, { hello: 'world' });
  assert.equal(fetchImpl.calls.length, 4);
});

test('http > authedFetch propagates auth_failed when refresh also fails', async () => {
  http.clearTokenCache();
  const fetchImpl = makeFetchSequence([
    mockResponse({ status: 200, json: { access_token: 'tok-A', token_type: 'Bearer', expires_in: 3600 } }),
    mockResponse({ status: 401 }),
    mockResponse({ status: 200, json: { access_token: 'tok-B', token_type: 'Bearer', expires_in: 3600 } }),
    mockResponse({ status: 401 }),
  ]);
  await assert.rejects(
    () => http.authedFetch({
      connector: 'unit', url: 'https://api.test/x',
      tokenUrl: 'https://t.test/token', clientId: 'c', clientSecret: 's',
      fetchImpl,
    }),
    e => { assert.equal(e.reason, 'auth_failed'); return true; }
  );
});

test('http > malformed token response is rejected', async () => {
  http.clearTokenCache();
  const fetchImpl = makeFetchSequence([
    mockResponse({ status: 200, json: { not_a_token: 'oops' } }),
  ]);
  await assert.rejects(
    () => http.fetchToken({
      connector: 'unit', tokenUrl: 'https://t.test/token',
      clientId: 'c', clientSecret: 's', fetchImpl,
    }),
    e => { assert.equal(e.reason, 'token_endpoint_error'); return true; }
  );
});
