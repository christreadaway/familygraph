'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const connectors = require('../server/connectors');
const credentials = require('../server/connectors/credentials');
const runs = require('../server/connectors/runs');
const httpMod = require('../server/connectors/http');
const importPipeline = require('../server/identity/import');
const conflicts = require('../server/identity/conflicts');
const { newDb, newSecrets, defaultThresholds, cleanup } = require('./_helpers');

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    async json() { return data; },
    async text() { return JSON.stringify(data); },
  };
}

function factsFetch({ students, parents }) {
  return async (url) => {
    if (url.includes('/oauth2/token') || url.includes('/token')) {
      return jsonResponse({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.includes('role=student')) return jsonResponse({ users: students });
    if (url.includes('role=parent')) return jsonResponse({ users: parents });
    if (url.includes('/orgs')) return jsonResponse({ orgs: [{ sourcedId: 'org' }] });
    return jsonResponse({}, 404);
  };
}

function mpFetch({ households, contacts, addresses }) {
  return async (url) => {
    if (url.includes('/oauth/connect/token')) {
      return jsonResponse({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.includes('/tables/Households')) return jsonResponse(households);
    if (url.includes('/tables/Contacts')) return jsonResponse(contacts);
    if (url.includes('/tables/Addresses')) return jsonResponse(addresses);
    return jsonResponse({}, 404);
  };
}

test('runSync > full FACTS flow creates families/persons + import_run + connector_run', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  httpMod.clearTokenCache();
  try {
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://example.test/api/v3',
      access_token_url: 'https://example.test/oauth2/token',
      client_id: 'c', client_secret: 's',
      enabled: true, schedule: 'daily_2am',
    });
    const students = [{
      sourcedId: 'stu-1', givenName: 'Anna', familyName: 'Treadaway',
      metadata: { address: '123 Main St', city: 'St Louis', state: 'MO', zip: '63101' },
      agents: [{ sourcedId: 'par-1' }],
    }];
    const parents = [{
      sourcedId: 'par-1', givenName: 'Chris', familyName: 'Treadaway',
      email: 'chris@example.com',
    }];
    const out = await connectors.runSync(db, secrets, defaultThresholds(), 'facts', {
      trigger: 'manual', actor: 'tester',
      fetchImpl: factsFetch({ students, parents }),
    });
    assert.equal(out.ok, true);
    assert.equal(out.rows_pulled, 1);
    assert.ok(out.import_run, 'expected import_run code');
    assert.ok(out.run_code, 'expected connector_run code');

    // Verify connector_runs row
    const cr = runs.get(db, out.run_code);
    assert.equal(cr.status, 'ok');
    assert.equal(cr.import_run, out.import_run);

    // Verify import_runs row
    const ir = importPipeline.getImportRun(db, out.import_run);
    assert.equal(ir.source, 'facts_api');
    assert.equal(ir.category, 'school');
    assert.deepEqual(ir.tags, ['connector', 'manual']);

    // Verify a family + person exist
    const famCount = db.prepare(`SELECT COUNT(*) AS n FROM families`).get().n;
    const perCount = db.prepare(`SELECT COUNT(*) AS n FROM persons`).get().n;
    assert.equal(famCount, 1);
    assert.equal(perCount, 2, 'student + parent');

    // Cursor should advance
    const desc = credentials.describe(db, secrets, 'facts');
    assert.ok(desc.last_modified_cursor, 'cursor should advance');
    assert.ok(desc.last_sync_at);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('runSync > auth_failed records connector_run with reason and writes nothing', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  httpMod.clearTokenCache();
  try {
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://example.test/api/v3',
      access_token_url: 'https://example.test/oauth2/token',
      client_id: 'c', client_secret: 'wrong',
      enabled: true, schedule: 'daily_2am',
    });
    const fetchImpl = async (url) => {
      if (url.includes('/token')) return jsonResponse({ error: 'invalid_client' }, 401);
      return jsonResponse({}, 500);
    };
    const out = await connectors.runSync(db, secrets, defaultThresholds(), 'facts', {
      trigger: 'manual', actor: 'tester',
      fetchImpl,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'auth_failed');
    const cr = runs.get(db, out.run_code);
    assert.equal(cr.status, 'error');
    assert.equal(cr.reason, 'auth_failed');
    const famCount = db.prepare(`SELECT COUNT(*) AS n FROM families`).get().n;
    assert.equal(famCount, 0, 'failed sync should write no rows');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('runSync > concurrent triggers are gated', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  try {
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://x', access_token_url: 'https://x/t',
      client_id: 'c', client_secret: 's',
      enabled: true, schedule: 'hourly',
    });
    runs.start(db, { connector: 'facts', trigger: 'manual' });
    const out = await connectors.runSync(db, secrets, defaultThresholds(), 'facts', {});
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'already_running');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('cross-source resolution > matching email auto-merges across FACTS and MP', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  httpMod.clearTokenCache();
  try {
    // Configure both connectors
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://school.test/api', access_token_url: 'https://school.test/token',
      client_id: 'c', client_secret: 's', enabled: true, schedule: 'daily_2am',
    });
    credentials.set(db, secrets, 'ministry_platform', {
      api_base_url: 'https://parish.test/ministryplatformapi/',
      client_id: 'c', client_secret: 's', enabled: true, schedule: 'daily_2am',
    });

    // FACTS sync first: parent Chris with email chris@example.com.
    await connectors.runSync(db, secrets, defaultThresholds(), 'facts', {
      trigger: 'manual',
      fetchImpl: factsFetch({
        students: [{
          sourcedId: 'stu-1', givenName: 'Anna', familyName: 'Treadaway',
          metadata: { address: '123 Main St', city: 'St Louis', state: 'MO', zip: '63101' },
          agents: [{ sourcedId: 'par-1' }],
        }],
        parents: [{
          sourcedId: 'par-1', givenName: 'Chris', familyName: 'Treadaway',
          email: 'chris@example.com',
        }],
      }),
    });

    const personsAfterFacts = db.prepare(`SELECT COUNT(*) AS n FROM persons WHERE status='active'`).get().n;
    assert.equal(personsAfterFacts, 2);

    // MP sync: same Chris with same email. Should auto-merge (definitive email match).
    httpMod.clearTokenCache();
    await connectors.runSync(db, secrets, defaultThresholds(), 'ministry_platform', {
      trigger: 'manual',
      fetchImpl: mpFetch({
        households: [{ Household_ID: 1, Household_Name: 'Treadaway Family', Address_ID: 11 }],
        contacts: [{
          Contact_ID: 100, Household_ID: 1, First_Name: 'Chris', Last_Name: 'Treadaway',
          Email_Address: 'chris@example.com',
        }],
        addresses: [{ Address_ID: 11, Address_Line_1: '123 Main St', City: 'St Louis', State_Region: 'MO', Postal_Code: '63101' }],
      }),
    });

    // Chris should be one person, not two.
    const chris = db.prepare(`
      SELECT COUNT(*) AS n FROM persons p
      JOIN person_emails pe ON pe.person_code = p.code
      JOIN emails e ON e.code = pe.email_code
      WHERE p.status = 'active'
    `).get().n;
    // 2 person<->email link rows but pointing at one canonical Chris. Let me count distinct persons.
    const distinctPersons = db.prepare(`SELECT COUNT(*) AS n FROM persons WHERE status='active'`).get().n;
    assert.equal(distinctPersons, 2, 'expected Anna + Chris (merged), not three persons');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('cross-source resolution > non-matching identifiers open a cross_source conflict', async () => {
  const { db, dir } = newDb();
  const secrets = newSecrets();
  httpMod.clearTokenCache();
  try {
    credentials.set(db, secrets, 'facts', {
      api_base_url: 'https://school.test/api', access_token_url: 'https://school.test/token',
      client_id: 'c', client_secret: 's', enabled: true, schedule: 'daily_2am',
    });
    credentials.set(db, secrets, 'ministry_platform', {
      api_base_url: 'https://parish.test/ministryplatformapi/',
      client_id: 'c', client_secret: 's', enabled: true, schedule: 'daily_2am',
    });

    // FACTS: Chris with dad's email.
    await connectors.runSync(db, secrets, defaultThresholds(), 'facts', {
      trigger: 'manual',
      fetchImpl: factsFetch({
        students: [{ sourcedId: 'stu-1', givenName: 'Anna', familyName: 'Treadaway',
          metadata: { address: '123 Main St', city: 'St Louis', state: 'MO', zip: '63101' },
          agents: [{ sourcedId: 'par-1' }] }],
        parents: [{ sourcedId: 'par-1', givenName: 'Chris', familyName: 'Treadaway',
          email: 'dad@example.com' }],
      }),
    });

    // MP: SAME Chris last name + SAME address but different email.
    httpMod.clearTokenCache();
    await connectors.runSync(db, secrets, defaultThresholds(), 'ministry_platform', {
      trigger: 'manual',
      fetchImpl: mpFetch({
        households: [{ Household_ID: 1, Household_Name: 'Treadaway Family', Address_ID: 11 }],
        contacts: [{
          Contact_ID: 100, Household_ID: 1, First_Name: 'Chris', Last_Name: 'Treadaway',
          Email_Address: 'mom-uses-this@example.com',
        }],
        addresses: [{ Address_ID: 11, Address_Line_1: '123 Main St', City: 'St Louis', State_Region: 'MO', Postal_Code: '63101' }],
      }),
    });

    const allConflicts = conflicts.list(db, { status: 'open', limit: 100 });
    // Should have at least one conflict, marked cross_source
    const crossSource = conflicts.list(db, { status: 'open', crossSource: true, limit: 100 });
    assert.ok(crossSource.length >= 1, `expected at least one cross_source conflict, got ${crossSource.length} of ${allConflicts.length}`);
    assert.equal(crossSource[0].metadata.cross_source, true);
    assert.ok(Array.isArray(crossSource[0].metadata.sources));
    assert.ok(crossSource[0].metadata.sources.includes('facts_api'));
    assert.ok(crossSource[0].metadata.sources.includes('ministry_platform_api'));
  } finally {
    db.close();
    cleanup(dir);
  }
});
