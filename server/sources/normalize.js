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
  return pickWithKey(row, keys).value;
}

// Same as pick, but also reports WHICH header supplied the value. Roster
// imports need it to point a community identifier back at the exact cell.
function pickWithKey(row, keys) {
  if (!Array.isArray(keys)) keys = [keys];
  for (const k of keys) {
    if (k && row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') {
      return { value: String(row[k]).trim(), key: k };
    }
  }
  return { value: null, key: null };
}

// "Tom, Ann & Joe" / "Tom; Ann and Joe" / "Tom/Ann" -> one entry per child,
// each with the exact text as it appears so the cell can be rewritten.
const _EMPTY_CELL_RE = /^(n\/?a|none|null|nil|-+|tbd|unknown|\?+|0)$/i;
const _SUFFIX_ONLY_RE = /^(jr|sr|ii|iii|iv|v|junior|senior)\.?$/i;

function splitNameList(field) {
  if (field == null) return [];
  const s = String(field);
  if (_EMPTY_CELL_RE.test(s.trim())) return [];
  const out = [];
  const re = /[^,;&/\n]+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    // " and " inside a segment separates names too ("Tom and Ann").
    const seg = m[0];
    const parts = seg.split(/\s+and\s+/i);
    const offset = m.index;
    let cursor = 0;
    for (const part of parts) {
      const at = seg.indexOf(part, cursor);
      cursor = at + part.length;
      const text = part.trim();
      if (!text || _EMPTY_CELL_RE.test(text)) continue;
      if (_SUFFIX_ONLY_RE.test(text) && out.length) {
        // "Tom Smith, Jr." - the suffix belongs to the name before it.
        const prev = out[out.length - 1];
        const end = offset + at + part.indexOf(text) + text.length;
        prev.text = s.slice(prev.start, end);
        continue;
      }
      out.push({ text, start: offset + at + part.indexOf(text) });
    }
  }
  return out;
}

