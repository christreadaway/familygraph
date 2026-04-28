'use strict';

// Ministry Platform (parish management system) "Households + Contacts" export.
// Ministry Platform uses CamelCase column names that look like SQL columns.

const csv = require('./csv');

const MP_MAPPING = {
  family: {
    display_name: ['Household_Name', 'HouseholdName'],
  },
  address: {
    line1: ['Address_Line_1', 'AddressLine1'],
    line2: ['Address_Line_2', 'AddressLine2'],
    city: ['City', 'CityRegion_City'],
    region: ['State_Region', 'StateRegion'],
    postal: ['Postal_Code', 'PostalCode'],
    country: ['Country', 'Country_Code'],
    label: 'home',
  },
  persons: [
    {
      given_name: ['First_Name', 'Nickname'],
      family_name: ['Last_Name'],
      middle_name: 'Middle_Name',
      prefix: 'Prefix',
      suffix: 'Suffix',
      email: 'Email_Address',
      phone: ['Mobile_Phone', 'Home_Phone'],
      date_of_birth: 'Date_of_Birth',
      gender: 'Gender',
      role: 'member',
    },
  ],
};

function loadFile(filePath, opts = {}) {
  const out = csv.loadFile(filePath, { mapping: MP_MAPPING, ...opts });
  out.source = 'ministry_platform';
  return out;
}

function loadString(content, opts = {}) {
  const out = csv.loadString(content, { mapping: MP_MAPPING, ...opts });
  out.source = 'ministry_platform';
  return out;
}

function detect(headers) {
  const set = new Set(headers);
  let score = 0;
  if (set.has('Household_ID') || set.has('Household_Name')) score += 2;
  if (set.has('Contact_ID')) score += 2;
  if (set.has('Email_Address')) score += 1;
  return score;
}

module.exports = { loadFile, loadString, detect, MP_MAPPING };
