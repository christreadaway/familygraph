'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { applyMapping } = require('./normalize');

// Generic CSV ingest. The caller supplies a mapping definition. If no mapping
// is supplied, we infer one based on column-name heuristics.

const HEADER_HEURISTICS = {
  given_name: ['first_name', 'firstname', 'first', 'given_name', 'givenname', 'fname'],
  family_name: ['last_name', 'lastname', 'last', 'family_name', 'familyname', 'lname', 'surname'],
  middle_name: ['middle_name', 'middle', 'middlename', 'mname'],
  prefix: ['title', 'prefix', 'salutation'],
  suffix: ['suffix'],
  email: ['email', 'email_address', 'email_addr', 'e_mail'],
  phone: ['phone', 'phone_number', 'mobile', 'cell', 'telephone'],
  date_of_birth: ['dob', 'date_of_birth', 'birthdate', 'birthday'],
  gender: ['gender', 'sex'],
  family_display_name: ['family', 'family_name_full', 'household', 'household_name'],
  line1: ['address', 'address1', 'address_line_1', 'street', 'street_address'],
  line2: ['address2', 'address_line_2', 'apt', 'unit', 'suite'],
  city: ['city', 'town'],
  region: ['state', 'region', 'province'],
  postal: ['zip', 'zip_code', 'postal', 'postal_code'],
  country: ['country'],
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function inferMapping(headers) {
  const lookup = {};
  for (const [field, candidates] of Object.entries(HEADER_HEURISTICS)) {
    for (const c of candidates) {
      const found = headers.find(h => normalizeHeader(h) === c);
      if (found) {
        lookup[field] = found;
        break;
      }
    }
  }
  return {
    family: { display_name: lookup.family_display_name },
    address: {
      line1: lookup.line1,
      line2: lookup.line2,
      city: lookup.city,
      region: lookup.region,
      postal: lookup.postal,
      country: lookup.country,
      label: 'home',
    },
    persons: [
      {
        given_name: lookup.given_name,
        family_name: lookup.family_name,
        middle_name: lookup.middle_name,
        prefix: lookup.prefix,
        suffix: lookup.suffix,
        email: lookup.email,
        phone: lookup.phone,
        date_of_birth: lookup.date_of_birth,
        gender: lookup.gender,
        role: 'member',
      },
    ],
  };
}

function parseCsv(content, opts = {}) {
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
    ...opts,
  });
}

function loadFile(filePath, opts = {}) {
  const content = fs.readFileSync(filePath, 'utf8');
  const records = parseCsv(content, opts.parserOptions);
  const headers = records.length > 0 ? Object.keys(records[0]) : [];
  const mapping = opts.mapping || inferMapping(headers);
  return {
    fileName: path.basename(filePath),
    rows: records,
    mapping,
    canonical: records.map(r => applyMapping(r, mapping)),
  };
}

function loadString(content, opts = {}) {
  const records = parseCsv(content, opts.parserOptions);
  const headers = records.length > 0 ? Object.keys(records[0]) : [];
  const mapping = opts.mapping || inferMapping(headers);
  return {
    fileName: opts.fileName || 'inline.csv',
    rows: records,
    mapping,
    canonical: records.map(r => applyMapping(r, mapping)),
  };
}

module.exports = { loadFile, loadString, inferMapping, parseCsv, normalizeHeader, HEADER_HEURISTICS };