// "Smith Family" / "The Smith Family" / "Smith Household" -> "Smith".
// Null unless exactly one surname-looking word remains.
function surnameFromDisplayName(display) {
  if (!display) return null;
  const words = String(display)
    .replace(/[(),]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !/^(the|family|household|home|residence|of)$/i.test(w));
  return words.length === 1 ? words[0] : null;
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
// US-format MM/DD/YYYY (also short year), ISO, YYYY/MM/DD, and "Jan 15, 2025"
// / "15 Jan 2025". Vendored from the upstream identity engine.
//
// Fixed 2026-09-28: every branch built Date.UTC(y, m-1, d) and trusted it,
// so impossible dates rolled over ('15/01/2010' -> 2011-03-01, '02/30/2010'
// -> 2010-03-02) and a `new Date(str)` fallback filled in partial dates
// ('2010' -> 2010-01-01, '01/15' -> 2001-01-15). These are birthdates, and a
// made-up birthdate is permanent evidence that two records are two people.
// Now a date is read only when year, month and day are all present and
// valid; anything else is null (unreadable), never a guess.
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function _isoIfValid(y, m, d) {
  y = +y; m = +m; d = +d;
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y <= 1900 || y >= 2200 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function _monthNumber(word) {
  const w = String(word).toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return null;
  const k = w.slice(0, w.startsWith('sept') ? 4 : 3);
  const n = MONTHS[k];
  // "Janxyz" is not January: the word must be the month or its abbreviation.
  if (!n) return null;
  const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'][n - 1];
  return full.startsWith(w) ? n : null;
}

function normalizeDate(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10);

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

  // ISO, optionally with a time ("2010-01-15T08:00:00Z"), or 2010/01/15.
  const isoMatch = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:$|[T\s])/);
  if (isoMatch) return _isoIfValid(isoMatch[1], isoMatch[2], isoMatch[3]);

  // US month/day/year. A first number above 12 cannot be a month, so the
  // only reading is day-first (15/01/2010); both above 12 is unreadable.
  const numeric = str.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
  if (numeric) {
    let [, m, d, y] = numeric;
    if (+m > 12 && +d <= 12) [m, d] = [d, m];
    if (y.length === 2) {
      // Two-digit year: the latest century that does not put the date in
      // the future ('5/6/45' is 1945, not 2045 - these are birthdates).
      const guess = _isoIfValid(2000 + +y, m, d);
      const today = new Date().toISOString().slice(0, 10);
      return guess && guess <= today ? guess : _isoIfValid(1900 + +y, m, d);
    }
    return _isoIfValid(y, m, d);
  }

  // Month names: "Jan 15, 2010", "January 15 2010", "Wed Jan 15 2010 ...",
  // "15 Jan 2010", "15-Jan-2010". A month and year without a day ("Mar
  // 2015") is not a date.
  const mdy = str.match(/^(?:[a-z]+,?\s+)?([a-z]+\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i);
  if (mdy) {
    const m = _monthNumber(mdy[1]);
    if (m) return _isoIfValid(mdy[3], m, mdy[2]);
  }
  const dmy = str.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]+\.?),?[\s-]+(\d{4})$/i);
  if (dmy) {
    const m = _monthNumber(dmy[2]);
    if (m) return _isoIfValid(dmy[3], m, dmy[1]);
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
  // Leading titles and a leading connector are not names: "Mr. John Smith",
  // "Mr. & Mrs. John Smith", "Dr. Ann Lee".
  const lead = /^(?:(?:mr|mrs|ms|miss|mx|dr|rev|fr|deacon|dcn)\.?|&|\+|and)$/i;
  const words = String(full).trim().split(/\s+/);
  while (words.length > 1 && lead.test(words[0])) words.shift();
  const s = words.join(' ').trim();
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

  // The household's surname, once known: the first mapped person's family
  // name, else a one-word family label ("Smith Family" -> "Smith"). A
  // spouse or child listed by first name only inherits it, instead of the
  // first name being filed as a surname.
  let householdSurname = null;
  const displaySurname = surnameFromDisplayName(out.family.display_name);

  // Persons (mapping.persons is an array of person templates). Every person
  // carries `_src`: which template and which header(s) its name came from.
  // Import ignores it; roster imports use it to find the name cell.
  const templates = mapping.persons || [];
  for (let ti = 0; ti < templates.length; ti++) {
    const tmpl = templates[ti];

    // A column that lists several children in one cell ("Tom, Ann & Joe").
    if (tmpl.list) {
      const listPick = pickWithKey(row, tmpl.list);
      const surname = householdSurname || displaySurname || null;
      const entries = splitNameList(listPick.value);
      for (let k = 0; k < entries.length; k++) {
        const entry = entries[k];
        const tokens = entry.text.split(/\s+/);
        let given;
        let family;
        let middle = null;
        if (tokens.length === 1) {
          given = tokens[0];
          family = surname;
        } else {
          const split = splitFullName(entry.text);
          given = split.given;
          family = split.family;
          middle = split.middle;
        }
        if (!given && !family) continue;
        out.persons.push({
          given_name: given,
          family_name: family || out.family.display_name,
          middle_name: middle,
          prefix: null,
          suffix: null,
          date_of_birth: null,
          gender: null,
          grade: null,
          role: tmpl.role || 'child',
          custody: tmpl.custody || null,
          emails: [],
          phones: [],
          _src: { template: ti, list: listPick.key, list_index: k, list_text: entry.text, list_start: entry.start },
        });
      }
      continue;
    }

    const givenPick = pickWithKey(row, tmpl.given_name);
    const familyPick = pickWithKey(row, tmpl.family_name);
    let given = givenPick.value;
    let family = familyPick.value;
    let middle = pick(row, tmpl.middle_name);
    let fullKey = null;

    // A couple (or twins) in one cell: "John & Mary Smith", "Smith, John &
    // Mary", or "John & Mary" in a First Name column. Without this the
    // second person silently disappears - never identified, never counted.
    const coupleSource = given ? givenPick : (tmpl.full_name ? pickWithKey(row, tmpl.full_name) : { value: null });
    const couple = splitCouple(coupleSource.value, family || null);
    if (couple && couple.length > 1) {
      const fromFull = !given;
      const base = tmpl.role || 'member';
      couple.forEach((nm, k) => {
        const role = k === 0 ? base : (base === 'member' ? 'spouse' : base);
        const person = _templatePerson(row, tmpl, k === 0);
        person.given_name = nm.given;
        person.family_name = nm.family || householdSurname || out.family.display_name;
        person.middle_name = nm.middle;
        person.role = role;
        person._src = {
          template: ti,
          given: fromFull ? null : coupleSource.key,
          family: familyPick.value ? familyPick.key : null,
          full: fromFull ? coupleSource.key : null,
          compound_index: k,
        };
        if (person.given_name || person.family_name) out.persons.push(person);
        if (!householdSurname && nm.family) householdSurname = nm.family;
      });
      continue;
    }

    // Fall back to splitting a full-name column when first/last weren't found.
    if ((!given || !family) && tmpl.full_name) {
      const fullPick = pickWithKey(row, tmpl.full_name);
      const full = fullPick.value;
      if (full) fullKey = fullPick.key;
      const split = splitFullName(full);
      const singleToken = !!full && split.given === null && !!split.family;
      const surname = family || householdSurname || (ti > 0 ? displaySurname : null);
      if (singleToken && surname && (ti > 0 || family)) {
        // "Mary" in a Spouse column, "Emma" in a Student column: a first
        // name, not a surname.
        if (!given) given = split.family;
        if (!family) family = surname;
      } else {
        if (!given) given = split.given;
        if (!family) family = split.family;
        if (!middle) middle = split.middle;
      }
    }

    const dobRaw = pick(row, tmpl.date_of_birth);
    const person = {
      given_name: given,
      family_name: family || householdSurname || out.family.display_name,
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
      _src: {
        template: ti,
        given: givenPick.value ? givenPick.key : null,
        family: familyPick.value ? familyPick.key : null,
        full: fullKey,
      },
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

    // A second adult or child slot whose own columns are empty is not a
    // person: its surname column falls back to the primary's, so without
    // this every row with a blank "Parent 2" produced a nameless phantom.
    const hasOwnSignal = !!(given || person.emails.length || person.phones.length);
    if ((person.given_name || person.family_name) && (ti === 0 || hasOwnSignal)) {
      out.persons.push(person);
      if (!householdSurname && family) householdSurname = family;
    }
  }

  // "John & Mary Smith" in the Head column AND "Mary" in the Spouse column is
  // one Mary. Drop the couple-derived copy; the person from her own column
  // (with her own email / phone) stays.
  const key = p => `${normName(p.given_name)}|${normName(p.family_name)}`;
  out.persons = out.persons.filter((p, i) => {
    if (!(p._src && p._src.compound_index > 0)) return true;
    return !out.persons.some((q, j) => j !== i && !(q._src && q._src.compound_index > 0) && key(q) === key(p));
  });

  return out;
}

function normName(s) {
  return String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// The per-template fields every person on a row carries. For a couple in one
// cell, only the first person gets the row's email / phone / birthdate /
// grade - they are one value and cannot be split between two people.
function _templatePerson(row, tmpl, withContact) {
  const dobRaw = withContact ? pick(row, tmpl.date_of_birth) : null;
  const person = {
    given_name: null,
    family_name: null,
    middle_name: null,
    prefix: null,
    suffix: withContact ? pick(row, tmpl.suffix) : null,
    date_of_birth: dobRaw ? (normalizeDate(dobRaw) || dobRaw) : null,
    gender: withContact ? pick(row, tmpl.gender) : null,
    grade: withContact ? pick(row, tmpl.grade) : null,
    role: tmpl.role || 'member',
    custody: tmpl.custody || null,
    emails: [],
    phones: [],
  };
  if (withContact) {
    for (const e of splitEmails(pick(row, tmpl.email))) if (!person.emails.includes(e)) person.emails.push(e);
    for (const p of splitPhones(pick(row, tmpl.phone))) if (!person.phones.includes(p)) person.phones.push(p);
  }
  return person;
}

const _HONORIFIC_RE = /^(mr|mrs|ms|miss|mx|dr|rev|fr|deacon|dcn)\.?$/i;
const _COUPLE_SPLIT_RE = /\s*(?:&|\+|\band\b)\s*/i;

// Names of two or more people written in one cell. Returns null when the cell
// holds one name (or none). `familyHint` is the row's surname column, used
// when the cell holds first names only ("John & Mary").
//   "John & Mary Smith"      -> John Smith, Mary Smith
//   "Smith, John & Mary"     -> John Smith, Mary Smith
//   "John Smith & Mary Jones"-> John Smith, Mary Jones
//   "Mr. & Mrs. John Smith"  -> null (one named person)
function splitCouple(raw, familyHint = null) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/\s+/g, ' ');
  if (!_COUPLE_SPLIT_RE.test(s)) return null;
  let family = null;
  const comma = s.indexOf(',');
  if (comma > 0) {
    family = s.slice(0, comma).trim();
    s = s.slice(comma + 1).trim();
  }
  const parts = s.split(_COUPLE_SPLIT_RE)
    .map(p => p.split(' ').filter(w => w && !_HONORIFIC_RE.test(w)).join(' ').trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  if (!family) {
    const lastMulti = [...parts].reverse().find(p => p.split(' ').length > 1);
    family = lastMulti ? lastMulti.split(' ').slice(-1)[0] : (familyHint || null);
  }
  return parts.map(p => {
    const toks = p.split(' ');
    if (toks.length === 1) return { given: toks[0], family, middle: null };
    if (comma > 0) return { given: toks[0], family, middle: toks.slice(1).join(' ') || null };
    return {
      given: toks[0],
      family: toks[toks.length - 1],
      middle: toks.length > 2 ? toks.slice(1, -1).join(' ') : null,
    };
  });
}

module.exports = {
  applyMapping,
  pick,
  pickWithKey,
  splitNameList,
  splitCouple,
  surnameFromDisplayName,
  splitFullName,
  splitEmails,
  splitPhones,
  normalizeDate,
  normalizeAmount,
};
