'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { applyMapping } = require('./normalize');

// Generic CSV ingest. The caller supplies a mapping definition. If no mapping
// is supplied, we infer one based on column-name heuristics.

const HEADER_HEURISTICS = {
  given_name: [
    'first_name', 'firstname', 'first', 'given_name', 'givenname', 'fname',
    'first_nm', 'firstnm', 'given',
  ],
  family_name: [
    'last_name', 'lastname', 'last', 'family_name', 'familyname', 'lname',
    'surname', 'last_nm', 'lastnm',
  ],
  full_name: [
    'name', 'full_name', 'fullname', 'display_name', 'displayname',
    'contact_name', 'person_name', 'person',
  ],
  middle_name: ['middle_name', 'middle', 'middlename', 'mname', 'middle_initial', 'mi'],
  prefix: ['title', 'prefix', 'salutation'],
  suffix: ['suffix'],
  email: [
    'email', 'email_address', 'email_addr', 'e_mail', 'emailaddress',
    'primary_email', 'home_email', 'work_email', 'contact_email', 'email_1',
    'email1',
  ],
  phone: [
    'phone', 'phone_number', 'mobile', 'cell', 'telephone', 'tel',
    'mobile_phone', 'cell_phone', 'home_phone', 'primary_phone', 'phone_1',
    'phone1', 'cellphone', 'mobilephone', 'cellnumber', 'phonenumber',
  ],
  date_of_birth: ['dob', 'date_of_birth', 'birthdate', 'birthday', 'birth_date', 'birth'],
  gender: ['gender', 'sex'],
  grade: ['grade', 'grade_level', 'current_grade', 'student_grade', 'class', 'class_year'],
  family_display_name: [
    'family', 'family_name_full', 'household', 'household_name',
    'family_full_name', 'family_display_name',
  ],
  line1: [
    'address', 'address1', 'address_line_1', 'street', 'street_address',
    'mailing_address', 'home_address', 'street_1', 'addr', 'addr1',
    'addressline1', 'address_1', 'home_street',
  ],
  line2: ['address2', 'address_line_2', 'apt', 'unit', 'suite', 'addr2', 'address_2', 'addressline2'],
  city: ['city', 'town', 'home_city', 'mailing_city'],
  region: ['state', 'region', 'province', 'home_state', 'mailing_state', 'st'],
  postal: ['zip', 'zip_code', 'postal', 'postal_code', 'zipcode', 'home_zip', 'mailing_zip'],
  country: ['country', 'home_country'],
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

const STUDENT_FIRST_PATTERNS = ['student_first_name', 'student_first', 'student_firstname', 'studentfirst', 'studentfirstname'];
const STUDENT_LAST_PATTERNS = ['student_last_name', 'student_last', 'student_lastname', 'studentlast', 'studentlastname'];
const STUDENT_FULL_PATTERNS = ['student_name', 'student_full_name', 'student'];
const STUDENT_GRADE_PATTERNS = ['student_grade', 'studentgrade'];

function _findHeader(headers, candidates) {
  for (const c of candidates) {
    const found = headers.find(h => normalizeHeader(h) === c);
    if (found) return found;
  }
  return null;
}

// Build a person template for a named role prefix (parent_1, father, mother,
// guardian, primary_contact, spouse, husband, wife, hoh, head_of_household).
// Returns the template if any field matched, else null.
function _slotTemplate(headers, prefix, role) {
  const tmpl = {
    given_name: _findHeader(headers, [
      `${prefix}_first_name`, `${prefix}_first`, `${prefix}_firstname`,
      `${prefix}_given_name`, `${prefix}_given`,
    ]),
    family_name: _findHeader(headers, [
      `${prefix}_last_name`, `${prefix}_last`, `${prefix}_lastname`,
      `${prefix}_family_name`, `${prefix}_surname`,
    ]),
    full_name: _findHeader(headers, [
      `${prefix}_name`, `${prefix}_full_name`, `${prefix}_fullname`,
      `${prefix}_display_name`, prefix,
    ]),
    email: _findHeader(headers, [
      `${prefix}_email`, `${prefix}_email_address`, `${prefix}_emailaddress`,
      `${prefix}_e_mail`, `${prefix}_email_1`,
    ]),
    phone: _findHeader(headers, [
      `${prefix}_phone`, `${prefix}_mobile`, `${prefix}_cell`,
      `${prefix}_phone_number`, `${prefix}_telephone`, `${prefix}_cell_phone`,
      `${prefix}_mobile_phone`, `${prefix}_home_phone`, `${prefix}_phone_1`,
    ]),
    role: role || 'parent',
  };
  // Don't claim a generic full_name token (e.g. just "father") if we already
  // claimed a more specific one for the same field elsewhere — that's handled
  // in inferMapping below.
  if (tmpl.given_name || tmpl.family_name || tmpl.full_name || tmpl.email || tmpl.phone) return tmpl;
  return null;
}

// Detect parent / spouse / hoh slots from header names.
function _detectParentTemplates(headers) {
  const slots = [];
  // Numbered: parent_1_*, parent_2_*, ...
  for (let n = 1; n <= 6; n++) {
    const t = _slotTemplate(headers, `parent_${n}`, 'parent');
    if (t) slots.push(t);
  }
  // Named: father_*, mother_*
  for (const role of ['father', 'mother']) {
    const t = _slotTemplate(headers, role, 'parent');
    if (t) slots.push(t);
  }
  // Generic: guardian_*, primary_contact_*, secondary_contact_*
  for (const prefix of ['guardian', 'primary_contact', 'secondary_contact', 'emergency_contact']) {
    const t = _slotTemplate(headers, prefix, 'parent');
    if (t) slots.push(t);
  }
  // Spouse / partner / husband / wife — modeled as a second adult.
  for (const prefix of ['spouse', 'partner', 'husband', 'wife']) {
    const t = _slotTemplate(headers, prefix, 'parent');
    if (t) slots.push(t);
  }
  // Head of household variants.
  for (const prefix of ['hoh', 'head_of_household', 'household_head', 'primary']) {
    const t = _slotTemplate(headers, prefix, 'parent');
    if (t) slots.push(t);
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
  const studentFull = _findHeader(headers, STUDENT_FULL_PATTERNS);
  const studentGrade = _findHeader(headers, STUDENT_GRADE_PATTERNS) || lookup.grade;
  const parentSlots = _detectParentTemplates(headers);

  if (studentFirst || studentLast || studentFull || parentSlots.length > 0) {
    const persons = [];
    if (studentFirst || studentLast || studentFull) {
      persons.push({
        given_name: studentFirst,
        family_name: studentLast,
        full_name: studentFull,
        date_of_birth: lookup.date_of_birth,
        gender: lookup.gender,
        grade: studentGrade,
        role: 'child',
      });
    } else if (lookup.given_name || lookup.family_name || lookup.full_name) {
      persons.push({
        given_name: lookup.given_name,
        family_name: lookup.family_name,
        full_name: lookup.full_name,
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

  // Single-person fallback shape.
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
        full_name: lookup.full_name,
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
    headers,
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
    headers,
    mapping,
    canonical: records.map(r => applyMapping(r, mapping)),
  };
}

module.exports = { loadFile, loadString, inferMapping, parseCsv, normalizeHeader, HEADER_HEURISTICS };
