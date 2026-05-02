'use strict';

// Ministry Platform REST API connector. The API exposes table-shaped
// endpoints — `/tables/Households`, `/tables/Contacts`, `/tables/Addresses`
// — that return JSON arrays. Joins are performed client-side via
// Household_ID. Field names are MP's CamelCase convention.
//
// Auth: OAuth 2.0 client_credentials. The discovery URL is optional and
// auto-derived from the API base URL when missing — the convention is
// `<api_base>/oauth/connect/token`. We do not currently parse the OIDC
// metadata document; we just hit the token endpoint directly.

const http = require('./http');
const log = require('../log');

const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 100;

function _tokenUrl(creds) {
  if (creds.oauth_discovery_url) {
    // If the operator pasted the discovery URL, assume it's the token
    // endpoint directly. (Real OIDC discovery would parse the JSON
    // metadata document; MP's convention is to give the token URL
    // directly.)
    return creds.oauth_discovery_url;
  }
  const base = String(creds.api_base_url || '').replace(/\/+$/, '');
  if (!base) throw _err('config_error', 'api_base_url not set');
  // Strip a trailing /ministryplatformapi if present so we land on the
  // canonical /oauth/connect/token endpoint.
  const root = base.replace(/\/ministryplatformapi$/, '');
  return `${root}/ministryplatformapi/oauth/connect/token`;
}

function _addressOf(household, addressesById) {
  if (!household.Address_ID) return null;
  const addr = addressesById.get(Number(household.Address_ID));
  if (!addr) return null;
  return {
    line1: addr.Address_Line_1 || addr.Address_Line_1_ || null,
    line2: addr.Address_Line_2 || null,
    city: addr.City || null,
    region: addr.State_Region || addr.State || null,
    postal: addr.Postal_Code || null,
    country: addr.Country || null,
    label: 'home',
  };
}

function _contactToPerson(contact) {
  const emails = [];
  if (contact.Email_Address) emails.push(String(contact.Email_Address).toLowerCase().trim());
  const phones = [];
  if (contact.Mobile_Phone) phones.push(String(contact.Mobile_Phone).replace(/\D+/g, ''));
  if (contact.Home_Phone) phones.push(String(contact.Home_Phone).replace(/\D+/g, ''));
  return {
    given_name: contact.Nickname || contact.First_Name || null,
    family_name: contact.Last_Name || null,
    middle_name: contact.Middle_Name || null,
    prefix: contact.Prefix || null,
    suffix: contact.Suffix || null,
    date_of_birth: contact.Date_of_Birth ? String(contact.Date_of_Birth).slice(0, 10) : null,
    gender: contact.Gender || null,
    emails: [...new Set(emails.filter(Boolean))],
    phones: [...new Set(phones.filter(Boolean))],
    role: 'member',
  };
}

function buildCanonical({ households = [], contacts = [], addresses = [] }) {
  const addressesById = new Map();
  for (const a of addresses) addressesById.set(Number(a.Address_ID), a);

  const out = [];
  const householdsById = new Map();
  for (const h of households) householdsById.set(Number(h.Household_ID), h);

  // Group contacts by Household_ID. Skip contacts with no household — they
  // become single-person rows so we don't drop the data.
  const byHousehold = new Map();
  const orphanContacts = [];
  for (const c of contacts) {
    const hid = c.Household_ID == null ? null : Number(c.Household_ID);
    if (hid && householdsById.has(hid)) {
      if (!byHousehold.has(hid)) byHousehold.set(hid, []);
      byHousehold.get(hid).push(c);
    } else {
      orphanContacts.push(c);
    }
  }

  for (const h of households) {
    const hid = Number(h.Household_ID);
    const hContacts = byHousehold.get(hid) || [];
    out.push({
      family: {
        display_name: h.Household_Name || null,
      },
      address: _addressOf(h, addressesById),
      persons: hContacts.map(_contactToPerson),
    });
  }
  for (const c of orphanContacts) {
    out.push({
      family: {
        display_name: c.Last_Name ? `${c.Last_Name} family` : null,
      },
      address: null,
      persons: [_contactToPerson(c)],
    });
  }
  return out;
}

