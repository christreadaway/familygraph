'use strict';

// FACTS OneRoster v1.1 connector. Pulls users (students, parents) and
// enrollments, joins them by family relationship, and emits canonical
// `{ family, persons[], address }` rows. The output shape is identical to
// what server/sources/facts.js produces from a CSV upload, so the rest of
// the pipeline doesn't care which path the data arrived on.
//
// OneRoster reference (relevant subset):
//   GET /orgs                    → list of schools
//   GET /users?role=student      → students
//   GET /users?role=parent       → parents/guardians
//   GET /enrollments             → student↔class associations (unused in v1)
//
// Each user object has metadata (email, phone, sms) and an `agents` array
// linking parents to children. We rely on `agents` to group parents with
// their kids into a single Family Graph household row.

const http = require('./http');
const log = require('../log');

const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 100;

function _mapAddress(user) {
  // OneRoster doesn't have a strict address shape — vendors put address
  // fields in `metadata` or in the top-level under custom keys. We try a
  // few common shapes and fall back to null.
  const md = user.metadata || {};
  const line1 = md.address || md['address1'] || md['street'] || null;
  if (!line1) return null;
  return {
    line1,
    line2: md['address2'] || null,
    city: md.city || null,
    region: md.state || md.region || null,
    postal: md.zip || md.postal || md.postalCode || null,
    country: md.country || null,
    label: 'home',
  };
}

function _userToPerson(user, role) {
  const emails = [];
  if (user.email) emails.push(String(user.email).toLowerCase().trim());
  if (Array.isArray(user.emails)) for (const e of user.emails) if (e) emails.push(String(e).toLowerCase().trim());
  const phones = [];
  if (user.phone) phones.push(String(user.phone).replace(/\D+/g, ''));
  if (user.sms) phones.push(String(user.sms).replace(/\D+/g, ''));
  return {
    given_name: user.givenName || user.given_name || null,
    family_name: user.familyName || user.family_name || null,
    middle_name: user.middleName || null,
    date_of_birth: user.dateOfBirth || user.birthdate || null,
    gender: user.gender || null,
    grade: user.grade || (user.grades && user.grades[0]) || null,
    emails: [...new Set(emails.filter(Boolean))],
    phones: [...new Set(phones.filter(Boolean))],
    role: role === 'student' ? 'child' : 'parent',
    custody: role === 'student' ? null : 'joint',
    _sourceId: user.sourceedId || user.sourcedId || null,
  };
}

// Group students and parents by their `agents` links into one canonical
// row per household. Vendors structure this differently; the
// canonicalization is best-effort but deterministic — the resolver gets
// the final say on identity.
function buildCanonical({ students = [], parents = [] }) {
  const parentsBySourcedId = new Map();
  for (const p of parents) parentsBySourcedId.set(p.sourcedId || p.sourceedId, p);

  const householdsByKey = new Map();
  function _key(student) {
    const ids = (student.agents || [])
      .map(a => a.sourcedId || a.sourceedId)
      .filter(Boolean)
      .sort()
      .join(',');
    if (ids) return `agents:${ids}`;
    // Fall back to family name + first non-empty address line so siblings
    // without explicit agent links still group together.
    const addr = _mapAddress(student);
    return `family:${student.familyName || ''}|${(addr && addr.line1) || ''}`;
  }

  for (const student of students) {
    const k = _key(student);
    if (!householdsByKey.has(k)) {
      householdsByKey.set(k, {
        family: { display_name: student.familyName ? `${student.familyName} family` : null },
        address: _mapAddress(student),
        persons: [],
        _agents: new Set(),
      });
    }
    const h = householdsByKey.get(k);
    h.persons.push(_userToPerson(student, 'student'));
    if (!h.address) h.address = _mapAddress(student);
    for (const a of student.agents || []) {
      const id = a.sourcedId || a.sourceedId;
      if (id) h._agents.add(id);
    }
  }

  // Attach parents into their student's household.
  for (const h of householdsByKey.values()) {
    for (const id of h._agents) {
      const p = parentsBySourcedId.get(id);
      if (p) {
        const person = _userToPerson(p, 'parent');
        h.persons.push(person);
        if (!h.family.display_name && p.familyName) {
          h.family.display_name = `${p.familyName} family`;
        }
        if (!h.address) {
          const addr = _mapAddress(p);
          if (addr) h.address = addr;
        }
      }
    }
    delete h._agents;
  }

  // Parent-only rows (no children in roster). Useful for parishes that
  // export the same OneRoster feed but have no students.
  const claimedAgentIds = new Set();
  for (const h of householdsByKey.values()) {
    for (const p of h.persons) {
      if (p._sourceId) claimedAgentIds.add(p._sourceId);
    }
  }
  for (const p of parents) {
    const id = p.sourcedId || p.sourceedId;
    if (id && !claimedAgentIds.has(id)) {
      householdsByKey.set(`parent:${id}`, {
        family: { display_name: p.familyName ? `${p.familyName} family` : null },
        address: _mapAddress(p),
        persons: [_userToPerson(p, 'parent')],
      });
    }
  }

  // Strip the internal _sourceId helper before returning.
  for (const h of householdsByKey.values()) {
    for (const p of h.persons) delete p._sourceId;
  }
  return [...householdsByKey.values()];
}

