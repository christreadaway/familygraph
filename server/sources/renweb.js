'use strict';

// RenWeb (now FACTS SIS) "Family Roster" export. Newer FACTS exports are
// labeled the same way; this handler covers RenWeb's older column names.

const csv = require('./csv');

const RENWEB_MAPPING = {
  family: {
    display_name: ['FamilyName', 'Family Name'],
  },
  address: {
    line1: ['HomeAddress1', 'Address1'],
    line2: ['HomeAddress2', 'Address2'],
    city: ['HomeCity', 'City'],
    region: ['HomeState', 'State'],
    postal: ['HomeZip', 'Zip'],
    country: ['HomeCountry', 'Country'],
    label: 'home',
  },
  persons: [
    {
      given_name: ['StudentFirst', 'StudentFirstName'],
      family_name: ['StudentLast', 'StudentLastName'],
      middle_name: 'StudentMiddle',
      date_of_birth: 'StudentDOB',
      gender: 'StudentGender',
      role: 'child',
    },
    {
      given_name: ['Father First', 'FatherFirst', 'FatherFirstName'],
      family_name: ['Father Last', 'FatherLast', 'FatherLastName'],
      email: ['FatherEmail'],
      phone: ['FatherCell', 'FatherPhone'],
      role: 'parent',
    },
    {
      given_name: ['Mother First', 'MotherFirst', 'MotherFirstName'],
      family_name: ['Mother Last', 'MotherLast', 'MotherLastName'],
      email: ['MotherEmail'],
      phone: ['MotherCell', 'MotherPhone'],
      role: 'parent',
    },
  ],
};

function loadFile(filePath, opts = {}) {
  const out = csv.loadFile(filePath, { mapping: RENWEB_MAPPING, ...opts });
  out.source = 'renweb';
  return out;
}

function loadString(content, opts = {}) {
  const out = csv.loadString(content, { mapping: RENWEB_MAPPING, ...opts });
  out.source = 'renweb';
  return out;
}

function detect(headers) {
  const set = new Set(headers.map(h => String(h)));
  let score = 0;
  if (set.has('FatherFirst') || set.has('FatherFirstName')) score += 2;
  if (set.has('MotherFirst') || set.has('MotherFirstName')) score += 2;
  if (set.has('StudentFirst') || set.has('StudentFirstName')) score += 1;
  return score;
}

module.exports = { loadFile, loadString, detect, RENWEB_MAPPING };
