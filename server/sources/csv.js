'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { applyMapping } = require('./normalize');

// CSV ingest. Heuristic mapping is vendored from missionIQ's ingestion module
// (server/services/ingestion.js): an extensive alias dictionary scored against
// each header with a word-boundary regex, then assigned globally so that
// "Child First Name" wins over generic "first_name" for the child slot.
//
// The flat (field → header) result is translated into the structured
// {family, address, persons[]} mapping the rest of Family Graph already uses.

// Aliases per "flat" canonical field. The shape is a near-direct port of
// missionIQ's STANDARD_FIELDS dictionary, with the missionIQ field names
// mapped to our internal naming:
//
//   first_name           → primary_given_name
//   last_name            → primary_family_name
//   secondary_*          → secondary_*    (parent 2 / spouse / partner)
//   child_first_name     → child_given_name
//   child_last_name      → child_family_name
//   child_birthday       → child_date_of_birth
//   address_line1/2      → line1/line2
//   state                → region
//   zip                  → postal
//   birthday             → date_of_birth
//
// Aliases use lowercase + spaces; we compare against headers normalized to
// lowercase + trimmed whitespace.
const STANDARD_FIELDS = {
  primary_given_name: [
    'first_name', 'firstname', 'first name', 'fname', 'fn', 'first', 'given name', 'given',
    'parent first', 'parent_first', 'guardian first', 'contact first',
    'parent first name', 'guardian first name', 'mom first', 'dad first',
    'parent fn', 'contact fn',
    'parent 1 first name', 'parent 1 first', 'parent1 first', 'parent1 first name',
    'contact 1 first name', 'primary first name', 'primary first',
  ],
  primary_family_name: [
    'last_name', 'lastname', 'last name', 'lname', 'ln', 'last',
    'surname', 'family name', 'parent last', 'parent_last', 'guardian last', 'contact last',
    'parent last name', 'guardian last name', 'mom last', 'dad last',
    'parent ln', 'contact ln',
    'parent 1 last name', 'parent 1 last', 'parent1 last', 'parent1 last name',
    'contact 1 last name', 'primary last name', 'primary last',
  ],
  primary_full_name: [
    'name', 'full name', 'fullname', 'display name', 'displayname',
    'contact name', 'person name', 'person',
    'parent name', 'parent full name', 'guardian name', 'guardian full name',
    'primary name', 'primary contact name', 'head of household', 'hoh',
  ],
  primary_middle_name: ['middle_name', 'middle', 'middlename', 'mname', 'middle initial', 'mi'],
  primary_prefix: ['title', 'prefix', 'salutation'],
  primary_suffix: ['suffix', 'name suffix'],
  secondary_given_name: [
    'parent 2 first name', 'parent 2 first', 'parent2 first', 'parent2 first name',
    'parent2_first', 'parent2_first_name',
    'spouse first name', 'spouse first', 'spouse_first', 'spouse_first_name',
    'contact 2 first name', 'contact 2 first', 'contact2 first',
    'guardian 2 first', 'guardian 2 first name',
    'secondary first name', 'secondary first', 'second parent first', 'other parent first',
    'parent/guardian 2 first', 'p2 first',
    'mom first name', 'father first name', 'mother first name',
    'husband first name', 'husband first', 'wife first name', 'wife first',
    'partner first name', 'partner first',
  ],
  secondary_family_name: [
    'parent 2 last name', 'parent 2 last', 'parent2 last', 'parent2 last name',
    'parent2_last', 'parent2_last_name',
    'spouse last name', 'spouse last', 'spouse_last', 'spouse_last_name',
    'contact 2 last name', 'contact 2 last', 'contact2 last',
    'guardian 2 last', 'guardian 2 last name',
    'secondary last name', 'secondary last', 'second parent last', 'other parent last',
    'parent/guardian 2 last', 'p2 last',
    'mom last name', 'father last name', 'mother last name',
    'husband last name', 'husband last', 'wife last name', 'wife last',
    'partner last name', 'partner last',
  ],
  secondary_full_name: [
    'spouse', 'spouse name', 'spouse full name',
    'partner', 'partner name', 'partner full name',
    'father', 'father name', 'mother', 'mother name',
    'husband', 'husband name', 'wife', 'wife name',
    'parent 2', 'parent 2 name', 'parent2 name',
    'secondary contact', 'secondary contact name',
  ],
  secondary_email: [
    'parent 2 email', 'parent2 email', 'parent2_email',
    'spouse email', 'spouse_email', 'contact 2 email', 'contact2 email',
    'secondary email', 'second email', 'email 2', 'email2',
    'other email', 'alternate email', 'alt email',
    'husband email', 'wife email', 'partner email',
    'father email', 'mother email',
  ],
  secondary_phone: [
    'parent 2 phone', 'parent2 phone', 'parent2_phone',
    'spouse phone', 'spouse_phone', 'contact 2 phone', 'contact2 phone',
    'secondary phone', 'second phone', 'phone 2', 'phone2',
    'other phone', 'alternate phone', 'alt phone',
    'cell 2', 'mobile 2',
    'husband phone', 'wife phone', 'partner phone',
    'father phone', 'mother phone',
  ],
  email: [
    'email', 'email address', 'e-mail', 'em', 'mail',
    'parent email', 'guardian email', 'contact email', 'primary email',
    'email_address', 'email addr', 'e mail', 'home email', 'work email',
    'email 1', 'email1',
  ],
  phone: [
    'phone', 'phone number', 'telephone', 'mobile', 'cell', 'ph', 'tel', 'mob',
    'parent phone', 'home phone', 'primary phone', 'phone_number',
    'cell phone', 'mobile phone', 'phone #', 'ph #', 'phone no',
    'contact phone', 'phone 1', 'phone1', 'cellphone', 'mobilephone',
    'cell number',
  ],
  line1: [
    'address', 'address1', 'address_line1', 'street', 'street address',
    'mailing address', 'address line 1', 'home address', 'address 1',
    'addr', 'addr1', 'street addr', 'mailing addr', 'home addr',
    'street_1',
  ],
  line2: [
    'address2', 'address_line2', 'apt', 'suite', 'unit',
    'address line 2', 'address 2', 'addr2', 'apt #', 'suite #', 'unit #',
  ],
  city: ['city', 'town', 'municipality', 'cty', 'home city', 'mailing city'],
  region: [
    'state', 'state/province', 'state / province', 'province', 'region',
    'state_province', 'st/prov', 'st', 'prov', 'home state', 'mailing state',
  ],
  postal: [
    'zip', 'zipcode', 'zip code', 'postal', 'postal code',
    'zip/postal', 'zip/postal code', 'postcode', 'post code', 'zip_code',
    'home zip', 'mailing zip',
  ],
  country: ['country', 'home country', 'mailing country'],
  child_given_name: [
    'child first name', 'child first', 'child_first', 'child_first_name',
    'student first name', 'student first', 'student_first', 'student_first_name',
    'child name', 'student name', 'pupil first name', 'pupil first',
    'child fn', 'student fn',
  ],
  child_family_name: [
    'child last name', 'child last', 'child_last', 'child_last_name',
    'student last name', 'student last', 'student_last', 'student_last_name',
    'pupil last name', 'pupil last', 'child ln', 'student ln',
  ],
  child_full_name: [
    'student', 'student name', 'student full name',
    'child', 'pupil', 'pupil name',
  ],
  grade: [
    'grade', 'grade level', 'class', 'year', 'current grade',
    'gr', 'grd', 'grade_level', 'class year', 'student grade',
  ],
  date_of_birth: [
    'birthday', 'birthdate', 'birth date', 'birth_date',
    'dob', 'date of birth', 'date_of_birth', 'bday', 'b-day',
    'parent birthday', 'parent dob', 'contact birthday',
  ],
  child_date_of_birth: [
    'child birthday', 'child birthdate', 'child dob', 'child_birthday',
    'child_dob', 'child birth date',
    'student birthday', 'student birthdate', 'student dob',
    'student_birthday', 'student_dob', 'student birth date',
  ],
  gender: ['gender', 'sex'],
  family_display_name: [
    'family', 'family name', 'family name full', 'household', 'household name',
    'family display name', 'household display name',
  ],
  notes: ['notes', 'comments', 'remarks', 'note'],
};