async function _fetchTable({ creds, table, cursor = null, cursorField = null, deadlineMs = null, fetchImpl = null, onProgress = null }) {
  const out = [];
  let page = 0;
  const phase = `pulling_${table.toLowerCase()}`;
  const counterKey = `${table.toLowerCase()}_pulled`;
  if (onProgress) onProgress(phase, { [counterKey]: 0, page: 0 });
  while (true) {
    if (deadlineMs && Date.now() > deadlineMs) {
      throw _err('timeout', 'connector run exceeded 60-minute wall clock budget');
    }
    const u = new URL(String(creds.api_base_url).replace(/\/+$/, '') + `/tables/${table}`);
    u.searchParams.set('$top', String(PAGE_SIZE));
    u.searchParams.set('$skip', String(page * PAGE_SIZE));
    if (cursor && cursorField) {
      u.searchParams.set('$filter', `${cursorField} > '${cursor}'`);
    }
    const data = await http.authedFetch({
      connector: 'ministry_platform',
      url: u.toString(),
      tokenUrl: _tokenUrl(creds),
      clientId: creds.client_id,
      clientSecret: creds.client_secret,
      scope: 'http://www.thinkministry.com/dataplatform/scopes/all',
      fetchImpl,
    });
    const rows = Array.isArray(data) ? data : (data && (data.value || data.data || data.items)) || [];
    out.push(...rows);
    page += 1;
    if (onProgress) onProgress(phase, { [counterKey]: out.length, page });
    if (rows.length < PAGE_SIZE) break;
    if (PAGE_DELAY_MS > 0) await http.sleep(PAGE_DELAY_MS);
    if (page > 1000) {
      log.warn('connector.pagination_cap', { connector: 'ministry_platform', table, page });
      break;
    }
  }
  return out;
}

async function testConnection({ creds, fetchImpl = null }) {
  if (!creds.api_base_url) throw _err('config_error', 'api_base_url not set');
  if (!creds.client_id || !creds.client_secret) throw _err('config_error', 'client credentials not set');
  const u = new URL(String(creds.api_base_url).replace(/\/+$/, '') + '/tables/Households');
  u.searchParams.set('$top', '1');
  const data = await http.authedFetch({
    connector: 'ministry_platform',
    url: u.toString(),
    tokenUrl: _tokenUrl(creds),
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    scope: 'http://www.thinkministry.com/dataplatform/scopes/all',
    fetchImpl,
  });
  const rows = Array.isArray(data) ? data : (data && (data.value || data.data || data.items)) || [];
  return { ok: true, sample_count: rows.length };
}

async function pullCanonical({ creds, cursor = null, deadlineMs = null, fetchImpl = null, onProgress = null }) {
  const households = await _fetchTable({
    creds, table: 'Households', deadlineMs, fetchImpl, onProgress,
    cursor, cursorField: cursor ? 'Date_Modified' : null,
  });
  const contacts = await _fetchTable({
    creds, table: 'Contacts', deadlineMs, fetchImpl, onProgress,
    cursor, cursorField: cursor ? 'Date_Modified' : null,
  });
  const addresses = await _fetchTable({
    creds, table: 'Addresses', deadlineMs, fetchImpl, onProgress,
  });
  if (onProgress) {
    onProgress('canonicalizing', {
      households_pulled: households.length,
      contacts_pulled: contacts.length,
      addresses_pulled: addresses.length,
    });
  }
  const canonical = buildCanonical({ households, contacts, addresses });
  return {
    canonical,
    metadata: {
      households_pulled: households.length,
      contacts_pulled: contacts.length,
      addresses_pulled: addresses.length,
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
  _tokenUrl,
};