// Paginate against /users?role=… until the vendor stops sending more
// rows. Honours the cursor (dateLastModified) for incremental syncs and
// caps total wall time at the supplied deadline.
async function _fetchUsers({ creds, role, cursor = null, deadlineMs = null, fetchImpl = null, onProgress = null }) {
  const params = new URLSearchParams();
  params.set('role', role);
  params.set('limit', String(PAGE_SIZE));
  if (cursor) {
    // OneRoster filter syntax: filter=dateLastModified>'<iso>'
    params.set('filter', `dateLastModified>'${cursor}'`);
  }
  let offset = 0;
  const out = [];
  let pageCount = 0;
  const phase = role === 'student' ? 'pulling_students' : 'pulling_parents';
  if (onProgress) onProgress(phase, { [`${role}s_pulled`]: 0, page: 0 });
  while (true) {
    if (deadlineMs && Date.now() > deadlineMs) {
      const e = new Error('connector run exceeded 60-minute wall clock budget');
      e.reason = 'timeout';
      throw e;
    }
    const u = new URL(creds.api_base_url.replace(/\/$/, '') + '/users');
    for (const [k, v] of params.entries()) u.searchParams.set(k, v);
    u.searchParams.set('offset', String(offset));
    const data = await http.authedFetch({
      connector: 'facts',
      url: u.toString(),
      tokenUrl: creds.access_token_url,
      clientId: creds.client_id,
      clientSecret: creds.client_secret,
      fetchImpl,
    });
    const users = (data && (data.users || data.data || [])) || [];
    out.push(...users);
    pageCount += 1;
    if (onProgress) onProgress(phase, { [`${role}s_pulled`]: out.length, page: pageCount });
    if (users.length < PAGE_SIZE) break;
    offset += users.length;
    if (PAGE_DELAY_MS > 0) await http.sleep(PAGE_DELAY_MS);
    // Safety: stop after 1000 pages even if the server hands us a
    // non-decreasing cursor.
    if (pageCount > 1000) {
      log.warn('connector.pagination_cap', { connector: 'facts', role, pageCount });
      break;
    }
  }
  return out;
}

// Public: test the credentials by hitting /orgs (1 row, no PII written).
async function testConnection({ creds, fetchImpl = null }) {
  if (!creds.api_base_url) throw _err('config_error', 'api_base_url not set');
  if (!creds.access_token_url) throw _err('config_error', 'access_token_url not set');
  if (!creds.client_id || !creds.client_secret) throw _err('config_error', 'client credentials not set');
  const u = new URL(creds.api_base_url.replace(/\/$/, '') + '/orgs');
  u.searchParams.set('limit', '1');
  const data = await http.authedFetch({
    connector: 'facts',
    url: u.toString(),
    tokenUrl: creds.access_token_url,
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    fetchImpl,
  });
  const orgs = (data && (data.orgs || data.data || [])) || [];
  return { ok: true, sample_count: orgs.length };
}

// Public: pull the full set of canonical rows. Used by sync().
async function pullCanonical({ creds, cursor = null, deadlineMs = null, fetchImpl = null, onProgress = null }) {
  const students = await _fetchUsers({ creds, role: 'student', cursor, deadlineMs, fetchImpl, onProgress });
  const parents = await _fetchUsers({ creds, role: 'parent', cursor, deadlineMs, fetchImpl, onProgress });
  if (onProgress) onProgress('canonicalizing', { students_pulled: students.length, parents_pulled: parents.length });
  const canonical = buildCanonical({ students, parents });
  return {
    canonical,
    metadata: {
      students_pulled: students.length,
      parents_pulled: parents.length,
      cursor_used: cursor || null,
    },
  };
}

function _err(reason, message) {
  const e = new Error(message);
  e.reason = reason;
  return e;
}

module.exports = {
  testConnection,
  pullCanonical,
  buildCanonical,
  PAGE_SIZE,
};
