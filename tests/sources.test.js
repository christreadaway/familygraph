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

test('sources > full-name column splits when no first/last present', () => {
  const data = 'Name,Email,Phone\nMary Smith,mary@example.org,415-555-0100\nJohn Q. Smith,john@example.org,\n';
  const out = csv.loadString(data);
  assert.equal(out.canonical.length, 2);
  assert.equal(out.canonical[0].persons[0].given_name, 'Mary');
  assert.equal(out.canonical[0].persons[0].family_name, 'Smith');
  assert.equal(out.canonical[1].persons[0].given_name, 'John');
  assert.equal(out.canonical[1].persons[0].family_name, 'Smith');
  assert.equal(out.canonical[1].persons[0].middle_name, 'Q.');
});

test('sources > "Last, First" full-name column splits correctly', () => {
  const data = 'Name\n"Smith, Mary"\n"Doe, John Quincy"\n';
  const out = csv.loadString(data);
  assert.equal(out.canonical[0].persons[0].given_name, 'Mary');
  assert.equal(out.canonical[0].persons[0].family_name, 'Smith');
  assert.equal(out.canonical[1].persons[0].given_name, 'John');
  assert.equal(out.canonical[1].persons[0].family_name, 'Doe');
  assert.equal(out.canonical[1].persons[0].middle_name, 'Quincy');
});

test('sources > spouse / husband / wife slots produce parent templates', () => {
  const data = 'First Name,Last Name,Spouse First Name,Spouse Last Name,Spouse Email\nMary,Smith,John,Smith,john@example.org\n';
  const out = csv.loadString(data);
  const persons = out.canonical[0].persons;
  assert.equal(persons.length, 2);
  const spouse = persons.find(p => p.given_name === 'John');
  assert.ok(spouse);
  assert.equal(spouse.role, 'parent');
  assert.equal(spouse.emails[0], 'john@example.org');
});

test('sources > headers, when nothing matches, produce zero persons (caller can detect)', () => {
  const data = 'foo,bar,baz\n1,2,3\n';
  const out = csv.loadString(data);
  assert.equal(out.canonical[0].persons.length, 0);
  assert.deepEqual(out.headers, ['foo', 'bar', 'baz']);
});

test('sources > scored auto-mapper picks specific over generic (Child First Name)', () => {
  const data = 'First Name,Last Name,Child First Name,Child Last Name,Grade\nMary,Smith,Lucy,Smith,3\n';
  const out = csv.loadString(data);
  const persons = out.canonical[0].persons;
  // Adult primary + child
  const child = persons.find(p => p.role === 'child');
  const adult = persons.find(p => p.role !== 'child');
  assert.ok(child, 'expected a child person');
  assert.equal(child.given_name, 'Lucy');
  assert.equal(adult.given_name, 'Mary');
});

test('sources > Excel serial DOB normalizes to ISO via applyMapping', () => {
  const data = 'first_name,last_name,date_of_birth\nMary,Smith,40179\n';
  const out = csv.loadString(data);
  // Excel serial 40179 = 2010-01-01 (epoch Dec 30 1899)
  assert.equal(out.canonical[0].persons[0].date_of_birth, '2010-01-01');
});

test('sources > concatenated phone splits into multiple values per person', () => {
  const data = 'first_name,last_name,phone\nMary,Smith,+13143783612+13145607897\n';
  const out = csv.loadString(data);
  assert.deepEqual(out.canonical[0].persons[0].phones, ['3143783612', '3145607897']);
});

test('sources > "Total" / "Grand Total" rows are dropped', () => {
  const data = 'first_name,last_name\nMary,Smith\nGrand Total,\nJohn,Doe\nTotal,\n';
  const out = csv.loadString(data);
  assert.equal(out.summary_rows_dropped, 2);
  assert.equal(out.canonical.length, 2);
});

test('sources > mapping warning fires when no identity columns detected', () => {
  const data = 'foo,bar,baz\n1,2,3\n';
  const out = csv.loadString(data);
  assert.match(out.mapping_warning, /No identity columns/);
});

test('matching > exact email match is definitive even with different last names', () => {
  const m = require('../server/identity/matching');
  const r = m.scoreMatch(
    { given_name: 'Mary', family_name: 'Escamilla', email: 'mary@example.org' },
    { given_name: 'Mary', family_name: 'Torre',     email: 'mary@example.org' },
  );
  assert.equal(r.definitive, true);
  assert.ok(r.confidence >= 0.95);
  assert.ok(r.reasons.includes('exact_email_match'));
});

test('matching > different states veto a definitive email match', () => {
  const m = require('../server/identity/matching');
  const r = m.scoreMatch(
    { given_name: 'Mary', family_name: 'Smith', email: 'mary@example.org', address_line1: '12 Maple St', state: 'TX' },
    { given_name: 'Mary', family_name: 'Smith', email: 'mary@example.org', address_line1: '88 Oak Ave',  state: 'NY' },
  );
  // Cross-state with same email = different households (gen-share / inherited inbox).
  // Confidence is capped below auto-merge so the operator must decide.
  assert.equal(r.definitive, false);
  assert.ok(r.confidence < 0.85);
  assert.ok(r.reasons.includes('address_conflict_present'));
});

test('matching > Tim/Timothy nickname match', () => {
  const m = require('../server/identity/matching');
  const r = m.scoreMatch(
    { given_name: 'Tim',     family_name: 'Smith' },
    { given_name: 'Timothy', family_name: 'Smith' },
  );
  // Last name exact + nickname → above review threshold but typically below auto-merge
  // unless an address/email/phone signal is also present. That is the desired behavior.
  assert.ok(r.confidence >= 0.40 && r.confidence < 0.85);
  assert.ok(r.reasons.includes('nickname_or_short_form'));
});

test('matching > Smith Jr. matches Smith (suffix-aware)', () => {
  const m = require('../server/identity/matching');
  const r = m.scoreMatch(
    { given_name: 'John', family_name: 'Smith Jr.' },
    { given_name: 'John', family_name: 'Smith' },
  );
  assert.ok(r.reasons.includes('exact_last_name') || r.reasons.includes('similar_last_name'));
});

test('matching > address match auto-merges even with different last names', () => {
  const m = require('../server/identity/matching');
  const r = m.scoreMatch(
    { given_name: 'Mary', family_name: 'Escamilla', address_line1: '123 Main Street', city: 'Lima', state: 'OH' },
    { given_name: 'John', family_name: 'Torre',     address_line1: '123 Main St',     city: 'Lima', state: 'OH' },
  );
  assert.ok(r.confidence >= 0.85);
  assert.ok(r.reasons.includes('address_match_household'));
});

test('matching > "Timothy & Mary" matches Timothy', () => {
  const m = require('../server/identity/matching');
  const r = m.scoreMatch(
    { given_name: 'Timothy & Mary', family_name: 'Smith' },
    { given_name: 'Timothy',         family_name: 'Smith' },
  );
  assert.ok(r.reasons.includes('exact_first_name') || r.reasons.includes('nickname_or_short_form'));
});
