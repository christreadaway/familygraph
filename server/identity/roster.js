'use strict';

// Roster imports that issue community identifiers (owner decision 2026-09-28).
//
// A school roster or parishioner list comes in as sheets of rows. Every person
// on it must end up with exactly ONE identifier for life (I + hex) and every
// household with one family identifier (F + hex) - the same ones Family Graph
// already holds, so a person who was on last year's roster, or on the parish
// list, keeps the id they already have. A wrong merge would give two humans
// one id and nobody would ever find out, so:
//
//   1. Matching is strict (matching.js `strict`): contact matches need the
//      first name to line up, Jr/Sr and birthdate conflicts veto, ambiguous
//      nicknames don't count, and a candidate that is already someone else in
//      the same row is never matched again.
//   2. Anything short of certain goes to a human. A person or family is
//      matched automatically only when exactly one candidate qualifies; two
//      qualifying candidates, an archived candidate, a role mismatch (a child
//      row against an adult record), or a soft score all become REVIEW items.
//   3. Nothing is minted on a guess. PLAN runs the real import inside a
//      transaction and rolls it back, so it shows exactly what COMMIT will do
//      - including duplicates within the sheet (a parent listed once per
//      child) - without writing anything. COMMIT refuses, and writes nothing,
//      while any review item lacks a decision.
//
// Decisions are keyed "<sheet>:<row>:<slot>" for people and
// "<sheet>:<row>:family" for households:
//   { action: 'attach', target: 'I…' | 'F…' | '<sheet>:<row>:<slot|family>' }
//   { action: 'create' }   // a different person / household: new id
//   { action: 'skip' }     // not a real person (people only)
// A target may be an earlier row of the same upload - the id it gets at
// commit time is not known when the operator decides.
//
// Never logs names or any other PII - counts, codes, and timings only.

const enc = require('../crypto/encryption');
const ids = require('../crypto/identifiers');
const people = require('./people');
const families = require('./families');
const aliases = require('./aliases');
const resolver = require('./resolver');
const matching = require('./matching');
const importPipeline = require('./import');
const crosswalk = require('./crosswalk');
const audit = require('../audit');
const csv = require('../sources/csv');
const { applyMapping, splitEmails, splitPhones, normalizeDate } = require('../sources/normalize');
const log = require('../log');

const LIMITS = {
  sheets: 25,
  rows: 20000,        // across all sheets
  columns: 300,
  cellChars: 4000,
  headerChars: 200,
};

const ADULT_ROLES = new Set(['parent', 'guardian', 'grandparent', 'spouse', 'head', 'other_adult']);
const VETO_REASONS = new Set(['dob_conflict', 'suffix_conflict', 'suffix_one_sided']);
// A candidate is worth a person's time only when the first AND last name line
// up, or the birthdate matches along with one of them.
//   - Sharing a surname and an address is what siblings and spouses do.
//   - Sharing a first name and nothing else ("James Linquist" / "James
//     Kaplan") is two people.
//   - A shared email or phone with a first name that does not line up is a
//     spouse on the family inbox or a child under a parent's phone: it says
//     "same household", and the household step uses it that way.
//   - A merely similar email (jsmith@ / jsmith2@) proves nothing.
const FIRST_NAME_REASONS = new Set([
  'exact_first_name', 'nickname_or_short_form', 'similar_first_name', 'phonetic_first_name', 'first_name_typo',
]);
const LAST_NAME_REASONS = new Set(['exact_last_name', 'similar_last_name']);
const _plausible = s => {
  const first = s.reasons.some(r => FIRST_NAME_REASONS.has(r));
  const last = s.reasons.some(r => LAST_NAME_REASONS.has(r));
  const dob = s.reasons.includes('exact_date_of_birth');
  return (first && last) || (dob && (first || last));
};
// A crosswalk link was already settled by a match or a human; only a hard
// contradiction reopens it. (A suffix known on one side only is normal: the
// other app may not have a suffix field at all.)
const LINK_VETOES = new Set(['dob_conflict', 'suffix_conflict']);

// Not names: a roster's stand-ins for "we don't know yet". Minting an
// identifier for "TBD Smith" creates a person who does not exist.
const PLACEHOLDER_NAME_RE = /^(tbd|tba|unknown|unk|n\/?a|none|null|nil|test|x+|\?+|-+|parent|guardian|mom|dad|mother|father|student|child|kid|baby|spouse|other)$/i;

// A business or parish in a name column (donor lists do this) is not a person.
const ORG_WORD_RE = /\b(inc|llc|ltd|corp|corporation|company|co|construction|church|parish|school|academy|foundation|sons|bank|trust|associates|group|ministries|ministry|society|club|fund|council|knights|committee|dept|department|services|enterprises|partners)\b\.?/i;

function _nameProblem(incoming) {
  const g = String(incoming.given_name || '').trim();
  if (!g) return 'no_first_name';
  if (PLACEHOLDER_NAME_RE.test(g.replace(/\.$/, ''))) return 'placeholder_name';
  if (/^[A-Za-z]\.?$/.test(g)) return 'initial_only';
  const whole = [incoming.given_name, incoming.middle_name, incoming.family_name].filter(Boolean).join(' ');
  if (ORG_WORD_RE.test(whole)) return 'looks_like_organization';
  return null;
}

class RosterError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const ROLLBACK = Symbol('roster-plan-rollback');

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function _cell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.length > LIMITS.cellChars) {
    throw new RosterError(`a cell is longer than ${LIMITS.cellChars} characters`);
  }
  return s.trim();
}

// Header list -> unique, non-empty names (csv-parse would silently let a
// duplicate header overwrite the first column's value).
function _uniqueHeaders(headers) {
  const out = [];
  const seen = new Map();
  headers.forEach((h, i) => {
    let name = _cell(h).slice(0, LIMITS.headerChars) || `Column ${i + 1}`;
    const base = name;
    let n = 1;
    while (seen.has(name.toLowerCase())) {
      n += 1;
      name = `${base} (${n})`;
    }
    seen.set(name.toLowerCase(), i);
    out.push(name);
  });
  return out;
}

function _householdDisplayName(canonical) {
  if (canonical.family && canonical.family.display_name) return canonical.family.display_name;
  const withSurname = (canonical.persons || []).find(p => p.family_name);
  if (!withSurname) return null;
  const ln = String(withSurname.family_name).trim();
  return ln ? `${ln.charAt(0).toUpperCase()}${ln.slice(1)} Family` : null;
}

function _roleClass(role) {
  if (role === 'child') return 'child';
  if (ADULT_ROLES.has(role)) return 'adult';
  return null;
}

// Structured input - households already known to another app (MissionIQ):
//   { households: [{ ref?, code_hint?, display_name?, address?: {line1, line2,
//       city, region, postal, country}, persons: [{ ref?, code_hint?,
//       given_name, family_name, middle_name?, suffix?, emails?|email?,
//       phones?|phone?, date_of_birth?, gender?, grade?, role }] }] }
// `ref` is the source app's own record id: once committed it is linked in the
// crosswalk and every later import or /api/identity/resolve call with the
// same (source, ref) lands on the same person without matching. `code_hint`
// is a Family Graph code the source app already stored; it is honored only
// when the record still agrees with it (see resolvePerson).
const HOUSEHOLD_ROLES = new Set(['parent', 'guardian', 'grandparent', 'spouse', 'other_adult', 'head', 'member', 'child']);

function _refOrNull(v, what) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' && typeof v !== 'number') throw new RosterError(`${what}: ref must be a string`);
  const s = String(v);
  if (s.length > 200 || /[\s\u0000-\u001f]/.test(s)) throw new RosterError(`${what}: ref must be a short id without spaces`);
  return s;
}

