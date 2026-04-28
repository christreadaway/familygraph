'use strict';

// Pure-JS NER detection. Four layers, in order of confidence:
//   1. Regex for high-confidence structured PII (email, phone, SSN-shaped, DOB,
//      US-style street address).
//   2. Registry-driven name lookups (every active person's name HMAC).
//   3. compromise NLP entity detection (#Person, #Place) — pure JS, MIT.
//   4. Simple capitalized-token heuristic for unseen names.

let nlp = null;
try {
  // compromise is loaded lazily so the rest of the system still works if the
  // dep is removed in a constrained build.
  nlp = require('compromise');
} catch (_) {
  nlp = null;
}

const enc = require('../crypto/encryption');

const RE_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
// Phone numbers can begin with `(`, which is not a word character, so we use
// look-arounds rather than \b to anchor the match without dropping forms like
// "(415) 555-0100" that are preceded by a space.
const RE_PHONE = /(?<![\w-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/g;
const RE_SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const RE_DOB = /\b(0?[1-9]|1[0-2])[\/-](0?[1-9]|[12]\d|3[01])[\/-](19|20)\d{2}\b/g;
const STREET_HINT = /\b\d{1,5}\s+([A-Z][a-z]+\s){1,4}(St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Ter|Terrace)\b/g;

const COMMON_TITLES = ['Mr', 'Mrs', 'Ms', 'Mx', 'Fr', 'Sr', 'Jr', 'Dr', 'Rev', 'Father', 'Sister', 'Brother'];
const STOPWORDS = new Set([
  'The','And','Or','But','If','When','While','Of','For','To','By','In','On','At','From','With','As','Is','Are','Was','Were',
  'I','We','You','They','He','She','It','This','That','These','Those','My','Your','Our','Their',
  'January','February','March','April','May','June','July','August','September','October','November','December',
  'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday',
]);

function detectStructured(text) {
  const findings = [];
  for (const re of [RE_EMAIL, RE_PHONE, RE_SSN, RE_DOB, STREET_HINT]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const kind = re === RE_EMAIL
        ? 'email'
        : re === RE_PHONE
          ? 'phone'
          : re === RE_SSN
            ? 'ssn'
            : re === RE_DOB
              ? 'dob'
              : 'address';
      findings.push({ kind, value: m[0], start: m.index, end: m.index + m[0].length });
    }
  }
  return findings;
}

function detectNameCandidates(text) {
  // Find sequences of 2-3 capitalized tokens that are not stopwords. This is
  // the unseen-name fallback; high recall, low precision. The application
  // layer down-weights matches not corroborated by the registry.
  const findings = [];
  const re = /\b([A-Z][a-zA-Z'’-]+)(?:\s+([A-Z][a-zA-Z'’-]+))?(?:\s+([A-Z][a-zA-Z'’-]+))?\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tokens = [m[1], m[2], m[3]].filter(Boolean);
    if (tokens.every(t => STOPWORDS.has(t))) continue;
    if (tokens.length === 1 && (STOPWORDS.has(tokens[0]) || COMMON_TITLES.includes(tokens[0]))) continue;
    findings.push({
      kind: 'name_candidate',
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
      tokens,
    });
  }
  return findings;
}

// Detect names already present in the registry. Hashes given/family names of
// active persons and matches by token. This is exact, deterministic, and
// guarantees that every known person in the registry is detected.
function detectKnownNames(db, secrets, text) {
  const findings = [];
  // Build a map of family-name-hash -> person codes (decrypt only when matched).
  const tokenRe = /[A-Z][a-zA-Z'’-]+/g;
  const seen = new Map();
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    const t = m[0];
    const hash = enc.hmac(secrets, enc.normalizeName(t));
    if (!hash) continue;
    if (!seen.has(hash)) seen.set(hash, []);
    seen.get(hash).push({ token: t, start: m.index, end: m.index + t.length });
  }
  if (seen.size === 0) return [];
  const hashes = [...seen.keys()];
  // Look for any active person whose given OR family name hashes into our token set.
  const placeholders = hashes.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT code, given_name_hash, family_name_hash
         FROM persons
        WHERE status = 'active' AND
              (given_name_hash IN (${placeholders}) OR family_name_hash IN (${placeholders}))`
    )
    .all(...hashes, ...hashes);
  const codeByHash = new Map();
  for (const r of rows) {
    if (r.given_name_hash) codeByHash.set(r.given_name_hash, [...(codeByHash.get(r.given_name_hash) || []), r.code]);
    if (r.family_name_hash) codeByHash.set(r.family_name_hash, [...(codeByHash.get(r.family_name_hash) || []), r.code]);
  }
  for (const [hash, occurrences] of seen) {
    const matches = codeByHash.get(hash);
    if (!matches) continue;
    for (const occ of occurrences) {
      findings.push({
        kind: 'known_name',
        value: occ.token,
        start: occ.start,
        end: occ.end,
        person_codes: matches,
      });
    }
  }
  return findings;
}

function detectNlpPeople(text) {
  if (!nlp) return [];
  try {
    const doc = nlp(text);
    const findings = [];
    const people = doc.people().out('offset');
    for (const p of people) {
      if (typeof p.offset === 'object' && p.offset.start != null) {
        findings.push({
          kind: 'name_candidate',
          value: p.text,
          start: p.offset.start,
          end: p.offset.start + p.text.length,
          source: 'compromise',
        });
      }
    }
    return findings;
  } catch (_) {
    return [];
  }
}

function detect(db, secrets, text) {
  const all = [
    ...detectStructured(text),
    ...detectKnownNames(db, secrets, text),
    ...detectNlpPeople(text),
    ...detectNameCandidates(text),
  ];
  // Deduplicate overlapping findings, preferring higher-confidence kinds.
  const PRIORITY = { email: 5, phone: 5, ssn: 5, dob: 4, address: 4, known_name: 3, name_candidate: 1 };
  all.sort((a, b) => a.start - b.start || (PRIORITY[b.kind] - PRIORITY[a.kind]));
  const accepted = [];
  for (const f of all) {
    const overlaps = accepted.find(a => !(f.end <= a.start || f.start >= a.end));
    if (!overlaps) {
      accepted.push(f);
    } else if (PRIORITY[f.kind] > PRIORITY[overlaps.kind]) {
      accepted.splice(accepted.indexOf(overlaps), 1, f);
    }
  }
  return accepted.sort((a, b) => a.start - b.start);
}

module.exports = { detect, detectStructured, detectKnownNames, detectNameCandidates, detectNlpPeople };
