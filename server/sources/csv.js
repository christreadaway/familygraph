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
  grade: ['grade', 'grade_level', 'current_grade', 'student_grade'],
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

const STUDENT_FIRST_PATTERNS = ['student_first_name', 'student_first', 'student_firstname', 'studentfirst', 'studentfirstname'];
const STUDENT_LAST_PATTERNS = ['student_last_name', 'student_last', 'student_lastname', 'studentlast', 'studentlastname'];
const STUDENT_GRADE_PATTERNS = ['student_grade', 'studentgrade'];

function _findHeader(headers, candidates) {
  for (const c of candidates) {
    const found = headers.find(h => normalizeHeader(h) === c);
    if (found) return found;
  }
  return null;
}

// Detect parent slots like Parent 1 First Name / Father First / Mother Email.
// Returns an array of person templates for parents that appear in the headers.
function _detectParentTemplates(headers) {
  const slots = [];
  // Numbered: parent_1_*, parent_2_*, ...
  for (let n = 1; n <= 4; n++) {
    const tmpl = {
      given_name: _findHeader(headers, [`parent_${n}_first_name`, `parent_${n}_first`, `parent_${n}_firstname`]),
      family_name: _findHeader(headers, [`parent_${n}_last_name`, `parent_${n}_last`, `parent_${n}_lastname`]),
      email: _findHeader(headers, [`parent_${n}_email`, `parent_${n}_email_address`]),
      phone: _findHeader(headers, [`parent_${n}_phone`, `parent_${n}_mobile`, `parent_${n}_cell`]),
      role: 'parent',
    };
    if (tmpl.given_name || tmpl.family_name || tmpl.email || tmpl.phone) slots.push(tmpl);
  }
  // Named: father_*, mother_*
  for (const role of ['father', 'mother']) {
    const tmpl = {
      given_name: _findHeader(headers, [`${role}_first_name`, `${role}_first`, `${role}_firstname`]),
      family_name: _findHeader(headers, [`${role}_last_name`, `${role}_last`, `${role}_lastname`]),
      email: _findHeader(headers, [`${role}_email`]),
      phone: _findHeader(headers, [`${role}_phone`, `${role}_mobile`, `${role}_cell`]),
      role: 'parent',
    };
    if (tmpl.given_name || tmpl.family_name || tmpl.email || tmpl.phone) slots.push(tmpl);
  }
  // Generic: guardian_*, primary_contact_*
  for (const prefix of ['guardian', 'primary_contact']) {
    const tmpl = {
      given_name: _findHeader(headers, [`${prefix}_first_name`, `${prefix}_first`, `${prefix}_name`]),
      family_name: _findHeader(headers, [`${prefix}_last_name`, `${prefix}_last`]),
      email: _findHeader(headers, [`${prefix}_email`]),
      phone: _findHeader(headers, [`${prefix}_phone`, `${prefix}_mobile`]),
      role: 'parent',
    };
    if (tmpl.given_name || tmpl.email || tmpl.phone) slots.push(tmpl);
  }
  return slots;
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

  // Try the school-roster shape: student fields + parent slots.
  const studentFirst = _findHeader(headers, STUDENT_FIRST_PATTERNS);
  const studentLast = _findHeader(headers, STUDENT_LAST_PATTERNS);
  const studentGrade = _findHeader(headers, STUDENT_GRADE_PATTERNS) || lookup.grade;
  const parentSlots = _detectParentTemplates(headers);

  if (studentFirst || studentLast || parentSlots.length > 0) {
    const persons = [];
    if (studentFirst || studentLast) {
      persons.push({
        given_name: studentFirst,
        family_name: studentLast,
        date_of_birth: lookup.date_of_birth,
        gender: lookup.gender,
        grade: studentGrade,
        role: 'child',
      });
    } else if (lookup.given_name || lookup.family_name) {
      // Fallback: a single named person who has a grade — treat as a kid.
      persons.push({
        given_name: lookup.given_name,
        family_name: lookup.family_name,
        date_of_birth: lookup.date_of_birth,
        gender: lookup.gender,
        grade: lookup.grade,
        role: lookup.grade ? 'child' : 'member',
      });
    }
    persons.push(...parentSlots);
    return {
      family: { display_name: lookup.family_display_name },
      address: {
        line1: lookup.line1, line2: lookup.line2, city: lookup.city,
        region: lookup.region, postal: lookup.postal, country: lookup.country,
        label: 'home',
      },
      persons,
    };
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
        grade: lookup.grade,
        role: lookup.grade ? 'child' : 'member',
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