function _prepareHouseholds(list) {
  if (list.length > LIMITS.rows) throw new RosterError(`too many households (max ${LIMITS.rows})`);
  const val = v => (v === null || v === undefined ? null : (_cell(v) || null));
  const rows = list.map((h, i) => {
    if (!h || typeof h !== 'object' || !Array.isArray(h.persons)) {
      throw new RosterError(`household ${i}: persons array required`);
    }
    const persons = [];
    h.persons.forEach((p, k) => {
      if (!p || typeof p !== 'object') throw new RosterError(`household ${i} person ${k}: object required`);
      const role = HOUSEHOLD_ROLES.has(p.role) ? p.role : 'member';
      const emails = [];
      for (const e of [].concat(p.emails || [], p.email || [])) for (const x of splitEmails(val(e))) if (!emails.includes(x)) emails.push(x);
      const phones = [];
      for (const ph of [].concat(p.phones || [], p.phone || [])) for (const x of splitPhones(val(ph))) if (!phones.includes(x)) phones.push(x);
      const dobRaw = val(p.date_of_birth);
      const person = {
        given_name: val(p.given_name),
        family_name: val(p.family_name),
        middle_name: val(p.middle_name),
        prefix: null,
        suffix: val(p.suffix),
        date_of_birth: dobRaw ? (normalizeDate(dobRaw) || dobRaw) : null,
        gender: val(p.gender),
        grade: val(p.grade),
        role,
        custody: null,
        emails,
        phones,
        _ref: _refOrNull(p.ref, `household ${i} person ${k}`),
        _code_hint: typeof p.code_hint === 'string' && ids.kindOf(p.code_hint) === 'person' && ids.isValidCode(p.code_hint) ? p.code_hint : null,
        _src: {},
      };
      // A do-not-contact flag travels with the person; it is only ever set,
      // never cleared, by an import.
      if (p.do_not_contact === true || p.do_not_contact === 1) person.do_not_contact = true;
      const cls = _roleClass(role);
      if (cls) person.kind = cls;
      if (person.given_name || person.family_name) persons.push(person);
    });
    if (!persons.length) return { index: i, skipped: 'no_person' };
    const a = h.address && typeof h.address === 'object' ? h.address : null;
    const address = a && (a.line1 || a.city || a.postal) ? {
      line1: val(a.line1), line2: val(a.line2), city: val(a.city), region: val(a.region),
      postal: val(a.postal), country: val(a.country), label: 'home',
    } : null;
    const canonical = {
      family: { display_name: val(h.display_name), notes: null },
      address,
      persons,
      _ref: _refOrNull(h.ref, `household ${i}`),
      _code_hint: typeof h.code_hint === 'string' && ids.kindOf(h.code_hint) === 'family' && ids.isValidCode(h.code_hint) ? h.code_hint : null,
    };
    canonical.family.display_name = _householdDisplayName(canonical);
    return { index: i, canonical };
  });
  return { index: 0, name: 'households', headers: [], colOf: new Map(), mapping: { persons: [] }, skipped: null, rows };
}

function prepare(body) {
  if (!body || typeof body !== 'object') throw new RosterError('body required');
  if (body.households !== undefined) {
    if (!Array.isArray(body.households)) throw new RosterError('households must be an array');
    if (body.sheets !== undefined) throw new RosterError('send sheets or households, not both');
    return [_prepareHouseholds(body.households)];
  }
  const sheets = body.sheets;
  if (!Array.isArray(sheets) || sheets.length === 0) throw new RosterError('sheets array required');
  if (sheets.length > LIMITS.sheets) throw new RosterError(`too many sheets (max ${LIMITS.sheets})`);
  let totalRows = 0;

  return sheets.map((sheet, si) => {
    if (!sheet || !Array.isArray(sheet.headers) || !Array.isArray(sheet.rows)) {
      throw new RosterError(`sheet ${si}: headers and rows arrays required`);
    }
    if (sheet.headers.length > LIMITS.columns) {
      throw new RosterError(`sheet ${si}: too many columns (max ${LIMITS.columns})`);
    }
    totalRows += sheet.rows.length;
    if (totalRows > LIMITS.rows) throw new RosterError(`too many rows (max ${LIMITS.rows})`);

    const headers = _uniqueHeaders(sheet.headers);
    const colOf = new Map(headers.map((h, i) => [h, i]));
    const mapping = sheet.mapping && typeof sheet.mapping === 'object'
      ? sheet.mapping
      : csv.inferMapping(headers);
    const warning = sheet.mapping ? null : csv.buildMappingWarning(mapping._flat);
    const out = {
      index: si,
      name: typeof sheet.name === 'string' ? sheet.name.slice(0, 200) : null,
      headers,
      colOf,
      mapping,
      skipped: warning ? 'no_identity_columns' : null,
      rows: [],
    };
    if (warning) return out;

    sheet.rows.forEach((raw, ri) => {
      if (!Array.isArray(raw)) throw new RosterError(`sheet ${si} row ${ri}: must be an array`);
      const obj = {};
      let any = false;
      headers.forEach((h, ci) => {
        const v = _cell(raw[ci]);
        obj[h] = v;
        if (v) any = true;
      });
      if (!any) { out.rows.push({ index: ri, skipped: 'blank' }); return; }
      if (csv.isSummaryRow(obj, headers)) { out.rows.push({ index: ri, skipped: 'summary' }); return; }
      const canonical = applyMapping(obj, mapping);
      if (!(canonical.persons || []).length) {
        out.rows.push({ index: ri, skipped: 'no_person' });
        return;
      }
      canonical.family = canonical.family || {};
      canonical.family.display_name = _householdDisplayName(canonical);
      for (const p of canonical.persons) {
        const cls = _roleClass(p.role);
        if (cls) p.kind = cls;
      }
      out.rows.push({ index: ri, canonical });
    });
    return out;
  });
}

// ---------------------------------------------------------------------------
// Lookups used while resolving
// ---------------------------------------------------------------------------

function _activeFamiliesOf(db, personCode, { includeArchived = false } = {}) {
  const statusSql = includeArchived ? `f.status IN ('active','archived')` : `f.status = 'active'`;
  return db.prepare(
    `SELECT m.family_code AS code, f.status AS status
       FROM memberships m JOIN families f ON f.code = m.family_code
      WHERE m.person_code = ? AND m.ended_at IS NULL AND ${statusSql}`
  ).all(personCode);
}

function _candidateClass(db, cand) {
  if (cand.kind === 'child' || cand.kind === 'adult') return cand.kind;
  const roles = db.prepare(
    `SELECT role FROM memberships WHERE person_code = ? AND ended_at IS NULL`
  ).all(cand.code).map(r => r.role);
  if (roles.includes('child')) return 'child';
  if (roles.some(r => ADULT_ROLES.has(r))) return 'adult';
  return null;
}

function _familySummary(db, secrets, code) {
  if (!code) return null;
  const row = db.prepare('SELECT code, status, display_name_ct FROM families WHERE code = ?').get(code);
  if (!row) return null;
  return { code: row.code, status: row.status, display_name: enc.decrypt(secrets, row.display_name_ct) };
}

function _personSummary(db, secrets, code) {
  const row = db.prepare('SELECT * FROM persons WHERE code = ?').get(code);
  if (!row) return null;
  return {
    code: row.code,
    status: row.status,
    given_name: enc.decrypt(secrets, row.given_name_ct),
    family_name: enc.decrypt(secrets, row.family_name_ct),
    suffix: enc.decrypt(secrets, row.suffix_ct),
    date_of_birth: enc.decrypt(secrets, row.date_of_birth_ct),
    grade: row.grade || null,
    kind: row.kind || null,
    do_not_contact: !!row.do_not_contact,
  };
}

// Strict household rule: someone listed by name only (a child with no
// birthdate or email) still matches when the row's own household - found
// through the adults already matched on this row, or the exact home address
// - has exactly one member with that exact first and last name, the same
// role (child/adult), and no birthdate or Jr/Sr contradiction.
function _householdMatches(db, secrets, incoming, personOutcomes, canonical) {
  const rowCodes = personOutcomes.map(o => o.code).filter(Boolean);
  const given = enc.normalizeName(incoming.given_name);
  const family = enc.normalizeName(incoming.family_name);
  if (!given || !family) return [];
  // Start from the exact namesakes (indexed hashes): a handful at most. The
  // households to check them against can be thousands when many rows share
  // one address (a parish office address used as a placeholder).
  const namesakes = db.prepare(
    `SELECT p.*, m.role AS m_role, m.family_code AS m_family FROM persons p
       JOIN memberships m ON m.person_code = p.code AND m.ended_at IS NULL
      WHERE p.given_name_hash = ? AND p.family_name_hash = ? AND p.status = 'active'`
  ).all(enc.hmac(secrets, given), enc.hmac(secrets, family));
  if (!namesakes.length) return [];

  const famCodes = new Set();
  const memberOf = db.prepare(
    `SELECT m.family_code AS code, m.role AS role FROM memberships m JOIN families f ON f.code = m.family_code
      WHERE m.person_code = ? AND m.ended_at IS NULL AND f.status = 'active'`
  );
  for (const o of personOutcomes) {
    if (!o.code) continue;
    const grp = _vouchGroup((o.incoming || {}).role);
    for (const f of memberOf.all(o.code)) {
      if (!grp || !_vouchGroup(f.role) || _vouchGroup(f.role) === grp) famCodes.add(f.code);
    }
  }
  const addr = canonical.address;
  if (addr && addr.line1) {
    const norm = enc.normalizeAddress(addr);
    const h = norm ? enc.hmac(secrets, norm) : null;
    if (h) {
      const atAddress = db.prepare(
        `SELECT 1 FROM addresses a
           JOIN family_addresses fa ON fa.address_code = a.code
           JOIN families f ON f.code = fa.family_code
          WHERE a.norm_hash = ? AND fa.family_code = ? AND f.status = 'active'`
      );
      for (const r of namesakes) if (atAddress.get(h, r.m_family)) famCodes.add(r.m_family);
    }
  }
  if (!famCodes.size) return [];
  const activeFamily = db.prepare(`SELECT 1 FROM families WHERE code = ? AND status = 'active'`);
  const incomingClass = _roleClass(incoming.role);
  const rec = resolver.toMatcherRecord(incoming);
  const found = new Map();
  for (const r of namesakes) {
    if (!famCodes.has(r.m_family) || !activeFamily.get(r.m_family)) continue;
    if (rowCodes.includes(r.code) || found.has(r.code)) continue;
    const memberClass = r.kind || _roleClass(r.m_role);
    if (incomingClass && memberClass && incomingClass !== memberClass) continue;
    const cand = resolver.enrichCandidate(db, secrets, r);
    const scored = matching.scoreMatch(rec, cand, { strict: true });
    if (scored.reasons.some(x => VETO_REASONS.has(x))) continue;
    found.set(r.code, { candidate: cand, confidence: Math.max(scored.confidence, 0.9), reasons: [...scored.reasons, 'household_exact_name'], definitive: true });
  }
  return [...found.values()];
}

