'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const facts = require('../server/connectors/facts');
const httpMod = require('../server/connectors/http');

function mockResponse({ status = 200, json = null, text = null }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    async json() {
      if (json === undefined || json === null) throw new Error('no json');
      return json;
    },
    async text() { return text || (json ? JSON.stringify(json) : ''); },
  };
}

// FACTS sample: two students sharing two parents, plus a stand-alone parent.
const STUDENTS = [
  {
    sourcedId: 'stu-1', givenName: 'Anna', familyName: 'Treadaway', dateOfBirth: '2014-04-15',
    grade: '5', metadata: { address: '123 Main St', city: 'St Louis', state: 'MO', zip: '63101' },
    agents: [{ sourcedId: 'par-1' }, { sourcedId: 'par-2' }],
  },
  {
    sourcedId: 'stu-2', givenName: 'Ben', familyName: 'Treadaway', dateOfBirth: '2016-09-22',
    grade: '3', metadata: { address: '123 Main St', city: 'St Louis', state: 'MO', zip: '63101' },
    agents: [{ sourcedId: 'par-1' }, { sourcedId: 'par-2' }],
  },
];

const PARENTS = [
  {
    sourcedId: 'par-1', givenName: 'Chris', familyName: 'Treadaway',
    email: 'chris@example.com', phone: '+1-314-555-0001',
  },
  {
    sourcedId: 'par-2', givenName: 'Sarah', familyName: 'Treadaway',
    email: 'sarah@example.com', phone: '3145550002',
  },
  {
    sourcedId: 'par-99', givenName: 'Solo', familyName: 'Singleton',
    email: 'solo@example.com',
  },
];

test('facts.buildCanonical groups siblings + parents into one household', () => {
  const out = facts.buildCanonical({ students: STUDENTS, parents: PARENTS });
  // Expect: 1 Treadaway household + 1 Singleton parent-only row.
  assert.equal(out.length, 2);
  const tread = out.find(h => h.persons.some(p => p.family_name === 'Treadaway'));
  const singleton = out.find(h => h.persons.some(p => p.family_name === 'Singleton'));
  assert.ok(tread, 'expected Treadaway household');
  assert.ok(singleton, 'expected Singleton parent-only row');
  assert.equal(tread.persons.length, 4, 'two students + two parents');
  assert.ok(tread.address);
  assert.equal(tread.address.line1, '123 Main St');
  assert.equal(tread.persons.find(p => p.given_name === 'Chris').emails[0], 'chris@example.com');
});

test('facts.testConnection succeeds against a mock', async () => {
  httpMod.clearTokenCache();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts && opts.method });
    if (url.includes('/token')) {
      return mockResponse({ status: 200, json: { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 } });
    }
    if (url.includes('/orgs')) {
      return mockResponse({ status: 200, json: { orgs: [{ sourcedId: 'org-1' }] } });
    }
    return mockResponse({ status: 404 });
  };
  const out = await facts.testConnection({
    creds: {
      api_base_url: 'https://example.test/api/v3',
      access_token_url: 'https://example.test/oauth2/token',
      client_id: 'c', client_secret: 's',
    },
    fetchImpl,
  });
  assert.equal(out.ok, true);
  assert.equal(out.sample_count, 1);
  assert.ok(calls.length >= 2, 'token call + orgs call');
});

test('facts.testConnection bubbles up auth_failed from token endpoint', async () => {
  httpMod.clearTokenCache();
  const fetchImpl = async (url) => {
    if (url.includes('/token')) {
      return mockResponse({ status: 401, json: { error: 'invalid_client' } });
    }
    return mockResponse({ status: 500 });
  };
  await assert.rejects(
    () => facts.testConnection({
      creds: {
        api_base_url: 'https://example.test/api/v3',
        access_token_url: 'https://example.test/oauth2/token',
        client_id: 'c', client_secret: 'wrong',
      },
      fetchImpl,
    }),
    e => { assert.equal(e.reason, 'auth_failed'); return true; }
  );
});

test('facts.pullCanonical paginates students until short page', async () => {
  httpMod.clearTokenCache();
  // Build a fetchImpl that returns 100 students on the first page and 5 on the second.
  let userCallCount = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/token')) {
      return mockResponse({ status: 200, json: { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 } });
    }
    if (url.includes('role=student')) {
      userCallCount += 1;
      if (userCallCount === 1) {
        const users = Array.from({ length: 100 }, (_, i) => ({
          sourcedId: `stu-${i}`, familyName: `Fam${i}`, givenName: `Kid${i}`,
        }));
        return mockResponse({ status: 200, json: { users } });
      }
      return mockResponse({ status: 200, json: { users: [{ sourcedId: 'stu-last', familyName: 'Last', givenName: 'Kid' }] } });
    }
    if (url.includes('role=parent')) {
      return mockResponse({ status: 200, json: { users: [] } });
    }
    return mockResponse({ status: 404 });
  };
  const out = await facts.pullCanonical({
    creds: {
      api_base_url: 'https://example.test/api/v3',
      access_token_url: 'https://example.test/oauth2/token',
      client_id: 'c', client_secret: 's',
    },
    fetchImpl,
  });
  assert.equal(out.metadata.students_pulled, 101);
  assert.equal(userCallCount, 2, 'expected pagination over two pages');
});
