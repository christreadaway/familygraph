'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mp = require('../server/connectors/ministry-platform');
const httpMod = require('../server/connectors/http');

function mockResponse({ status = 200, json = null }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    async json() { if (json == null) throw new Error('no json'); return json; },
    async text() { return json ? JSON.stringify(json) : ''; },
  };
}

const HOUSEHOLDS = [
  { Household_ID: 1, Household_Name: 'Treadaway Family', Address_ID: 11 },
  { Household_ID: 2, Household_Name: 'Smith Family', Address_ID: 12 },
];

const ADDRESSES = [
  { Address_ID: 11, Address_Line_1: '123 Main St', City: 'St Louis', State_Region: 'MO', Postal_Code: '63101' },
  { Address_ID: 12, Address_Line_1: '500 Oak', City: 'St Louis', State_Region: 'MO', Postal_Code: '63102' },
];

const CONTACTS = [
  { Contact_ID: 100, Household_ID: 1, First_Name: 'Chris', Last_Name: 'Treadaway',
    Email_Address: 'chris@example.com', Mobile_Phone: '314-555-0001', Date_of_Birth: '1980-01-15T00:00:00' },
  { Contact_ID: 101, Household_ID: 1, First_Name: 'Sarah', Last_Name: 'Treadaway',
    Email_Address: 'sarah@example.com', Mobile_Phone: '3145550002' },
  { Contact_ID: 102, Household_ID: 2, First_Name: 'John', Last_Name: 'Smith',
    Email_Address: 'john@smith.test' },
  { Contact_ID: 999, Household_ID: null, First_Name: 'Orphan', Last_Name: 'Solo',
    Email_Address: 'orphan@example.com' },
];

test('mp.buildCanonical joins households, contacts, addresses', () => {
  const out = mp.buildCanonical({ households: HOUSEHOLDS, contacts: CONTACTS, addresses: ADDRESSES });
  // 2 households + 1 orphan = 3 rows
  assert.equal(out.length, 3);
  const tread = out.find(h => h.family.display_name === 'Treadaway Family');
  assert.ok(tread, 'expected Treadaway household');
  assert.equal(tread.address.line1, '123 Main St');
  assert.equal(tread.persons.length, 2);
  assert.equal(tread.persons[0].given_name, 'Chris');
  assert.equal(tread.persons[0].emails[0], 'chris@example.com');
  assert.equal(tread.persons[0].date_of_birth, '1980-01-15');

  const orphan = out.find(h => h.persons[0].given_name === 'Orphan');
  assert.ok(orphan, 'expected orphan-contact row');
  assert.equal(orphan.address, null);
});

test('mp._tokenUrl derives endpoint from api_base_url when discovery url is absent', () => {
  const url1 = mp._tokenUrl({ api_base_url: 'https://parish.test/ministryplatformapi/' });
  assert.equal(url1, 'https://parish.test/ministryplatformapi/oauth/connect/token');
  const url2 = mp._tokenUrl({ api_base_url: 'https://parish.test/ministryplatformapi' });
  assert.equal(url2, 'https://parish.test/ministryplatformapi/oauth/connect/token');
  const url3 = mp._tokenUrl({ api_base_url: 'https://parish.test/x', oauth_discovery_url: 'https://other/y' });
  assert.equal(url3, 'https://other/y');
});

test('mp.testConnection issues a token + GET /tables/Households', async () => {
  httpMod.clearTokenCache();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/oauth/connect/token')) {
      return mockResponse({ status: 200, json: { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 } });
    }
    if (url.includes('/tables/Households')) {
      return mockResponse({ status: 200, json: [{ Household_ID: 1, Household_Name: 'Test' }] });
    }
    return mockResponse({ status: 404 });
  };
  const out = await mp.testConnection({
    creds: {
      api_base_url: 'https://parish.test/ministryplatformapi/',
      client_id: 'c', client_secret: 's',
    },
    fetchImpl,
  });
  assert.equal(out.ok, true);
  assert.equal(out.sample_count, 1);
  assert.ok(calls.some(u => u.includes('/oauth/connect/token')));
  assert.ok(calls.some(u => u.includes('/tables/Households')));
});

test('mp.pullCanonical handles all three table fetches', async () => {
  httpMod.clearTokenCache();
  const fetchImpl = async (url) => {
    if (url.includes('/oauth/connect/token')) {
      return mockResponse({ status: 200, json: { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 } });
    }
    if (url.includes('/tables/Households')) {
      return mockResponse({ status: 200, json: HOUSEHOLDS });
    }
    if (url.includes('/tables/Contacts')) {
      return mockResponse({ status: 200, json: CONTACTS });
    }
    if (url.includes('/tables/Addresses')) {
      return mockResponse({ status: 200, json: ADDRESSES });
    }
    return mockResponse({ status: 404 });
  };
  const out = await mp.pullCanonical({
    creds: {
      api_base_url: 'https://parish.test/ministryplatformapi/',
      client_id: 'c', client_secret: 's',
    },
    fetchImpl,
  });
  assert.equal(out.metadata.households_pulled, 2);
  assert.equal(out.metadata.contacts_pulled, 4);
  assert.equal(out.metadata.addresses_pulled, 2);
  assert.equal(out.canonical.length, 3); // 2 households + 1 orphan
});