// Every role class the candidate holds today (from active memberships; the
// stored kind only when there are none). Someone who was a child in their
// parents' household and is now a parent in their own holds both.
function _candidateClasses(db, cand) {
  const out = new Set();
  for (const r of db.prepare('SELECT role FROM memberships WHERE person_code = ? AND ended_at IS NULL').all(cand.code)) {
    const c = _roleClass(r.role);
    if (c) out.add(c);
  }
  if (!out.size && (cand.kind === 'child' || cand.kind === 'adult')) out.add(cand.kind);
  return out;
}

function _normGrade(g) {
  if (g === null || g === undefined) return null;
  let s = String(g).toLowerCase().replace(/grade|gr\.?|\s|-|_/g, '');
  s = s.replace(/^(\d{1,2})(st|nd|rd|th)$/, '$1');
  if (['k', 'kg', 'kinder', 'kindergarten', '0k'].includes(s)) return 'k';
  if (['pk', 'prek', 'prekindergarten', 'tk', 'pk3', 'pk4', 'prek3', 'prek4'].includes(s)) return s.startsWith('tk') ? 'tk' : 'pk';
  if (/^\d{1,2}$/.test(s)) return String(Number(s));
  return null;
}

// Evidence about the person rather than the household.
const _personEvidence = s => s.reasons.includes('exact_date_of_birth') ||
  s.reasons.includes('exact_email_match') || s.reasons.includes('exact_phone_match');