// Platform signatures — vendored from missionIQ. The score is whether any
// signature substring appears in any header (case-insensitive). Highest match
// wins; we surface the platform name in the audit/log so operators know which
// shape was detected.
const PLATFORM_SIGNATURES = {
  facts: ['family_id', 'student_id', 'facts'],
  renweb: ['renweb', 'family id', 'student id'],
  hellofund: ['hellofund', 'campaign', 'supporter'],
  vanco: ['vanco', 'payment_method', 'transaction_id'],
  parishsoft: ['parishsoft', 'envelope', 'family envelope'],
  ministry_platform: ['household_id', 'contact_id'],
};

function detectPlatform(headers) {
  const normalized = headers.map(h => String(h).toLowerCase().trim());
  for (const [platform, sigs] of Object.entries(PLATFORM_SIGNATURES)) {
    if (sigs.some(s => normalized.some(h => h.includes(s)))) return platform;
  }
  return null;
}

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// Score how well a header matches an alias. Vendored from missionIQ.
//   100 — exact match
//    80 — alias appears as a whole word inside the header
//    70 — header appears as a whole word inside the alias
//    50 — header simply contains the alias (alias must be ≥4 chars to avoid false positives)
//     0 — no match
function headerMatchScore(header, alias) {
  const h = String(header).toLowerCase().trim();
  const a = String(alias).toLowerCase().trim();
  if (h === a) return 100;
  const escA = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escH = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:^|[\\s/_\\-])${escA}(?:$|[\\s/_\\-])`, 'i').test(h)) return 80;
  if (new RegExp(`(?:^|[\\s/_\\-])${escH}(?:$|[\\s/_\\-])`, 'i').test(a)) return 70;
  if (a.length >= 4 && h.includes(a)) return 50;
  return 0;
}

// Auto-map source columns to canonical fields using global best-match.
// Returns a flat { field: header } object.
function autoMapFlat(headers) {
  const flat = {};
  const usedHeaders = new Set();
  const usedFields = new Set();

  // Build score list: every (field, header) pair scored.
  const scores = [];
  for (const [field, aliases] of Object.entries(STANDARD_FIELDS)) {
    for (let i = 0; i < headers.length; i++) {
      let best = 0;
      for (const alias of aliases) {
        const s = headerMatchScore(headers[i], alias);
        if (s > best) best = s;
      }
      if (best >= 50) scores.push({ field, headerIdx: i, score: best });
    }
  }

  // Sort highest score first. Tie-break: prefer specific-prefix fields
  // (child_*, secondary_*) so they grab their specific headers first.
  function specificity(field) {
    if (field.startsWith('child_')) return 2;
    if (field.startsWith('secondary_')) return 1;
    return 0;
  }
  scores.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return specificity(b.field) - specificity(a.field);
  });

  for (const { field, headerIdx } of scores) {
    if (usedHeaders.has(headers[headerIdx]) || usedFields.has(field)) continue;
    flat[field] = headers[headerIdx];
    usedHeaders.add(headers[headerIdx]);
    usedFields.add(field);
  }

  return flat;
}

// Translate a flat { field: header } map into the structured Family Graph
// mapping shape: { family, address, persons[] }.
function flatToStructured(flat) {
  const persons = [];

  // Primary adult — uses primary_* fields, falls back to top-level given/family
  // when an unprefixed dataset lands in primary slots via aliases.
  const primary = {
    given_name: flat.primary_given_name || null,
    family_name: flat.primary_family_name || null,
    full_name: flat.primary_full_name || null,
    middle_name: flat.primary_middle_name || null,
    prefix: flat.primary_prefix || null,
    suffix: flat.primary_suffix || null,
    email: flat.email || null,
    phone: flat.phone || null,
    date_of_birth: flat.date_of_birth || null,
    gender: flat.gender || null,
    role: 'member',
  };
  if (
    primary.given_name || primary.family_name || primary.full_name ||
    primary.email || primary.phone
  ) {
    persons.push(primary);
  }

  // Secondary adult (parent 2 / spouse).
  if (
    flat.secondary_given_name || flat.secondary_family_name || flat.secondary_full_name ||
    flat.secondary_email || flat.secondary_phone
  ) {
    persons.push({
      given_name: flat.secondary_given_name || null,
      family_name: flat.secondary_family_name || flat.primary_family_name || null,
      full_name: flat.secondary_full_name || null,
      email: flat.secondary_email || null,
      phone: flat.secondary_phone || null,
      role: 'parent',
    });
  }

  // Child — when a child_* field is present we have a roster shape.
  if (flat.child_given_name || flat.child_family_name || flat.child_full_name) {
    persons.push({
      given_name: flat.child_given_name || null,
      family_name: flat.child_family_name || flat.primary_family_name || null,
      full_name: flat.child_full_name || null,
      grade: flat.grade || null,
      date_of_birth: flat.child_date_of_birth || null,
      role: 'child',
    });
    // If there's a child slot but no adult primary, the primary entry above is
    // misleading (it'd be empty). Promote the child to the only person.
    if (
      !primary.given_name && !primary.family_name && !primary.full_name &&
      !primary.email && !primary.phone
    ) {
      // remove the empty primary placeholder we may have skipped — already
      // handled by the conditional above.
    }
  } else if (flat.grade && persons.length > 0) {
    // No explicit child slot but a grade column exists — annotate the
    // primary person as a child.
    persons[0].grade = flat.grade;
    persons[0].role = 'child';
  }

  return {
    family: {
      display_name: flat.family_display_name || null,
      notes: flat.notes || null,
    },
    address: (flat.line1 || flat.line2 || flat.city || flat.region || flat.postal || flat.country)
      ? {
          line1: flat.line1 || null,
          line2: flat.line2 || null,
          city: flat.city || null,
          region: flat.region || null,
          postal: flat.postal || null,
          country: flat.country || null,
          label: 'home',
        }
      : { label: 'home' },
    persons,
    _flat: flat,            // retained for diagnostics; ignored by applyMapping
  };
}

function inferMapping(headers) {
  if (!headers || headers.length === 0) return flatToStructured({});
  const flat = autoMapFlat(headers);
  return flatToStructured(flat);
}

// Identify and drop summary/totals rows — vendored from missionIQ.
const SUMMARY_KEYWORDS = /^(total|grand total|subtotal|sum|totals|report total|net total|balance)$/i;
function isSummaryRow(row, headers) {
  for (const h of headers) {
    const v = String(row[h] == null ? '' : row[h]).trim();
    if (SUMMARY_KEYWORDS.test(v)) return true;
  }
  return false;
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

function _filterSummaryRows(rows, headers) {
  if (rows.length === 0) return { kept: rows, dropped: 0 };
  const kept = rows.filter(r => !isSummaryRow(r, headers));
  return { kept, dropped: rows.length - kept.length };
}

// Build the audit-friendly "mapping warning" string. Vendored from missionIQ.
function buildMappingWarning(flat) {
  if (!flat) return null;
  const hasIdentity =
    flat.primary_given_name || flat.primary_family_name || flat.primary_full_name ||
    flat.email || flat.phone ||
    flat.child_given_name || flat.child_family_name || flat.child_full_name;
  if (!hasIdentity) {
    return 'No identity columns (name, email, phone) were auto-detected. Review the column mapping before running the import — otherwise every row will be skipped.';
  }
  return null;
}

function _build(records, opts) {
  const headers = records.length > 0 ? Object.keys(records[0]) : [];
  const { kept, dropped } = _filterSummaryRows(records, headers);
  const mapping = opts.mapping || inferMapping(headers);
  const flat = mapping && mapping._flat ? mapping._flat : null;
  const platform = detectPlatform(headers);
  return {
    rows: kept,
    summary_rows_dropped: dropped,
    headers,
    mapping,
    canonical: kept.map(r => applyMapping(r, mapping)),
    platform,
    mapping_warning: buildMappingWarning(flat),
  };
}

function loadFile(filePath, opts = {}) {
  const content = fs.readFileSync(filePath, 'utf8');
  const records = parseCsv(content, opts.parserOptions);
  const out = _build(records, opts);
  out.fileName = path.basename(filePath);
  return out;
}

function loadString(content, opts = {}) {
  const records = parseCsv(content, opts.parserOptions);
  const out = _build(records, opts);
  out.fileName = opts.fileName || 'inline.csv';
  return out;
}

module.exports = {
  loadFile,
  loadString,
  inferMapping,
  parseCsv,
  normalizeHeader,
  headerMatchScore,
  autoMapFlat,
  flatToStructured,
  detectPlatform,
  isSummaryRow,
  buildMappingWarning,
  STANDARD_FIELDS,
  PLATFORM_SIGNATURES,
  // Backwards-compat alias kept in case downstream still imports it.
  HEADER_HEURISTICS: STANDARD_FIELDS,
};
