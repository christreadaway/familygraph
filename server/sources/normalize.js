'use strict';

// Map a vendor row + a structured field-mapping definition into Family Graph's
// canonical shape. The mapping shape is produced by csv.js.flatToStructured and
// looks like:
//
//   {
//     family:   { display_name, notes },
//     address:  { line1, line2, city, region, postal, country, label },
//     persons:  [ { given_name, family_name, full_name, middle_name, email,
//                   phone, date_of_birth, gender, grade, role, ... } ]
//   }
//
// Value normalization (phone splitting, email lowercasing, date parsing) is
// vendored from the upstream identity engine's ingestion module so the canonical shape we hand to
// the resolver is already clean.

function pick(row, keys) {
  if (!Array.isArray(keys)) keys = [keys];
  for (const k of keys) {
    if (k && row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') {
      return String(row[k]).trim();
    }
  }
  return null;
}

// Split a multi-value email field. Vendored from the upstream identity engine.
function splitEmails(field) {
  if (field == null) return [];
  return String(field)
    .split(/[,;]\s*|\s+/)
    .map(e => e.trim().toLowerCase())
    .filter(e => e && e.includes('@'));
}

// Extract every 10-digit number from a phone field. Handles
// "+13143783612+13145607897" (concatenated) and "555-1234, 555-5678".
function splitPhones(field) {
  if (field == null) return [];
  const raw = String(field);
  const digitsOnly = raw.replace(/[^\d]/g, '');
  const phones = [];
  if (digitsOnly.length > 10) {
    const parts = raw.split(/[,;]\s*/);
    if (parts.length > 1) {
      for (const part of parts) {
        const d = part.replace(/[^\d]/g, '').slice(-10);
        if (d.length >= 10) phones.push(d);
      }
    } else {
      let remaining = digitsOnly;
      while (remaining.length >= 10) {
        if (remaining.length >= 11 && remaining[0] === '1') {
          phones.push(remaining.slice(1, 11));
          remaining = remaining.slice(11);
        } else {
          phones.push(remaining.slice(0, 10));
          remaining = remaining.slice(10);
        }
      }
    }
  } else {
    const d = digitsOnly.slice(-10);
    if (d.length >= 10) phones.push(d);
  }
  return phones;
}

// Normalize a date value to ISO YYYY-MM-DD. Handles Excel serial numbers,
// US-format MM/DD/YYYY (also short year), ISO, and "Jan 15, 2025".
// Vendored from the upstream identity engine.
function normalizeDate(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date && !isNaN(raw.getTime())) return raw.toISOString().slice(0, 10);

  const str = String(raw).trim();
  if (!str) return null;

  // Excel serial number (a plain number in a realistic date range)
  const num = Number(str);
  if (!isNaN(num) && num > 365 && num < 55000 && /^\d+(\.\d+)?$/.test(str)) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const msPerDay = 86400000;
    const d = new Date(excelEpoch.getTime() + num * msPerDay);
    if (!isNaN(d.getTime()) && d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2050) {
      return d.toISOString().slice(0, 10);
    }
  }

  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const dt = new Date(Date.UTC(+y, +m - 1, +d));
    if (!isNaN(dt.getTime()) && dt.getUTCFullYear() > 1900) return dt.toISOString().slice(0, 10);
  }

  const usMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (usMatch) {
    const [, m, d, y] = usMatch;
    const dt = new Date(Date.UTC(+y, +m - 1, +d));
    if (!isNaN(dt.getTime()) && dt.getUTCFullYear() > 1900) return dt.toISOString().slice(0, 10);
  }

  const shortYearMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (shortYearMatch) {
    const [, m, d, y] = shortYearMatch;
    const fullYear = +y < 50 ? 2000 + +y : 1900 + +y;
    const dt = new Date(Date.UTC(fullYear, +m - 1, +d));
    if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  }

  const dt = new Date(str);
  if (!isNaN(dt.getTime()) && dt.getFullYear() > 1900 && dt.getFullYear() < 2200) {
    return dt.toISOString().slice(0, 10);
  }

  return null;
}

// Strip currency adornments and parse to a finite number, else null.
function normalizeAmount(raw) {
  if (raw == null || raw === '') return null;
  const n = parseFloat(String(raw).replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : null;
}

// Split a single full-name string into { given, family, middle? }.
//   "Last, First [Middle]"  → comma-separated
//   "First Last"            → space-separated, family-last
//   "First Middle Last"     → middle gets folded
// Single tokens become family_name (matches what the resolver blocks on).
function splitFullName(full) {
  if (!full) return { given: null, family: null, middle: null };
  const s = String(full).trim().replace(/\s+/g, ' ');
  if (!s) return { given: null, family: null, middle: null };
  if (s.includes(',')) {
    const [familyPart, restPart = ''] = s.split(',', 2).map(t => t.trim());
    const restTokens = restPart.split(' ').filter(Boolean);
    return {
      given: restTokens[0] || null,
      family: familyPart || null,
      middle: restTokens.length > 1 ? restTokens.slice(1).join(' ') : null,
    };
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
    if (Object.values(addr).some(v => v && v !== addr.label)) out.address = addr;
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

    const dobRaw = pick(row, tmpl.date_of_birth);
    const person = {
      given_name: given,
      family_name: family || out.family.display_name,
      middle_name: middle,
      prefix: pick(row, tmpl.prefix),
      suffix: pick(row, tmpl.suffix),
      date_of_birth: dobRaw ? (normalizeDate(dobRaw) || dobRaw) : null,
      gender: pick(row, tmpl.gender),
      grade: pick(row, tmpl.grade),
      role: tmpl.role || 'member',
      custody: tmpl.custody || null,
      emails: [],
      phones: [],
    };

    const emailRaw = pick(row, tmpl.email);
    if (emailRaw) {
      for (const e of splitEmails(emailRaw)) {
        if (!person.emails.includes(e)) person.emails.push(e);
      }
    }

    const phoneRaw = pick(row, tmpl.phone);
    if (phoneRaw) {
      for (const p of splitPhones(phoneRaw)) {
        if (!person.phones.includes(p)) person.phones.push(p);
      }
    }

    if (person.given_name || person.family_name) out.persons.push(person);
  }

  return out;
}

module.exports = {
  applyMapping,
  pick,
  splitFullName,
  splitEmails,
  splitPhones,
  normalizeDate,
  normalizeAmount,
};