const _normEmail = e => String(e || '').trim().toLowerCase();
const _normPhone = p => { const d = String(p || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; };
const PARENT_ROLES = new Set(['parent', 'spouse', 'head']);

// "Easily determined" different people - the candidates a person should
// never be asked about. Each rule needs positive contradicting evidence;
// missing data never makes two records different.
//   - a birthdate or Jr/Sr contradiction, with no shared email, phone or
//     address (with one, it may be a typo - a person looks);
//   - a child row against an adult record or the reverse, unless the
//     birthdates match (the child who grew up and now enrolls their own);
//   - in the same upload, two children with the same name in different
//     grades;
//   - two adults whose emails, phones AND home addresses all differ; in the
//     same upload two parents need only differ in email or phone AND home
//     address (one roster lists each household once, at one address).
function _clearlyDifferent(db, s, incoming, address, runSeen) {
  const r = s.reasons;
  const c = s.candidate;
  const shared = r.includes('exact_email_match') || r.includes('exact_phone_match') ||
    r.includes('address_match_household') || r.includes('similar_address');
  if (r.includes('suffix_conflict')) {
    // Jr vs Sr, II vs III: two people by definition. (Jr and II are used
    // interchangeably by some families, so that pair still goes to a person.)
    const pair = [matching.generationalSuffix(incoming), matching.generationalSuffix(c)].sort().join(',');
    if (pair !== 'ii,jr') return 'suffix_differs';
  }
  if (r.includes('dob_conflict') && !shared) return 'birthdate_differs';
  const inc = _roleClass(incoming.role);
  const classes = _candidateClasses(db, c);
  if (inc && classes.size && !classes.has(inc) && !_personEvidence(s)) return 'adult_and_child';
  if (shared) return null;
  const seen = runSeen.get(c.code);
  if (seen && inc === 'child') {
    const a = _normGrade(incoming.grade);
    const b = _normGrade(seen.grade);
    if (a && b && a !== b) return 'different_grade_same_upload';
  }
  const incEmails = (incoming.emails || []).map(_normEmail).filter(Boolean);
  const incPhones = (incoming.phones || []).flatMap(p => matching.splitPhones(p)).map(_normPhone).filter(Boolean);
  const candEmails = new Set([...(c.emails || []), ...(seen ? seen.emails : [])].map(_normEmail).filter(Boolean));
  const candPhones = new Set([...(c.phones || []), ...(seen ? seen.phones : [])].map(_normPhone).filter(Boolean));
  const emailsDiffer = incEmails.length > 0 && candEmails.size > 0 && !incEmails.some(e => candEmails.has(e));
  const phonesDiffer = incPhones.length > 0 && candPhones.size > 0 && !incPhones.some(p => candPhones.has(p));
  const candLines = [c.address_line1, seen && seen.address && seen.address.line1].filter(Boolean);
  const incLine = address && address.line1;
  const addressDiffers = !!incLine && candLines.length > 0 &&
    candLines.every(l => matching.addressSimilarity(incLine, l) <= 0.65);
  if (emailsDiffer && phonesDiffer && addressDiffers) return 'contacts_and_address_differ';
  if (seen && PARENT_ROLES.has(incoming.role) && PARENT_ROLES.has(seen.role) &&
      (emailsDiffer || phonesDiffer) && addressDiffers) return 'different_household_same_upload';
  return null;
}

// ---------------------------------------------------------------------------
// Household evidence
// ---------------------------------------------------------------------------

// The capacity someone holds in a household, for "does their membership
// vouch for this row being that household?". Unknown roles vouch for any.
function _vouchGroup(role) {
  if (role === 'child') return 'child';
  if (role === 'parent' || role === 'spouse' || role === 'head' || role === 'guardian') return 'core';
  if (role === 'grandparent' || role === 'other_adult') return 'extended';
  return null;
}

const SURNAME_STOP = new Set(['family', 'the', 'and', 'of', 'de', 'la', 'del', 'los', 'las', 'da', 'do', 'dos', 'van', 'von', 'der', 'y', 'e', 'mr', 'mrs', 'ms', 'dr']);

function _surnameTokens(names) {
  const out = new Set();
  for (const n of names) {
    const norm = enc.normalizeName(n);
    if (!norm) continue;
    for (const tok of norm.split(/[\s-]+/)) if (tok.length >= 2 && !SURNAME_STOP.has(tok)) out.add(tok);
  }
  return out;
}

// Does anyone in this household (or its name) share a surname with the row?
function _familySurnameFits(db, secrets, code, rowTokens) {
  if (!rowTokens.size) return false;
  const f = _familySummary(db, secrets, code);
  const names = [f && f.display_name];
  for (const r of db.prepare(
    `SELECT p.family_name_ct FROM memberships m JOIN persons p ON p.code = m.person_code
      WHERE m.family_code = ? AND m.ended_at IS NULL`
  ).all(code)) names.push(enc.decrypt(secrets, r.family_name_ct));
  for (const tok of _surnameTokens(names.filter(Boolean))) if (rowTokens.has(tok)) return true;
  return false;
}

function _familiesAtAddress(db, secrets, address) {
  if (!address || !address.line1) return [];
  const norm = enc.normalizeAddress(address);
  const h = norm ? enc.hmac(secrets, norm) : null;
  if (!h) return [];
  return db.prepare(
    `SELECT DISTINCT fa.family_code AS code FROM addresses a
       JOIN family_addresses fa ON fa.address_code = a.code
       JOIN families f ON f.code = fa.family_code
      WHERE a.norm_hash = ? AND f.status IN ('active','archived')`
  ).all(h).map(r => r.code);
}

// Placeholder contact values say nothing about who someone is.
const FAKE_EMAIL_RE = /^(no|none|na|n\/a|noemail|no-?email|noreply|no-?reply|unknown|test|null|x+|nobody|donotreply|do-?not-?reply)@/i;
function _realEmail(e) {
  const v = _normEmail(e);
  return v.includes('@') && !FAKE_EMAIL_RE.test(v) ? v : null;
}
function _realPhone(p) {
  const d = _normPhone(p);
  if (d.length !== 10 || /^(\d)\1+$/.test(d) || /^(0123456789|1234567890)$/.test(d) || /555(0100|1212)$/.test(d)) return null;
  return d;
}

// Households of people NOT on this row who share an exact email or phone
// with someone on it: the family inbox a spouse is listed under, a parent's
// phone on a child's row. A contact already spread over more than two
// households (an office line, a shared placeholder) proves nothing.
function _familiesSharingContact(db, secrets, personOutcomes, rowCodes) {
  const counts = new Map();
  const emailQ = db.prepare(
    `SELECT DISTINCT m.family_code AS code FROM emails e
       JOIN person_emails pe ON pe.email_code = e.code
       JOIN persons p ON p.code = pe.person_code AND p.status = 'active'
       JOIN memberships m ON m.person_code = p.code AND m.ended_at IS NULL
       JOIN families f ON f.code = m.family_code AND f.status = 'active'
      WHERE e.norm_hash = ? AND p.code NOT IN (SELECT value FROM json_each(?))`
  );
  const phoneQ = db.prepare(
    `SELECT DISTINCT m.family_code AS code FROM phones ph
       JOIN person_phones pp ON pp.phone_code = ph.code
       JOIN persons p ON p.code = pp.person_code AND p.status = 'active'
       JOIN memberships m ON m.person_code = p.code AND m.ended_at IS NULL
       JOIN families f ON f.code = m.family_code AND f.status = 'active'
      WHERE ph.norm_hash = ? AND p.code NOT IN (SELECT value FROM json_each(?))`
  );
  const exclude = JSON.stringify(rowCodes);
  const seen = new Set();
  for (const o of personOutcomes) {
    const inc = o.incoming || {};
    for (const e of inc.emails || []) {
      const v = _realEmail(e);
      const norm = v && enc.normalizeEmail(v);
      if (!norm || seen.has(`e:${norm}`)) continue;
      seen.add(`e:${norm}`);
      const fams = emailQ.all(enc.hmac(secrets, norm), exclude).map(r => r.code);
      if (fams.length > 2) continue;
      for (const c of fams) counts.set(c, (counts.get(c) || 0) + 1);
    }
    for (const ph of inc.phones || []) {
      if (!_realPhone(ph)) continue;
      const norm = enc.normalizePhone(ph);
      if (!norm || seen.has(`p:${norm}`)) continue;
      seen.add(`p:${norm}`);
      const fams = phoneQ.all(enc.hmac(secrets, norm), exclude).map(r => r.code);
      if (fams.length > 2) continue;
      for (const c of fams) counts.set(c, (counts.get(c) || 0) + 1);
    }
  }
  return counts;
}

// Does this record still describe that person? Names, birthdate and Jr/Sr
// only: a shared email or phone proves nothing about WHICH family member a
// stored link belongs to (and the scorer stops at an exact email).
function _namesScore(incoming, cand) {
  const strip = r => ({ ...r, emails: [], phones: [], email: null, phone: null });
  return matching.scoreMatch(strip(resolver.toMatcherRecord(incoming)), strip(cand), { strict: true });
}

// An earlier person on the same row with exactly this name and nothing that
// tells them apart (no differing Jr/Sr, no differing birthdate, not a parent
// and a student - those are two people by definition).
function _sameNameOnRow(incoming, personOutcomes) {
  const g = enc.normalizeName(incoming.given_name);
  const f = enc.normalizeName(incoming.family_name);
  if (!g || !f) return null;
  const cls = _roleClass(incoming.role);
  for (const o of personOutcomes) {
    const p = o.incoming || {};
    if (!o.code || enc.normalizeName(p.given_name) !== g || enc.normalizeName(p.family_name) !== f) continue;
    const pcls = _roleClass(p.role);
    if (cls && pcls && cls !== pcls) continue;
    // A grandparent and a parent (or child) with one name are two
    // generations - Maria the grandmother and Maria the mother.
    const gen = r => (r === 'grandparent' ? 2 : (r === 'parent' || r === 'spouse' || r === 'head') ? 1 : r === 'child' ? 0 : null);
    const ga = gen(incoming.role);
    const gb = gen(p.role);
    if (ga !== null && gb !== null && ga !== gb) continue;
    const sa = matching.generationalSuffix(incoming);
    const sb = matching.generationalSuffix(p);
    if (sa && sb && sa !== sb) continue;
    const da = matching.normalizeDob(incoming.date_of_birth);
    const db2 = matching.normalizeDob(p.date_of_birth);
    if (da && db2 && da !== db2) continue;
    return { code: o.code };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function run(db, secrets, thresholds, body, { mode, actor = 'roster' } = {}) {
  if (mode !== 'plan' && mode !== 'commit') throw new Error('mode must be plan or commit');
  const started = Date.now();
  const sheets = prepare(body);
  const decisions = (body.decisions && typeof body.decisions === 'object') ? body.decisions : {};
  if (body.source !== undefined && !(typeof body.source === 'string' && crosswalk.SOURCE_RE.test(body.source))) {
    throw new RosterError('source must be a short lowercase name like "missioniq"');
  }
  const source = body.source || 'roster';
  const sourceRef = typeof body.source_ref === 'string' ? body.source_ref.slice(0, 200) : null;
  const category = ['church', 'school', 'other'].includes(body.category) ? body.category : null;
  const tags = Array.isArray(body.tags) ? body.tags.map(String).slice(0, 20) : null;

  // Validate decision shapes up front: a malformed decision is a caller bug,
  // never something to guess around.
  for (const [key, d] of Object.entries(decisions)) {
    if (!/^\d+:\d+:(\d+|family)$/.test(key)) throw new RosterError(`bad decision key: ${key}`);
    if (!d || typeof d !== 'object') throw new RosterError(`decision ${key}: object required`);
    const isFamily = key.endsWith(':family');
    const allowed = isFamily ? ['attach', 'create'] : ['attach', 'create', 'skip'];
    if (!allowed.includes(d.action)) throw new RosterError(`decision ${key}: action must be ${allowed.join(' | ')}`);
    if (d.action === 'attach' && typeof d.target !== 'string') {
      throw new RosterError(`decision ${key}: attach needs a target`);
    }
  }

  const createdPersons = new Map();   // code -> person key (minted in this run)
  const createdFamilies = new Map();  // code -> family key
  const personCodeByKey = new Map();
  const familyCodeByKey = new Map();
  const pending = [];
  const output = sheets.map(s => ({
    index: s.index,
    name: s.name,
    skipped: s.skipped,
    columns: s.headers,
    mapping: _mappingSummary(s),
    rows: [],
  }));

  // An id minted during this run exists only if the run commits. A plan
  // never shows one; a commit that is refused (pending reviews) is rolled
  // back, and every id it would have minted is blanked before responding
  // (see _blankIds below).
  function communityIdFor(code, createdMap) {
    if (mode === 'plan' && createdMap.has(code)) return null;
    return ids.toCommunityId(code);
  }

  function describePerson(scored) {
    const c = scored.candidate;
    const fam = _activeFamiliesOf(db, c.code, { includeArchived: true })[0];
    const famSummary = fam ? _familySummary(db, secrets, fam.code) : null;
    const d = {
      community_id: communityIdFor(c.code, createdPersons),
      sheet_ref: createdPersons.get(c.code) || null,
      status: c.status || 'active',
      given_name: c.given_name || null,
      family_name: c.family_name || null,
      suffix: c.suffix || null,
      date_of_birth: c.date_of_birth || null,
      role: _candidateClass(db, c),
      family: famSummary ? {
        community_id: communityIdFor(famSummary.code, createdFamilies),
        sheet_ref: createdFamilies.get(famSummary.code) || null,
        display_name: famSummary.display_name,
      } : null,
      confidence: Math.round(scored.confidence * 100) / 100,
      reasons: scored.reasons,
    };
    const grade = db.prepare('SELECT grade FROM persons WHERE code = ?').get(c.code);
    d.grade = grade ? grade.grade || null : null;
    return d;
  }

  function resolveTargetPerson(target) {
    if (/^\d+:\d+:\d+$/.test(target)) {
      const code = personCodeByKey.get(target);
      if (!code) throw new RosterError(`decision target ${target} is not an earlier person on this upload`, 409);
      return code;
    }
    const code = ids.fromCommunityId(target);
    if (!code || ids.kindOf(code) !== 'person') throw new RosterError(`decision target ${target} is not an individual id`, 409);
    const resolved = aliases.resolveAlias(db, code);
    const row = db.prepare('SELECT code, status FROM persons WHERE code = ?').get(resolved);
    if (!row) throw new RosterError(`decision target ${target} does not exist`, 409);
    return row.code;
  }

  function resolveTargetFamily(target) {
    if (/^\d+:\d+:family$/.test(target)) {
      const code = familyCodeByKey.get(target);
      if (!code) throw new RosterError(`decision target ${target} is not an earlier household on this upload`, 409);
      return code;
    }
    const code = ids.fromCommunityId(target);
    if (!code || ids.kindOf(code) !== 'family') throw new RosterError(`decision target ${target} is not a family id`, 409);
    const resolved = aliases.resolveAlias(db, code);
    const row = db.prepare('SELECT code, status FROM families WHERE code = ?').get(resolved);
    if (!row) throw new RosterError(`decision target ${target} does not exist`, 409);
    return row.code;
  }

  function attachPerson(code, incoming, { via, reasons, confidence }) {
    const row = db.prepare('SELECT status FROM persons WHERE code = ?').get(code);
    if (row && row.status === 'archived') {
      people.reinstate(db, code, { actor, reason: 'returned on a roster import' });
    }
    const cur = _personSummary(db, secrets, code);
    const patch = {};
    if (!cur.given_name && incoming.given_name) patch.given_name = incoming.given_name;
    if (!cur.family_name && incoming.family_name) patch.family_name = incoming.family_name;
    if (!cur.date_of_birth && incoming.date_of_birth) patch.date_of_birth = incoming.date_of_birth;
    if (!cur.suffix && incoming.suffix) patch.suffix = incoming.suffix;
    if (!cur.kind && incoming.kind) patch.kind = incoming.kind;
    if (incoming.do_not_contact && !cur.do_not_contact) patch.do_not_contact = true;
    if (Object.keys(patch).length) people.update(db, secrets, code, patch, { actor, reason: 'roster import filled a blank field' });
    audit.record(db, {
      action: via === 'decision' ? 'resolver_attach_manual' : 'resolver_attach',
      actor,
      entityCode: code,
      entityKind: 'person',
      metadata: { via, confidence, reasons, strict: true },
    });
    return { code, action: 'attached', score: confidence || 1, reasons: reasons || [] };
  }

  function createPerson(incoming, key, { rejected = [] } = {}) {
    const code = people.create(db, secrets, incoming, { actor, reason: 'roster import' });
    createdPersons.set(code, key);
    for (const r of rejected) {
      if (!r || !r.code || createdPersons.has(r.code)) continue;
      db.prepare(
        `INSERT INTO conflicts (code, kind, left_code, right_code, score, reasons, status, resolved_by, resolved_at, resolution_notes)
         VALUES (?, 'person', ?, ?, ?, ?, 'rejected', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`
      ).run(ids.newCode('conflict'), code, r.code, r.confidence || 0, JSON.stringify(r.reasons || []),
        actor, 'roster review: operator said these are different people');
    }
    audit.record(db, {
      action: 'resolver_created',
      actor,
      entityCode: code,
      entityKind: 'person',
      metadata: { strict: true, reviewed_against: rejected.map(r => r.code) },
    });
    return { code, action: 'created', score: 0, reasons: [] };
  }

  const summary = {
    sheets: sheets.length,
    rows: 0,
    persons: { matched: 0, new: 0, review: 0, skipped: 0 },
    families: { matched: 0, new: 0, review: 0 },
    crosswalk: { created: 0, unchanged: 0, relinked: 0 },
    // New people who had a namesake the rules could tell apart on their own
    // (different birthdate, grade, household, adult vs child) - not asked.
    told_apart: 0,
  };
  const runSeen = new Map();   // person code -> what this upload said about them

  function processSheet(sheet) {
    const outSheet = output[sheet.index];
    if (sheet.skipped) return;
    const rowsToImport = [];
    for (const row of sheet.rows) {
      if (row.skipped) {
        outSheet.rows.push({ index: row.index, skipped: row.skipped });
        continue;
      }
      summary.rows += 1;
      const outRow = { index: row.index, persons: [], family: null };
      outSheet.rows.push(outRow);

      // Slots the operator marked "not a person" leave the row before import.
      const kept = [];
      row.canonical.persons.forEach((p, slot) => {
        const key = `${sheet.index}:${row.index}:${slot}`;
        const d = decisions[key];
        const desc = _slotDescription(sheet, p, slot, key);
        if (d && d.action === 'skip') {
          outRow.persons.push({ ...desc, action: 'skip', decided: true });
          summary.persons.skipped += 1;
          return;
        }
        outRow.persons.push(desc);
        kept.push({ p, slot, key, out: desc });
      });
      if (!kept.length) continue;
      const canonical = { ...row.canonical, persons: kept.map(k => k.p) };
      rowsToImport.push({ row, outRow, canonical, kept });
    }

    for (const item of rowsToImport) {
      const { row, outRow, canonical, kept } = item;
      const familyKey = `${sheet.index}:${row.index}:family`;

      const resolvePerson = (incoming, pi, { personOutcomes }) => {
        const { key, out } = kept[pi];
        const rowCodes = personOutcomes.map(o => o.code).filter(Boolean);
        const d = decisions[key];

        // The row's home address belongs to everyone on the row, so "same
        // name at the same address" can match a person listed without an
        // email or phone (a parishioner list, a re-imported roster).
        const forScore = canonical.address && canonical.address.line1 ? { ...incoming, address: canonical.address } : incoming;
        const scored = resolver
          .scoreCandidates(db, secrets, forScore, { strict: true, includeArchived: true })
          .filter(s => !rowCodes.includes(s.candidate.code));
        // The scorer stops at an exact email or phone without comparing names;
        // plausibility and "clearly different" need the name comparison too.
        for (const sc of scored) {
          if (!sc.reasons.includes('exact_email_match') && !sc.reasons.includes('exact_phone_match')) continue;
          for (const r of _namesScore(incoming, sc.candidate).reasons) {
            if ((FIRST_NAME_REASONS.has(r) || r === 'exact_date_of_birth' || r === 'exact_last_name' || r === 'similar_last_name') &&
                !sc.reasons.includes(r)) sc.reasons.push(r);
          }
        }
        const t = thresholds;
        const incomingClass = _roleClass(incoming.role);
        const strong = [];
        const reviewReasons = new Set();
        let toldApart = 0;
        const different = new Map();
        const isDifferent = sc => {
          if (!different.has(sc.candidate.code)) {
            different.set(sc.candidate.code, _clearlyDifferent(db, sc, incoming, canonical.address, runSeen));
          }
          return different.get(sc.candidate.code);
        };
        for (const s of scored) {
          // Only a definitive signal matches on its own: an exact email or
          // phone with the first name lining up, exact name + birthdate, or
          // exact name + the same home address. A high score built from
          // softer signals (jsmith@ vs jsmith1@ plus the same name and zip)
          // is two John Smiths as often as one, so it goes to a person.
          if (!s.definitive) continue;
          const classes = _candidateClasses(db, s.candidate);
          if (incomingClass && classes.size && !classes.has(incomingClass)) {
            // A child row against an adult record (or the reverse) at the
            // same address is a namesake - John Jr. under John. A matching
            // birthdate, email or phone (the child who grew up, or a father
            // and son on one inbox) is worth a look; nothing less is.
            if (_personEvidence(s)) {
              reviewReasons.add('role_mismatch');
              s.reasons = [...s.reasons, 'role_mismatch'];
              s.roleMismatch = true;
            }
            continue;
          }
          strong.push(s);
        }
        // Candidates worth a person's time: something about the person lines
        // up, and nothing clearly says "someone else".
        const reviewable = sc => sc.confidence >= t.review && _plausible(sc) && !isDifferent(sc);
        const household = _householdMatches(db, secrets, incoming, personOutcomes, canonical);

        // Exact links come before any matching. (1) The crosswalk: this very
        // source record was imported before - it IS that person, unless the
        // record has since changed into someone else (first name and
        // birthdate both differ now, or a birthdate / Jr-Sr contradiction).
        // (2) A code the source app already stored: honored only while the
        // record still agrees with it (same first name, no birthdate or
        // Jr/Sr conflict, not already someone else on this row). A code from
        // an old sync that fused two spouses fails that test and goes to a
        // human.
        let pre = null;
        const others = scored.filter(sc => _plausible(sc) && !isDifferent(sc));
        if (incoming._ref) {
          const x = crosswalk.lookup(db, source, incoming._ref);
          if (x && x.kind === 'person') {
            const row0 = db.prepare('SELECT * FROM persons WHERE code = ?').get(x.code);
            const cand = resolver.enrichCandidate(db, secrets, row0);
            const sc = _namesScore(incoming, cand);
            const s = { candidate: cand, confidence: 1, reasons: ['linked_record', ...sc.reasons], definitive: true };
            const rest = others.filter(o => o.candidate.code !== x.code);
            const stillSame = !sc.reasons.some(r => LINK_VETOES.has(r)) &&
              (sc.reasons.some(r => FIRST_NAME_REASONS.has(r)) || sc.reasons.includes('exact_date_of_birth'));
            if (rowCodes.includes(x.code)) pre = { kind: 'review', cands: [s, ...rest].slice(0, 4), reason: 'linked_record_used_twice' };
            else if (x.status === 'archived') pre = { kind: 'review', cands: [s, ...rest].slice(0, 4), reason: 'linked_record_archived' };
            else if (!stillSame) pre = { kind: 'review', cands: [s, ...rest].slice(0, 4), reason: 'linked_record_changed' };
            else pre = { kind: 'match', best: s, via: 'linked' };
          }
        }
        if (!pre && incoming._code_hint && !_nameProblem(incoming)) {
          const hinted = aliases.resolveAlias(db, incoming._code_hint);
          const row0 = db.prepare('SELECT * FROM persons WHERE code = ?').get(hinted);
          if (row0 && row0.status !== 'merged') {
            const cand = resolver.enrichCandidate(db, secrets, row0);
            const sc = _namesScore(incoming, cand);
            const s = { candidate: cand, confidence: sc.confidence, reasons: [...sc.reasons, 'prior_link'], definitive: sc.definitive };
            const namesAgree = sc.reasons.includes('exact_first_name') ||
              (sc.reasons.includes('nickname_or_short_form') && !matching.nicknameAmbiguous(incoming.given_name));
            const vetoed = sc.reasons.some(r => VETO_REASONS.has(r));
            const rest = others.filter(o => o.candidate.code !== hinted);
            if (rowCodes.includes(hinted)) pre = { kind: 'review', cands: [s, ...rest].slice(0, 4), reason: 'prior_link_used_twice' };
            else if (row0.status === 'archived') pre = { kind: 'review', cands: [s, ...rest].slice(0, 4), reason: 'candidate_archived' };
            else if (!namesAgree || vetoed) pre = { kind: 'review', cands: [s, ...rest].slice(0, 4), reason: 'prior_link_disagrees' };
            else pre = { kind: 'match', best: s, via: 'prior_link' };
          }
        }

        // The same name twice in one household: a father and son without a
        // Jr/Sr, or the same person entered twice. Only a human can tell.
        const twin = pre ? null : _sameNameOnRow(incoming, personOutcomes);

        let verdict;   // { kind: 'match', best } | { kind: 'review', cands } | { kind: 'new' }
        const activeStrong = strong.filter(s => s.candidate.status !== 'archived');
        const nameProblem = pre ? null : _nameProblem(incoming);
        if (pre) {
          verdict = pre;
          if (pre.reason) reviewReasons.add(pre.reason);
        } else if (nameProblem) {
          verdict = { kind: 'review', cands: others.slice(0, 3) };
          reviewReasons.add(nameProblem);
        } else if (twin) {
          const row0 = db.prepare('SELECT * FROM persons WHERE code = ?').get(twin.code);
          const s = { candidate: resolver.enrichCandidate(db, secrets, row0), confidence: 0.9, reasons: ['same_name_on_row'], definitive: false };
          verdict = { kind: 'review', cands: [s, ...strong.filter(o => o.candidate.code !== twin.code)].slice(0, 4) };
          reviewReasons.add('same_name_twice_in_household');
        } else if (strong.length === 1 && activeStrong.length === 1 &&
                   !(household.length && !household.some(h => h.candidate.code === strong[0].candidate.code))) {
          verdict = { kind: 'match', best: strong[0], via: 'score' };
        } else if (strong.length > 1) {
          verdict = { kind: 'review', cands: strong.slice(0, 5) };
          reviewReasons.add('several_strong_candidates');
        } else if (strong.length === 1) {
          verdict = { kind: 'review', cands: [strong[0], ...household].slice(0, 5) };
          reviewReasons.add(strong[0].candidate.status === 'archived' ? 'candidate_archived' : 'household_disagrees');
        } else if (household.length === 1) {
          verdict = { kind: 'match', best: household[0], via: 'household' };
        } else if (household.length > 1) {
          verdict = { kind: 'review', cands: household.slice(0, 5) };
          reviewReasons.add('several_household_namesakes');
        } else if (scored.some(reviewable)) {
          verdict = { kind: 'review', cands: scored.filter(reviewable).slice(0, 3) };
          reviewReasons.add('possible_match');
        } else if (reviewReasons.has('role_mismatch')) {
          verdict = { kind: 'review', cands: scored.filter(sc => sc.roleMismatch).slice(0, 3) };
        } else {
          verdict = { kind: 'new' };
          toldApart = scored.filter(sc => _plausible(sc) && sc.confidence >= t.review && isDifferent(sc)).length;
        }

        // Another record of the same source app already IS this person
        // (MissionIQ holding one parent in two households, or a duplicate
        // contact). Probably right - but two records claiming one human is
        // exactly how two humans end up fused, so a person confirms it once.
        // From then on both records are linked and never asked about again.
        if (verdict.kind === 'match' && verdict.via !== 'linked' && incoming._ref) {
          const code = verdict.best.candidate.code;
          if (crosswalk.refsFor(db, source, 'person', code).some(r => r !== incoming._ref)) {
            verdict = { kind: 'review', cands: [verdict.best, ...others.filter(o => o.candidate.code !== code)].slice(0, 4) };
            reviewReasons.add('same_person_as_another_record');
          }
        }

        if (verdict.kind === 'review') {
          out.candidates = verdict.cands.map(describePerson);
          out.review_reasons = [...reviewReasons];
        }

        let result;
        if (d) {
          out.decided = true;
          if (d.action === 'attach') {
            const code = resolveTargetPerson(d.target);
            // Someone already on this row can only be chosen when the review
            // itself offered them (the same name twice, or a stored link
            // used twice) - never by a typo'd id.
            const offered = (verdict.cands || []).some(s => s.candidate.code === code);
            if (rowCodes.includes(code) && !offered) {
              throw new RosterError(`decision ${key}: that id is already another person on the same row`, 409);
            }
            result = attachPerson(code, incoming, { via: 'decision', reasons: ['operator_decision'], confidence: 1 });
          } else {
            const rejected = (verdict.cands || []).map(s => ({ code: s.candidate.code, confidence: s.confidence, reasons: s.reasons }));
            result = createPerson(incoming, key, { rejected });
          }
          out.action = verdict.kind === 'review' ? 'review' : (result.action === 'attached' ? 'matched' : 'new');
        } else if (verdict.kind === 'match') {
          result = attachPerson(verdict.best.candidate.code, incoming, {
            via: verdict.via, reasons: verdict.best.reasons, confidence: verdict.best.confidence,
          });
          out.action = 'matched';
          out.matched = { ...describePerson(verdict.best), via: verdict.via };
        } else if (verdict.kind === 'new') {
          result = createPerson(incoming, key);
          out.action = 'new';
        } else {
          // Undecided review. PLAN carries on as if it were a new person so
          // later rows can still see this one; COMMIT will refuse at the end.
          pending.push(key);
          result = createPerson(incoming, key);
          out.action = 'review';
        }

        personCodeByKey.set(key, result.code);
        // What this upload says about the person, for telling namesakes
        // apart later in the same upload.
        const prev = runSeen.get(result.code);
        runSeen.set(result.code, {
          role: (prev && prev.role) || incoming.role || null,
          grade: incoming.grade || (prev && prev.grade) || null,
          emails: [...((prev && prev.emails) || []), ...(incoming.emails || [])],
          phones: [...((prev && prev.phones) || []), ...(incoming.phones || [])],
          address: (canonical.address && canonical.address.line1) ? canonical.address : ((prev && prev.address) || null),
        });
        if (toldApart && out.action === 'new') {
          summary.told_apart += 1;
          out.told_apart = toldApart;
        }
        if (incoming._ref) {
          const how = crosswalk.link(db, { source, ref: incoming._ref, kind: 'person', code: result.code });
          summary.crosswalk[how] += 1;
        }
        out.code_state = createdPersons.has(result.code) ? 'new' : 'existing';
        out.community_id = communityIdFor(result.code, createdPersons);
        if (result.action === 'attached' && createdPersons.has(result.code)) {
          out.same_as = createdPersons.get(result.code);
        }
        if (out.action === 'matched') summary.persons.matched += 1;
        else if (out.action === 'new') summary.persons.new += 1;
        else summary.persons.review += 1;
        return result;
      };

      const resolveFamily = (input, { personOutcomes }) => {
        const d = decisions[familyKey];
        const rowCodes = personOutcomes.map(o => o.code).filter(Boolean);
        const outFam = {
          key: familyKey,
          display_name: input.display_name || null,
          cell: _familyCell(sheet),
          ...(canonical._code_hint ? { prior_community_id: ids.toCommunityId(canonical._code_hint) } : {}),
        };
        outRow.family = outFam;

        // Households every already-known person on the row belongs to - in
        // the same capacity they have on this row. A grown-up child now
        // listed as a parent does not pull their own children into the
        // household they grew up in; a grandparent on a daughter's row does
        // not pull the daughter into the grandparent's own household.
        const sets = [];
        const union = new Map();
        let vouchingAdults = 0;
        let newAdults = 0;
        for (const o of personOutcomes) {
          if (!o.code) continue;
          const role = (o.incoming || {}).role;
          const grp = _vouchGroup(role);
          const fams = db.prepare(
            `SELECT m.family_code AS code, m.role AS role FROM memberships m
               JOIN families f ON f.code = m.family_code
              WHERE m.person_code = ? AND m.ended_at IS NULL AND f.status IN ('active','archived')`
          ).all(o.code).filter(f => !grp || !_vouchGroup(f.role) || _vouchGroup(f.role) === grp);
          if (!fams.length) {
            if (_roleClass(role) === 'adult') newAdults += 1;
            continue;
          }
          if (_roleClass(role) === 'adult') vouchingAdults += 1;
          sets.push(new Set(fams.map(f => f.code)));
          for (const f of fams) union.set(f.code, (union.get(f.code) || 0) + 1);
        }
        let verdict;
        const reasons = [];
        // Exact links first, as for people: the crosswalk, then a code the
        // source app stored - each honored only if it agrees with the
        // households of the people already known on this row.
        const sharedNow = sets.length ? [...sets[0]].filter(c => sets.every(s => s.has(c))) : null;
        const consistent = code => sharedNow === null || sharedNow.includes(code);
        const unionCodes = () => [...union.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
        let pre = null;
        if (canonical._ref) {
          const x = crosswalk.lookup(db, source, canonical._ref);
          if (x && x.kind === 'family') {
            if (x.status === 'archived') pre = { kind: 'review', cands: [x.code], reason: 'linked_household_archived' };
            else if (consistent(x.code)) pre = { kind: 'match', code: x.code, via: 'linked' };
            else pre = { kind: 'review', cands: [x.code, ...unionCodes().filter(c => c !== x.code)].slice(0, 5), reason: 'linked_household_disagrees' };
          }
        }
        // A stored household code needs a positive confirmation: someone
        // already known on this row must be in it. With nobody known, the
        // code may come from an old sync that fused this household with
        // another, so a person looks.
        if (!pre && canonical._code_hint) {
          const hinted = aliases.resolveAlias(db, canonical._code_hint);
          const f = _familySummary(db, secrets, hinted);
          if (f && f.status !== 'merged') {
            const rest = unionCodes().filter(c => c !== hinted);
            if (f.status === 'archived') pre = { kind: 'review', cands: [hinted, ...rest].slice(0, 5), reason: 'household_archived' };
            else if (sharedNow && sharedNow.includes(hinted)) pre = { kind: 'match', code: hinted, via: 'prior_link' };
            else pre = { kind: 'review', cands: [hinted, ...rest].slice(0, 5), reason: sharedNow ? 'prior_link_disagrees' : 'prior_link_unconfirmed' };
          }
        }
        if (pre) {
          verdict = pre;
          if (pre.reason) reasons.push(pre.reason);
        } else {
          // Which household is this row? First, the households of the people
          // already known on it. Beyond that, two kinds of evidence:
          //   - the exact home address, but only together with a surname:
          //     people move, so a house is the same household only while the
          //     same family lives in it;
          //   - an email or phone someone on the row shares with a person
          //     already in a household (a spouse on the family inbox, a
          //     child under a parent's phone), again with a surname in
          //     common. A family that moved keeps its email and phone.
          const rowTokens = _surnameTokens([
            ...canonical.persons.map(p => p.family_name),
            ...(input.display_name ? [input.display_name] : []),
          ].filter(Boolean));
          const isActive = c => { const f = _familySummary(db, secrets, c); return !!f && f.status === 'active'; };
          const atAddress = _familiesAtAddress(db, secrets, input.address);
          const viaContact = _familiesSharingContact(db, secrets, personOutcomes, rowCodes);
          if (sets.length) {
            const shared = sharedNow;
            const activeShared = shared.filter(isActive);
            if (shared.length === 1 && activeShared.length === 1 && !vouchingAdults && newAdults &&
                !atAddress.includes(shared[0]) && !viaContact.has(shared[0])) {
              // Only children are known, and a new adult is listed with them
              // somewhere else: the other parent's household (divorced
              // parents), or a new parent in the same one. A person decides.
              verdict = { kind: 'review', cands: [shared[0]] };
              reasons.push('new_adult_with_known_children');
            } else if (shared.length === 1 && activeShared.length === 1) {
              verdict = { kind: 'match', code: shared[0], via: 'members' };
            } else {
              // Known people in several households (a child of divorced
              // parents, a grandparent): the row's own address or contact
              // settles it when it points at exactly one of them.
              const pool = shared.length ? shared : unionCodes();
              const pointed = pool.filter(c => isActive(c) && (atAddress.includes(c) || viaContact.has(c)));
              if (pointed.length === 1) {
                verdict = { kind: 'match', code: pointed[0], via: atAddress.includes(pointed[0]) ? 'members_and_address' : 'members_and_contact' };
              } else {
                verdict = { kind: 'review', cands: unionCodes().slice(0, 5) };
                reasons.push(shared.length > 1 ? 'members_in_several_households'
                  : shared.length === 1 ? 'household_archived' : 'members_in_different_households');
              }
            }
          } else {
            const byContact = [...viaContact.keys()];
            const contactFit = byContact.filter(c => _familySurnameFits(db, secrets, c, rowTokens));
            const addressFit = atAddress.filter(c => _familySurnameFits(db, secrets, c, rowTokens));
            if (contactFit.length === 1) {
              verdict = { kind: 'match', code: contactFit[0], via: 'shared_contact' };
            } else if (contactFit.length > 1) {
              const both = contactFit.filter(c => atAddress.includes(c));
              if (both.length === 1) verdict = { kind: 'match', code: both[0], via: 'shared_contact' };
              else {
                verdict = { kind: 'review', cands: contactFit.slice(0, 5) };
                reasons.push('several_households_share_contact');
              }
            } else if (byContact.length) {
              verdict = { kind: 'review', cands: [...byContact, ...addressFit].slice(0, 5) };
              reasons.push('shared_contact_other_surname');
            } else if (addressFit.length === 1 && isActive(addressFit[0])) {
              verdict = { kind: 'match', code: addressFit[0], via: 'address_and_surname' };
            } else if (addressFit.length === 1) {
              verdict = { kind: 'review', cands: addressFit };
              reasons.push('household_archived');
            } else if (addressFit.length > 1) {
              verdict = { kind: 'review', cands: addressFit.slice(0, 5) };
              reasons.push('several_households_at_address');
            } else {
              // Nobody known, no shared contact, and nobody at this address
              // shares a surname: a different household (a new family moved
              // in, or a different family entirely).
              verdict = { kind: 'new' };
            }
          }
        }
        // As for people: a household another record of the same app already
        // IS (a duplicate household there, or a second household that shares
        // children - divorced parents) is confirmed by a person once.
        if (verdict.kind === 'match' && verdict.via !== 'linked' && canonical._ref &&
            crosswalk.refsFor(db, source, 'family', verdict.code).some(r => r !== canonical._ref)) {
          verdict = { kind: 'review', cands: [verdict.code, ...unionCodes().filter(c => c !== verdict.code)].slice(0, 5) };
          reasons.push('same_household_as_another_record');
        }

        const describeFamily = (code) => {
          const f = _familySummary(db, secrets, code);
          const members = db.prepare(
            `SELECT p.code, p.given_name_ct, p.family_name_ct, m.role FROM memberships m
               JOIN persons p ON p.code = m.person_code
              WHERE m.family_code = ? AND m.ended_at IS NULL LIMIT 12`
          ).all(code).map(r => ({
            community_id: communityIdFor(r.code, createdPersons),
            sheet_ref: createdPersons.get(r.code) || null,
            name: [enc.decrypt(secrets, r.given_name_ct), enc.decrypt(secrets, r.family_name_ct)].filter(Boolean).join(' '),
            role: r.role,
          }));
          return {
            community_id: communityIdFor(code, createdFamilies),
            sheet_ref: createdFamilies.get(code) || null,
            status: f.status,
            display_name: f.display_name,
            members,
          };
        };
        if (verdict.kind === 'review') {
          outFam.candidates = verdict.cands.map(describeFamily);
          outFam.review_reasons = reasons;
        }

        const createFamily = (rejected = []) => {
          const code = families.create(db, secrets, { display_name: input.display_name, notes: input.notes }, { actor, reason: 'roster import' });
          createdFamilies.set(code, familyKey);
          for (const other of rejected) {
            if (createdFamilies.has(other)) continue;
            db.prepare(
              `INSERT INTO conflicts (code, kind, left_code, right_code, score, reasons, status, resolved_by, resolved_at, resolution_notes)
               VALUES (?, 'family', ?, ?, 0, ?, 'rejected', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`
            ).run(ids.newCode('conflict'), code, other, JSON.stringify(reasons), actor,
              'roster review: operator said these are different households');
          }
          audit.record(db, { action: 'resolver_created', actor, entityCode: code, entityKind: 'family', metadata: { strict: true } });
          return { code, action: 'created' };
        };
        const attachFamily = (code, via) => {
          const f = _familySummary(db, secrets, code);
          if (f.status === 'archived') families.reinstate(db, code, { actor, reason: 'returned on a roster import' });
          audit.record(db, {
            action: via === 'decision' ? 'resolver_attach_manual' : 'resolver_attach',
            actor, entityCode: code, entityKind: 'family', metadata: { via, strict: true },
          });
          return { code, action: 'attached' };
        };

        let result;
        if (d) {
          outFam.decided = true;
          if (d.action === 'attach') {
            result = attachFamily(resolveTargetFamily(d.target), 'decision');
          } else {
            result = createFamily(verdict.cands || []);
          }
          outFam.action = verdict.kind === 'review' ? 'review' : (result.action === 'attached' ? 'matched' : 'new');
        } else if (verdict.kind === 'match') {
          result = attachFamily(verdict.code, verdict.via);
          outFam.action = 'matched';
        } else if (verdict.kind === 'new') {
          result = createFamily();
          outFam.action = 'new';
        } else {
          pending.push(familyKey);
          result = createFamily();
          outFam.action = 'review';
        }
        familyCodeByKey.set(familyKey, result.code);
        if (canonical._ref) {
          const how = crosswalk.link(db, { source, ref: canonical._ref, kind: 'family', code: result.code });
          summary.crosswalk[how] += 1;
          outFam.ref = canonical._ref;
        }
        if (verdict.kind === 'match' && verdict.via) outFam.via = verdict.via;
        outFam.code_state = createdFamilies.has(result.code) ? 'new' : 'existing';
        outFam.community_id = communityIdFor(result.code, createdFamilies);
        if (result.action === 'attached' && createdFamilies.has(result.code)) {
          outFam.same_as = createdFamilies.get(result.code);
        }
        if (outFam.action === 'matched') summary.families.matched += 1;
        else if (outFam.action === 'new') summary.families.new += 1;
        else summary.families.review += 1;
        return result;
      };

      item.resolvePerson = resolvePerson;
      item.resolveFamily = resolveFamily;
    }
    return rowsToImport;
  }

  let importRunCode = null;
  const exec = () => {
    const batches = sheets.map(processSheetLazy);
    for (const b of batches) {
      if (!b.length) continue;
      // One import_runs row per sheet; rows run through the shared import
      // path with this module's resolvers plugged in.
      const canonicalRows = b.map(it => it.canonical);
      const ctxBase = {
        source,
        sourceRef: sourceRef ? `${sourceRef}#sheet${b.sheetIndex}` : `sheet${b.sheetIndex}`,
        actor,
        category,
        tags,
      };
      const res = importPipeline.importBatch(db, secrets, thresholds, canonicalRows, {
        ...ctxBase,
        rowHooks: b.map(it => ({ resolvePerson: it.resolvePerson, resolveFamily: it.resolveFamily })),
      });
      if (!importRunCode) importRunCode = res.importRunCode;
      output[b.sheetIndex].import_run = res.importRunCode;
    }
  };

  function processSheetLazy(sheet) {
    const rows = processSheet(sheet) || [];
    rows.sheetIndex = sheet.index;
    return rows;
  }

  let committed = false;
  try {
    db.transaction(() => {
      exec();
      if (mode === 'plan' || pending.length) throw ROLLBACK;
    })();
    committed = true;
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  // A rolled-back run's import_runs rows and minted ids no longer exist.
  if (!committed) {
    for (const s of output) delete s.import_run;
    const minted = new Set([
      ...[...createdPersons.keys()].map(ids.toCommunityId),
      ...[...createdFamilies.keys()].map(ids.toCommunityId),
    ]);
    _blankIds(output, minted);
  }
  const result = {
    mode,
    committed,
    summary,
    pending,
    sheets: output,
  };
  if (committed) result.import_runs = output.map(s => s.import_run).filter(Boolean);
  const ms = Date.now() - started;

  // Outside the transaction: a plan's audit row must survive its rollback.
  audit.record(db, {
    action: mode === 'plan' ? 'roster_plan' : (committed ? 'roster_commit' : 'roster_commit_refused'),
    actor,
    metadata: {
      source,
      source_ref: sourceRef,
      sheets: summary.sheets,
      rows: summary.rows,
      persons: summary.persons,
      families: summary.families,
      pending: pending.length,
      decisions: Object.keys(decisions).length,
      import_runs: result.import_runs || null,
      ms,
    },
  });
  log.info(`roster.${mode}`, {
    actor,
    committed,
    sheets: summary.sheets,
    rows: summary.rows,
    persons_matched: summary.persons.matched,
    persons_new: summary.persons.new,
    persons_review: summary.persons.review,
    persons_skipped: summary.persons.skipped,
    families_matched: summary.families.matched,
    families_new: summary.families.new,
    families_review: summary.families.review,
    crosswalk_created: summary.crosswalk.created,
    crosswalk_relinked: summary.crosswalk.relinked,
    told_apart: summary.told_apart,
    pending: pending.length,
    ms,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function _blankIds(node, minted) {
  if (Array.isArray(node)) { node.forEach(n => _blankIds(n, minted)); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'community_id' && typeof v === 'string' && minted.has(v)) node[k] = null;
    else if (v && typeof v === 'object') _blankIds(v, minted);
  }
}

function _mappingSummary(sheet) {
  const m = sheet.mapping || {};
  const col = h => (h && sheet.colOf.has(h) ? sheet.colOf.get(h) : null);
  const first = v => (Array.isArray(v) ? v[0] : v) || null;
  return {
    family: col(first(m.family && m.family.display_name)),
    persons: (m.persons || []).map(t => ({
      role: t.role || 'member',
      given: col(first(t.given_name)),
      family: col(first(t.family_name)),
      full: col(first(t.full_name)),
      list: col(first(t.list)),
      email: col(first(t.email)),
      phone: col(first(t.phone)),
      date_of_birth: col(first(t.date_of_birth)),
    })),
    address: m.address ? {
      line1: col(first(m.address.line1)),
      city: col(first(m.address.city)),
      postal: col(first(m.address.postal)),
    } : null,
  };
}

function _familyCell(sheet) {
  const m = sheet.mapping || {};
  const h = m.family && (Array.isArray(m.family.display_name) ? m.family.display_name[0] : m.family.display_name);
  return h && sheet.colOf.has(h) ? { col: sheet.colOf.get(h) } : null;
}

// Where this person's name lives on the sheet, so the caller can put the
// community id in exactly that cell (or that part of a list cell).
function _slotDescription(sheet, p, slot, key) {
  const src = p._src || {};
  const col = h => (h && sheet.colOf.has(h) ? sheet.colOf.get(h) : null);
  const cells = [];
  if (src.list) {
    cells.push({ col: col(src.list), part: 'list', text: src.list_text, start: src.list_start, index: src.list_index });
  } else {
    if (src.full) cells.push({ col: col(src.full), part: 'full' });
    if (src.given) cells.push({ col: col(src.given), part: 'given' });
    if (src.family) cells.push({ col: col(src.family), part: 'family' });
  }
  return {
    key,
    slot,
    role: p.role || 'member',
    given_name: p.given_name || null,
    family_name: p.family_name || null,
    date_of_birth: p.date_of_birth || null,
    name_cells: cells.filter(c => c.col !== null),
    ...(p._ref ? { ref: p._ref } : {}),
    ...(p._code_hint ? { prior_community_id: ids.toCommunityId(p._code_hint) } : {}),
  };
}

// Look up a community id (either letter, any case), following merges.
function lookup(db, id) {
  const code = ids.toCode(id);
  if (!code) return null;
  const kind = ids.kindOf(code);
  if (kind !== 'person' && kind !== 'family') return null;
  const target = aliases.resolveAlias(db, code);
  const table = kind === 'person' ? 'persons' : 'families';
  const row = db.prepare(`SELECT code, status, merged_into FROM ${table} WHERE code = ?`).get(target);
  if (!row) return null;
  return {
    kind,
    code: row.code,
    community_id: ids.toCommunityId(row.code),
    status: row.status,
    requested: typeof id === 'string' ? id.trim() : id,
    redirected: target !== code,
  };
}

module.exports = { run, prepare, lookup, RosterError, LIMITS };
