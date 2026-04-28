'use strict';

// Map a vendor row + a field-mapping definition into Custos's canonical shape.
// Canonical shape:
//   {
//     family: { display_name, notes },
//     persons: [{ given_name, family_name, middle_name, prefix, suffix,
//                 date_of_birth, gender, role, custody, emails:[], phones:[] }],
//     address: { line1, line2, city, region, postal, country, label }
//   }

function pick(row, keys) {
  if (!Array.isArray(keys)) keys = [keys];
  for (const k of keys) {
    if (k && row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') {
      return String(row[k]).trim();
    }
  }
  return null;
}

function applyMapping(row, mapping) {
  const out = { family: {}, persons: [], address: null };

  // Family
  out.family.display_name = pick(row, mapping.family?.display_name);
  out.family.notes = pick(row, mapping.family?.notes);

  // Address
  if (mapping.address) {
    const addr = {
      line1: pick(row, mapping.address.line1),
      line2: pick(row, mapping.address.line2),
      city: pick(row, mapping.address.city),
      region: pick(row, mapping.address.region),
      postal: pick(row, mapping.address.postal),
      country: pick(row, mapping.address.country),
      label: mapping.address.label || 'home',
    };
    if (Object.values(addr).some(v => v && v !== addr.label)) {
      out.address = addr;
    }
  }

  // Persons (mapping.persons is an array of person templates)
  for (const tmpl of mapping.persons || []) {
    const person = {
      given_name: pick(row, tmpl.given_name),
      family_name: pick(row, tmpl.family_name) || out.family.display_name,
      middle_name: pick(row, tmpl.middle_name),
      prefix: pick(row, tmpl.prefix),
      suffix: pick(row, tmpl.suffix),
      date_of_birth: pick(row, tmpl.date_of_birth),
      gender: pick(row, tmpl.gender),
      role: tmpl.role || 'member',
      custody: tmpl.custody || null,
      emails: [],
      phones: [],
    };
    const email = pick(row, tmpl.email);
    if (email) person.emails.push(email);
    const phone = pick(row, tmpl.phone);
    if (phone) person.phones.push(phone);

    if (person.given_name || person.family_name) out.persons.push(person);
  }

  return out;
}

module.exports = { applyMapping, pick };
