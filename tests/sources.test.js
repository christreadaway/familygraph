'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sources = require('../server/sources');
const csv = require('../server/sources/csv');
const facts = require('../server/sources/facts');
const renweb = require('../server/sources/renweb');
const mp = require('../server/sources/ministry-platform');

test('sources > generic CSV inferred mapping', () => {
  const data = `first_name,last_name,email,phone,city,state,zip
Mary,Smith,mary@example.org,415-555-0100,Lima,OH,45801
John,Smith,john@example.org,415-555-0101,Lima,OH,45801
`;
  const out = csv.loadString(data);
  assert.equal(out.rows.length, 2);
  assert.equal(out.canonical[0].persons[0].given_name, 'Mary');
  assert.equal(out.canonical[0].persons[0].family_name, 'Smith');
  assert.equal(out.canonical[0].persons[0].emails[0], 'mary@example.org');
  assert.equal(out.canonical[0].address.city, 'Lima');
});

test('sources > FACTS shape', () => {
  const data =
    `Family Name,Family Address,Family City,Family State,Family Zip,Student First Name,Student Last Name,Parent 1 First Name,Parent 1 Last Name,Parent 1 Email,Parent 2 First Name,Parent 2 Last Name,Parent 2 Email
Smith,12 Maple St,Lima,OH,45801,Lucy,Smith,Mary,Smith,mary@example.org,John,Smith,john@example.org
`;
  const out = facts.loadString(data);
  assert.equal(out.canonical.length, 1);
  const r = out.canonical[0];
  assert.equal(r.family.display_name, 'Smith');
  assert.equal(r.address.line1, '12 Maple St');
  assert.equal(r.persons.length, 3);
  const roles = r.persons.map(p => p.role).sort();
  assert.deepEqual(roles, ['child', 'parent', 'parent']);
});

test('sources > RenWeb shape', () => {
  const data =
    `FamilyName,HomeAddress1,HomeCity,HomeState,HomeZip,StudentFirst,StudentLast,FatherFirst,FatherLast,FatherEmail,MotherFirst,MotherLast,MotherEmail
Doe,1 Main,Lima,OH,45801,Anna,Doe,John,Doe,john@d.com,Mary,Doe,mary@d.com
`;
  const out = renweb.loadString(data);
  assert.equal(out.canonical.length, 1);
  const r = out.canonical[0];
  assert.equal(r.persons.length, 3);
  assert.equal(r.persons[1].given_name, 'John'); // Father
  assert.equal(r.persons[2].given_name, 'Mary'); // Mother
});

test('sources > Ministry Platform shape', () => {
  const data =
    `Household_ID,Household_Name,Address_Line_1,City,State_Region,Postal_Code,Contact_ID,First_Name,Last_Name,Email_Address,Mobile_Phone
1,The Doe Family,1 Main,Lima,OH,45801,5,Mary,Doe,mary@d.com,415-555-0100
1,The Doe Family,1 Main,Lima,OH,45801,6,John,Doe,john@d.com,415-555-0101
`;
  const out = mp.loadString(data);
  assert.equal(out.canonical.length, 2);
  assert.equal(out.canonical[0].family.display_name, 'The Doe Family');
  assert.equal(out.canonical[0].persons[0].emails[0], 'mary@d.com');
});

test('sources > detection picks the right handler from headers', () => {
  assert.equal(sources.detectSource(['Student First Name', 'Parent 1 First Name', 'Family Name']), 'facts');
  assert.equal(sources.detectSource(['StudentFirst', 'FatherFirst', 'MotherFirst']), 'renweb');
  assert.equal(sources.detectSource(['Household_ID', 'Contact_ID', 'Email_Address']), 'ministry_platform');
  assert.equal(sources.detectSource(['first_name', 'last_name', 'email']), 'csv');
});

test('sources > BOM-prefixed CSV is parsed', () => {
  const data = '﻿first_name,last_name\nMary,Smith\n';
  const out = csv.loadString(data);
  assert.equal(out.rows.length, 1);
  assert.equal(out.canonical[0].persons[0].given_name, 'Mary');
});

test('sources > empty rows are skipped', () => {
  const data = 'first_name,last_name\nMary,Smith\n\n,\n';
  const out = csv.loadString(data);
  // csv-parse skip_empty_lines drops blank lines; rows with empty fields persist
  // but produce no canonical persons.
  const peopleRows = out.canonical.flatMap(c => c.persons);
  assert.equal(peopleRows.length, 1);
});
