'use strict';

// FACTS Management Software (the school accounting system) export shape.
// FACTS exports a mix of student-centric and parent-centric rows. The
// canonical shape we receive from FACTS is "one row per student, with
// parent fields suffixed _1 and _2".
//
// The mapping below matches the column names FACTS uses in its standard
// "Family List" export. Operators with non-standard exports can supply a
// custom mapping in the bulk import wizard.

const csv = require('./csv');
const { applyMapping } = require('./normalize');

const FACTS_MAPPING = {
  family: {
    display_name: ['Family Name', 'family_name', 'Household'],
    notes: 'Family Notes',
  },
  address: {
    line1: ['Family Address', 'address', 'Street'],
    line2: ['Family Address 2', 'address2'],
    city: ['Family City', 'city'],
    region: ['Family State', 'state'],
    postal: ['Family Zip', 'zip', 'Postal Code'],
    country: ['Country'],
    label: 'home',
  },
  persons: [
    {
      given_name: ['Student First Name', 'student_first', 'First Name'],
      family_name: ['Student Last Name', 'student_last', 'Last Name'],
      middle_name: 'Student Middle Name',
      // Real-world FACTS exports use both 'DOB' and 'Student DOB'; accept either.
      date_of_birth: ['DOB', 'Student DOB', 'Student Date of Birth', 'Date of Birth', 'Birthdate'],
      gender: ['Gender', 'Sex'],
      grade: ['Grade', 'Grade Level', 'Current Grade', 'Student Grade'],
      role: 'child',
    },
    {
      given_name: ['Parent 1 First Name', 'parent_1_first'],
      family_name: ['Parent 1 Last Name', 'parent_1_last'],
      email: ['Parent 1 Email', 'parent_1_email'],
      phone: ['Parent 1 Phone', 'parent_1_mobile'],
      role: 'parent',
      custody: 'joint',
    },
    {
      given_name: ['Parent 2 First Name', 'parent_2_first'],
      family_name: ['Parent 2 Last Name', 'parent_2_last'],
      email: ['Parent 2 Email', 'parent_2_email'],
      phone: ['Parent 2 Phone', 'parent_2_mobile'],
      role: 'parent',
      custody: 'joint',
    },
  ],
};

// When the caller passes an explicit `mapping` (anything truthy), respect it.
// Otherwise fall back to FACTS_MAPPING. The earlier shape `{ mapping:
// FACTS_MAPPING, ...opts }` was wrong: a caller passing `mapping: null` (the
// API does this when the operator hasn't customized anything) ended up
// nulling out FACTS_MAPPING entirely, so the inferred mapper ran instead.
function _resolvedOpts(opts) {
  return { ...opts, mapping: opts.mapping || FACTS_MAPPING };
}

function loadFile(filePath, opts = {}) {
  const out = csv.loadFile(filePath, _resolvedOpts(opts));
  out.source = 'facts';
  return out;
}

function loadString(content, opts = {}) {
  const out = csv.loadString(content, _resolvedOpts(opts));
  out.source = 'facts';
  return out;
}

function detect(headers) {
  const set = new Set(headers.map(h => String(h).toLowerCase()));
  let score = 0;
  if (set.has('student first name')) score += 2;
  if (set.has('parent 1 first name') || set.has('parent_1_first_name')) score += 2;
  if (set.has('family name')) score += 1;
  return score;
}

module.exports = { loadFile, loadString, detect, FACTS_MAPPING };
