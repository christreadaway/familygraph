'use strict';

// Map a vendor row + a field-mapping definition into Family Graph's canonical shape.
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

// Split a single full-name string into { given, family, middle? }.
// Recognizes:
//   "Last, First" / "Last, First Middle"   → comma-separated, family-first
//   "First Last"                            → space-separated, family-last
//   "First Middle Last"                     → middle gets folded as middle_name
// Single-token names are treated as family_name (matches what the resolver
// blocks on; better than dropping the row).
function splitFullName(full) {
  if (!full) return { given: null, family: null, middle: null };
  const s = String(full).trim().replace(/\s+/g, ' ');
  if (!s) return { given: null, family: null, middle: null };
  if (s.includes(',')) {
    const [familyPart, restPart = ''] = s.split(',', 2).map(t => t.trim());
    const restTokens = restPart.split(' ').filter(Boolean);
    const given = restTokens[0] || null;
    const middle = restTokens.length > 1 ? restTokens.slice(1).join(' ') : null;
    return { given, family: familyPart || null, middle };
  }
  const tokens = s.split(' ').filter(Boolean);
  if (tokens.length === 1) return { given: null, family: tokens[0], middle: null };
  if (tokens.length === 2) return { given: tokens[0], family: tokens[1], middle: null };
  return {
    given: tokens[0],
    family: tokens[tokens.length - 1],
    middle: tokens.slice(1, -1).join(' '),
  };
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
    let given = pick(row, tmpl.given_name);
    let family = pick(row, tmpl.family_name);
    let middle = pick(row, tmpl.middle_name);

    // Fall back to splitting a full-name column when first/last weren't found.
    if ((!given || !family) && tmpl.full_name) {
      const full = pick(row, tmpl.full_name);
      const split = splitFullName(full);
      if (!given) given = split.given;
      if (!family) family = split.family;
      if (!middle) middle = split.middle;
    }

    const person = {
      given_name: given,
      family_name: family || out.family.display_name,
      middle_name: middle,
      prefix: pick(row, tmpl.prefix),
      suffix: pick(row, tmpl.suffix),
      date_of_birth: pick(row, tmpl.date_of_birth),
      gender: pick(row, tmpl.gender),
      grade: pick(row, tmpl.grade),
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

module.exports = { applyMapping, pick, splitFullName };
